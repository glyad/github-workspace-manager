import { blocked, verified } from './contracts.mjs';
import { operationKey, sameCandidate, validCandidate } from './journal.mjs';
import { admitReview } from './worker-results.mjs';
/** @typedef {{callsPerAttempt:number,maxOutputTokens:number,maxInputBytes:number,maxRunSeconds:number,maxConcurrentCalls:number}} ReviewLimits */
const keys = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
const validLimits = (l) =>
  l &&
  Object.keys(l).length === keys.length &&
  keys.every((k) => Number.isSafeInteger(l[k]) && l[k] > 0);
const equalLimits = (a, b) => validLimits(a) && validLimits(b) && keys.every((k) => a[k] === b[k]);
const sameAttempt = (a, b) =>
  a.repositoryId === b.repositoryId && a.pr === b.pr && a.attempt === b.attempt;
function validRows(rows) {
  return (
    Array.isArray(rows) &&
    rows.length <= 10000 &&
    rows.every(
      (r) =>
        validCandidate(r.candidate) &&
        typeof r.key === 'string' &&
        typeof r.requestId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(r.requestId) &&
        r.key === operationKey(r.candidate, `review-reservation:${r.requestId}`) &&
        validLimits(r.limits) &&
        ['reserved', 'unknown', 'completed'].includes(r.status),
    ) &&
    new Set(rows.map((r) => r.key)).size === rows.length
  );
}
/** Ledger is an authenticated trusted port, NOT a JSON object from a worker.
 * withReservationLock holds a global funding-scope lock across read, fresh
 * observation, append and readback. All CI/controller admission still requires
 * Task 6's shared PR lock; adapters must impose one consistent lock ordering.
 * Reservations are single-use call slots, not reusable execution capabilities.
 * Every retry needs a new requestId/slot. Unknown billing stays active. Only a
 * separate authenticated reconciliation may mark a slot completed; never delete.
 * There is deliberately no live adapter, dispatcher, API client or currency cap.
 */
export async function reserveReviewBudget(attempt, limits, ledger) {
  if (
    !validLimits(limits) ||
    !validCandidate(attempt?.candidate) ||
    typeof attempt.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(attempt.requestId) ||
    !ledger?.withReservationLock ||
    !ledger.read ||
    !ledger.append ||
    !ledger.observe
  )
    return blocked('Explicit positive approved limits and durable serialized ledger required');
  const request = structuredClone(attempt);
  const approved = structuredClone(limits);
  if (admitReview(request.candidate, request.observed, approved).kind !== 'verified')
    return blocked('Review not admitted');
  try {
    return await ledger.withReservationLock(async () => {
      const read = await ledger.read();
      const state = read?.value;
      if (
        read?.kind !== 'verified' ||
        state?.limitsApproved !== true ||
        !equalLimits(state.limits, approved) ||
        !validRows(state.reservations)
      )
        return blocked('Unverified, incomplete or unapproved reservation history');
      const c = request.candidate;
      const rows = state.reservations;
      // A readiness attempt's budget survives base/head drift. Concurrency is
      // global across this funding scope, not merely per PR or per workflow run.
      if (rows.some((r) => sameAttempt(r.candidate, c) && r.requestId === request.requestId))
        return blocked('Duplicate request: reconcile existing reservation, never spend again');
      if (
        rows.filter((r) => sameAttempt(r.candidate, c)).length >= approved.callsPerAttempt ||
        rows.filter((r) => r.status !== 'completed').length >= approved.maxConcurrentCalls
      )
        return blocked('Call budget exhausted or funding-scope concurrency occupied');
      if (admitReview(c, await ledger.observe(c), approved).kind !== 'verified')
        return blocked('Current review admission changed');
      const reservation = {
        key: operationKey(c, `review-reservation:${request.requestId}`),
        candidate: c,
        requestId: request.requestId,
        status: 'reserved',
        limits: approved,
      };
      const write = await ledger.append(reservation);
      if (write?.kind !== 'verified')
        return {
          kind: 'uncertain',
          reason: 'Reservation append unknown; no call authorized',
          evidence: [],
        };
      const after = await ledger.read();
      if (
        after?.kind !== 'verified' ||
        after.value?.limitsApproved !== true ||
        !equalLimits(after.value.limits, approved) ||
        !validRows(after.value.reservations) ||
        !after.value.reservations.some(
          (r) =>
            r.key === reservation.key &&
            r.status === 'reserved' &&
            sameCandidate(r.candidate, c) &&
            equalLimits(r.limits, approved),
        )
      )
        return {
          kind: 'uncertain',
          reason: 'Reservation readback unknown; no call authorized',
          evidence: [],
        };
      if (admitReview(c, await ledger.observe(c), approved).kind !== 'verified')
        return blocked('Admission changed after reservation; retain slot for reconciliation');
      return verified(structuredClone(reservation));
    });
  } catch {
    return {
      kind: 'uncertain',
      reason: 'Ledger or lock unavailable; no call authorized',
      evidence: [],
    };
  }
}
