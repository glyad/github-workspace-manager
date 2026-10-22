import { blocked, verified } from './contracts.mjs';
import { digest, sameCandidate, validCandidate } from './journal.mjs';
const none = (reason) => ({ action: 'none', reason });
const runKeys = ['id', 'attempt', 'repositoryId', 'workflowId', 'sha', 'event'];
const validRun = (r) =>
  r &&
  typeof r.id === 'string' &&
  r.id.length > 0 &&
  Number.isSafeInteger(r.attempt) &&
  r.attempt > 0 &&
  typeof r.workflowId === 'string' &&
  r.workflowId.length > 0 &&
  /^[a-f0-9]{40}$/.test(r.sha) &&
  r.event === 'workflow_dispatch';
const sameRun = (a, b) => validRun(a) && validRun(b) && runKeys.every((k) => a[k] === b[k]);
/** These facts MUST come from the Task 6 authenticated admission adapter under
 * its shared PR lock. Raw event payloads, artifact fields and PR text are not facts.
 * This policy does not create attestations, verify GitHub transport or mutate PRs.
 */
function current(c, o) {
  return (
    validCandidate(c) &&
    sameCandidate(c, o?.candidate) &&
    o.nativeVerified === true &&
    o.lifecycleVerified === true &&
    o.ready === true &&
    o.admitted === true &&
    o.invalidated === false &&
    o.sameRepository === true
  );
}
function currentCi(c, o) {
  return o.ci?.verified === true && sameCandidate(c, o.ci.candidate) && o.ci.outcome === 'success';
}
/** Offline admission only: no API client or credential material is accepted. */
export function admitReview(candidate, observed, limits) {
  if (!current(candidate, observed) || !currentCi(candidate, observed))
    return blocked('Current admitted Ready and authenticated exact CI success required');
  if (
    ![
      'fundingActivated',
      'credentialsActivated',
      'trustVerified',
      'actionPinVerified',
      'ceilingsEnforced',
    ].every((k) => observed[k] === true) ||
    observed.keyExposedToCheckout !== false ||
    observed.untrustedTools !== false
  )
    return blocked('Funding, credentials, trusted Action and credential isolation not proven');
  if (
    !Number.isSafeInteger(limits?.maxInputBytes) ||
    limits.maxInputBytes <= 0 ||
    !Number.isSafeInteger(observed.inputBytes) ||
    observed.inputBytes < 0 ||
    observed.inputBytes > limits.maxInputBytes
  )
    return blocked('Input byte ceiling exceeded or unselected');
  return verified({
    candidate: structuredClone(candidate),
    model: 'gpt-6-astra',
    effort: 'high',
    fresh: true,
  });
}
/** A verified attestation must bind the exact result bytes to an independently
 * authenticated expected run (including its trusted workflow SHA and issuer).
 * The caller must recheck Task 6 admission before persisting this decision.
 */
export function acceptWorkerResult(candidate, runIdentity, result, observed) {
  try {
    if (!current(candidate, observed) || !sameCandidate(candidate, result?.candidate))
      return none('Stale or unadmitted candidate');
    if (
      observed.expectedWorker !== result.worker ||
      !sameRun(runIdentity, observed.expectedRun) ||
      runIdentity.repositoryId !== candidate.repositoryId ||
      observed.attestation?.verified !== true ||
      !sameRun(runIdentity, observed.attestation.run) ||
      Buffer.byteLength(JSON.stringify(result)) > 1_000_000 ||
      observed.attestation.bodyDigest !== digest(JSON.stringify(result))
    )
      return none('Unauthenticated run or exact result body');
    if (
      !['ci', 'review'].includes(result.worker) ||
      !['success', 'failure'].includes(result.outcome)
    )
      return none('Malformed worker result');
    if (result.worker === 'review') {
      if (
        !currentCi(candidate, observed) ||
        result.model !== 'gpt-6-astra' ||
        result.effort !== 'high' ||
        result.fresh !== true ||
        !Number.isSafeInteger(result.findings) ||
        result.findings < 0
      )
        return none('Review configuration or current CI evidence unavailable');
      if (result.findings > 0) return { action: 'draft', candidate: structuredClone(candidate) };
    }
    return {
      action: result.outcome === 'failure' ? 'draft' : `${result.worker}-success`,
      candidate: structuredClone(candidate),
    };
  } catch {
    return none('Malformed or oversized worker envelope');
  }
}
