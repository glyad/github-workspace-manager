// Local test provisioning only. These positive limits are NOT activation decisions.
export const candidate = Object.freeze({
  repositoryId: 'repo-1',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-1',
  protocolVersion: 2,
  baseRef: 'refs/heads/develop',
  requestId: 'ready-request-1',
});
export const limits = Object.freeze({
  callsPerAttempt: 2,
  maxOutputTokens: 300,
  maxInputBytes: 10000,
  maxRunSeconds: 20,
  maxConcurrentCalls: 2,
});
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function registration(c = candidate, request = 'paid-1', l = limits) {
  const run = {
    id: '123',
    attempt: 1,
    repositoryId: c.repositoryId,
    actorId: 'actor-1',
    workflowId: 'review-1',
    sha: 'c'.repeat(40),
    executionSha: c.head,
    ref: 'refs/heads/develop',
    event: 'workflow_dispatch',
  };
  const approvedDefinition = {
    repositoryId: run.repositoryId,
    workflowId: run.workflowId,
    sha: run.sha,
    ref: run.ref,
  };
  const fields = structuredClone({
    candidate: c,
    reservationRequestId: request,
    run,
    approvedDefinition,
    limits: l,
  });
  return { ...fields, evidenceBody: canonical(fields) };
}
export function observation(c = candidate) {
  return {
    candidate: c,
    ready: true,
    admitted: true,
    nativeVerified: true,
    lifecycleVerified: true,
    invalidated: false,
    sameRepository: true,
    ci: { verified: true, candidate: c, outcome: 'success' },
    fundingActivated: true,
    credentialsActivated: true,
    trustVerified: true,
    actionPinVerified: true,
    ceilingsEnforced: true,
    keyExposedToCheckout: false,
    untrustedTools: false,
    inputBytes: 30,
  };
}
