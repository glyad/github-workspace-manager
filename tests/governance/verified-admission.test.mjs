import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
import { encodeWorkerResult } from '../../tools/governance/worker-transport.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { admitCandidate } from '../../tools/governance/admission.mjs';
import * as runtime from '../../tools/governance/controller-runtime.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const request = Object.freeze({
  protocolVersion: 2,
  requestId: 'request-1',
  repositoryId: '1',
  pr: 2,
  prNodeId: 'PR_2',
  baseRef: 'refs/heads/develop',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  initiatingActorId: '9',
  originalRunId: '12',
  workflowId: '4',
  definitionSha: 'c'.repeat(40),
});
const run = {
  id: '12',
  attempt: 1,
  repositoryId: '1',
  workflowId: '4',
  actorId: '9',
  sha: request.definitionSha,
  executionSha: request.definitionSha,
  ref: 'refs/heads/main',
  event: 'workflow_dispatch',
};
const controller = { ...run, actorId: '5', event: 'workflow_run' };
const signed = (value) => {
  const body = JSON.stringify({
    version: value.candidate?.protocolVersion === 2 ? 2 : 1,
    ...value,
  });
  return { body, signature: sign(null, Buffer.from(body), privateKey).toString('base64') };
};
async function auth(r, attempt = 1) {
  const body = JSON.stringify(r);
  return authenticateReadinessRequest(body, {
    runId: '12',
    runAttempt: attempt,
    authorizedActorIds: ['9'],
    approvedDefinition: Object.freeze({
      repositoryId: '1',
      workflowId: '4',
      sha: request.definitionSha,
      ref: run.ref,
    }),
    lookupRun: async (_id, a) => verified({ ...run, attempt: a }),
    resolvePr: async () => verified({ repositoryId: '1', pr: 2, prNodeId: 'PR_2' }),
    verifyRequestEvidence: async () =>
      verified({
        bodyDigest: digest(body),
        originalRunId: '12',
        runAttempt: attempt,
        definitionSha: request.definitionSha,
        triggeringActorId: '9',
      }),
  });
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'handshake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root);
  store.authorizeReadinessRequest = options.authorize ?? auth;
  let pr = {
    number: 2,
    node_id: 'PR_2',
    state: 'open',
    draft: true,
    base: { sha: request.base, ref: 'develop', repo: { id: 1 } },
    head: { sha: request.head, repo: { id: 1 } },
  };
  let events = options.initialEvents ?? [
    { id: 1, event: 'converted_to_draft', actor: { id: 9 }, created_at: '2026-01-01T00:00:00Z' },
  ];
  const calls = [],
    archives = [],
    proofs = new Map(),
    phases = new Map(),
    admittedWindows = new Map();
  let reads = 0,
    locks = 0;
  const lock = store.withPrLock.bind(store);
  store.withPrLock = async (...args) => {
    locks++;
    await options.beforeLock?.({ pr, events });
    return lock(...args);
  };
  const comments = [];
  const archive = async (purpose, input) => {
    if (options.archive) {
      const override = options.archive(purpose, input);
      if (override !== undefined) return override;
    }
    if (purpose === 'readiness-admission') {
      const entry = [...proofs].find(([body]) => digest(body) === input.proofDigest);
      return entry
        ? { body: entry[0], envelope: entry[1], after: admittedWindows.get(input.proofDigest) }
        : null;
    }
    if (purpose === 'journal-index')
      return signed({
        purpose,
        run: controller,
        ledgerId: '7',
        entriesDigest: digest(JSON.stringify(comments.map((e) => [e.id, digest(e.body)]))),
      });
    if (purpose === 'journal')
      return signed({
        version: 2,
        purpose,
        run: controller,
        bodyDigest: digest(input.body),
        candidate: JSON.parse(input.body).candidate,
      });
    archives.push({ purpose, input });
    if (options.archive) {
      const override = options.archive(purpose, input);
      if (override !== undefined) return override;
    }
    if (purpose === 'readiness-phase') {
      const envelope = signed({ purpose, run: controller, ...input.bindings });
      phases.set(input.body, envelope);
      if (input.evidence?.proof)
        admittedWindows.set(
          digest(JSON.stringify(input.evidence.proof)),
          structuredClone(input.evidence.after),
        );
      return envelope;
    }
    if (purpose === 'readiness-phase-read')
      return { body: input.body, envelope: phases.get(input.body) };
    if (purpose === 'readiness-proof-write') {
      proofs.set(
        input.body,
        signed({ purpose: 'readiness-proof', run: controller, bodyDigest: digest(input.body) }),
      );
      return proofs.get(input.body);
    }
    if (purpose === 'readiness-proof-read')
      return options.readbackFailure
        ? null
        : {
            body: options.changedProofBytes ? input.body + ' ' : input.body,
            envelope: proofs.get(input.body),
          };
    return signed({ purpose, run: controller, ...input.bindings });
  };
  const http = async (call) => {
    calls.push(call);
    let body,
      headers = {};
    if (call.path.endsWith('/issues/7/comments') && call.method === 'POST') {
      const body = JSON.parse(call.body).body;
      const row = {
        id: comments.length + 10,
        body,
        user: { id: 5 },
        created_at: 'x',
        updated_at: 'x',
      };
      comments.push(row);
      return { status: 201, headers: {}, body: JSON.stringify(row) };
    }
    if (call.path.endsWith('/issues/7')) body = { id: 7, user: { id: 5 } };
    else if (call.path.includes('/issues/7/comments?')) body = comments;
    else if (call.path.endsWith('/pulls/2')) {
      reads++;
      options.onRead?.({ reads, pr, events });
      body = structuredClone(pr);
    } else if (call.path.includes('/timeline?')) {
      body = structuredClone(events);
      if (options.unstable) body.push({ id: 100 + calls.length, event: 'closed' });
      if (options.badPages) headers.link = '<https://evil.invalid>; rel="next"';
      if (options.paginated) {
        const page = Number(new URL('https://api.github.com' + call.path).searchParams.get('page'));
        body = body.slice((page - 1) * 100, page * 100);
        if (events.length > page * 100)
          headers.link = `<https://api.github.com/repos/owner/repo/issues/2/timeline?per_page=100&page=${page + 1}>; rel="next"`;
      }
    } else if (call.path.includes('/actions/runs/') && options.nativeRun?.(call.path)) {
      const native = options.nativeRun(call.path);
      body = {
        id: Number(native.id),
        run_attempt: native.attempt,
        repository: { id: Number(native.repositoryId) },
        workflow_id: Number(native.workflowId),
        actor: { id: Number(native.actorId) },
        event: native.event,
        head_sha: native.executionSha,
      };
    } else if (call.path.includes('/actions/runs/') && call.path.includes('/runs/66/'))
      body = {
        id: 66,
        run_attempt: options.workerRun.attempt,
        repository: { id: 1 },
        workflow_id: Number(options.workerRun.workflowId),
        actor: { id: Number(options.workerRun.actorId) },
        event: options.workerRun.event,
        head_sha: options.workerRun.executionSha,
      };
    else if (call.path.includes('/actions/runs/'))
      body = {
        id: 12,
        run_attempt: 1,
        repository: { id: 1 },
        workflow_id: 4,
        actor: { id: 5 },
        event: controller.event,
        head_sha: controller.executionSha,
      };
    else if (
      call.path === '/graphql' &&
      JSON.parse(call.body).query.includes('convertPullRequestToDraft')
    ) {
      pr.draft = true;
      events.push({
        id: 3,
        event: 'converted_to_draft',
        actor: { id: 5 },
        created_at: '2026-01-01T00:00:00Z',
      });
      body = {
        data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_2', isDraft: true } } },
      };
    } else if (call.path === '/graphql') {
      const op = (await store.readOperation(request.requestId)).value;
      assert.equal(op.state, 'mutation-pending');
      assert.match(op.beforeDigest, /^[a-f0-9]{64}$/);
      const payload = JSON.parse(call.body);
      assert.deepEqual(payload.variables, { id: 'PR_2', clientMutationId: 'request-1' });
      pr.draft = false;
      events.push({
        id: Number(events.at(-1)?.id ?? 0) + 1,
        event: 'ready_for_review',
        actor: { id: 5 },
        created_at: '2026-01-01T00:00:00Z',
      });
      options.afterMutation?.({ pr, events });
      if (options.lost) throw Error('response lost');
      body = {
        data: {
          markPullRequestReadyForReview: {
            clientMutationId: 'request-1',
            pullRequest: { id: 'PR_2', isDraft: false },
          },
        },
      };
    } else throw Error('Unexpected request ' + call.path);
    return { status: 200, headers, body: JSON.stringify(body) };
  };
  const port = createGithubPort({
    http,
    archive,
    publicKey,
    store,
    repository: 'owner/repo',
    repositoryId: '1',
    ledgerNumber: 7,
    ledgerId: '7',
    controllerRun: controller,
    ciContinuation: options.ciContinuation,
    workers: options.workers,
    workerResults: options.workerResults,
  });
  return {
    port,
    pr,
    events,
    comments,
    archive,
    store,
    calls,
    archives,
    root,
    get locks() {
      return locks;
    },
    get sends() {
      return calls.filter((c) => c.path === '/graphql').length;
    },
  };
}

