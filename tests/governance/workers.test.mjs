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

test('worker v2 candidate result preserves full identity and rejects legacy promotion', async () => {
  const { encodeWorkerResult } = await import('../../tools/governance/worker-transport.mjs');
  const v2 = { ...c, baseRef: 'refs/heads/develop', requestId: 'request-1', protocolVersion: 2 };
  const body = encodeWorkerResult({
    candidate: v2,
    worker: 'ci',
    outcome: 'success',
    claimId: 'claim-1',
  });
  assert.deepEqual(JSON.parse(body).candidate, v2);
  assert.throws(() =>
    encodeWorkerResult({
      candidate: { ...c, protocolVersion: 2 },
      worker: 'ci',
      outcome: 'success',
    }),
  );
});

test('v2 exact-byte worker envelopes authenticate full identity and never upgrade historical archives', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { encodeWorkerResult, verifyResultEnvelope } =
    await import('../../tools/governance/worker-transport.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const candidate = {
    ...c,
    baseRef: 'refs/heads/develop',
    requestId: 'request-1',
    protocolVersion: 2,
  };
  const workerRun = { ...run, actorId: 'worker', executionSha: run.sha, ref: 'refs/heads/main' };
  const body = encodeWorkerResult({
    candidate,
    worker: 'ci',
    outcome: 'success',
    claimId: 'claim-1',
  });
  const archive = {
    version: 2,
    purpose: 'worker-result',
    run: workerRun,
    candidate,
    worker: 'ci',
    bodyDigest: createHash('sha256').update(body).digest('hex'),
  };
  const envelope = (value) => {
    const body = JSON.stringify(value);
    return { body, signature: sign(null, Buffer.from(body), privateKey).toString('base64') };
  };
  assert.equal(
    verifyResultEnvelope(body, envelope(archive), workerRun, candidate, 'ci', publicKey, 'claim-1')
      .kind,
    'verified',
  );
  for (const patch of [
    { baseRef: 'refs/heads/main' },
    { requestId: 'other' },
    { protocolVersion: 1 },
  ])
    assert.equal(
      verifyResultEnvelope(
        body,
        envelope(archive),
        workerRun,
        { ...candidate, ...patch },
        'ci',
        publicKey,
      ).kind,
      'blocked',
    );
  assert.equal(
    verifyResultEnvelope(
      body + ' ',
      envelope(archive),
      workerRun,
      candidate,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
  assert.equal(
    verifyResultEnvelope(
      body,
      envelope({ ...archive, version: 1 }),
      workerRun,
      candidate,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
  const legacyBody = encodeWorkerResult(result);
  const legacy = {
    ...archive,
    version: 1,
    candidate: c,
    bodyDigest: createHash('sha256').update(legacyBody).digest('hex'),
  };
  assert.equal(
    verifyResultEnvelope(legacyBody, envelope(legacy), workerRun, c, 'ci', publicKey).kind,
    'verified',
  );
  assert.equal(
    verifyResultEnvelope(
      legacyBody,
      envelope(legacy),
      workerRun,
      candidate,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
});

test('signed archive parsing rejects incomplete, extra-field and unknown-version candidate unions', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { verifyArchive } = await import('../../tools/governance/worker-transport.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const archiveRun = { ...run, actorId: 'worker', executionSha: run.sha, ref: 'refs/heads/main' };
  for (const candidate of [
    { ...c, protocolVersion: 2 },
    { ...c, extra: true },
    { ...c, protocolVersion: 3 },
    { ...c, protocolVersion: 2, requestId: 'request-1', baseRef: 'refs/heads/a..b' },
  ]) {
    const body = JSON.stringify({
      version: candidate.protocolVersion === 2 ? 2 : 1,
      purpose: 'worker-result',
      run: archiveRun,
      candidate,
    });
    const envelope = {
      body,
      signature: sign(null, Buffer.from(body), privateKey).toString('base64'),
    };
    assert.equal(
      verifyArchive(envelope, { purpose: 'worker-result', run: archiveRun, candidate }, publicKey)
        .kind,
      'blocked',
    );
  }
});
