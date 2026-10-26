import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { admitCandidate } from '../../tools/governance/admission.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest, operationKey } from '../../tools/governance/journal.mjs';
import { ciClaimId } from '../../tools/governance/worker-dispatch.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import {
  handleTrustedEvent as handleNativeEvent,
  handleTrustedWorkerCallback,
  handleTrustedCiContinuation,
} from '../../tools/governance/controller-runtime.mjs';
import {
  encodeWorkerResult,
  verifyResultEnvelope,
  resultDecision,
  verifyArchive,
} from '../../tools/governance/worker-transport.mjs';
import {
  publicKey,
  signed,
  c,
  run,
  workerRun,
  timeline,
  snapshot,
  fixture,
} from './composed-adapter-fixture.mjs';
// Positive runtime regressions begin with a separately authenticated retained v2
// operation. Metadata alone is tested through handleNativeEvent below.
async function admitRetainedFixture(input, context) {
  const native = await handleNativeEvent(input, context);
  if (
    verifyArchive(
      input.archive,
      { purpose: 'controller-event', run: context?.expectedRun, bodyDigest: digest(input.body) },
      publicKey,
    ).kind !== 'verified'
  )
    return native;
  if (
    context?.mode !== 'offline-test' ||
    !input.archive ||
    JSON.parse(input.archive.body).bodyDigest !== digest(input.body)
  )
    return native;
  const raw = JSON.parse(input.body),
    envelope = JSON.parse(input.archive.body);
  if (
    raw.action !== 'ready_for_review' ||
    JSON.stringify(envelope.run) !== JSON.stringify(context.expectedRun)
  )
    return native;
  return admitCandidate(context.port, {
    type: 'verified_readiness',
    repositoryId: '1',
    pr: 2,
    readinessId: c.attempt,
    candidate: c,
    proofDigest: context.port.fixtureProofDigest,
  });
}
test('concrete bridge admits exact Ready through existing policy and journal readback', async (t) => {
  const { port, comments } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2, head: { sha: c.head } },
    workerVerified: true,
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const result = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(result.kind, 'verified');
  assert.equal(comments.length, 2);
});
test('production default denies without invoking injected HTTP', async () => {
  const r = await admitRetainedFixture(
    { body: '{}' },
    {
      port: {
        observe() {
          throw Error('called');
        },
      },
    },
  );
  assert.equal(r.kind, 'blocked');
});
test('event exact body and definition substitution denied before any observation', async (t) => {
  const { port, calls } = await fixture(t);
  const body = '{}';
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  for (const input of [
    { body: body + ' ', archive },
    {
      body,
      archive: signed({
        purpose: 'controller-event',
        run: { ...run, sha: 'd'.repeat(40) },
        bodyDigest: digest(body),
      }),
    },
  ])
    assert.equal(
      (
        await admitRetainedFixture(input, {
          port,
          expectedRun: run,
          publicKey,
          mode: 'offline-test',
        })
      ).kind,
      'blocked',
    );
  assert.equal(calls.length, 0);
});
test('native proof missing denies rather than trusting snapshot or booleans', async (t) => {
  const { port } = await fixture(t, { proof: false });
  await assert.rejects(() => port.observe(c));
});
test('history validates Ready origin and closure survives reopen', async (t) => {
  const events = [
    ...timeline,
    { id: 11, event: 'closed', actor: { id: 5 }, created_at: '2026-01-02T00:00:00Z' },
    { id: 12, event: 'reopened', actor: { id: 5 }, created_at: '2026-01-03T00:00:00Z' },
  ];
  const { port, store } = await fixture(t, { events });
  const o = await port.observe(c);
  assert.equal(o.lifecycle.closedSinceReady, true);
  assert.equal((await store.pending('1:2')).length, 1);
});
test('origin cannot be replaced with current candidate after head drift', async (t) => {
  const pr = snapshot();
  pr.head.sha = 'd'.repeat(40);
  const { port } = await fixture(t, { pr });
  const o = await port.observe(c);
  assert.equal(o.readiness.candidate.head, c.head);
  assert.equal(o.head, pr.head.sha);
});
test('malformed native schema and incomplete pagination deny', async (t) => {
  for (const modify of [
    (_q, r) => {
      r.body = '{}';
    },
    (q, r) => {
      if (q.path.includes('timeline')) r.headers.link = '<https://evil.invalid/page>; rel="next"';
    },
  ]) {
    const { port } = await fixture(t, { modify });
    await assert.rejects(() => port.observe(c));
  }
});
test('pagination follows only bounded exact next URL, includes all lifecycle pages', async (t) => {
  const { port, calls } = await fixture(t, {
    modify: (q, r) => {
      if (q.path.endsWith('timeline?per_page=100&page=1'))
        r.headers.link =
          '<https://api.github.com/repos/o/r/issues/2/timeline?per_page=100&page=2>; rel="next"';
      if (q.path.endsWith('timeline?per_page=100&page=2')) r.body = '[]';
    },
  });
  await port.observe(c);
  assert.ok(calls.some((q) => q.path.endsWith('page=2')));
});
test('durable pending survives process restart and blocks later admission', async (t) => {
  const { store, dir, port } = await fixture(t);
  await store.withPrLock('1:2', () =>
    store.append('1:2', { type: 'pending', id: 'uncertain', candidate: c }),
  );
  assert.equal((await new LocalDurableStore(dir).pending('1:2')).length, 1);
  await assert.rejects(() => port.withPrLock('1:2', async () => assert.fail('must not execute')));
});
test('fsync crash uncertainty persists and partial writes deny without repair', async (t) => {
  const { dir } = await fixture(t);
  const store = new LocalDurableStore(dir, {
    fault: () => {
      throw Error('crash');
    },
  });
  await assert.rejects(() =>
    store.withPrLock('x', () => store.append('x', { type: 'pending', id: 'p' })),
  );
  assert.equal((await new LocalDurableStore(dir).pending('x')).length, 1);
  await appendFile(join(dir, `${digest('x')}.jsonl`), '{');
  await assert.rejects(() => store.read('x'));
});
test('separate process cannot enter held local lock; no timeout reclaim', async (t) => {
  const { dir, store } = await fixture(t);
  await store.withPrLock('x', async () => {
    const url = new URL('../../tools/governance/local-durable-store.mjs', import.meta.url).href;
    const code = `import {LocalDurableStore} from ${JSON.stringify(url)};try {await new LocalDurableStore(${JSON.stringify(dir)}).withPrLock('x',()=>{});process.exitCode=9;}catch(e){process.exitCode=e.code==='EEXIST'?0:8;}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
    assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
  });
  assert.deepEqual(await store.read('x'), []);
});
test('result protocol composes existing Task7 policy and rejects changed bytes/run', () => {
  const result = { candidate: c, worker: 'ci', outcome: 'failure', claimId: 'claim-1' };
  const body = encodeWorkerResult(result);
  const envelope = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(body),
  });
  const observed = {
    candidate: c,
    nativeVerified: true,
    lifecycleVerified: true,
    ready: true,
    admitted: true,
    invalidated: false,
    sameRepository: true,
    expectedWorker: 'ci',
    expectedClaimId: 'claim-1',
    expectedRun: workerRun,
  };
  assert.equal(resultDecision(c, workerRun, result, observed, envelope, publicKey).action, 'draft');
  assert.equal(
    verifyResultEnvelope(body + ' ', envelope, workerRun, c, 'ci', publicKey, 'claim-1').kind,
    'blocked',
  );
  assert.equal(
    verifyResultEnvelope(
      body,
      envelope,
      { ...workerRun, attempt: 2 },
      c,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
});
test('unknown append outcome keeps durable obligation across restart', async (t) => {
  const { port, store } = await fixture(t, {
    modify: (q, r) => {
      if (q.method === 'POST') r.status = 503;
    },
  });
  const row = {
    version: 2,
    candidate: c,
    action: 'invalidate',
    phase: 'intent',
    key: operationKey(c, 'invalidate'),
  };
  await assert.rejects(() => port.withPrLock('1:2', () => port.append(row)));
  assert.equal((await store.pending('1:2')).length, 1);
});
test('forged worker run metadata and journal body edits deny', async (t) => {
  for (const modify of [
    (q, r) => {
      if (q.path.includes('/actions/runs/')) {
        const v = JSON.parse(r.body);
        v.actor.id = 99;
        r.body = JSON.stringify(v);
      }
    },
    (q, r) => {
      if (q.path.includes('/comments?')) {
        const v = JSON.parse(r.body);
        if (v.length) v[0].body += ' ';
        r.body = JSON.stringify(v);
      }
    },
  ]) {
    const { port } = await fixture(t, { modify });
    const body = JSON.stringify({
      repository: { id: 1 },
      action: 'ready_for_review',
      pull_request: { number: 2 },
    });
    const archive = signed({
      purpose: 'controller-event',
      run,
      readinessId: '10',
      bodyDigest: digest(body),
    });
    assert.notEqual(
      (
        await admitRetainedFixture(
          { body, archive },
          { port, expectedRun: run, publicKey, mode: 'offline-test' },
        )
      ).kind,
      'verified',
    );
  }
});
test('killed holder retains lock and fsynced pending; recovery never grants eligibility', async (t) => {
  const { dir } = await fixture(t);
  const url = new URL('../../tools/governance/local-durable-store.mjs', import.meta.url).href;
  const code = `import {LocalDurableStore} from ${JSON.stringify(url)};const s=new LocalDurableStore(${JSON.stringify(dir)});await s.withPrLock('crashed',async()=>{await s.append('crashed',{type:'pending',id:'persisted'});process.kill(process.pid,'SIGKILL');});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
  assert.equal(
    await new Promise((resolve) => child.on('exit', (_code, signal) => resolve(signal))),
    'SIGKILL',
  );
  const recovered = new LocalDurableStore(dir);
  assert.equal((await recovered.pending('crashed')).length, 1);
  await assert.rejects(
    () => recovered.withPrLock('crashed', () => assert.fail('must not reclaim')),
    { code: 'EEXIST' },
  );
});
test('trusted worker start/completion use same admitted Task6 gate and Task7 policy', async (t) => {
  const { port } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  for (const type of ['worker_start', 'worker_completed']) {
    const b = JSON.stringify({
      type,
      claimId: 'claim-1',
      candidate: c,
      worker: 'ci',
      outcome: 'success',
      workerVerified: true,
    });
    const a = signed({
      purpose: 'worker-callback',
      run: workerRun,
      candidate: c,
      worker: 'ci',
      bodyDigest: digest(b),
    });
    assert.equal(
      (
        await handleTrustedWorkerCallback(
          { body: b, archive: a },
          { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
        )
      ).kind,
      'verified',
    );
  }
});
test('outage before append retains local lock even when no pending row exists', async (t) => {
  const { dir, store } = await fixture(t);
  await assert.rejects(() =>
    store.withPrLock('outage', async () => {
      throw Error('storage unavailable before append');
    }),
  );
  assert.deepEqual(await store.pending('outage'), []);
  await assert.rejects(
    () => new LocalDurableStore(dir).withPrLock('outage', () => assert.fail('must deny')),
    { code: 'EEXIST' },
  );
});
test('current authenticated worker failure returns exact admitted candidate to Draft', async (t) => {
  const pr = snapshot();
  const { port } = await fixture(t, {
    pr,
    workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
  });
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  const b = JSON.stringify({
    claimId: 'claim-1',
    type: 'worker_completed',
    candidate: c,
    worker: 'ci',
    outcome: 'failure',
  });
  const a = signed({
    purpose: 'worker-callback',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(b),
  });
  assert.equal(
    (
      await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'blocked',
  );
  assert.equal(pr.draft, true);
});
test('archive rejects candidate-body, event and run-attempt substitutions', () => {
  const result = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' };
  const body = encodeWorkerResult(result);
  const envelope = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(body),
  });
  for (const altered of [
    { ...workerRun, event: 'pull_request_target' },
    { ...workerRun, sha: 'f'.repeat(40) },
    { ...workerRun, attempt: 3 },
  ])
    assert.equal(
      verifyResultEnvelope(body, envelope, altered, c, 'ci', publicKey, 'claim-1').kind,
      'blocked',
    );
  const changed = { ...result, candidate: { ...c, attempt: '11' } };
  assert.equal(
    verifyResultEnvelope(
      encodeWorkerResult(changed),
      envelope,
      workerRun,
      changed.candidate,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
});

test('runtime returned uncertainty before WAL retains lock and blocks fresh holder/replay', async (t) => {
  const { port, store, dir, comments } = await fixture(t);
  const originalAppend = store.append.bind(store);
  store.append = async () => {
    throw Error('pre-WAL storage outage');
  };
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const first = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(first.kind, 'uncertain');
  assert.deepEqual(await store.pending('1:2'), []);
  assert.equal(comments.length, 0);
  const fresh = new LocalDurableStore(dir);
  await assert.rejects(
    () => fresh.withPrLock('1:2', () => assert.fail('uncertainty must retain lock')),
    { code: 'EEXIST' },
  );
  store.append = originalAppend;
  const replay = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(replay.kind, 'blocked');
  assert.equal(comments.length, 0);
});

test('runtime Draft refuses already observed final-read candidate or PR identity drift', async (t) => {
  const cases = {
    head: (p) => {
      p.head.sha = 'd'.repeat(40);
    },
    base: (p) => {
      p.base.sha = 'd'.repeat(40);
    },
    state: (p) => {
      p.state = 'closed';
    },
    draft: (p) => {
      p.draft = true;
    },
    wrongNumber: (p) => {
      p.number = 999;
      p.node_id = 'PR_OTHER';
    },
    wrongNode: (p) => {
      p.node_id = 'PR_OTHER';
    },
    wrongBaseRepository: (p) => {
      p.base.repo.id = 999;
    },
    wrongHeadRepository: (p) => {
      p.head.repo.id = 999;
    },
    malformed: (p) => {
      delete p.number;
    },
  };
  for (const [name, change] of Object.entries(cases))
    await t.test(name, async (t) => {
      const pr = snapshot();
      let draftIntent = false;
      let readsAfterIntent = 0;
      const { port, calls } = await fixture(t, {
        pr,
        workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
        modify(q, r) {
          if (q.method === 'POST' && q.path.endsWith('/comments')) {
            const row = JSON.parse(JSON.parse(q.body).body);
            if (row.action === 'draft' && row.phase === 'intent') draftIntent = true;
          }
          if (q.path.endsWith('/pulls/2') && draftIntent && ++readsAfterIntent === 2) {
            change(pr);
            r.body = JSON.stringify(pr);
          }
        },
      });
      const body = JSON.stringify({
        repository: { id: 1 },
        action: 'ready_for_review',
        pull_request: { number: 2 },
      });
      const archive = signed({
        purpose: 'controller-event',
        run,
        readinessId: '10',
        bodyDigest: digest(body),
      });
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'verified',
      );
      const b = JSON.stringify({
        claimId: 'claim-1',
        type: 'worker_completed',
        candidate: c,
        worker: 'ci',
        outcome: 'failure',
      });
      const a = signed({
        purpose: 'worker-callback',
        run: workerRun,
        candidate: c,
        worker: 'ci',
        bodyDigest: digest(b),
      });
      const completion = await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      );
      assert.notEqual(completion.kind, 'verified');
      assert.equal(readsAfterIntent >= 2, true);
      assert.equal(
        calls.filter((q) => q.path === '/graphql').length,
        0,
        'must not mutate already observed unrelated or changed PR',
      );
    });
});

test('runtime Draft refuses new native attempt or closure visible at final read', async (t) => {
  for (const event of ['ready_for_review', 'closed'])
    await t.test(event, async (t) => {
      const events = structuredClone(timeline);
      let draftIntent = false;
      let readsAfterIntent = 0;
      const { port, calls } = await fixture(t, {
        events,
        workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
        modify(q) {
          if (q.method === 'POST' && q.path.endsWith('/comments')) {
            const row = JSON.parse(JSON.parse(q.body).body);
            if (row.action === 'draft' && row.phase === 'intent') draftIntent = true;
          }
          if (q.path.endsWith('/pulls/2') && draftIntent && ++readsAfterIntent === 2)
            events.push({ id: 13, actor: { id: 5 }, event, created_at: '2026-01-02T00:00:00Z' });
        },
      });
      const body = JSON.stringify({
        repository: { id: 1 },
        action: 'ready_for_review',
        pull_request: { number: 2 },
      });
      const archive = signed({
        purpose: 'controller-event',
        run,
        readinessId: '10',
        bodyDigest: digest(body),
      });
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'verified',
      );
      const b = JSON.stringify({
        claimId: 'claim-1',
        type: 'worker_completed',
        candidate: c,
        worker: 'ci',
        outcome: 'failure',
      });
      const a = signed({
        purpose: 'worker-callback',
        run: workerRun,
        candidate: c,
        worker: 'ci',
        bodyDigest: digest(b),
      });
      const completion = await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      );
      assert.notEqual(completion.kind, 'verified');
      assert.equal(readsAfterIntent >= 2, true);
      assert.equal(calls.filter((q) => q.path === '/graphql').length, 0);
    });
});

