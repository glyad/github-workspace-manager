import { sameExecution } from './worker-results.mjs';
import { blocked } from './contracts.mjs';
import { decideReadiness, reconcileTransition } from './controller.mjs';
import { sameCandidate } from './journal.mjs';
/** Single shared lock namespace for every readiness/controller/worker admission call.
 * Live ports must independently authenticate native timeline, journal and worker runs.
 * Event payload assertions are never accepted as worker provenance.
 */
export async function admitCandidate(port, event) {
  if (!port?.withPrLock || !event?.repositoryId || !Number.isSafeInteger(event.pr))
    return blocked('Shared serialization or event identity unavailable');
  try {
    return await port.withPrLock(`${event.repositoryId}:${event.pr}`, async () => {
      return admitCandidateInScope(port, event);
    });
  } catch {
    return blocked('Observation or lock unavailable');
  }
}
/** Internal composition boundary: caller already owns the single PR lock. */
export async function admitCandidateInScope(port, event) {
  const observed = await port.observe(event);
  const journal = await port.readJournal(event);
  let input = { ...event, workerVerified: false };
  if (
    event.type === 'worker_start' &&
    event.worker === 'review' &&
    event.candidate?.protocolVersion === 2
  ) {
    const provenance = await port.verifyWorkerCallback?.(event, event.run);
    if (provenance?.kind !== 'verified' || !sameExecution(provenance.value, event.run))
      return blocked('Authenticated review execution required');
  }
  if (event.type === 'worker_completed') {
    const proof = await port.verifyWorker(event);
    if (
      proof?.kind !== 'verified' ||
      !sameCandidate(proof.value.candidate, event.candidate) ||
      proof.value.worker !== event.worker ||
      proof.value.outcome !== event.outcome
    )
      return blocked('Unverified or unrelated worker run');
    input = { ...input, workerVerified: true };
  }
  return reconcileTransition(port, decideReadiness(observed, input, journal));
}
/** Intentionally no GitHub client: activation cannot be inferred from a token. */
export function inactivePort() {
  return {
    withPrLock: async () =>
      blocked(
        'Inactive: ledger Issue, actor/run issuer, timeline completeness, shared lock and permissions require live verification',
      ),
  };
}
