import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validCandidate, sameCandidate, operationKey } from '../../tools/governance/journal.mjs';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
export const request = {
  protocolVersion: 2,
  requestId: 'request-1',
  repositoryId: 'repo',
  pr: 7,
  prNodeId: 'PR_7',
  baseRef: 'refs/heads/develop',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  initiatingActorId: 'human',
  originalRunId: '12',
  workflowId: 'workflow',
  definitionSha: 'c'.repeat(40),
};
export function fixture(attempt = 1) {
  const original = {
    id: '12',
    attempt: 1,
    repositoryId: 'repo',
    actorId: 'human',
    workflowId: 'workflow',
    sha: 'c'.repeat(40),
    executionSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  };
  const current = { ...original, attempt };
  const body = JSON.stringify(request);
  let writes = 0;
  const context = {
    runId: '12',
    runAttempt: attempt,
    authorizedActorIds: ['human'],
    approvedDefinition: Object.freeze({
      repositoryId: 'repo',
      workflowId: 'workflow',
      sha: 'c'.repeat(40),
      ref: 'refs/heads/main',
    }),
    lookupRun: async (id, n) => ({
      kind: 'verified',
      value: id === '12' ? (n === 1 ? original : current) : null,
    }),
    resolvePr: async () => ({
      kind: 'verified',
      value: { repositoryId: 'repo', pr: 7, prNodeId: 'PR_7' },
    }),
    verifyRequestEvidence: async (bytes) =>
      bytes === body
        ? {
            kind: 'verified',
            value: {
              bodyDigest: hash(body),
              originalRunId: '12',
              runAttempt: attempt,
              definitionSha: 'c'.repeat(40),
              triggeringActorId: 'human',
            },
          }
        : { kind: 'blocked' },
    append: () => {
      writes++;
    },
    markReady: () => {
      writes++;
    },
  };
  return { body, context, original, current, writes: () => writes };
}
test('authenticated dispatch and rerun retain original request with separately verified attribution', async () => {
  for (const attempt of [1, 2]) {
    const f = fixture(attempt);
    const result = await authenticateReadinessRequest(f.body, f.context);
    assert.equal(result.kind, 'verified');
    assert.deepEqual(result.value, request);
    assert.equal(f.writes(), 0);
  }
});
test('reject_untrusted_ref_or_definition', async () => {
  for (const patch of [
    { ref: 'refs/heads/feature/evil' },
    { sha: 'd'.repeat(40) },
    { executionSha: 'd'.repeat(40) },
    { event: 'pull_request_target' },
    { workflowId: 'other' },
    { repositoryId: 'other' },
  ]) {
    const f = fixture();
    Object.assign(f.original, patch);
    assert.equal((await authenticateReadinessRequest(f.body, f.context)).kind, 'blocked');
    assert.equal(f.writes(), 0);
  }
});
test('reject_changed_rerun_inputs', async () => {
  for (const patch of [
    { requestId: 'replacement' },
    { head: 'd'.repeat(40) },
    { baseRef: 'refs/heads/main' },
    { initiatingActorId: 'other' },
    { originalRunId: '13' },
  ]) {
    const f = fixture(2);
    assert.equal(
      (await authenticateReadinessRequest(JSON.stringify({ ...request, ...patch }), f.context))
        .kind,
      'blocked',
    );
    assert.equal(f.writes(), 0);
  }
  const f = fixture(2);
  f.current.actorId = 'other';
  assert.equal((await authenticateReadinessRequest(f.body, f.context)).kind, 'blocked');
});
test('reject_unauthorized_initiator and forged provenance', async () => {
  for (const patch of [
    { authorizedActorIds: ['other'] },
    { verifyRequestEvidence: async () => ({ kind: 'verified', value: { bodyDigest: 'forged' } }) },
    { verifyRequestEvidence: async () => ({ kind: 'uncertain' }) },
    { lookupRun: async () => ({ kind: 'verified', value: { ...fixture().original, attempt: 2 } }) },
    {
      resolvePr: async () => ({
        kind: 'verified',
        value: { repositoryId: 'repo', pr: 7, prNodeId: 'PR_other' },
      }),
    },
    { approvedDefinition: { ...fixture().context.approvedDefinition } },
  ]) {
    const f = fixture();
    Object.assign(f.context, patch);
    assert.equal((await authenticateReadinessRequest(f.body, f.context)).kind, 'blocked');
    assert.equal(f.writes(), 0);
  }
});
test('reject malformed, missing, extra and oversized request fields before trusted lookups', async () => {
  const invalid = [
    null,
    {},
    { ...request, unexpected: true },
    { ...request, protocolVersion: 1 },
    { ...request, pr: 0 },
    { ...request, pr: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, requestId: 'x'.repeat(129) },
    { ...request, repositoryId: 'é'.repeat(65) },
    { ...request, base: 'A'.repeat(40) },
    { ...request, baseRef: 'refs/heads/a..b' },
    { ...request, baseRef: 'refs/heads/a.lock' },
    { ...request, baseRef: 'refs/heads/@{bad' },
    { ...request, baseRef: 'refs/heads/a b' },
  ];
  for (const value of invalid) {
    const f = fixture();
    let reads = 0;
    f.context.lookupRun = async () => {
      reads++;
      throw Error();
    };
    assert.equal(
      (await authenticateReadinessRequest(JSON.stringify(value), f.context)).kind,
      'blocked',
    );
    assert.equal(reads, 0);
    assert.equal(f.writes(), 0);
  }
  const f = fixture();
  for (const bytes of ['{', ' '.repeat(16385), { kind: 'verified', value: request }])
    assert.equal((await authenticateReadinessRequest(bytes, f.context)).kind, 'blocked');
});
export const v2 = {
  repositoryId: 'repo',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-1',
  baseRef: 'refs/heads/develop',
  requestId: 'request-1',
  protocolVersion: 2,
};
test('v2_identity_includes_ref_request_version and every legacy field', () => {
  assert.equal(validCandidate(v2), true);
  for (const patch of [
    { repositoryId: 'other' },
    { pr: 8 },
    { base: 'd'.repeat(40) },
    { head: 'd'.repeat(40) },
    { attempt: 'ready-2' },
    { baseRef: 'refs/heads/main' },
    { requestId: 'request-2' },
    { protocolVersion: 1 },
  ]) {
    assert.equal(sameCandidate(v2, { ...v2, ...patch }), false);
    assert.notEqual(operationKey(v2, 'admit-ci'), operationKey({ ...v2, ...patch }, 'admit-ci'));
  }
});
test('v1_cannot_be_promoted; historical identity and keys remain stable', () => {
  const legacy = {
    repositoryId: 'repo',
    pr: 7,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    attempt: 'ready-1',
  };
  assert.equal(validCandidate(legacy), true);
  assert.equal(
    operationKey(legacy, 'admit-ci'),
    'e963b9ee44c308ed56347ba651dcd5f4be44f35d3613937a18bfc88bbeb571f8',
  );
  assert.equal(sameCandidate(v2, legacy), false);
  assert.notEqual(operationKey(v2, 'admit-ci'), operationKey(legacy, 'admit-ci'));
  assert.equal(validCandidate({ ...legacy, protocolVersion: 2 }), false);
  assert.equal(validCandidate({ ...v2, ignored: true }), false);
  assert.equal(validCandidate({ ...legacy, ignored: true }), false);
});