const start = (c) => ({
  type: 'worker_start',
  repositoryId: c.repositoryId,
  pr: c.pr,
  readinessId: c.attempt,
  candidate: c,
  worker: 'ci',
});
const context = (f) => ({
  port: f.port,
  mode: 'offline-test',
  requestContext: {
    runId: '12',
    runAttempt: 1,
    authorizedActorIds: ['9'],
    approvedDefinition: Object.freeze({
      repositoryId: '1',
      workflowId: '4',
      sha: request.definitionSha,
      ref: run.ref,
    }),
    lookupRun: async () => verified(run),
    resolvePr: async () => verified({ repositoryId: '1', pr: 2, prNodeId: 'PR_2' }),
    verifyRequestEvidence: async (body) =>
      verified({
        bodyDigest: digest(body),
        originalRunId: '12',
        runAttempt: 1,
        definitionSha: request.definitionSha,
        triggeringActorId: '9',
      }),
  },
});
async function admit(f) {
  return runtime.handleTrustedReadinessRequest(
    { body: JSON.stringify(request), archive: {} },
    context(f),
  );
}
test('native_ready_alone_never_admits', async (t) => {
  const f = await fixture(t);
  f.pr.draft = false;
  f.events.push({
    id: 2,
    event: 'ready_for_review',
    actor: { id: 5 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.notEqual(
    (
      await admitCandidate(f.port, {
        type: 'ready_for_review',
        repositoryId: '1',
        pr: 2,
        readinessId: '2',
        verified: true,
      })
    ).kind,
    'verified',
  );
  assert.equal(f.comments.length, 0);
});
test('accepted_proof_enters_shared_gate', async (t) => {
  const f = await fixture(t);
  const result = await admit(f);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.protocolVersion, 2);
  assert.equal(f.locks, 1);
  assert.equal(f.sends, 1);
  assert.equal(f.comments.length, 2);
  assert.equal((await admitCandidate(f.port, start(result.value))).kind, 'blocked');
});
test('changed_pair_or_witness_denies_start', async (t) => {
  for (const field of ['head', 'base', 'witness', 'ref']) {
    const options = ciOptions(),
      f = await fixture(t, options);
    const result = await admit(f);
    assert.equal(result.kind, 'verified');
    if (field === 'witness')
      f.events.push({
        id: 3,
        event: 'ready_for_review',
        actor: { id: 5 },
        created_at: '2026-01-01T00:00:00Z',
      });
    else if (field === 'ref') f.pr.base.ref = 'other';
    else f.pr[field].sha = 'd'.repeat(40);
    assert.notEqual((await admitCandidate(f.port, ciStart())).kind, 'verified');
    assert.equal(options.consumes, 0);
    assert.equal(f.sends, 1);
  }
});
test('stale_completion_never_drafts_new_attempt', async (t) => {
  const options = ciOptions();
  options.workerResults = async (run) => {
    const result = { candidate, worker: 'ci', outcome: 'failure', claimId: 'claim-1' },
      body = encodeWorkerResult(result);
    return {
      body,
      envelope: signed({
        purpose: 'worker-result',
        run,
        candidate,
        worker: 'ci',
        bodyDigest: digest(body),
      }),
    };
  };
  const f = await fixture(t, options);
  const result = await admit(f);
  assert.equal(result.kind, 'verified');
  assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
  f.events.push({
    id: 3,
    event: 'ready_for_review',
    actor: { id: 5 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal((await callback(f, options, 'worker_completed', 'failure')).kind, 'blocked');
  assert.equal(f.pr.draft, false);
  assert.equal(f.sends, 1);
});
test('closure_reopen_invalidates', async (t) => {
  const options = ciOptions(),
    f = await fixture(t, options);
  const result = await admit(f);
  assert.equal(result.kind, 'verified');
  f.events.push(
    { id: 3, event: 'closed', actor: { id: 9 }, created_at: '2026-01-01T00:00:00Z' },
    { id: 4, event: 'reopened', actor: { id: 9 }, created_at: '2026-01-01T00:00:00Z' },
  );
  assert.notEqual((await admitCandidate(f.port, ciStart())).kind, 'verified');
  assert.equal(options.consumes, 0);
  assert.equal(f.sends, 1);
});
test('legacy_event_time_proof_not_v2', async () => {
  const { decideReadiness } = await import('../../tools/governance/controller.mjs');
  const c = { repositoryId: '1', pr: 2, base: request.base, head: request.head, attempt: '2' };
  const o = {
    ...c,
    nativeVerified: true,
    sameRepository: true,
    state: 'open',
    draft: false,
    readiness: { id: '2', kind: 'ready_for_review', candidate: c, candidateVerified: true },
    lifecycle: { verified: true, attempt: '2', closedSinceReady: false },
  };
  assert.equal(
    decideReadiness(
      o,
      { type: 'ready_for_review', repositoryId: '1', pr: 2, readinessId: '2' },
      verified([]),
    ).action,
    'none',
  );
});

const candidate = {
  repositoryId: '1',
  pr: 2,
  base: request.base,
  head: request.head,
  attempt: '2',
  baseRef: request.baseRef,
  requestId: request.requestId,
  protocolVersion: 2,
};
const workerRun = { ...controller, id: '66', workflowId: '8', event: 'workflow_dispatch' };
function ciOptions() {
  const claim = {
    id: 'claim-1',
    candidate,
    worker: 'ci',
    requestId: candidate.requestId,
    definitionSha: request.definitionSha,
    status: 'observed',
    run: workerRun,
    start: null,
  };
  let consumes = 0;
  return {
    claim,
    workerRun,
    get consumes() {
      return consumes;
    },
    ciContinuation: {
      readCiContinuation: async (id) =>
        id === claim.id ? verified(structuredClone(claim)) : { kind: 'blocked' },
      consumeCiStart: async (id, run) => {
        assert.equal(id, claim.id);
        assert.deepEqual(run, claim.run);
        consumes++;
        if (claim.start) return verified({ newlyConsumed: false, claim: structuredClone(claim) });
        claim.start = {
          claimId: claim.id,
          runId: run.id,
          runAttempt: run.attempt,
          candidate: claim.candidate,
          definitionSha: claim.definitionSha,
          state: 'consumed',
        };
        return verified({ newlyConsumed: true, claim: structuredClone(claim) });
      },
    },
    workerResults: async (run) => {
      const result = { candidate, worker: 'ci', outcome: 'success', claimId: claim.id };
      const body = encodeWorkerResult(result);
      return {
        body,
        envelope: signed({
          purpose: 'worker-result',
          run,
          candidate,
          worker: 'ci',
          bodyDigest: digest(body),
        }),
      };
    },
  };
}
const ciStart = () => ({ ...start(candidate), claimId: 'claim-1', run: workerRun });
async function callback(f, options, type = 'worker_completed', outcome = 'success', patch = {}) {
  const raw = { type, candidate, worker: 'ci', outcome, claimId: 'claim-1', ...patch },
    body = JSON.stringify(raw);
  return runtime.handleTrustedWorkerCallback(
    {
      body,
      archive: signed({
        purpose: 'worker-callback',
        run: options.workerRun,
        candidate: raw.candidate,
        worker: 'ci',
        bodyDigest: digest(body),
      }),
    },
    { port: f.port, expectedRun: options.workerRun, publicKey, mode: 'offline-test' },
  );
}
test('ci_start_is_single_use_and_completion_unlocks_review_only_after_success', async (t) => {
  const options = ciOptions();
  options.workers = { review: workerRun };
  const f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  assert.equal(
    (await admitCandidate(f.port, { ...start(candidate), worker: 'review', run: workerRun })).kind,
    'blocked',
  );
  assert.equal((await callback(f, options)).kind, 'blocked');
  assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
  assert.equal(options.consumes, 1);
  assert.equal(options.claim.start.state, 'consumed');
  assert.equal((await callback(f, options, 'worker_start')).kind, 'blocked');
  assert.equal(options.consumes, 1);
  assert.equal((await callback(f, options)).kind, 'verified');
  const verify = f.port.verifyWorkerCallback;
  f.port.verifyWorkerCallback = undefined;
  assert.equal(
    (await admitCandidate(f.port, { ...start(candidate), worker: 'review', run: workerRun })).kind,
    'blocked',
  );
  f.port.verifyWorkerCallback = verify;
  assert.equal(
    (await admitCandidate(f.port, { ...start(candidate), worker: 'review', run: workerRun })).kind,
    'verified',
  );
});
test('caller_ci_mapping_never_authorizes_v2_callbacks_without_continuation', async (t) => {
  const options = ciOptions();
  delete options.ciContinuation;
  options.workers = { ci: workerRun };
  const f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  assert.equal((await callback(f, options, 'worker_start')).kind, 'blocked');
  assert.equal((await callback(f, options)).kind, 'blocked');
});
test('claim_and_original_execution_substitutions_deny_start_and_completion', async (t) => {
  for (const patch of [
    { id: 'other' },
    { requestId: 'other' },
    { candidate: { ...candidate, requestId: 'other' } },
    { candidate: { ...candidate, baseRef: 'refs/heads/other' } },
    { candidate: { ...candidate, head: 'f'.repeat(40) } },
    { definitionSha: 'f'.repeat(40) },
    { status: 'pending' },
    { run: { ...workerRun, attempt: 2 } },
    { run: { ...workerRun, actorId: '7' } },
    { run: { ...workerRun, executionSha: 'f'.repeat(40) } },
    { run: { ...workerRun, sha: 'f'.repeat(40) } },
    { run: { ...workerRun, ref: 'refs/heads/other' } },
  ]) {
    const options = ciOptions(),
      f = await fixture(t, options);
    assert.equal((await admit(f)).kind, 'verified');
    Object.assign(options.claim, patch);
    assert.notEqual((await admitCandidate(f.port, ciStart())).kind, 'verified');
    assert.equal(options.consumes, 0);
    assert.equal((await callback(f, options)).kind, 'blocked');
  }
});
test('existing_or_uncertain_consumption_never_grants_fresh_execution', async (t) => {
  for (const result of [
    { kind: 'uncertain' },
    verified({ newlyConsumed: false }),
    verified({ newlyConsumed: true, claim: {} }),
  ]) {
    const options = ciOptions();
    options.ciContinuation.consumeCiStart = async () => result;
    const f = await fixture(t, options);
    assert.equal((await admit(f)).kind, 'verified');
    assert.notEqual((await admitCandidate(f.port, ciStart())).kind, 'verified');
  }
});
test('changed_candidate_after_consumption_retains_slot_without_execution', async (t) => {
  const options = ciOptions(),
    consume = options.ciContinuation.consumeCiStart;
  let f;
  options.ciContinuation.consumeCiStart = async (...args) => {
    const r = await consume(...args);
    f.pr.head.sha = 'd'.repeat(40);
    return r;
  };
  f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  assert.equal((await admitCandidate(f.port, ciStart())).kind, 'blocked');
  assert.equal(options.claim.start.state, 'consumed');
});
test('full_retained_proof_is_required_again_after_acceptance', async (t) => {
  let revoked = false;
  const f = await fixture(t, {
    archive: (purpose) => (purpose === 'readiness-admission' && revoked ? null : undefined),
  });
  assert.equal((await admit(f)).kind, 'verified');
  revoked = true;
  assert.equal((await admitCandidate(f.port, start(candidate))).kind, 'blocked');
});
test('safety_drift_journal_keeps_original_parseable_identity_and_exact_current_target', async (t) => {
  const f = await fixture(t);
  assert.equal((await admit(f)).kind, 'verified');
  f.pr.head.sha = 'd'.repeat(40);
  const invalidated = await admitCandidate(f.port, start(candidate));
  assert.notEqual(invalidated.kind, 'verified');
  let rows = await f.port.readJournal();
  assert.equal(rows.kind, 'verified');
  assert.deepEqual(rows.value.at(-1).candidate, candidate);
  assert.equal(rows.value.at(-1).action, 'invalidate');
  const drafted = await admitCandidate(f.port, {
    type: 'synchronize',
    repositoryId: '1',
    pr: 2,
    readinessId: '2',
    head: f.pr.head.sha,
  });
  assert.notEqual(drafted.kind, 'verified');
  assert.equal(f.pr.draft, true);
  assert.equal(f.sends, 2);
  rows = await f.port.readJournal();
  assert.equal(rows.kind, 'verified');
  assert.equal(rows.value.at(-1).action, 'draft');
  assert.deepEqual(rows.value.at(-1).candidate, candidate);
});

test('uncertain_ci_consumption_retains_shared_exclusion_across_restart', async (t) => {
  const options = ciOptions();
  options.ciContinuation.consumeCiStart = async () => ({
    kind: 'uncertain',
    reason: 'consumption readback lost',
    evidence: [],
  });
  const f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  assert.equal((await admitCandidate(f.port, ciStart())).kind, 'uncertain');
  const restarted = new LocalDurableStore(f.root);
  await assert.rejects(
    () =>
      restarted.withPrLock('1:2', () =>
        assert.fail('unknown consumption must exclude another holder'),
      ),
    { code: 'EEXIST' },
  );
});

test('invocation_attempt_and_retained_window_substitutions_deny_without_worker_authority', async (t) => {
  const mismatch = await fixture(t, { authorize: (r) => auth(r, 2) });
  assert.equal((await admit(mismatch)).kind, 'blocked');
  assert.equal(mismatch.sends, 0);
  const options = ciOptions(),
    f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  f.events.unshift({
    id: 100,
    event: 'closed',
    actor: { id: 9 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal((await admitCandidate(f.port, ciStart())).kind, 'blocked');
  assert.equal(options.consumes, 0);
});
test('request_archive_reaches_authentication_and_unverified_evidence_never_mutates', async (t) => {
  const f = await fixture(t),
    ctx = context(f),
    archive = { input: 'exact-archive' };
  let received;
  ctx.requestContext.verifyRequestEvidence = async (_body, _bindings, a) => {
    received = a;
    return { kind: 'blocked' };
  };
  assert.equal(
    (await runtime.handleTrustedReadinessRequest({ body: JSON.stringify(request), archive }, ctx))
      .kind,
    'blocked',
  );
  assert.equal(received, archive);
  assert.equal(f.sends, 0);
  assert.equal(f.comments.length, 0);
});

test('completion_envelopes_bind_claim_candidate_and_original_run_attempt', async (t) => {
  for (const patch of [
    { claimId: 'other' },
    { candidate: { ...candidate, requestId: 'other' } },
    { candidate: { ...candidate, baseRef: 'refs/heads/other' } },
    { candidate: { ...candidate, head: 'f'.repeat(40) } },
    { run: { ...workerRun, attempt: 2 } },
    { run: { ...workerRun, actorId: '9' } },
    { run: { ...workerRun, executionSha: 'f'.repeat(40) } },
    { run: { ...workerRun, ref: 'refs/heads/other' } },
  ]) {
    const options = ciOptions();
    options.workerResults = async (run) => {
      const result = {
          candidate: patch.candidate ?? candidate,
          worker: 'ci',
          outcome: 'failure',
          claimId: patch.claimId ?? 'claim-1',
        },
        body = encodeWorkerResult(result);
      return {
        body,
        envelope: signed({
          purpose: 'worker-result',
          run: patch.run ?? run,
          candidate: result.candidate,
          worker: 'ci',
          bodyDigest: digest(body),
        }),
      };
    };
    const f = await fixture(t, options);
    assert.equal((await admit(f)).kind, 'verified');
    assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
    assert.equal((await callback(f, options, 'worker_completed', 'failure')).kind, 'blocked');
    assert.equal(f.pr.draft, false);
    assert.equal(f.sends, 1);
  }
});
test('completed_ci_requires_the_exact_persisted_start_consumption', async (t) => {
  for (const patch of [
    { claimId: 'other' },
    { runId: '67' },
    { runAttempt: 2 },
    { candidate: { ...candidate, requestId: 'other' } },
    { definitionSha: 'f'.repeat(40) },
    { state: 'pending' },
  ]) {
    const options = ciOptions(),
      f = await fixture(t, options);
    assert.equal((await admit(f)).kind, 'verified');
    assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
    Object.assign(options.claim.start, patch);
    assert.equal((await callback(f, options)).kind, 'blocked');
    assert.equal(f.sends, 1);
  }
});

test('round1_authenticated_intervening_head_invalidates_restored_same_attempt_without_draft', async (t) => {
  const options = ciOptions(),
    f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  // The delivery records B2, while the fresh current snapshot has already returned to B.
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'synchronize',
    pull_request: { number: 2, head: { sha: 'd'.repeat(40) } },
  });
  const archive = signed({
    purpose: 'controller-event',
    run: controller,
    readinessId: candidate.attempt,
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await runtime.handleTrustedEvent(
        { body, archive },
        { port: f.port, expectedRun: controller, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'blocked',
  );
  const journal = await f.port.readJournal();
  assert.equal(journal.kind, 'verified');
  assert.deepEqual(
    journal.value.slice(-2).map((r) => [r.action, r.phase]),
    [
      ['invalidate', 'intent'],
      ['invalidate', 'result'],
    ],
  );
  for (const row of journal.value) assert.deepEqual(row.candidate, candidate);
  assert.equal(f.pr.head.sha, candidate.head);
  assert.equal(f.pr.draft, false);
  assert.equal(f.sends, 1);
  assert.equal((await callback(f, options, 'worker_start')).kind, 'blocked');
  assert.equal(options.consumes, 0);
});

test('round1_different_attempt_synchronize_cannot_invalidate_or_draft_current_candidate', async (t) => {
  const options = ciOptions(),
    f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'synchronize',
    pull_request: { number: 2, head: { sha: 'd'.repeat(40) } },
  });
  const archive = signed({
    purpose: 'controller-event',
    run: controller,
    readinessId: 'previous-attempt',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await runtime.handleTrustedEvent(
        { body, archive },
        { port: f.port, expectedRun: controller, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'blocked',
  );
  assert.equal(f.comments.length, 2);
  assert.equal(f.pr.draft, false);
  assert.equal(f.sends, 1);
  assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
  assert.equal(options.consumes, 1);
});

test('round1_review_mapping_change_after_callback_authentication_denies_every_execution_field', async (t) => {
  const substitutions = [
    { id: '67' },
    { attempt: 2 },
    { repositoryId: '7' },
    { actorId: '7' },
    { workflowId: '7' },
    { sha: 'd'.repeat(40) },
    { executionSha: 'd'.repeat(40) },
    { ref: 'refs/heads/other' },
    { event: 'workflow_run' },
  ];
  for (const patch of substitutions)
    await t.test(Object.keys(patch)[0], async (t) => {
      const options = ciOptions(),
        mapped = { review: { ...workerRun } };
      options.workers = mapped;
      options.nativeRun = (path) =>
        path.includes(`/runs/${mapped.review.id}/`) ? mapped.review : null;
      const ciResult = options.workerResults;
      let reviewDownload = 0;
      options.workerResults = async (run) => {
        if (
          run === workerRun ||
          (run.id === workerRun.id && run.attempt === workerRun.attempt && !mutated)
        )
          return ciResult(run);
        reviewDownload++;
        const result = {
            candidate,
            worker: 'review',
            outcome: 'failure',
            model: 'gpt-6-astra',
            effort: 'high',
            fresh: true,
            findings: 1,
          },
          body = encodeWorkerResult(result);
        return {
          body,
          envelope: signed({
            purpose: 'worker-result',
            run,
            candidate,
            worker: 'review',
            bodyDigest: digest(body),
          }),
        };
      };
      let mutated = false,
        intercept = false;
      options.beforeLock = () => {
        if (intercept) {
          mapped.review = { ...workerRun, ...patch };
          mutated = true;
          intercept = false;
        }
      };
      const f = await fixture(t, options);
      assert.equal((await admit(f)).kind, 'verified');
      assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
      assert.equal((await callback(f, options)).kind, 'verified');
      const prior = f.comments.map((row) => row.body);
      const raw = { type: 'worker_completed', candidate, worker: 'review', outcome: 'failure' },
        body = JSON.stringify(raw);
      const archive = signed({
        purpose: 'worker-callback',
        run: workerRun,
        candidate,
        worker: 'review',
        bodyDigest: digest(body),
      });
      intercept = true;
      const result = await runtime.handleTrustedWorkerCallback(
        { body, archive },
        { port: f.port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      );
      assert.equal(mutated, true);
      assert.equal(result.kind, 'blocked');
      assert.equal(
        f.pr.draft,
        false,
        'a callback cannot draft using another authenticated execution',
      );
      assert.equal(f.sends, 1);
      assert.deepEqual(
        f.comments.map((row) => row.body),
        prior,
      );
      assert.equal(reviewDownload, 0);
    });
});

test('round1_matching_review_completion_keeps_separate_mapping_and_result_policy', async (t) => {
  for (const outcome of ['success', 'failure'])
    await t.test(outcome, async (t) => {
      const reviewRun = { ...workerRun, id: '67', workflowId: '9' },
        options = ciOptions();
      options.workers = { review: reviewRun };
      options.nativeRun = (path) => (path.includes('/runs/67/') ? reviewRun : null);
      const ciResult = options.workerResults;
      options.workerResults = async (run) => {
        if (run.id !== reviewRun.id) return ciResult(run);
        const result = {
            candidate,
            worker: 'review',
            outcome,
            model: 'gpt-6-astra',
            effort: 'high',
            fresh: true,
            findings: outcome === 'success' ? 0 : 1,
          },
          body = encodeWorkerResult(result);
        return {
          body,
          envelope: signed({
            purpose: 'worker-result',
            run,
            candidate,
            worker: 'review',
            bodyDigest: digest(body),
          }),
        };
      };
      const f = await fixture(t, options);
      assert.equal((await admit(f)).kind, 'verified');
      assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
      assert.equal((await callback(f, options)).kind, 'verified');
      const body = JSON.stringify({
          type: 'worker_completed',
          candidate,
          worker: 'review',
          outcome,
        }),
        archive = signed({
          purpose: 'worker-callback',
          run: reviewRun,
          candidate,
          worker: 'review',
          bodyDigest: digest(body),
        });
      const result = await runtime.handleTrustedWorkerCallback(
        { body, archive },
        { port: f.port, expectedRun: reviewRun, publicKey, mode: 'offline-test' },
      );
      assert.equal(result.kind, outcome === 'success' ? 'verified' : 'blocked');
      assert.equal(f.pr.draft, outcome === 'failure');
      const journal = await f.port.readJournal();
      assert.equal(journal.kind, 'verified');
      assert.equal(journal.value.at(-1).action, outcome === 'success' ? 'review-success' : 'draft');
      assert.equal(journal.value.at(-1).phase, 'result');
      assert.equal(f.sends, outcome === 'success' ? 1 : 2);
    });
});

test('round1_review_callback_retains_signed_execution_when_mapping_mutates_in_place', async (t) => {
  const original = { ...workerRun, id: '67', workflowId: '9' },
    mapped = { review: { ...original } },
    options = ciOptions();
  options.workers = mapped;
  options.nativeRun = (path) => (path.includes('/runs/67/') ? mapped.review : null);
  let intercept = false,
    changed = false,
    downloads = 0;
  const ciResult = options.workerResults;
  options.beforeLock = () => {
    if (intercept) {
      Object.assign(mapped.review, { attempt: 2 });
      changed = true;
      intercept = false;
    }
  };
  options.workerResults = async (run) => {
    if (run.id !== original.id) return ciResult(run);
    downloads++;
    const result = {
        candidate,
        worker: 'review',
        outcome: 'failure',
        model: 'gpt-6-astra',
        effort: 'high',
        fresh: true,
        findings: 1,
      },
      body = encodeWorkerResult(result);
    return {
      body,
      envelope: signed({
        purpose: 'worker-result',
        run,
        candidate,
        worker: 'review',
        bodyDigest: digest(body),
      }),
    };
  };
  const f = await fixture(t, options);
  assert.equal((await admit(f)).kind, 'verified');
  assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
  assert.equal((await callback(f, options)).kind, 'verified');
  const before = f.comments.map((row) => row.body),
    body = JSON.stringify({
      type: 'worker_completed',
      candidate,
      worker: 'review',
      outcome: 'failure',
    }),
    archive = signed({
      purpose: 'worker-callback',
      run: original,
      candidate,
      worker: 'review',
      bodyDigest: digest(body),
    });
  intercept = true;
  const result = await runtime.handleTrustedWorkerCallback(
    { body, archive },
    { port: f.port, expectedRun: mapped.review, publicKey, mode: 'offline-test' },
  );
  assert.equal(changed, true);
  assert.equal(result.kind, 'blocked');
  assert.equal(f.pr.draft, false);
  assert.equal(f.sends, 1);
  assert.deepEqual(
    f.comments.map((row) => row.body),
    before,
  );
  assert.equal(downloads, 0);
});

test('round2_authoritative_review_execution_survives_lookup_and_download_mutation', async (t) => {
  for (const boundary of ['lookup', 'download'])
    await t.test(boundary, async (t) => {
      const original = { ...workerRun, id: '67', workflowId: '9' },
        mapped = { review: { ...original } },
        options = ciOptions();
      options.workers = mapped;
      let armed = false,
        changed = false,
        downloads = 0,
        lookupPath = null,
        selectedBefore = null,
        selectedAfter = null;
      options.beforeLock = () => {
        if (armed && boundary === 'lookup') lookupArmed = true;
      };
      let lookupArmed = false;
      options.nativeRun = (path) => {
        if (!path.includes('/runs/67/')) return null;
        if (lookupArmed && !changed) {
          lookupPath = path;
          Object.assign(mapped.review, { attempt: 2 });
          changed = true;
        }
        return mapped.review;
      };
      const ciResult = options.workerResults;
      options.workerResults = async (selected) => {
        if (selected.id !== original.id) return ciResult(selected);
        downloads++;
        selectedBefore = selected.attempt;
        await Promise.resolve();
        if (boundary === 'download') {
          Object.assign(mapped.review, { attempt: 2 });
          changed = true;
        }
        selectedAfter = selected.attempt;
        const result = {
            candidate,
            worker: 'review',
            outcome: 'failure',
            model: 'gpt-6-astra',
            effort: 'high',
            fresh: true,
            findings: 1,
          },
          body = encodeWorkerResult(result);
        return {
          body,
          envelope: signed({
            purpose: 'worker-result',
            run: mapped.review,
            candidate,
            worker: 'review',
            bodyDigest: digest(body),
          }),
        };
      };
      const f = await fixture(t, options);
      assert.equal((await admit(f)).kind, 'verified');
      assert.equal((await callback(f, options, 'worker_start')).kind, 'verified');
      assert.equal((await callback(f, options)).kind, 'verified');
      const before = f.comments.map((row) => row.body),
        body = JSON.stringify({
          type: 'worker_completed',
          candidate,
          worker: 'review',
          outcome: 'failure',
        }),
        archive = signed({
          purpose: 'worker-callback',
          run: original,
          candidate,
          worker: 'review',
          bodyDigest: digest(body),
        });
      armed = true;
      const result = await runtime.handleTrustedWorkerCallback(
        { body, archive },
        { port: f.port, expectedRun: original, publicKey, mode: 'offline-test' },
      );
      assert.equal(changed, true);
      assert.equal(result.kind, 'blocked');
      assert.equal(
        f.pr.draft,
        false,
        'the original callback cannot accept another selected execution after an await',
      );
      assert.equal(f.sends, 1);
      assert.deepEqual(
        f.comments.map((row) => row.body),
        before,
      );
      if (boundary === 'download') {
        assert.equal(downloads, 1);
        assert.equal(selectedBefore, 1);
        assert.equal(selectedAfter, 1);
      } else {
        assert.match(lookupPath, /\/runs\/67\/attempts\/1$/);
        assert.equal(downloads, 0);
      }
    });
});
