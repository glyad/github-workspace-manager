import { blocked, verified } from './contracts.mjs';
import { sameCandidate, validCandidate, operationKey } from './journal.mjs';
export function candidateOf(o) {
  return {
    repositoryId: o.repositoryId,
    pr: o.pr,
    base: o.base,
    head: o.head,
    attempt: o.readiness?.id,
  };
}
const none = (reason) => ({ action: 'none', reason });
/** Supplied only by the trusted observation adapter, never by the event payload.
 * It must establish the native Ready transition's event-time base/head, not merely
 * observe the current PR while that Ready event remains the latest attempt.
 */
function verifiedReadyOrigin(o, c) {
  const origin = o.readiness?.candidate;
  return (
    o.readiness?.candidateVerified === true &&
    validCandidate(origin) &&
    origin.repositoryId === c.repositoryId &&
    origin.pr === c.pr &&
    origin.attempt === c.attempt
  );
}
function readyCandidateMatches(o, c) {
  return verifiedReadyOrigin(o, c) && sameCandidate(o.readiness.candidate, c);
}
function verifiedLifecycle(o, c) {
  return (
    o.lifecycle?.verified === true &&
    o.lifecycle.attempt === c.attempt &&
    typeof o.lifecycle.closedSinceReady === 'boolean'
  );
}
const sameAttempt = (a, b) =>
  a.repositoryId === b.repositoryId && a.pr === b.pr && a.attempt === b.attempt;
export function decideReadiness(o, event, journal) {
  if (journal?.kind !== 'verified' || !Array.isArray(journal.value))
    return none('Authenticated ledger required');
  const c = candidateOf(o);
  if (!validCandidate(c) || !o.nativeVerified || !o.sameRepository || !verifiedLifecycle(o, c))
    return none('Current native Ready and trusted repository required');
  if (event.repositoryId !== c.repositoryId || event.pr !== c.pr || event.readinessId !== c.attempt)
    return none('Superseded or unrelated event');
  const rows = journal.value;
  const current = rows.filter((r) => sameCandidate(r.candidate, c));
  const attemptRows = rows.filter((r) => sameAttempt(r.candidate, c));
  const invalidations = attemptRows.filter((r) => r.action === 'invalidate');
  const unfinishedInvalidation = invalidations.some(
    (r) =>
      r.phase === 'intent' &&
      !invalidations.some((other) => other.key === r.key && other.phase === 'result'),
  );
  if (
    attemptRows.some((r) => r.phase === 'quarantine' || r.action === 'draft') ||
    unfinishedInvalidation
  )
    return none('Quarantined or unresolved attempt requires reconciliation');
  const evidenceInvalidated = invalidations.length > 0;
  const admitted = current.some((r) => r.action === 'admit-ci' && r.phase === 'result');
  const success = (action) => current.some((r) => r.action === action && r.phase === 'result');
  const decision = (action) => ({ action, candidate: c, key: operationKey(c, action) });
  if (o.lifecycle.closedSinceReady)
    return evidenceInvalidated
      ? none('Closed readiness attempt invalidated')
      : decision('invalidate');
  if (o.state !== 'open' || o.draft || o.readiness.kind !== 'ready_for_review')
    return none('Current native Ready required');
  if (event.type === 'synchronize') {
    if (event.head !== c.head) return none('Superseded synchronization');
    if (!verifiedReadyOrigin(o, c))
      return none('Authenticated event-time Ready candidate required');
    if (o.readiness.candidate.head !== c.head) return decision('draft');
    if (o.readiness.candidate.base !== c.base && !evidenceInvalidated)
      return decision('invalidate');
    return none('Synchronize never admits CI');
  }
  if (evidenceInvalidated) return none('Attempt evidence invalidated; new Ready required');
  if (verifiedReadyOrigin(o, c) && !sameCandidate(o.readiness.candidate, c))
    return decision('invalidate');
  if (!readyCandidateMatches(o, c))
    return none(
      'Candidate drifted since Ready or event-time identity is unverified; require a new Ready cycle',
    );
  if (event.type === 'ready_for_review') {
    if (
      rows.some(
        (r) =>
          r.candidate.repositoryId === c.repositoryId &&
          r.candidate.pr === c.pr &&
          r.candidate.attempt === c.attempt,
      )
    )
      return none('Attempt already recorded or identity drifted');
    return decision('admit-ci');
  }
  if (!admitted || !sameCandidate(event.candidate, c)) return none('Missing exact admission');
  if (event.type === 'worker_start') {
    if (event.worker === 'ci') return decision('start-ci');
    if (event.worker === 'review' && success('ci-success')) return decision('start-review');
  }
  if (
    event.type === 'worker_completed' &&
    event.workerVerified === true &&
    ['ci', 'review'].includes(event.worker) &&
    (event.worker === 'ci' || success('ci-success'))
  ) {
    if (event.outcome === 'failure') return decision('draft');
    if (event.outcome === 'success') {
      const action = `${event.worker}-success`;
      return rows.some((r) => r.key === operationKey(c, action))
        ? none('Completion already recorded')
        : decision(action);
    }
  }
  return none('No admitted transition');
}
function matches(o, c, action) {
  if (
    !sameCandidate(candidateOf(o), c) ||
    !o.nativeVerified ||
    !o.sameRepository ||
    !verifiedLifecycle(o, c)
  )
    return false;
  return (
    !o.lifecycle.closedSinceReady &&
    (action === 'draft' ? verifiedReadyOrigin(o, c) : readyCandidateMatches(o, c)) &&
    !o.draft &&
    o.state === 'open' &&
    o.readiness.kind === 'ready_for_review'
  );
}
/** Caller MUST hold the same per-PR lock used by all worker start/completion paths.
 * GitHub readiness mutation is not atomic with candidate comparison.
 */
