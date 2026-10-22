import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as worker from '../../tools/governance/worker-ledger.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { reserveReviewBudget } from '../../tools/governance/review-budget.mjs';
import {
  candidate,
  limits,
  registration,
  observation,
  createReviewAuthorityFixture,
  canonical,
} from './fixtures/review-authority-fixture.mjs';
const scope = 'lifecycle-fixture';
const ld = digest(JSON.stringify(['review-limits-v1', ...Object.values(limits)]));
const materialDigest = digest(canonical({ base: candidate.base, head: candidate.head, files: [] }));
const body = canonical({
  version: 1,
  model: 'gpt-6-astra',
  effort: 'high',
  fresh: true,
  tools: [],
  maxOutputTokens: limits.maxOutputTokens,
  instructions: 'Review fixture',
  material: { base: candidate.base, head: candidate.head, files: [] },
});
const invocationDigest = digest(body);
function invocation(c) {
  return {
    candidate: c.candidate,
    materialDigest: c.materialDigest,
    body,
    bodyDigest: digest(body),
    inputBytes: Buffer.byteLength(body),
    model: 'gpt-6-astra',
    effort: 'high',
    fresh: true,
    limits: c.limits,
  };
}
async function fixture(
  t,
  {
    fault,
    observe = async (c) => observation(c),
    registrations = [
      registration(),
      registration(candidate, 'paid-2'),
      registration(candidate, 'paid-3'),
    ],
  } = {},
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root, { fault });
  const identity = await store.initializeReviewFunding(scope, ld);
  let authority,
    ledger,
    retainedOutcomes = [];
  function compose(outcomes = retainedOutcomes) {
    retainedOutcomes = outcomes;
    const fixture = createReviewAuthorityFixture({ registrations, outcomes });
    authority = fixture.originAuthority;
    ledger = worker.createLocalReviewLedger({
      store,
      fundingScope: scope,
      approvedLimits: limits,
      observeUnderPrLock: observe,
      ...fixture,
    });
  }
  compose();
  const receipt = (id = 'paid-1', c = candidate) =>
    authority.resolve({ candidate: c, reservationRequestId: id }).value;
  const reserve = (id = 'paid-1', c = candidate) =>
    reserveReviewBudget(
      { candidate: c, requestId: id, observed: observation(c) },
      limits,
      ledger.forOrigin(receipt(id, c)),
    );
  const claim = (key, patch = {}) =>
    worker.claimReservation(
      key,
      { originReceipt: receipt(), materialDigest, invocationDigest, ...patch },
      ledger,
    );
  const read = () => ledger.withFunding(() => ledger.read());
  async function provision(key, providerOutcome = 'not-sent', options = {}) {
    const events = await store.readReviewFunding(scope, ld);
    const last = events.filter((e) => e.reservation.key === key).at(-1),
      c = last.claim;
    const origin = {
      run: registration().run,
      approvedDefinition: registration().approvedDefinition,
      evidenceDigest: digest(registration().evidenceBody),
    };
    const proof = {
      originEvidenceDigest: origin.evidenceDigest,
      phase: last.kind,
      guardConsumed: !!c?.start,
      sendObserved: providerOutcome === 'completed',
      executionEnded: true,
      completion:
        providerOutcome === 'completed'
          ? { body: '{"outcome":"success"}', outputTokens: 1, inputBytes: 30 }
          : null,
      ...options,
    };
    const evidenceBody = canonical(proof);
    const outcome = {
      reservationKey: key,
      claimId: c?.id ?? null,
      candidate,
      run: c?.run ?? null,
      invocationDigest: c?.invocationDigest ?? null,
      executionEnded: proof.executionEnded,
      providerOutcome,
      evidenceDigest: digest(evidenceBody),
    };
    const binding = {
      reservation: last.reservation,
      claim: c,
      outcome: last.outcome,
      events,
      origin,
    };
    compose([...retainedOutcomes, { evidenceBody, outcome, binding }]);
    return { evidenceBody, outcome, binding };
  }
  return {
    root,
    store,
    identity,
    compose,
    receipt,
    reserve,
    claim,
    read,
    provision,
    get ledger() {
      return ledger;
    },
    path: join(root, digest(scope) + '.review'),
  };
}
test('duplicate_claim_grants_nothing and claim_rejects_changed_material_or_limits', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value;
  const claim = await f.claim(r.key);
  assert.equal(claim.kind, 'verified');
  assert.equal((await f.claim(r.key)).kind, 'blocked');
  assert.equal((await f.claim(r.key, { materialDigest: '3'.repeat(64) })).kind, 'blocked');
  assert.equal(
    (await f.claim(r.key, { limits: { ...limits, maxRunSeconds: 21 } })).kind,
    'blocked',
  );
  assert.equal((await f.read()).value.reservations.length, 1);
});
test('simultaneous_start_executes_once and guards are opaque one-shot exact bindings', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  let executions = 0,
    sends = 0;
  const execute = async (claim, guard) => {
    executions++;
    await assert.rejects(fs.stat(join(f.path, 'lock')));
    assert.ok(Object.isFrozen(claim.run));
    assert.equal(
      worker.consumeReviewGuard(structuredClone(guard), invocation(claim)).kind,
      'blocked',
    );
    assert.equal(
      worker.consumeReviewGuard(guard, {
        ...invocation(claim),
        limits: { ...limits, maxInputBytes: 2 },
      }).kind,
      'blocked',
    );
    assert.equal(worker.consumeReviewGuard(guard, invocation(claim)).kind, 'verified');
    sends++;
    assert.equal(worker.consumeReviewGuard(guard, invocation(claim)).kind, 'blocked');
    return { sent: true };
  };
  const results = await Promise.all([
    worker.withClaimedReview(c.id, f.ledger, execute),
    worker.withClaimedReview(c.id, f.ledger, execute),
  ]);
  assert.equal(results.filter((x) => x.kind === 'verified').length, 1);
  assert.equal(executions, 1);
  assert.equal(sends, 1);
  assert.equal((await worker.withClaimedReview(c.id, f.ledger, execute)).kind, 'blocked');
});
test('lost_start_readback_executes_zero and retains consumed durable start', async (t) => {
  let armed = false;
  const f = await fixture(t, {
    fault: async (point, event) => {
      if (armed && point === 'review-readback' && event?.kind === 'consumed')
        throw Error('lost consume response');
    },
  });
  const r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  armed = true;
  let executions = 0;
  assert.equal(
    (await worker.withClaimedReview(c.id, f.ledger, () => executions++)).kind,
    'uncertain',
  );
  armed = false;
  assert.equal(executions, 0);
  assert.equal((await f.store.readReviewFunding(scope, ld)).at(-1).claim.start.state, 'consumed');
  assert.notEqual(
    (await worker.withClaimedReview(c.id, f.ledger, () => executions++)).kind,
    'verified',
  );
  assert.equal(executions, 0);
});
test('rerun_cannot_replace_original_run and cloned_foreign_receipt_denied', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value;
  const other = createReviewAuthorityFixture({
    registrations: [registration()],
    outcomes: [],
  }).originAuthority;
  for (const originReceipt of [
    structuredClone(f.receipt()),
    other.resolve({ candidate, reservationRequestId: 'paid-1' }).value,
  ])
    assert.equal((await f.claim(r.key, { originReceipt })).kind, 'blocked');
  assert.equal(
    (await f.claim(r.key, { run: { ...registration().run, attempt: 2 } })).kind,
    'blocked',
  );
  assert.equal((await f.claim(r.key)).kind, 'verified');
});
test('preclaim_not_sent_releases_concurrency_not_budget and completed_never_refunds_attempt', async (t) => {
  const f = await fixture(t),
    a = (await f.reserve()).value,
    b = (await f.reserve('paid-2')).value;
  const evidence = await f.provision(a.key);
  assert.equal(
    (await worker.settleReservation(a.key, evidence.evidenceBody, f.ledger)).kind,
    'verified',
  );
  assert.equal(
    (await f.read()).value.reservations.filter((r) => r.status !== 'completed').length,
    1,
  );
  assert.equal((await f.reserve('paid-3')).kind, 'blocked');
  assert.equal((await f.read()).value.reservations.length, 2);
  assert.ok(b);
});
test('unknown_stays_occupied and unauthenticated settlement flags deny', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value;
  assert.equal(
    (
      await worker.settleReservation(
        r.key,
        { verified: true, executionEnded: true, providerOutcome: 'not-sent' },
        f.ledger,
      )
    ).kind,
    'blocked',
  );
  const e = await f.provision(r.key, 'unknown', { executionEnded: false });
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  assert.equal((await f.claim(r.key)).kind, 'blocked');
  assert.equal((await f.read()).value.reservations[0].status, 'unknown');
});
test('stale_candidate_accounting_is_not_admission and claimed no-send does not fabricate start', async (t) => {
  let ready = true;
  const f = await fixture(t, { observe: async (c) => ({ ...observation(c), ready }) }),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  ready = false;
  let executed = 0;
  assert.equal((await worker.withClaimedReview(c.id, f.ledger, () => executed++)).kind, 'blocked');
  const e = await f.provision(r.key);
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).kind,
    'verified',
  );
  assert.equal(executed, 0);
  const last = (await f.store.readReviewFunding(scope, ld)).at(-1);
  assert.equal(last.claim.start, null);
  assert.equal(last.reservation.status, 'completed');
});
test('terminal_contradiction_reoccupies_capacity and contradictory_settlement_denies future completion', async (t) => {
  const other = { ...candidate, pr: 8, attempt: 'ready-2' },
    extra = { ...candidate, pr: 9, attempt: 'ready-3' };
  const f = await fixture(t, {
      registrations: [
        registration(),
        registration(candidate, 'paid-2'),
        registration(other, 'paid-other'),
        registration(extra, 'paid-extra'),
      ],
    }),
    r = (await f.reserve()).value;
  let e = await f.provision(r.key);
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
  const count = (await f.store.readReviewFunding(scope, ld)).length;
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
  assert.equal((await f.store.readReviewFunding(scope, ld)).length, count);
  assert.equal((await f.reserve('paid-2')).kind, 'verified');
  assert.equal((await f.reserve('paid-other', other)).kind, 'verified');
  e = await f.provision(r.key);
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).kind,
    'blocked',
  );
  const state = await f.read();
  assert.equal(state.value.reservations[0].status, 'unknown');
  assert.equal(state.value.reservations.filter((r) => r.status !== 'completed').length, 3);
  assert.equal((await f.reserve('paid-extra', extra)).kind, 'blocked');
});
test('missing_or_duplicate_claim_index_denies', async (t) => {
  for (const mode of ['missing', 'duplicate']) {
    const f = await fixture(t),
      r = (await f.reserve()).value,
      c = (await f.claim(r.key)).value;
    if (mode === 'missing') await fs.rm(join(f.path, 'claims', c.id));
    else await fs.writeFile(join(f.path, 'claims', 'f'.repeat(64)), r.key);
    let calls = 0;
    assert.notEqual(
      (await worker.withClaimedReview(c.id, f.ledger, () => calls++)).kind,
      'verified',
    );
    assert.equal(calls, 0);
  }
});