test('public runtime and result verifier bound malformed signature before base64 decoding', async (t) => {
  const { port, calls } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const result = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' };
  const resultBody = encodeWorkerResult(result);
  const resultArchive = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(resultBody),
  });
  const invalid = [
    'A'.repeat(2_000_000),
    '!'.repeat(88),
    'A'.repeat(85) + 'B==',
    'A'.repeat(87),
    Buffer.alloc(64),
    null,
  ];
  const original = Buffer.from;
  let base64Decodes = 0;
  Buffer.from = function (value, encoding, ...args) {
    if (encoding === 'base64') base64Decodes++;
    return original(value, encoding, ...args);
  };
  try {
    for (const signature of invalid) {
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive: { ...archive, signature } },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'blocked',
      );
      assert.equal(
        verifyResultEnvelope(
          resultBody,
          { ...resultArchive, signature },
          workerRun,
          c,
          'ci',
          publicKey,
        ).kind,
        'blocked',
      );
    }
  } finally {
    Buffer.from = original;
  }
  assert.equal(base64Decodes, 0);
  assert.equal(calls.length, 0);
});

test('runtime failed-worker uncertainty before WAL survives restart and denies later start', async (t) => {
  const { port, store, dir, comments } = await fixture(t, {
    workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
  });
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  const call = async (type, outcome) => {
    const b = JSON.stringify({ type, claimId: 'claim-1', candidate: c, worker: 'ci', outcome });
    const a = signed({
      purpose: 'worker-callback',
      run: workerRun,
      candidate: c,
      worker: 'ci',
      bodyDigest: digest(b),
    });
    return handleTrustedWorkerCallback(
      { body: b, archive: a },
      { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
    );
  };
  const original = store.append.bind(store);
  store.append = async () => {
    throw Error('pre-WAL failure');
  };
  assert.equal((await call('worker_completed', 'failure')).kind, 'uncertain');
  assert.deepEqual(await store.pending('1:2'), []);
  assert.equal(comments.length, 2);
  store.append = original;
  assert.equal((await call('worker_start', 'success')).kind, 'blocked');
  await assert.rejects(
    () =>
      new LocalDurableStore(dir).withPrLock('1:2', () =>
        assert.fail('failed candidate must stay blocked'),
      ),
    { code: 'EEXIST' },
  );
  assert.equal(comments.length, 2);
});

test('explicit continuation runtime composes real local durable providers and stays closed by default', async (t) => {
  const f = await fixture(t, { concreteContinuation: true });
  const closed = await handleTrustedCiContinuation({ candidate: c }, { port: f.port });
  assert.equal(closed.kind, 'blocked');
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await admitCandidate(f.port, {
        type: 'verified_readiness',
        repositoryId: '1',
        pr: 2,
        readinessId: c.attempt,
        candidate: c,
        proofDigest: f.port.fixtureProofDigest,
      })
    ).kind,
    'verified',
  );
  const dispatched = await handleTrustedCiContinuation(
    { candidate: c },
    { port: f.port, mode: 'offline-test' },
  );
  assert.equal(dispatched.kind, 'verified');
  const body = JSON.stringify({
    type: 'worker_start',
    worker: 'ci',
    candidate: c,
    claimId: dispatched.value.id,
  });
  const input = {
    body,
    archive: signed({
      purpose: 'worker-callback',
      run: workerRun,
      worker: 'ci',
      candidate: c,
      bodyDigest: digest(body),
    }),
  };
  const context = { port: f.port, expectedRun: workerRun, publicKey, mode: 'offline-test' };
  assert.equal((await handleTrustedWorkerCallback(input, context)).kind, 'verified');
  assert.equal((await f.store.readCiClaim(dispatched.value.id)).value.start.state, 'consumed');
  assert.equal((await handleTrustedWorkerCallback(input, context)).kind, 'blocked');
  assert.equal(
    (
      await handleTrustedCiContinuation(
        { claimId: dispatched.value.id },
        { port: f.port, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  assert.equal((await handleTrustedWorkerCallback(input, context)).kind, 'blocked');
  assert.equal(f.calls.filter((x) => x.path.endsWith('/dispatches')).length, 1);
});

test('v2 review has no static worker mapping fallback or worker_start permission route', async (t) => {
  const f = await fixture(t);
  const port = createGithubPort({
    ...f.portConfig,
    workers: { ...f.portConfig.workers, review: workerRun },
  });
  for (const type of ['worker_start', 'worker_completed']) {
    const body = JSON.stringify({
      type,
      candidate: c,
      worker: 'review',
      outcome: 'success',
      claimId: 'a'.repeat(64),
    });
    const archive = signed({
      purpose: 'worker-callback',
      run: workerRun,
      candidate: c,
      worker: 'review',
      bodyDigest: digest(body),
    });
    const result = await handleTrustedWorkerCallback(
      { body, archive },
      { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
    );
    assert.equal(result.kind, 'blocked');
  }
  assert.equal(f.calls.filter((r) => r.method === 'POST').length, 0);
});

test('read-only review observation requires the current held PR scope', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.port.observeReviewAdmission(c));
  const result = await f.port.withPrLock('1:2', () => f.port.observeReviewAdmission(c));
  assert.equal(result.ci.verified, false);
  assert.equal(result.admitted, false);
  assert.equal(f.calls.filter((r) => r.method === 'POST').length, 0);
});

test('consumed review continuation constructor rejects extra fields and accessors without invoking them', async (t) => {
  const f = await fixture(t);
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'resolveConsumed', {
    enumerable: true,
    get() {
      invoked++;
      return () => verified(null);
    },
  });
  for (const reviewContinuation of [
    accessor,
    { resolveConsumed: () => verified(null), extra: true },
    { resolveConsumed: () => verified(null), [Symbol('extra')]: true },
  ])
    assert.throws(() => createGithubPort({ ...f.portConfig, reviewContinuation }));
  assert.equal(invoked, 0);
});