export async function reconcileTransition(port, decision) {
  if (!decision || decision.action === 'none') return blocked(decision?.reason || 'No transition');
  const c = decision.candidate;
  const uncertain = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
  const row = (phase) => ({
    version: 1,
    key: decision.key,
    action: decision.action,
    candidate: c,
    phase,
  });
  const persist = async (phase) => {
    const record = row(phase);
    const write = await port.append(record);
    if (write?.kind !== 'verified') return false;
    const read = await port.readJournal(c);
    return (
      read?.kind === 'verified' &&
      read.value.some(
        (r) =>
          r.key === record.key &&
          r.phase === phase &&
          r.action === record.action &&
          sameCandidate(r.candidate, c),
      )
    );
  };
  try {
    if (decision.action === 'invalidate') {
      // Retain the already authenticated observation as an attempt-scoped fact.
      // Recording it never mutates PR state or accepts a worker result, so a
      // restored candidate or later Ready attempt cannot erase that observation.
      const before = await port.readJournal(c);
      if (before?.kind !== 'verified') return blocked('Ledger unavailable');
      if (before.value.some((r) => r.key === decision.key))
        return blocked('Existing invalidation requires reconciliation');
      if (!(await persist('intent'))) return uncertain('Invalidation intent read-back failed');
      if (!(await persist('result'))) return uncertain('Invalidation result read-back failed');
      return blocked('Observed readiness attempt invalidated; new Ready required');
    }
    if (!matches(await port.observe(c), c, decision.action))
      return blocked('Candidate changed before transition');
    if (decision.action.startsWith('start-')) return verified(c);
    const before = await port.readJournal(c);
    if (before?.kind !== 'verified') return blocked('Ledger unavailable');
    if (before.value.some((r) => r.key === decision.key))
      return blocked('Existing intent requires explicit reconciliation');
    if (!(await persist('intent'))) return uncertain('Intent read-back failed');
    if (!matches(await port.observe(c), c, decision.action)) {
      await persist('quarantine');
      return uncertain('Candidate changed after intent');
    }
    if (decision.action === 'draft') {
      await port.draft(c);
      const after = await port.observe(c);
      if (
        !sameCandidate(candidateOf(after), c) ||
        after.draft !== true ||
        !after.nativeVerified ||
        !after.sameRepository ||
        after.state !== 'open' ||
        !verifiedLifecycle(after, c) ||
        after.lifecycle.closedSinceReady
      ) {
        await persist('quarantine');
        return uncertain('Readiness race: reconcile quarantined attempt; never auto-restore Ready');
      }
    } else if (!matches(await port.observe(c), c, decision.action)) {
      await persist('quarantine');
      return uncertain('Candidate changed before result');
    }
    if (!(await persist('result'))) return uncertain('Result read-back failed; work not admitted');
    if (decision.action !== 'draft' && !matches(await port.observe(c), c, decision.action)) {
      await persist('quarantine');
      return uncertain('Candidate changed after result');
    }
    return ['draft', 'invalidate'].includes(decision.action)
      ? blocked('Current attempt invalidated; a new deliberate Ready cycle is required')
      : verified(c);
  } catch {
    try {
      await persist('quarantine');
    } catch {
      /* Keep uncertainty when durable writes fail. */
    }
    return uncertain('Unknown transition outcome; explicit reconciliation required');
  }
}