test('guard expires on executor return, thrown executor remains occupied and never retries', async (t) => {
  for (const throws of [false, true]) {
    const f = await fixture(t),
      r = (await f.reserve()).value,
      c = (await f.claim(r.key)).value;
    let saved,
      executions = 0;
    const report = await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) => {
      saved = guard;
      executions++;
      if (throws) throw Error('execution lost');
      return { done: true };
    });
    assert.equal(report.kind, throws ? 'uncertain' : 'verified');
    assert.equal(worker.consumeReviewGuard(saved, invocation(c)).kind, 'blocked');
    assert.equal(
      (await worker.withClaimedReview(c.id, f.ledger, () => executions++)).kind,
      'blocked',
    );
    assert.equal(executions, 1);
    assert.equal((await f.read()).value.reservations[0].status, throws ? 'unknown' : 'reserved');
  }
});
test('authenticated completion requires consumed original execution and measured bounded response', async (t) => {
  for (const bad of [
    'no-start',
    'no-usage',
    'over-output',
    'over-input',
    'oversized',
    'alive',
    'sent-no-guard',
  ]) {
    const f = await fixture(t),
      r = (await f.reserve()).value,
      c = (await f.claim(r.key)).value;
    if (bad !== 'no-start')
      await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) =>
        worker.consumeReviewGuard(guard, invocation(claim)),
      );
    const patch =
      bad === 'no-usage'
        ? { completion: null }
        : bad === 'over-output'
          ? {
              completion: {
                body: '{"outcome":"success"}',
                outputTokens: limits.maxOutputTokens + 1,
                inputBytes: 1,
              },
            }
          : bad === 'over-input'
            ? {
                completion: {
                  body: '{"outcome":"success"}',
                  outputTokens: 1,
                  inputBytes: limits.maxInputBytes + 1,
                },
              }
            : bad === 'oversized'
              ? { completion: { body: 'x'.repeat(1_000_001), outputTokens: 1, inputBytes: 1 } }
              : bad === 'alive'
                ? { executionEnded: false }
                : bad === 'sent-no-guard'
                  ? { guardConsumed: false }
                  : {};
    if (bad === 'oversized') {
      await assert.rejects(f.provision(r.key, 'completed', patch));
      continue;
    }
    const e = await f.provision(r.key, 'completed', patch);
    assert.equal(
      (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).kind,
      'blocked',
      bad,
    );
  }
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) =>
    worker.consumeReviewGuard(guard, invocation(claim)),
  );
  const e = await f.provision(r.key, 'completed');
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
});
test('unknown may reconcile completed without reexecuting and runtime evidence cannot mutate trusted outcome', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  let executions = 0;
  await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) => {
    executions++;
    return worker.consumeReviewGuard(guard, invocation(claim));
  });
  let e = await f.provision(r.key, 'unknown', { executionEnded: false });
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  e = await f.provision(r.key, 'completed');
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody + ' ', f.ledger)).kind,
    'blocked',
  );
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
  assert.equal(executions, 1);
});
async function lifecycleChild(f, stage) {
  const script = `import {LocalDurableStore} from './tools/governance/local-durable-store.mjs';
    import * as w from './tools/governance/worker-ledger.mjs';
    import {candidate,limits,registration,observation,createReviewAuthorityFixture,canonical} from './tests/governance/fixtures/review-authority-fixture.mjs';
    import {digest} from './tools/governance/journal.mjs';
    import {promises as fs} from 'node:fs';
    import {reserveReviewBudget} from './tools/governance/review-budget.mjs';
    const {root,identity,stage,body,materialDigest,invocationDigest}=JSON.parse(process.env.LIFECYCLE_FIXTURE);
    const store=new LocalDurableStore(root,{fault:async(point,event)=>{if(stage==='consume-readback'&&point==='review-readback'&&event?.kind==='consumed')process.kill(process.pid,'SIGKILL');}});
    await store.bindReviewFunding(identity);
    const fixture=createReviewAuthorityFixture({registrations:[registration(),registration(candidate,'paid-2'),registration(candidate,'paid-3')],outcomes:[]});
    const ledger=w.createLocalReviewLedger({store,fundingScope:'lifecycle-fixture',approvedLimits:limits,observeUnderPrLock:async c=>observation(c),...fixture});
    const receipt=fixture.originAuthority.resolve({candidate,reservationRequestId:'paid-1'}).value;
    const r=(await reserveReviewBudget({candidate,requestId:'paid-1',observed:observation()},limits,ledger.forOrigin(receipt))).value;
    const c=(await w.claimReservation(r.key,{originReceipt:receipt,materialDigest,invocationDigest},ledger)).value;
    if(stage==='claim')process.kill(process.pid,'SIGKILL');
    await w.withClaimedReview(c.id,ledger,async(claim,guard)=>{
      if(stage==='consume')process.kill(process.pid,'SIGKILL');
      const invocation={candidate,materialDigest,body,bodyDigest:invocationDigest,inputBytes:Buffer.byteLength(body),model:'gpt-6-astra',effort:'high',fresh:true,limits};
      if(w.consumeReviewGuard(guard,invocation).kind==='verified')await fs.appendFile(root+'/fake-sends','one\\n');
      if(stage==='send')process.kill(process.pid,'SIGKILL');
      return {done:true};
    });`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        LIFECYCLE_FIXTURE: JSON.stringify({
          root: f.root,
          identity: f.identity,
          stage,
          body,
          materialDigest,
          invocationDigest,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}
test('SIGKILL restart between claim consume send settlement never resets consumed start', async (t) => {
  for (const stage of ['claim', 'consume', 'consume-readback', 'send']) {
    const f = await fixture(t),
      child = await lifecycleChild(f, stage);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const events = await f.store.readReviewFunding(scope, ld),
      last = events.at(-1),
      c = last.claim;
    assert.equal(last.kind, stage === 'claim' ? 'claimed' : 'consumed');
    const restartedStore = new LocalDurableStore(f.root);
    await restartedStore.bindReviewFunding(f.identity);
    const authorityFixture = createReviewAuthorityFixture({
      registrations: [registration()],
      outcomes: [],
    });
    const ledger = worker.createLocalReviewLedger({
      store: restartedStore,
      fundingScope: scope,
      approvedLimits: limits,
      observeUnderPrLock: async (c) => observation(c),
      ...authorityFixture,
    });
    let executions = 0;
    if (stage === 'claim') {
      assert.equal(c.start, null);
      const e = await f.provision(last.reservation.key);
      assert.equal(
        (await worker.reconcileReservation(last.reservation.key, e.evidenceBody, f.ledger)).value
          .status,
        'completed',
      );
    } else {
      assert.equal(c.start.state, 'consumed');
      assert.notEqual(
        (await worker.withClaimedReview(c.id, ledger, () => executions++)).kind,
        'verified',
      );
      assert.equal(executions, 0);
      if (stage !== 'consume-readback') {
        const e = await f.provision(
          last.reservation.key,
          stage === 'send' ? 'completed' : 'not-sent',
          { guardConsumed: stage === 'send' },
        );
        assert.equal(
          (await worker.reconcileReservation(last.reservation.key, e.evidenceBody, f.ledger)).value
            .status,
          'completed',
        );
        assert.equal(
          (await f.store.readReviewFunding(scope, ld)).at(-1).claim.start.state,
          'consumed',
        );
      } else assert.ok((await fs.stat(join(f.path, 'lock'))).isDirectory());
    }
    const sends = await fs.readFile(join(f.root, 'fake-sends'), 'utf8').catch(() => '');
    assert.equal(sends, stage === 'send' ? 'one\n' : '');
    t.diagnostic(
      JSON.stringify({
        stage,
        signal: child.signal,
        phase: last.kind,
        executionsAfterRestart: executions,
        sends: sends ? 1 : 0,
      }),
    );
  }
});

test('independent processes race one original start and one fake send', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  const script = String.raw`import {LocalDurableStore} from './tools/governance/local-durable-store.mjs';
    import * as w from './tools/governance/worker-ledger.mjs';
    import {limits,registration,observation,createReviewAuthorityFixture} from './tests/governance/fixtures/review-authority-fixture.mjs';
    import {promises as fs} from 'node:fs';
    const {root,identity,id,invocation}=JSON.parse(process.env.LIFECYCLE_RACE);
    const store=new LocalDurableStore(root); await store.bindReviewFunding(identity);
    const fixture=createReviewAuthorityFixture({registrations:[registration()],outcomes:[]});
    const ledger=w.createLocalReviewLedger({store,fundingScope:'lifecycle-fixture',approvedLimits:limits,observeUnderPrLock:async c=>observation(c),...fixture});
    const report=await w.withClaimedReview(id,ledger,async(claim,guard)=>{
      const binding=w.consumeReviewGuard(guard,invocation);
      if(binding.kind==='verified')await fs.appendFile(root+'/fake-sends','one\n');
      return binding;
    }); console.log(JSON.stringify(report));`;
  const child = () =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          LIFECYCLE_RACE: JSON.stringify({
            root: f.root,
            identity: f.identity,
            id: c.id,
            invocation: invocation(c),
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('error', reject);
      p.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
  const results = await Promise.all([child(), child()]);
  assert.ok(
    results.every((r) => r.code === 0),
    JSON.stringify(results),
  );
  assert.equal(results.filter((r) => JSON.parse(r.stdout).kind === 'verified').length, 1);
  assert.equal(await fs.readFile(join(f.root, 'fake-sends'), 'utf8'), 'one\n');
  assert.equal(
    (await f.store.readReviewFunding(scope, ld)).filter((e) => e.kind === 'consumed').length,
    1,
  );
});
test('guard rejects envelope overhead errors, altered canonical bytes, tools and copied claims', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) => {
    const good = invocation(claim);
    for (const patch of [
      { inputBytes: good.inputBytes - 1 },
      { body: good.body + ' ' },
      { fresh: false },
      { model: 'other' },
      { materialDigest: 'f'.repeat(64) },
      { extra: true },
      { candidate: { ...candidate, attempt: 'later' } },
    ])
      assert.equal(worker.consumeReviewGuard(guard, { ...good, ...patch }).kind, 'blocked');
    assert.equal(worker.consumeReviewGuard(claim, good).kind, 'blocked');
    assert.equal(worker.consumeReviewGuard(claim.start, good).kind, 'blocked');
    assert.equal(worker.consumeReviewGuard(guard, good).kind, 'verified');
  });
});

