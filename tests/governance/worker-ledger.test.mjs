import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import * as worker from '../../tools/governance/worker-ledger.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { reserveReviewBudget } from '../../tools/governance/review-budget.mjs';
import {
  candidate,
  limits,
  registration,
  observation,
} from './fixtures/review-authority-fixture.mjs';
const scope = 'fixture-funding';
const limitsDigest = (l) =>
  digest(
    JSON.stringify([
      'review-limits-v1',
      l.callsPerAttempt,
      l.maxOutputTokens,
      l.maxInputBytes,
      l.maxRunSeconds,
      l.maxConcurrentCalls,
    ]),
  );
async function fixture(
  t,
  {
    registrations = [registration()],
    approvedLimits = limits,
    observe = async (c) => observation(c),
    fault,
  } = {},
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root, { fault });
  const identity = await store.initializeReviewFunding(
    scope,
    limitsDigest(approvedLimits ?? limits),
  );
  const authority = worker.createOfflineReviewOriginAuthority({ registrations });
  const ledger = worker.createLocalReviewLedger({
    store,
    fundingScope: scope,
    approvedLimits,
    observeUnderPrLock: observe,
    originAuthority: authority,
    verifyOutcome: async () => ({ kind: 'blocked' }),
  });
  const reserve = async (c = candidate, id = 'paid-1') =>
    reserveReviewBudget(
      { candidate: c, requestId: id, observed: observation(c) },
      approvedLimits,
      ledger.forOrigin(authority.resolve({ candidate: c, reservationRequestId: id }).value),
    );
  return {
    root,
    store,
    identity,
    authority,
    ledger,
    reserve,
    path: join(root, `${digest(scope)}.review`),
  };
}
test('funding_lock_precedes_pr_lock and ownership expires across async descendants', async (t) => {
  let f,
    calls = 0;
  f = await fixture(t, {
    observe: async (c) => {
      assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
      return f.store.withPrLock(`${c.repositoryId}:${c.pr}`, async () => {
        calls++;
        assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
        assert.ok(
          (
            await fs.stat(join(f.root, `${digest(`${c.repositoryId}:${c.pr}`)}.lock`))
          ).isDirectory(),
        );
        return observation(c);
      });
    },
  });
  assert.equal((await f.reserve()).kind, 'verified');
  assert.equal(calls, 2);
  assert.equal((await f.ledger.read()).kind, 'uncertain');
  let finish, escaped;
  await f.ledger.withFunding(async () => {
    assert.equal((await f.ledger.withFunding(async () => {})).kind, 'blocked');
    escaped = new Promise((resolve) => {
      finish = resolve;
    }).then(() => f.ledger.read());
    assert.equal((await f.ledger.readReservation('f'.repeat(64))).value, null);
  });
  finish();
  assert.equal((await escaped).kind, 'uncertain');
});
test('same_native_attempt_survives_request_and_pair_change', async (t) => {
  const cs = [
    candidate,
    { ...candidate, requestId: 'ready-2', base: 'd'.repeat(40), head: 'e'.repeat(40) },
    { ...candidate, requestId: 'ready-3', head: 'f'.repeat(40) },
  ];
  const roomy = { ...limits, maxConcurrentCalls: 3 };
  const f = await fixture(t, {
    approvedLimits: roomy,
    registrations: cs.map((c, i) => registration(c, `paid-${i + 1}`, roomy)),
  });
  for (let i = 0; i < 3; i++)
    assert.equal((await f.reserve(cs[i], `paid-${i + 1}`)).kind, i < 2 ? 'verified' : 'blocked');
  assert.equal((await f.ledger.withFunding(() => f.ledger.read())).value.reservations.length, 2);
});
test('removed_tail_or_index_denies_capacity including complete history and initialized empty files', async (t) => {
  for (const deletion of [
    'tail',
    'events.jsonl',
    'intents.jsonl',
    'members',
    'claims',
    'binding',
  ]) {
    const f = await fixture(t);
    assert.equal((await f.reserve()).kind, 'verified');
    if (deletion === 'tail') await fs.writeFile(join(f.path, 'events.jsonl'), '');
    else await fs.rm(join(f.path, deletion), { recursive: true, force: true });
    assert.notEqual((await f.ledger.withFunding(() => f.ledger.read())).kind, 'verified');
    assert.notEqual((await f.reserve()).kind, 'verified');
  }
});
test('whole root deletion or replacement denies fresh store bind and never recreates history', async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await fs.rm(f.root, { recursive: true });
  let store = new LocalDurableStore(f.root);
  await assert.rejects(store.bindReviewFunding(f.identity));
  await assert.rejects(fs.stat(f.root));
  await fs.mkdir(f.root);
  store = new LocalDurableStore(f.root);
  await store.initializeReviewFunding(scope, limitsDigest(limits));
  await assert.rejects(store.bindReviewFunding(f.identity));
});
test('missing_approval_or_changed_limits_denies before storage or observation', async (t) => {
  const f = await fixture(t);
  let touched = 0;
  f.store.fault = async () => {
    touched++;
  };
  assert.equal(
    (
      await reserveReviewBudget(
        { candidate, requestId: 'invented', observed: observation() },
        limits,
        f.ledger.forOrigin({ verified: true }),
      )
    ).kind,
    'blocked',
  );
  assert.equal(touched, 0);
  assert.throws(() =>
    worker.createLocalReviewLedger({
      store: f.store,
      fundingScope: scope,
      approvedLimits: null,
      observeUnderPrLock: async () => {},
      originAuthority: f.authority,
      verifyOutcome: async () => {},
    }),
  );
  const receipt = f.authority.resolve({ candidate, reservationRequestId: 'paid-1' }).value;
  const facade = f.ledger.forOrigin(receipt);
  assert.notEqual(
    (
      await reserveReviewBudget(
        { candidate, requestId: 'paid-2', observed: observation() },
        limits,
        facade,
      )
    ).kind,
    'verified',
  );
  assert.notEqual(
    (
      await reserveReviewBudget(
        { candidate, requestId: 'paid-1', observed: observation() },
        { ...limits, maxOutputTokens: 301 },
        facade,
      )
    ).kind,
    'verified',
  );
});
async function child(root, identity, mode = 'reserve') {
  const script = `import {LocalDurableStore} from './tools/governance/local-durable-store.mjs';
    import {createLocalReviewLedger,createOfflineReviewOriginAuthority} from './tools/governance/worker-ledger.mjs';
    import {reserveReviewBudget} from './tools/governance/review-budget.mjs';
    import {candidate,limits,registration,observation} from './tests/governance/fixtures/review-authority-fixture.mjs';
    const [root,identity,mode]=JSON.parse(process.env.REVIEW_FIXTURE);
    const store=new LocalDurableStore(root,{fault:async(point,value)=>{if(point===mode && (point!=='review-readback' || value?.kind==='reserved'))process.exit(73);}});
    await store.bindReviewFunding(identity);
    const authority=createOfflineReviewOriginAuthority({registrations:[registration()]});
    const ledger=createLocalReviewLedger({store,fundingScope:'fixture-funding',approvedLimits:limits,
      observeUnderPrLock:async c=>observation(c),originAuthority:authority,verifyOutcome:async()=>({kind:'blocked'})});
    const receipt=authority.resolve({candidate,reservationRequestId:'paid-1'}).value;
    const result=await reserveReviewBudget({candidate,requestId:'paid-1',observed:observation()},limits,ledger.forOrigin(receipt));
    console.log(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, REVIEW_FIXTURE: JSON.stringify([root, identity, mode]) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('exit', (code) =>
      resolve({ code, stdout, stderr, result: stdout ? JSON.parse(stdout) : null }),
    );
  });
}
test('reserves_once_across_processes', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([child(f.root, f.identity), child(f.root, f.identity)]);
  assert.equal(
    results.filter((r) => r.result?.kind === 'verified').length,
    1,
    JSON.stringify(results),
  );
  assert.equal((await f.store.readReviewFunding(scope, limitsDigest(limits))).length, 1);
});
test('crash_after_fsync_preserves_slot and crash matrix never sends or takes over', async (t) => {
  for (const point of ['review-before-append', 'review-after-fsync', 'review-readback']) {
    const f = await fixture(t);
    const r = await child(f.root, f.identity, point);
    assert.equal(r.code, 73, r.stderr);
    t.diagnostic(`crash=${point} exit=${r.code} lock=retained sends=0`);
    assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
    assert.notEqual((await f.reserve()).kind, 'verified');
    if (point === 'review-after-fsync')
      assert.equal((await f.store.readReviewFunding(scope, limitsDigest(limits))).length, 1);
  }
});
test('detached pending observation cannot continue after its funding owner returns', async (t) => {
  let release, started, finish;
  const gate = new Promise((r) => {
    release = r;
  });
  const entered = new Promise((r) => {
    started = r;
  });
  const f = await fixture(t, {
    observe: async (c) => {
      started();
      await gate;
      finish = true;
      return observation(c);
    },
  });
  let escaped;
  const owned = f.ledger.withFunding(async () => {
    escaped = f.ledger.observe(candidate);
    await entered;
  });
  await entered;
  await new Promise((r) => setImmediate(r));
  // Owner callback ended, but lock remains while the already-started work drains.
  assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
  release();
  assert.equal((await owned).kind, 'uncertain');
  assert.equal((await escaped).kind, 'uncertain');
  assert.equal(finish, true);
  assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
});
test('wrong instance, legacy candidate, unsupported fixture authority and changed root limits deny', async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  await a.ledger.withFunding(async () => {
    assert.equal((await b.ledger.read()).kind, 'uncertain');
    assert.equal((await b.ledger.withFunding(() => b.ledger.read())).kind, 'blocked');
    assert.equal((await a.ledger.readByClaimId('f'.repeat(64))).value, null);
  });
  const config = {
    store: a.store,
    fundingScope: scope,
    approvedLimits: { ...limits, maxInputBytes: 999 },
    observeUnderPrLock: async (c) => observation(c),
    originAuthority: a.authority,
    verifyOutcome: async () => ({ kind: 'blocked' }),
  };
  const changed = worker.createLocalReviewLedger(config);
  assert.equal((await changed.withFunding(() => changed.read())).kind, 'uncertain');
  assert.throws(() =>
    worker.createLocalReviewLedger({
      ...config,
      originAuthority: {
        resolve: () => ({ kind: 'verified' }),
        inspect: () => ({ kind: 'verified' }),
      },
    }),
  );
  const c = { ...candidate };
  delete c.protocolVersion;
  delete c.baseRef;
  delete c.requestId;
  assert.equal(
    a.authority.resolve({ candidate: c, reservationRequestId: 'paid-1' }).kind,
    'blocked',
  );
});
test('append binding rejects forged reservation and repeat API calls remain single slots', async (t) => {
  const f = await fixture(t);
  const reservation = (await f.reserve()).value;
  const facade = f.ledger.forOrigin(
    f.authority.resolve({ candidate, reservationRequestId: 'paid-1' }).value,
  );
  for (const patch of [
    { extra: true },
    { status: 'completed' },
    { requestId: 'paid-new' },
    { limits: { ...limits, maxRunSeconds: 21 } },
  ]) {
    assert.notEqual(
      (await facade.withReservationLock(() => facade.append({ ...reservation, ...patch }))).kind,
      'verified',
    );
  }
  assert.notEqual((await f.reserve()).kind, 'verified');
  assert.equal((await f.store.readReviewFunding(scope, limitsDigest(limits))).length, 1);
});
test('fresh observation drift before and after append retains only actually persisted slots', async (t) => {
  for (const afterAppend of [false, true]) {
    let reads = 0;
    const f = await fixture(t, {
      observe: async (c) => ({ ...observation(c), ready: ++reads <= (afterAppend ? 1 : 0) }),
    });
    assert.equal((await f.reserve()).kind, 'blocked');
    assert.equal(
      (await f.store.readReviewFunding(scope, limitsDigest(limits))).length,
      afterAppend ? 1 : 0,
    );
  }
});
test('full history is checked before row projection and exact event shape denies unknown fields', async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const events = await f.store.readReviewFunding(scope, limitsDigest(limits));
  const malformed = { ...events[0], extra: 'not-allowed' };
  const line = JSON.stringify(malformed),
    member = `1-${digest(line)}`;
  await fs.rm(join(f.path, 'members'), { recursive: true });
  await fs.mkdir(join(f.path, 'members'));
  await fs.writeFile(join(f.path, 'members', member), '');
  await fs.writeFile(join(f.path, 'events.jsonl'), line + '\n');
  await fs.writeFile(join(f.path, 'intents.jsonl'), member + '\n');
  assert.equal((await f.ledger.withFunding(() => f.ledger.read())).kind, 'uncertain');
});
test('read projection and claim lookup validate complete index, original run and immutable transitions', async (t) => {
  const f = await fixture(t);
  const reservation = (await f.reserve()).value;
  const claim = {
    id: digest(JSON.stringify(['review-claim-v1', reservation.key])),
    reservationKey: reservation.key,
    candidate,
    requestId: 'paid-1',
    limits,
    run: registration().run,
    materialDigest: '1'.repeat(64),
    invocationDigest: '2'.repeat(64),
    start: null,
  };
  const events = await f.store.readReviewFunding(scope, limitsDigest(limits));
  // Trusted storage fixture only; Unit 1 exports no claim lifecycle mutation.
  const event = {
    version: 1,
    sequence: 2,
    previousDigest: digest(JSON.stringify(events[0])),
    kind: 'claimed',
    reservation,
    claim,
    outcome: null,
  };
  await f.store.withReviewFundingLock(scope, limitsDigest(limits), () =>
    f.store.appendReviewFunding(scope, limitsDigest(limits), event),
  );
  const read = await f.ledger.withFunding(() => f.ledger.readByClaimId(claim.id));
  assert.equal(read.kind, 'verified');
  assert.deepEqual(read.value.claim, claim);
  assert.equal((await f.ledger.withFunding(() => f.ledger.read())).value.reservations.length, 1);
  await fs.writeFile(join(f.path, 'claims', claim.id), 'f'.repeat(64));
  assert.equal(
    (await f.ledger.withFunding(() => f.ledger.readByClaimId(claim.id))).kind,
    'uncertain',
  );
});
async function appendFixtureEvent(f, kind, reservation, claim = null, outcome = null) {
  const rows = await f.store.readReviewFunding(scope, limitsDigest(limits));
  const event = {
    version: 1,
    sequence: rows.length + 1,
    previousDigest: rows.length ? digest(JSON.stringify(rows.at(-1))) : '',
    kind,
    reservation,
    claim,
    outcome,
  };
  await f.store.withReviewFundingLock(scope, limitsDigest(limits), () =>
    f.store.appendReviewFunding(scope, limitsDigest(limits), event),
  );
  return event;
}
function preclaimOutcome(r, providerOutcome = 'not-sent', evidenceDigest = '9'.repeat(64)) {
  return {
    reservationKey: r.key,
    claimId: null,
    candidate: r.candidate,
    run: null,
    invocationDigest: null,
    executionEnded: true,
    providerOutcome,
    evidenceDigest,
  };
}
test('projection counts reservation identities while unknown occupies and completion consumes native attempt', async (t) => {
  const registrations = [1, 2, 3].map((i) => registration(candidate, `paid-${i}`));
  const f = await fixture(t, { registrations });
  const a = (await f.reserve()).value;
  await appendFixtureEvent(f, 'unknown', { ...a, status: 'unknown' });
  await appendFixtureEvent(f, 'unknown', { ...a, status: 'unknown' });
  const unknown = await f.ledger.withFunding(() => f.ledger.read());
  assert.equal(unknown.value.reservations.length, 1);
  assert.equal(unknown.value.reservations[0].status, 'unknown');
  const b = (await f.reserve(candidate, 'paid-2')).value;
  assert.equal((await f.reserve(candidate, 'paid-3')).kind, 'blocked');
  await appendFixtureEvent(f, 'completed', { ...a, status: 'completed' }, null, preclaimOutcome(a));
  await appendFixtureEvent(f, 'completed', { ...b, status: 'completed' }, null, preclaimOutcome(b));
  assert.equal((await f.reserve(candidate, 'paid-3')).kind, 'blocked');
  const result = await f.ledger.withFunding(() => f.ledger.read());
  assert.equal(result.value.reservations.length, 2);
  assert.ok(result.value.reservations.every((r) => r.status === 'completed'));
});
test('contradiction reoccupies concurrency and further automatic completion rejects', async (t) => {
  const other = { ...candidate, pr: 8, attempt: 'ready-2' };
  const registrations = [
    registration(),
    registration(candidate, 'paid-2'),
    registration(other, 'paid-3'),
  ];
  const f = await fixture(t, { registrations });
  const a = (await f.reserve()).value;
  await appendFixtureEvent(f, 'completed', { ...a, status: 'completed' }, null, preclaimOutcome(a));
  await f.reserve(candidate, 'paid-2');
  await f.reserve(other, 'paid-3');
  await appendFixtureEvent(
    f,
    'contradiction',
    { ...a, status: 'unknown' },
    null,
    preclaimOutcome(a, 'unknown', '8'.repeat(64)),
  );
  const result = await f.ledger.withFunding(() => f.ledger.read());
  assert.equal(result.value.reservations.filter((r) => r.status !== 'completed').length, 3);
  await appendFixtureEvent(f, 'completed', { ...a, status: 'completed' }, null, preclaimOutcome(a));
  assert.equal((await f.ledger.withFunding(() => f.ledger.read())).kind, 'uncertain');
});
test('claim shape and indexed history deny forged run, start, immutable material and duplicate sequence', async (t) => {
  for (const corrupt of ['run', 'start', 'material', 'sequence']) {
    const f = await fixture(t);
    const r = (await f.reserve()).value;
    const claim = {
      id: digest(JSON.stringify(['review-claim-v1', r.key])),
      reservationKey: r.key,
      candidate,
      requestId: r.requestId,
      limits,
      run: registration().run,
      materialDigest: '1'.repeat(64),
      invocationDigest: '2'.repeat(64),
      start: null,
    };
    if (corrupt === 'run') claim.run.id = '999';
    if (corrupt === 'start') claim.start = { state: 'consumed', claimId: claim.id, run: claim.run };
    await appendFixtureEvent(f, 'claimed', r, claim);
    if (corrupt === 'material')
      await appendFixtureEvent(
        f,
        'unknown',
        { ...r, status: 'unknown' },
        { ...claim, materialDigest: '4'.repeat(64) },
      );
    if (corrupt === 'sequence') {
      const rows = await f.store.readReviewFunding(scope, limitsDigest(limits));
      const bad = { ...rows[1], sequence: 1 };
      await assert.rejects(f.store.appendReviewFunding(scope, limitsDigest(limits), bad));
      continue;
    }
    assert.equal(
      (await f.ledger.withFunding(() => f.ledger.readByClaimId(claim.id))).kind,
      'uncertain',
    );
  }
});
test('ignored storage uncertainty still poisons ownership and retains funding lock', async (t) => {
  const f = await fixture(t);
  await fs.rm(join(f.path, 'events.jsonl'));
  const result = await f.ledger.withFunding(async () => {
    assert.equal((await f.ledger.read()).kind, 'uncertain');
    return { kind: 'verified', value: 'caller cannot erase uncertainty' };
  });
  assert.equal(result.kind, 'uncertain');
  assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
});

test('successful funding release has no post-removal I/O uncertainty or lock recreation gap', async (t) => {
  for (const stage of ['open', 'sync', 'close']) {
    const f = await fixture(t);
    const originalOpen = fs.open,
      originalRmdir = fs.rmdir;
    let released = false,
      postReleaseIo = 0;
    fs.rmdir = async (...args) => {
      const result = await originalRmdir(...args);
      if (args[0] === join(f.path, 'lock')) released = true;
      return result;
    };
    fs.open = async (...args) => {
      const afterRelease = released && args[0] === f.path;
      if (afterRelease) {
        postReleaseIo++;
        if (stage === 'open') throw Object.assign(Error('post-release open'), { code: 'EIO' });
      }
      const handle = await originalOpen(...args);
      if (!afterRelease) return handle;
      return {
        sync: async () => {
          if (stage === 'sync') throw Object.assign(Error('post-release sync'), { code: 'EIO' });
          return handle.sync();
        },
        close: async () => {
          await handle.close();
          if (stage === 'close') throw Object.assign(Error('post-release close'), { code: 'EIO' });
        },
      };
    };
    let first;
    try {
      first = await f.ledger.withFunding(() => f.ledger.read());
    } finally {
      fs.open = originalOpen;
      fs.rmdir = originalRmdir;
    }
    assert.equal(released, true);
    const lockPresent = await fs.stat(join(f.path, 'lock')).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    const next = await f.ledger.withFunding(() => f.ledger.read());
    t.diagnostic(
      JSON.stringify({
        fault: stage,
        firstResult: first.kind,
        lockPresent,
        nextResult: next.kind,
        postReleaseIo,
      }),
    );
    assert.equal(first.kind, 'verified', stage);
    assert.equal(lockPresent, false, stage);
    assert.equal(next.kind, 'verified', stage);
    assert.equal(postReleaseIo, 0, stage);
  }
});

test('pre-release funding directory open sync and close failures retain exclusion', async (t) => {
  for (const stage of ['open', 'sync', 'close', 'rmdir']) {
    const f = await fixture(t);
    const originalOpen = fs.open,
      originalRmdir = fs.rmdir;
    fs.rmdir = async (...args) => {
      if (stage === 'rmdir' && args[0] === join(f.path, 'lock'))
        throw Object.assign(Error('pre-release remove'), { code: 'EIO' });
      return originalRmdir(...args);
    };
    fs.open = async (...args) => {
      if (args[0] !== f.path) return originalOpen(...args);
      if (stage === 'open') throw Object.assign(Error('pre-release open'), { code: 'EIO' });
      const handle = await originalOpen(...args);
      return {
        sync: async () => {
          if (stage === 'sync') throw Object.assign(Error('pre-release sync'), { code: 'EIO' });
          return handle.sync();
        },
        close: async () => {
          await handle.close();
          if (stage === 'close') throw Object.assign(Error('pre-release close'), { code: 'EIO' });
        },
      };
    };
    let first;
    try {
      first = await f.ledger.withFunding(() => f.ledger.read());
    } finally {
      fs.open = originalOpen;
      fs.rmdir = originalRmdir;
    }
    assert.equal(first.kind, 'uncertain', stage);
    assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory(), stage);
    const next = await f.ledger.withFunding(() => f.ledger.read());
    assert.equal(next.kind, 'uncertain', stage);
    t.diagnostic(
      JSON.stringify({
        fault: stage,
        firstResult: first.kind,
        lockPresent: true,
        nextResult: next.kind,
      }),
    );
  }
});
