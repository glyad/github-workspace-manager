import { blocked, verified } from './contracts.mjs';
import { digest, sameCandidate, validCandidate } from './journal.mjs';
import { validDispatchClaim } from './worker-transport.mjs';
import { sameExecution } from './worker-results.mjs';
import { decideReadiness } from './controller.mjs';
const uncertain = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
export const ciClaimId = (c) => `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`;
/** Reuse the existing policy's start decision without consuming execution.
 * Caller owns the same PR lock. Only D's callback may grant a start permission. */
async function fresh(candidate, port) {
  const observed = await port.observe(candidate);
  const journal = await port.readJournal(candidate);
  const decision = decideReadiness(
    observed,
    {
      type: 'worker_start',
      worker: 'ci',
      candidate,
      repositoryId: candidate.repositoryId,
      pr: candidate.pr,
      readinessId: candidate.attempt,
    },
    journal,
  );
  return decision.action === 'start-ci' && sameCandidate(decision.candidate, candidate);
}
/** Every unresolved exit after occupying a slot, including binding's second
 * issuer lookup, needs a final exact obligation readback before normal release.
 * Unavailable storage returns uncertainty to the existing retained-lock backend. */
async function settleOccupied(claim, port, operation) {
  let result;
  try {
    result = await operation();
  } catch {
    result = uncertain('CI operation outcome unavailable');
  }
  if (result?.kind === 'verified') return { result, unresolved: false };
  try {
    const read = await port.readCiContinuation(claim.id);
    const retained = read?.value;
    if (
      read?.kind === 'verified' &&
      validDispatchClaim(retained) &&
      ['id', 'requestId', 'definitionSha', 'worker'].every((k) => retained[k] === claim[k]) &&
      sameCandidate(retained.candidate, claim.candidate) &&
      (!claim.run || sameExecution(retained.run, claim.run))
    )
      return { result: verified(retained), unresolved: true };
  } catch {
    /* The existing lock remains retained when evidence cannot be read. */
  }
  return { result: uncertain('CI outcome and durable obligation unavailable'), unresolved: true };
}
export async function dispatchAdmittedCi(input, port) {
  if (!validCandidate(input) || input.protocolVersion !== 2)
    return blocked('Verified v2 candidate required');
  const candidate = Object.freeze(structuredClone(input));
  let unsettled = false;
  try {
    const result = await port.withPrLock(`${candidate.repositoryId}:${candidate.pr}`, async () => {
      if (!(await fresh(candidate, port))) return blocked('Fresh shared admission denied');
      const reserved = await port.claimCiContinuation(candidate);
      if (reserved.kind !== 'verified') return reserved;
      const claim = structuredClone(reserved.value);
      if (!(await fresh(candidate, port)))
        return blocked('Candidate changed before CI dispatch; retain claim');
      const settled = await settleOccupied(claim, port, async () => {
        const sent = await port.dispatchCi(claim);
        if (sent.kind !== 'verified') return sent;
        const found = await port.findCiRun(claim);
        if (found.kind !== 'verified') return found;
        return port.bindCiRun(claim.id, found.value);
      });
      unsettled = settled.unresolved;
      return settled.result;
    });
    return unsettled && result.kind === 'verified'
      ? uncertain('CI claim occupied; reconcile original dispatch')
      : result;
  } catch {
    return uncertain('CI ownership unavailable; retain original obligation');
  }
}
export async function reconcileCiDispatch(claimId, port) {
  let unsettled = false;
  try {
    const read = await port.readCiContinuation(claimId);
    if (read.kind !== 'verified' || !read.value)
      return read.kind === 'verified' ? blocked('Missing CI claim') : read;
    const claim = structuredClone(read.value);
    if (claim.status === 'quarantined') return blocked('CI claim quarantined');
    const result = await port.withPrLock(
      `${claim.candidate.repositoryId}:${claim.candidate.pr}`,
      async () => {
        const current = await port.readCiContinuation(claimId);
        if (current.kind !== 'verified' || !current.value)
          return uncertain('CI history unavailable');
        const original = structuredClone(current.value);
        const settled = await settleOccupied(original, port, async () => {
          const found = await port.findCiRun(original);
          if (found.kind !== 'verified') return found;
          return port.bindCiRun(claimId, found.value);
        });
        unsettled = settled.unresolved;
        return settled.result;
      },
    );
    return unsettled && result.kind === 'verified'
      ? uncertain('Original CI dispatch unresolved; claim occupied')
      : result;
  } catch {
    return uncertain('CI reconciliation ownership unavailable');
  }
}