test('unknown_new_digest_remains_unknown and unknown_resolves_to_not_sent_without_refund', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value;
  let e = await f.provision(r.key, 'unknown', { executionEnded: false });
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  const original = e;
  e = await f.provision(r.key, 'unknown', { executionEnded: false });
  assert.notEqual(e.outcome.evidenceDigest, original.outcome.evidenceDigest);
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  e = await f.provision(r.key, 'not-sent');
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
  const events = await f.store.readReviewFunding(scope, ld);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['reserved', 'unknown', 'unknown', 'completed'],
  );
  assert.equal(events[1].outcome.evidenceDigest, original.outcome.evidenceDigest);
  assert.equal((await f.read()).value.reservations.length, 1);
  assert.equal((await f.reserve()).kind, 'blocked');
});
test('inconsistent_retained_resolution_is_not_verified', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) =>
    worker.consumeReviewGuard(guard, invocation(claim)),
  );
  let e = await f.provision(r.key, 'unknown', { executionEnded: false, sendObserved: true });
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  const before = await f.store.readReviewFunding(scope, ld);
  e = await f.provision(r.key, 'not-sent', { guardConsumed: false, sendObserved: false });
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).kind,
    'blocked',
  );
  assert.deepEqual(await f.store.readReviewFunding(scope, ld), before);
  assert.equal((await f.read()).value.reservations[0].status, 'unknown');
});
test('preexisting_unknown_contradiction_stays_quarantined', async (t) => {
  const f = await fixture(t),
    r = (await f.reserve()).value;
  let e = await f.provision(r.key, 'unknown', { executionEnded: false });
  await worker.settleReservation(r.key, e.evidenceBody, f.ledger);
  e = await f.provision(r.key, 'unknown', { executionEnded: true });
  const events = await f.store.readReviewFunding(scope, ld),
    last = events.at(-1);
  // Pre-existing independently retained fixture history; no lifecycle conflict flag.
  await f.store.withReviewFundingLock(scope, ld, () =>
    f.store.appendReviewFunding(scope, ld, {
      version: 1,
      sequence: events.length + 1,
      previousDigest: digest(JSON.stringify(last)),
      kind: 'contradiction',
      reservation: last.reservation,
      claim: last.claim,
      outcome: e.outcome,
    }),
  );
  assert.equal((await f.read()).value.reservations[0].status, 'unknown');
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).kind,
    'blocked',
  );
  assert.equal((await f.claim(r.key)).kind, 'blocked');
});

