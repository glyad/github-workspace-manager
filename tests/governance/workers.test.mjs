import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { acceptWorkerResult, admitReview } from '../../tools/governance/worker-results.mjs';
const c = {
  repositoryId: 'repo-1',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-1',
};
const run = {
  id: '11',
  attempt: 1,
  repositoryId: 'repo-1',
  workflowId: 'ci-1',
  sha: 'c'.repeat(40),
  event: 'workflow_dispatch',
};
const result = { candidate: c, worker: 'ci', outcome: 'success' };
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function observed(r = result) {
  return {
    candidate: c,
    ready: true,
    admitted: true,
    nativeVerified: true,
    lifecycleVerified: true,
    invalidated: false,
    sameRepository: true,
    attestation: { verified: true, run, bodyDigest: hash(r) },
    expectedRun: run,
    expectedWorker: r.worker,
  };
}
function review() {
  return {
    ...observed(),
    ci: { verified: true, candidate: c, outcome: 'success' },
    fundingActivated: true,
    credentialsActivated: true,
    trustVerified: true,
    actionPinVerified: true,
    ceilingsEnforced: true,
    keyExposedToCheckout: false,
    untrustedTools: false,
    inputBytes: 20,
  };
}
test('accepts exact authenticated successful CI and requests Draft only for its current failed attempt', () => {
  assert.equal(acceptWorkerResult(c, run, result, observed()).action, 'ci-success');
  const failure = { ...result, outcome: 'failure' };
  assert.equal(acceptWorkerResult(c, run, failure, observed(failure)).action, 'draft');
  assert.equal(
    acceptWorkerResult(c, run, failure, {
      ...observed(failure),
      candidate: { ...c, attempt: 'ready-2' },
    }).action,
    'none',
  );
});
test('rejects Draft, missing admission, forged body/run, base drift and invalidated history', () => {
  for (const patch of [
    { ready: false },
    { admitted: false },
    { invalidated: true },
    { nativeVerified: false },
    { lifecycleVerified: false },
    { sameRepository: false },
    { candidate: { ...c, base: 'd'.repeat(40) } },
    { attestation: { verified: true, run, bodyDigest: hash({ ...result, outcome: 'failure' }) } },
    { expectedRun: { ...run, id: '12' } },
  ])
    assert.equal(acceptWorkerResult(c, run, result, { ...observed(), ...patch }).action, 'none');
  assert.equal(acceptWorkerResult(c, { ...run, attempt: 2 }, result, observed()).action, 'none');
});
test('review completion requires current authenticated CI, fresh Astra High and no findings', () => {
  const r = {
    candidate: c,
    worker: 'review',
    outcome: 'success',
    model: 'gpt-6-astra',
    effort: 'high',
    fresh: true,
    findings: 0,
  };
  const o = { ...review(), ...observed(r) };
  assert.equal(acceptWorkerResult(c, run, r, o).action, 'review-success');
  for (const patch of [
    { model: 'other' },
    { effort: 'xhigh' },
    { fresh: false },
    { findings: 1 },
  ]) {
    const changed = { ...r, ...patch };
    assert.notEqual(
      acceptWorkerResult(c, run, changed, { ...o, ...observed(changed) }).action,
      'review-success',
    );
  }
  assert.equal(
    acceptWorkerResult(c, run, r, { ...o, ci: { ...o.ci, candidate: { ...c, attempt: 'old' } } })
      .action,
    'none',
  );
});
test('zero review authorization before Ready/current CI/funding/credentials/trust and resource gates', () => {
  const limits = { maxInputBytes: 100 };
  assert.equal(admitReview(c, review(), limits).kind, 'verified');
  for (const patch of [
    { ready: false },
    { admitted: false },
    { ci: null },
    { ci: { verified: true, candidate: { ...c, head: 'd'.repeat(40) }, outcome: 'success' } },
    { fundingActivated: false },
    { credentialsActivated: false },
    { trustVerified: false },
    { actionPinVerified: false },
    { ceilingsEnforced: false },
    { sameRepository: false },
    { keyExposedToCheckout: true },
    { untrustedTools: true },
    { inputBytes: 101 },
    { inputBytes: -1 },
  ])
    assert.equal(admitReview(c, { ...review(), ...patch }, limits).kind, 'blocked');
});
export { c, review };
test('rejects worker substitution and unbounded result bodies despite matching self-reported claims', () => {
  assert.equal(
    acceptWorkerResult(c, run, result, { ...observed(), expectedWorker: 'review' }).action,
    'none',
  );
  const huge = { ...result, diagnostics: 'x'.repeat(1_000_001) };
  assert.equal(acceptWorkerResult(c, run, huge, observed(huge)).action, 'none');
});