test('all request IDs, fields and ref bounds are enforced without writes', async () => {
  for (const field of Object.keys(request)) {
    const f = fixture();
    const missing = { ...request };
    delete missing[field];
    assert.equal(
      (await authenticateReadinessRequest(JSON.stringify(missing), f.context)).kind,
      'blocked',
    );
    assert.equal(f.writes(), 0);
  }
  for (const field of [
    'repositoryId',
    'prNodeId',
    'initiatingActorId',
    'originalRunId',
    'workflowId',
  ])
    for (const bad of ['', 'x'.repeat(129), 'é'.repeat(65), 'bad\nvalue', null, 12]) {
      const f = fixture();
      assert.equal(
        (
          await authenticateReadinessRequest(
            JSON.stringify({ ...request, [field]: bad }),
            f.context,
          )
        ).kind,
        'blocked',
      );
      assert.equal(f.writes(), 0);
    }
  for (const baseRef of [
    'refs/heads/',
    'refs/heads/a//b',
    'refs/heads/.hidden',
    'refs/heads/a.',
    'refs/heads/a.lock/b',
    'refs/tags/v1',
    'refs/heads/' + 'x'.repeat(245),
    'refs/heads/é'.repeat(30),
  ]) {
    const f = fixture();
    assert.equal(
      (await authenticateReadinessRequest(JSON.stringify({ ...request, baseRef }), f.context)).kind,
      'blocked',
    );
    assert.equal(f.writes(), 0);
  }
});
test('evidence must bind each original/run/definition/actor fact and exact original bytes', async () => {
  for (const patch of [
    { originalRunId: '13' },
    { runAttempt: 1 },
    { definitionSha: 'd'.repeat(40) },
    { triggeringActorId: 'other' },
    { bodyDigest: 'd'.repeat(64) },
  ]) {
    const f = fixture(2);
    const verify = f.context.verifyRequestEvidence;
    f.context.verifyRequestEvidence = async (...args) => {
      const r = await verify(...args);
      return { ...r, value: { ...r.value, ...patch } };
    };
    assert.equal((await authenticateReadinessRequest(f.body, f.context)).kind, 'blocked');
    assert.equal(f.writes(), 0);
  }
  const f = fixture(2);
  assert.equal((await authenticateReadinessRequest(f.body + ' ', f.context)).kind, 'blocked');
});
test('trusted lookup failures and invocation substitutions deny without side effects', async () => {
  for (const patch of [
    { runId: '13' },
    { runAttempt: 0 },
    { runAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { lookupRun: async () => ({ kind: 'uncertain' }) },
    {
      lookupRun: async () => {
        throw Error('offline');
      },
    },
    { resolvePr: async () => ({ kind: 'blocked' }) },
    {
      verifyRequestEvidence: async () => {
        throw Error('archive unavailable');
      },
    },
    {
      resolvePr: async () => ({
        kind: 'verified',
        value: { repositoryId: 'other', pr: 7, prNodeId: 'PR_7' },
      }),
    },
    {
      resolvePr: async () => ({
        kind: 'verified',
        value: { repositoryId: 'repo', pr: 8, prNodeId: 'PR_7' },
      }),
    },
  ]) {
    const f = fixture();
    Object.assign(f.context, patch);
    assert.equal((await authenticateReadinessRequest(f.body, f.context)).kind, 'blocked');
    assert.equal(f.writes(), 0);
  }
});
test('bounded field limits accept legitimate maximum identities and preserve selected pair', async () => {
  const selected = {
    ...request,
    requestId: 'R'.repeat(128),
    repositoryId: 'r'.repeat(128),
    prNodeId: 'p'.repeat(128),
    baseRef: 'refs/heads/' + 'x'.repeat(244),
  };
  const body = JSON.stringify(selected),
    f = fixture();
  f.context.approvedDefinition = Object.freeze({
    ...f.context.approvedDefinition,
    repositoryId: selected.repositoryId,
  });
  f.context.lookupRun = async (_id, attempt) => ({
    kind: 'verified',
    value: { ...f.original, repositoryId: selected.repositoryId, attempt },
  });
  f.context.resolvePr = async () => ({
    kind: 'verified',
    value: {
      repositoryId: selected.repositoryId,
      pr: 7,
      prNodeId: selected.prNodeId,
      base: 'd'.repeat(40),
      head: 'e'.repeat(40),
    },
  });
  f.context.verifyRequestEvidence = async () => ({
    kind: 'verified',
    value: {
      bodyDigest: hash(body),
      originalRunId: '12',
      runAttempt: 1,
      definitionSha: request.definitionSha,
      triggeringActorId: 'human',
    },
  });
  const result = await authenticateReadinessRequest(body, f.context);
  assert.equal(result.kind, 'verified');
  assert.deepEqual(result.value, selected);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(f.writes(), 0);
});

test('successful authentication evidence satisfies the shared contract with a local observation timestamp', async () => {
  const { isEvidence } = await import('../../tools/governance/validate.mjs');
  for (const attempt of [1, 2]) {
    const f = fixture(attempt),
      before = Date.now();
    const result = await authenticateReadinessRequest(f.body, f.context),
      after = Date.now();
    assert.equal(result.kind, 'verified');
    assert.equal(isEvidence(result.evidence), true);
    const observed = Date.parse(result.evidence[0].observedAt);
    assert.equal(observed >= before && observed <= after, true);
    assert.deepEqual(result.value, request);
    assert.equal(f.writes(), 0);
  }
});