test('preclaim completion frees concurrency for a separately registered different attempt', async (t) => {
  const other = { ...candidate, pr: 8, attempt: 'ready-2' };
  const f = await fixture(t, {
    registrations: [
      registration(),
      registration(candidate, 'paid-2'),
      registration(other, 'paid-other'),
    ],
  });
  const a = (await f.reserve()).value;
  await f.reserve('paid-2');
  assert.equal((await f.reserve('paid-other', other)).kind, 'blocked');
  const e = await f.provision(a.key);
  await worker.settleReservation(a.key, e.evidenceBody, f.ledger);
  assert.equal((await f.reserve('paid-other', other)).kind, 'verified');
  assert.equal((await f.read()).value.reservations.length, 3);
  assert.equal(
    (await worker.settleReservation(a.key, e.evidenceBody, f.ledger)).value.status,
    'completed',
  );
});

test('thrown executor revokes guard before asynchronous accounting begins', async (t) => {
  let saved, attempt;
  const f = await fixture(t, {
      fault: async (point, event) => {
        if (point === 'review-before-append' && event?.kind === 'unknown')
          attempt = worker.consumeReviewGuard(saved, invocation(event.claim));
      },
    }),
    r = (await f.reserve()).value,
    c = (await f.claim(r.key)).value;
  assert.equal(
    (
      await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) => {
        saved = guard;
        throw Error('executor ended');
      })
    ).kind,
    'uncertain',
  );
  assert.equal(attempt.kind, 'blocked');
  assert.equal((await f.read()).value.reservations[0].status, 'unknown');
});

