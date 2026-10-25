import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../../tools/governance/controller-runtime.mjs';
import * as ledgerApi from '../../tools/governance/worker-ledger.mjs';
import { fixture, c, workerRun, publicKey, signed, timeline } from './composed-adapter-fixture.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import { admitCandidate } from '../../tools/governance/admission.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest, operationKey } from '../../tools/governance/journal.mjs';
import {
  canonical,
  observation,
  registration,
  createReviewAuthorityFixture,
  limits as baseLimits,
} from './fixtures/review-authority-fixture.mjs';
import { createLocalReviewRunnerPort } from './fixtures/review-runner-port.mjs';
import { readFile } from 'node:fs/promises';
const limits = { ...baseLimits, maxRunSeconds: 1 };
const childScript = new URL('./fixtures/review-child.mjs', import.meta.url).pathname;
async function setup(t, options = {}) {
  const fixtureLimits = options.oneConcurrent ? { ...limits, maxConcurrentCalls: 1 } : limits;
  const ports = new Map();
  const run = { ...workerRun, executionSha: c.head };
  let observationStarted = false,
    enteredObservation,
    settledObservation;
  const observationEntered = new Promise((resolve) => {
    enteredObservation = resolve;
  });
  const observationSettled = new Promise((resolve) => {
    settledObservation = resolve;
  });
  const f = await fixture(t, {
    workerExecution: run,
    events: structuredClone(timeline),
    beforeCleanup: async () => {
      if (observationStarted) await observationSettled;
    },
  });
  let port;
  const row = registration(c, 'paid-1', fixtureLimits);
  row.run = run;
  row.approvedDefinition = Object.fromEntries(
    ['repositoryId', 'workflowId', 'sha', 'ref'].map((k) => [k, run[k]]),
  );
  const fields = { ...row };
  delete fields.evidenceBody;
  row.evidenceBody = canonical(fields);
  const otherCandidate = { ...c, pr: 3, requestId: 'ready-request-3' };
  const otherRow = { ...row, candidate: otherCandidate, reservationRequestId: 'paid-2' };
  const otherFields = { ...otherRow };
  delete otherFields.evidenceBody;
  otherRow.evidenceBody = canonical(otherFields);
  const originAuthority = ledgerApi.createOfflineReviewOriginAuthority({
    registrations: options.otherPr ? [row, otherRow] : [row],
  });
  let releaseWrite;
  let enteredWrite;
  const writeEntered = new Promise((resolve) => {
    enteredWrite = resolve;
  });
  const writeRelease = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  if (options.hangWrite) {
    const append = f.store.appendReviewFunding.bind(f.store);
    f.store.appendReviewFunding = async (...args) => {
      const result = await append(...args);
      if (args[2]?.kind === options.hangWrite) {
        enteredWrite();
        await writeRelease;
      }
      return result;
    };
  }
  const scope = 'runtime-fixture';
  await f.store.initializeReviewFunding(
    scope,
    digest(JSON.stringify(['review-limits-v1', ...Object.values(fixtureLimits)])),
  );
  const locks = [];
  const ledger = ledgerApi.createLocalReviewLedger({
    store: f.store,
    fundingScope: scope,
    approvedLimits: fixtureLimits,
    originAuthority,
    observeUnderPrLock: async (candidate) => {
      locks.push('funding->pr');
      const delayed = locks.length === options.delayObservation;
      if (delayed) {
        observationStarted = true;
        enteredObservation();
      }
      try {
        if (delayed) await new Promise((resolve) => setTimeout(resolve, 1500));
        const selected = ports.get(candidate.pr);
        return await selected.withPrLock(`${candidate.repositoryId}:${candidate.pr}`, async () => ({
          ...observation(candidate),
          ...(await selected.observeReviewAdmission(candidate)),
          ...(options.absentFacts ? { fundingActivated: false } : {}),
        }));
      } finally {
        if (delayed) settledObservation();
      }
    },
    verifyOutcome: () => ({ kind: 'blocked', reason: 'No retained settlement evidence' }),
  });
  const resolver = ledgerApi.createConsumedReviewResolver({ ledger, originAuthority });
  let result;
  port = createGithubPort({
    ...f.portConfig,
    reviewContinuation: { resolveConsumed: resolver.resolve },
    workerResults: async () => {
      const body = JSON.stringify(result);
      return {
        body,
        envelope: signed({
          purpose: 'worker-result',
          run,
          candidate: c,
          worker: 'review',
          bodyDigest: digest(body),
        }),
      };
    },
  });
  ports.set(c.pr, port);
  assert.equal(
    (
      await admitCandidate(port, {
        type: 'verified_readiness',
        repositoryId: c.repositoryId,
        pr: c.pr,
        readinessId: c.attempt,
        candidate: c,
        proofDigest: f.proofDigest,
      })
    ).kind,
    'verified',
  );
  if (!options.noCi)
    await port.withPrLock('1:2', async () => {
      for (const phase of ['intent', 'result'])
        await port.append({
          version: 2,
          candidate: c,
          action: 'ci-success',
          key: operationKey(c, 'ci-success'),
          phase,
        });
    });
  let sends = 0,
    spawns = 0;
  const real = createLocalReviewRunnerPort();
  const runnerPort = {
    ...real,
    spawn(input) {
      spawns++;
      return real.spawn(input);
    },
  };
  let completion;
  const responseBody = '{"outcome":"success"}';
  const fakeKey = 'PRIVATE-IN-MEMORY-FAKE-KEY';
  const proxyPort = {
    async open() {
      assert.ok(fakeKey.startsWith('PRIVATE'));
      sends++;
      if (options.hangProxy) return new Promise(() => {});
      let sent = false;
      return verified({
        async read() {
          if (sent) return { chunk: new Uint8Array(), done: true };
          sent = true;
          return { chunk: new TextEncoder().encode(responseBody), done: false };
        },
        async finish() {
          completion = {
            bodyDigest: digest(responseBody),
            totalBytes: Buffer.byteLength(responseBody),
            complete: true,
            outputTokens: responseBody.length,
            providerOutcome: 'completed',
            evidenceId: 'fixture',
          };
          return completion;
        },
        async cancel() {},
      });
    },
    async verifyCompletion(value) {
      return canonical(value) === canonical(completion) ? verified(null) : { kind: 'blocked' };
    },
  };
  const material = canonical({ base: c.base, head: c.head, files: [] });
  let cancelled = 0;
  const materialTransport = {
    async open({ candidate: materialCandidate }) {
      if (options.preparationMs)
        await new Promise((resolve) => setTimeout(resolve, options.preparationMs));
      if (options.hang === 'open') return new Promise(() => {});
      let sent = false;
      return verified({
        async read() {
          if (options.hang === 'read') return new Promise(() => {});
          if (sent) return { chunk: new Uint8Array(), done: true };
          sent = true;
          return { chunk: new TextEncoder().encode(material), done: false };
        },
        async finish() {
          if (options.hang === 'finish') return new Promise(() => {});
          return {
            candidate: materialCandidate,
            bodyDigest: digest(material),
            totalBytes: Buffer.byteLength(material),
            complete: true,
            evidenceId: 'material-fixture',
          };
        },
        async cancel() {
          cancelled++;
        },
      });
    },
    async verifyCompletion() {
      if (options.hang === 'verification') return new Promise(() => {});
      return verified(null);
    },
  };
  const config = {
    mode: 'offline-test',
    productionBackend: null,
    port,
    ledger,
    originAuthority,
    materialTransport,
    runnerPort,
    proxyPort,
    localConfig: {
      executable: process.execPath,
      childScript,
      sourceDigest: digest(await readFile(childScript)),
      trustedInstructions: 'Review fixture',
      env: { LANG: 'C', TZ: 'UTC' },
    },
    limits: fixtureLimits,
    callbackContext: { publicKey },
  };
  if (options.otherPr) {
    const other = await fixture(t, { candidate: otherCandidate, workerExecution: run });
    const otherPort = createGithubPort({
      ...other.portConfig,
      reviewContinuation: { resolveConsumed: resolver.resolve },
    });
    ports.set(otherCandidate.pr, otherPort);
    assert.equal(
      (
        await admitCandidate(otherPort, {
          type: 'verified_readiness',
          repositoryId: otherCandidate.repositoryId,
          pr: otherCandidate.pr,
          readinessId: otherCandidate.attempt,
          candidate: otherCandidate,
          proofDigest: other.proofDigest,
        })
      ).kind,
      'verified',
    );
    await otherPort.withPrLock('1:3', async () => {
      for (const phase of ['intent', 'result'])
        await otherPort.append({
          version: 2,
          candidate: otherCandidate,
          action: 'ci-success',
          key: operationKey(otherCandidate, 'ci-success'),
          phase,
        });
    });
  }
  const engine = runtime.createReviewRuntime(config);
  const rows = () => ledger.withFunding(() => ledger.read());
  const callback = (claimId, patch = {}) => {
    const body = JSON.stringify({
      type: 'worker_completed',
      candidate: c,
      worker: 'review',
      outcome: 'success',
      claimId,
      ...patch,
    });
    return {
      body,
      archive: signed({
        purpose: 'worker-callback',
        run,
        candidate: c,
        worker: 'review',
        bodyDigest: digest(body),
      }),
    };
  };
  return {
    ...f,
    registration: row,
    otherCandidate,
    port,
    config,
    engine,
    ledger,
    originAuthority,
    resolver,
    rows,
    callback,
    locks,
    writeEntered,
    releaseWrite,
    observationEntered,
    observationSettled,
    stats: () => ({ sends, spawns, cancelled }),
    setResult: (claimId, patch = {}) => {
      result = {
        candidate: c,
        worker: 'review',
        outcome: 'success',
        claimId,
        model: 'gpt-6-astra',
        effort: 'high',
        fresh: true,
        findings: 0,
        ...patch,
      };
    },
  };
}
test('production_denies_before_any_io', async () => {
  let calls = 0;
  const engine = runtime.createReviewRuntime({
    mode: 'production',
    get port() {
      calls++;
      throw Error('I/O');
    },
  });
  for (const result of [
    await engine.run({}),
    await engine.complete({}),
    await engine.reconcile({}),
  ])
    assert.equal(result.kind, 'blocked');
  assert.equal(calls, 0);
});
test('unconsumed_origin_reserves_claims_consumes_sends_once and exact_callback_archive_accepted', async (t) => {
  const f = await setup(t);
  const result = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.providerOutcome, 'completed');
  assert.deepEqual(f.stats(), { sends: 1, spawns: 1, cancelled: 0 });
  const read = await f.rows();
  const reservation = read.value.reservations[0];
  const claim = await f.ledger.withFunding(() => f.ledger.readReservation(reservation.key));
  f.setResult(claim.value.claim.id);
  assert.equal((await f.engine.complete(f.callback(claim.value.claim.id))).kind, 'verified');
  assert.equal(
    (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'blocked',
  );
  assert.equal(f.stats().sends, 1);
  assert.equal((await f.rows()).value.reservations[0].status, 'reserved');
  assert.ok(f.locks.length >= 4);
});
for (const phase of ['open', 'read', 'finish', 'verification'])
  test(`hanging_material_${phase}_returns_without_reservation`, async (t) => {
    const f = await setup(t, { hang: phase });
    const start = performance.now();
    assert.equal(
      (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
      'uncertain',
    );
    assert.ok(performance.now() - start < 1800);
    assert.equal((await f.rows()).value.reservations.length, 0);
    assert.equal(f.stats().sends, 0);
    assert.equal(f.stats().cancelled, phase === 'open' ? 0 : 1);
  });
test('actual_composition_requires_current_ci and explicit fixture trust facts', async (t) => {
  for (const options of [{ noCi: true }, { absentFacts: true }]) {
    const f = await setup(t, options);
    assert.equal(
      (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
      'blocked',
    );
    assert.equal((await f.rows()).value.reservations.length, 0);
    assert.equal(f.stats().sends, 0);
  }
});
test('review_completion_requires_consumed_original_claim and rejects key/run injection', async (t) => {
  const f = await setup(t);
  assert.equal((await f.engine.complete(f.callback('a'.repeat(64)))).kind, 'blocked');
  for (const patch of [
    { publicKey },
    { expectedRun: workerRun },
    { callbackContext: { publicKey } },
  ])
    assert.equal(
      (await f.engine.complete({ ...f.callback('a'.repeat(64)), ...patch })).kind,
      'blocked',
    );
});
export { setup };

test('missing_extra_wrong_callback_and_result_claimId_denied; rerun archives denied', async (t) => {
  const f = await setup(t);
  await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  const row = (await f.rows()).value.reservations[0];
  const claim = (await f.ledger.withFunding(() => f.ledger.readReservation(row.key))).value.claim;
  for (const patch of [
    { claimId: undefined },
    { claimId: 'wrong' },
    { extra: true },
    { type: 'worker_start' },
  ])
    assert.equal((await f.engine.complete(f.callback(claim.id, patch))).kind, 'blocked');
  for (const patch of [{ claimId: undefined }, { claimId: 'other' }, { extra: true }]) {
    f.setResult(claim.id, patch);
    assert.equal((await f.engine.complete(f.callback(claim.id))).kind, 'blocked');
  }
  f.setResult(claim.id);
  const data = f.callback(claim.id);
  const rerun = signed({
    ...JSON.parse(data.archive.body),
    run: { ...workerRun, executionSha: c.head, attempt: 2 },
  });
  assert.equal((await f.engine.complete({ ...data, archive: rerun })).kind, 'blocked');
  assert.equal((await f.engine.complete(data)).kind, 'blocked'); // Earlier invalid result retained a safety obligation.
});
test('base_drift_blocks_start_and_posting; stale completion does not draft a newer attempt', async (t) => {
  const f = await setup(t);
  f.pr.base.sha = 'd'.repeat(40);
  assert.equal(
    (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'blocked',
  );
  assert.equal(f.stats().sends, 0);
  assert.equal((await f.rows()).value.reservations.length, 0);
  const fresh = await setup(t);
  Object.assign(f, fresh);
  assert.equal(
    (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'verified',
  );
  const row = (await f.rows()).value.reservations[0];
  const claim = (await f.ledger.withFunding(() => f.ledger.readReservation(row.key))).value.claim;
  f.setResult(claim.id, { outcome: 'failure', findings: 1 });
  f.pr.base.sha = 'd'.repeat(40);
  const before = f.calls.filter((r) => r.path === '/graphql').length;
  assert.equal(
    (await f.engine.complete(f.callback(claim.id, { outcome: 'failure' }))).kind,
    'blocked',
  );
  assert.equal(f.pr.draft, false);
  assert.equal(f.calls.filter((r) => r.path === '/graphql').length, before);
});
test('caller_cannot_replace_origin_mapping and config_limits_mismatch_denies_before_send', async (t) => {
  const f = await setup(t);
  for (const extra of [
    { run: workerRun },
    { originReceipt: {} },
    { workers: { review: workerRun } },
    { publicKey },
  ])
    assert.equal(
      (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1', ...extra })).kind,
      'uncertain',
    );
  assert.equal(
    (await f.engine.run({ candidate: c, reservationRequestId: 'invented' })).kind,
    'blocked',
  );
  const other = ledgerApi.createOfflineReviewOriginAuthority({ registrations: [] });
  const changed = runtime.createReviewRuntime({ ...f.config, originAuthority: other });
  assert.equal(
    (await changed.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'blocked',
  );
  const mismatch = runtime.createReviewRuntime({
    ...f.config,
    limits: { ...limits, callsPerAttempt: 3 },
  });
  assert.equal(
    (await mismatch.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'blocked',
  );
  assert.equal(f.stats().sends, 0);
});
test('constructor and run reject accessor/proxy/coercion input without invoking it', async (t) => {
  const f = await setup(t);
  let invoked = 0;
  const candidate = { ...c };
  Object.defineProperty(candidate, 'head', {
    enumerable: true,
    get() {
      invoked++;
      return c.head;
    },
  });
  assert.notEqual(
    (await f.engine.run({ candidate, reservationRequestId: 'paid-1' })).kind,
    'verified',
  );
  const input = new Proxy(
    { candidate: c, reservationRequestId: 'paid-1' },
    {
      ownKeys() {
        invoked++;
        throw Error('trap');
      },
    },
  );
  assert.notEqual((await f.engine.run(input)).kind, 'verified');
  assert.notEqual(
    (
      await f.engine.run({
        candidate: c,
        reservationRequestId: {
          toString() {
            invoked++;
            return 'paid-1';
          },
        },
      })
    ).kind,
    'verified',
  );
  const config = { ...f.config, limits: { ...limits, maxRunSeconds: 2147484 } };
  assert.equal(
    (
      await runtime
        .createReviewRuntime(config)
        .run({ candidate: c, reservationRequestId: 'paid-1' })
    ).kind,
    'blocked',
  );
  assert.equal(invoked, 0);
  assert.equal(f.stats().sends, 0);
});
test('consumed resolver requires live original funding scope and immutable run', async (t) => {
  const f = await setup(t);
  await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  const row = (await f.rows()).value.reservations[0];
  const claim = (await f.ledger.withFunding(() => f.ledger.readReservation(row.key))).value.claim;
  assert.equal((await f.resolver.resolve({ claimId: claim.id, candidate: c })).kind, 'blocked');
  let late;
  await f.ledger.withFunding(async () => {
    const value = await f.resolver.resolve({ claimId: claim.id, candidate: c });
    assert.equal(value.kind, 'verified');
    assert.ok(Object.isFrozen(value.value.run));
    late = () => f.resolver.resolve({ claimId: claim.id, candidate: c });
  });
  assert.equal((await late()).kind, 'blocked');
});
test('workflow_gates_remain_false', async () => {
  const text = await readFile(
    new URL('../../.github/workflows/candidate-review.yml', import.meta.url),
    'utf8',
  );
  assert.equal((text.match(/if: \$\{\{ false \}\}/g) || []).length, 2);
  assert.ok(text.includes('exit 1'));
  assert.ok(!text.includes('OPENAI_API_KEY'));
});

test('preparation_time_reduces_supervisor_budget', async (t) => {
  const f = await setup(t, { preparationMs: 500, hangProxy: true });
  const start = performance.now();
  const result = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.providerOutcome, 'unknown');
  assert.equal(f.stats().sends, 1);
  assert.ok(performance.now() - start < 1450);
});
for (const kind of ['reserved', 'consumed'])
  test(`deadline_during_${kind}_write_returns_occupied_without_late_send`, async (t) => {
    const f = await setup(t, { hangWrite: kind });
    const start = performance.now();
    const pending = f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
    await f.writeEntered;
    const result = await pending;
    assert.equal(result.kind, 'uncertain');
    assert.ok(performance.now() - start < 1500);
    f.releaseWrite();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await f.rows();
    if (kind === 'reserved') assert.equal(rows.kind, 'uncertain');
    else {
      assert.equal(rows.value.reservations.length, 1);
      assert.notEqual(rows.value.reservations[0].status, 'completed');
    }
    const retained = await f.store.readReviewFunding(
      'runtime-fixture',
      digest(JSON.stringify(['review-limits-v1', ...Object.values(limits)])),
    );
    assert.equal(retained[0].kind, 'reserved');
    assert.notEqual(
      (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
      'verified',
    );
    assert.equal(f.stats().sends, 0);
    assert.equal(f.stats().spawns, 0);
  });

for (const [observationNumber, expectedKinds] of [
  [4, ['reserved']],
  [5, ['reserved', 'claimed']],
])
  test(`deadline_before_observation_${observationNumber}_resumes_starts_no_late_write`, async (t) => {
    const f = await setup(t, { delayObservation: observationNumber });
    const start = performance.now();
    const result = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
    assert.equal(result.kind, 'uncertain');
    assert.ok(performance.now() - start < 1450);
    await f.observationEntered;
    await f.observationSettled;
    const retained = await f.store.readReviewFunding(
      'runtime-fixture',
      digest(JSON.stringify(['review-limits-v1', ...Object.values(limits)])),
    );
    assert.deepEqual(
      retained.map((event) => event.kind),
      expectedKinds,
    );
    assert.equal(retained.at(-1).claim?.start ?? null, null);
    assert.equal(f.stats().spawns, 0);
    assert.equal(f.stats().sends, 0);
  });

test('unknown_capacity_blocks_other_pr sharing the actual funding scope', async (t) => {
  const f = await setup(t, { oneConcurrent: true, otherPr: true, hangProxy: true });
  const first = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  assert.equal(first.value.providerOutcome, 'unknown');
  const second = await f.engine.run({
    candidate: f.otherCandidate,
    reservationRequestId: 'paid-2',
  });
  assert.equal(second.kind, 'blocked');
  assert.equal(f.stats().sends, 1);
  assert.equal((await f.rows()).value.reservations.length, 1);
});

test('stale_settlement_does_not_draft_new_attempt or release completion accounting implicitly', async (t) => {
  const f = await setup(t);
  const report = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  assert.equal(report.value.providerOutcome, 'completed');
  assert.equal(report.value.executionEnded, true);
  const events = await f.store.readReviewFunding(
    'runtime-fixture',
    digest(JSON.stringify(['review-limits-v1', ...Object.values(limits)])),
  );
  const last = events.at(-1),
    claim = last.claim;
  const origin = {
    run: f.registration.run,
    approvedDefinition: f.registration.approvedDefinition,
    evidenceDigest: digest(f.registration.evidenceBody),
  };
  const evidenceBody = canonical({
    originEvidenceDigest: origin.evidenceDigest,
    phase: 'consumed',
    guardConsumed: true,
    sendObserved: true,
    executionEnded: true,
    completion: {
      body: report.value.resultBody,
      outputTokens: report.value.outputTokens,
      inputBytes: 1,
    },
  });
  const outcome = {
    reservationKey: last.reservation.key,
    claimId: claim.id,
    candidate: c,
    run: claim.run,
    invocationDigest: claim.invocationDigest,
    executionEnded: true,
    providerOutcome: 'completed',
    evidenceDigest: digest(evidenceBody),
  };
  const binding = { reservation: last.reservation, claim, outcome: last.outcome, events, origin };
  const authority = createReviewAuthorityFixture({
    registrations: [f.registration],
    outcomes: [{ evidenceBody, outcome, binding }],
  });
  const ledger = ledgerApi.createLocalReviewLedger({
    store: f.store,
    fundingScope: 'runtime-fixture',
    approvedLimits: limits,
    observeUnderPrLock: () => {
      throw Error('Accounting cannot observe admission');
    },
    ...authority,
  });
  const engine = runtime.createReviewRuntime({
    ...f.config,
    ledger,
    originAuthority: authority.originAuthority,
  });
  // Native state has moved on to a newer Ready attempt. Accounting never calls
  // the PR adapter, so it cannot downgrade that attempt or confer admission.
  f.pr.head.sha = 'd'.repeat(40);
  f.events.push(
    { id: 11, actor: { id: 5 }, event: 'converted_to_draft', created_at: '2026-01-01T00:01:00Z' },
    { id: 12, actor: { id: 5 }, event: 'ready_for_review', created_at: '2026-01-01T00:02:00Z' },
  );
  const before = f.calls.length;
  assert.equal(
    (await engine.reconcile({ reservationKey: last.reservation.key, evidence: evidenceBody })).value
      .status,
    'completed',
  );
  assert.equal(f.calls.length, before);
  assert.equal(f.pr.draft, false);
  assert.equal(f.stats().sends, 1);
});

test('separate_posting_process_has_no_key after composed result verification', async (t) => {
  const f = await setup(t);
  await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  const row = (await f.rows()).value.reservations[0];
  const claim = (await f.ledger.withFunding(() => f.ledger.readReservation(row.key))).value.claim;
  f.setResult(claim.id);
  assert.equal((await f.engine.complete(f.callback(claim.id))).kind, 'verified');
  const { mkdtemp, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'runtime-posting-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [new URL('./fixtures/review-posting-child.mjs', import.meta.url).pathname],
    { cwd: home, env: { HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      assert.ok(output.length + chunk.length < 10000);
      output += chunk;
    });
  const validatedResult = JSON.stringify({
    candidate: c,
    worker: 'review',
    outcome: 'success',
    claimId: claim.id,
    model: 'gpt-6-astra',
    effort: 'high',
    fresh: true,
    findings: 0,
  });
  child.stdin.end(validatedResult);
  await new Promise((resolve, reject) => {
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(Error('Posting fixture failed')),
    );
    child.once('error', reject);
  });
  const audit = JSON.parse(output);
  assert.equal(audit.resultDigest, digest(validatedResult));
  assert.ok(audit.emptyHome && audit.privateCwd);
  assert.deepEqual(
    Object.keys(audit.env).sort(),
    ['HOME', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])].sort(),
  );
  for (const forbidden of [
    'guard',
    'materialDigest',
    'trustedInstructions',
    'PRIVATE-IN-MEMORY-FAKE-KEY',
  ])
    assert.ok(!output.includes(forbidden));
});

test('runtime deadline wins over the reviewed extractor standalone ceiling', async (t) => {
  const f = await setup(t, { preparationMs: 600, hang: 'finish' });
  const start = performance.now();
  const result = await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' });
  assert.equal(result.kind, 'uncertain');
  assert.ok(performance.now() - start < 1350);
  assert.equal((await f.rows()).value.reservations.length, 0);
  assert.equal(f.stats().sends, 0);
  assert.equal(f.stats().cancelled, 1);
});

test('funding_pr_order_across_reserve_claim_start_callback_settlement', async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.engine.run({ candidate: c, reservationRequestId: 'paid-1' })).kind,
    'verified',
  );
  assert.ok(f.locks.length >= 4, 'reservation claim and start observe under funding before PR');
  const row = (await f.rows()).value.reservations[0];
  const claim = (await f.ledger.withFunding(() => f.ledger.readReservation(row.key))).value.claim;
  f.setResult(claim.id);
  let callbackPrLocks = 0;
  const port = {
    ...f.port,
    async withPrLock(key, fn) {
      assert.equal(
        (await f.ledger.read()).kind,
        'verified',
        'public callback enters PR while funding is held',
      );
      callbackPrLocks++;
      return f.port.withPrLock(key, fn);
    },
  };
  const engine = runtime.createReviewRuntime({ ...f.config, port });
  assert.equal((await engine.complete(f.callback(claim.id))).kind, 'verified');
  assert.equal(callbackPrLocks, 1);
  const before = f.calls.length;
  assert.equal(
    (await engine.reconcile({ reservationKey: row.key, evidence: 'unregistered' })).kind,
    'blocked',
  );
  assert.equal(f.calls.length, before, 'settlement has no PR or HTTP path');
});