test('retained guard consumption refuses not-sent without append or freed concurrency', async (t) => {
  const other = { ...candidate, pr: 8, attempt: 'ready-2' };
  const f = await fixture(t, {
    registrations: [
      registration(),
      registration(candidate, 'paid-2'),
      registration(other, 'paid-other'),
    ],
  });
  const r = (await f.reserve()).value;
  const c = (await f.claim(r.key)).value;
  let executions = 0;
  const execution = await worker.withClaimedReview(c.id, f.ledger, async (claim, guard) => {
    executions++;
    return worker.consumeReviewGuard(guard, invocation(claim));
  });
  assert.equal(execution.kind, 'verified');
  assert.equal(executions, 1);
  assert.equal((await f.reserve('paid-2')).kind, 'verified');
  let e = await f.provision(r.key, 'unknown', {
    guardConsumed: true,
    sendObserved: false,
    executionEnded: false,
    completion: null,
  });
  assert.equal(
    (await worker.settleReservation(r.key, e.evidenceBody, f.ledger)).value.status,
    'unknown',
  );
  const before = await fs.readFile(join(f.path, 'events.jsonl'));
  e = await f.provision(r.key, 'not-sent', {
    guardConsumed: false,
    sendObserved: false,
    executionEnded: true,
    completion: null,
  });
  assert.equal(
    (await worker.reconcileReservation(r.key, e.evidenceBody, f.ledger)).kind,
    'blocked',
  );
  assert.deepEqual(await fs.readFile(join(f.path, 'events.jsonl')), before);
  const state = await f.read();
  assert.equal(state.value.reservations.find((row) => row.key === r.key).status, 'unknown');
  assert.equal(
    state.value.reservations.filter((row) => row.status !== 'completed').length,
    limits.maxConcurrentCalls,
  );
  assert.equal((await f.reserve('paid-other', other)).kind, 'blocked');
  assert.equal(
    (await worker.withClaimedReview(c.id, f.ledger, () => executions++)).kind,
    'blocked',
  );
  assert.equal(executions, 1);
  await assert.rejects(fs.stat(join(f.root, 'fake-sends')));
});
