import { sameExecution } from './worker-results.mjs';
import { blocked, verified, exactFields, sha40 } from './contracts.mjs';
import { sameCandidate, validCandidate, operationKey } from './journal.mjs';
export function candidateOf(o) {
  const origin = o.admission?.candidate;
  return {
    ...(origin?.protocolVersion === 2
      ? { protocolVersion: 2, requestId: origin.requestId, baseRef: o.baseRef }
      : {}),
    repositoryId: o.repositoryId,
    pr: o.pr,
    base: o.base,
    head: o.head,
    attempt: o.readiness?.id,
  };
}
const none = (reason) => ({ action: 'none', reason });
/** Admission-time identity comes only from the trusted adapter's authenticated
 * retained proof and current native window. Legacy origin is safety history only.
 */
function verifiedReadyOrigin(o, c) {
  const origin = o.admission?.candidate ?? o.readiness?.candidate;
  return (
    validCandidate(origin) &&
    (origin.protocolVersion === 2
      ? o.admission?.proof?.version === 2
      : o.readiness?.candidateVerified === true) &&
    origin.repositoryId === c.repositoryId &&
    origin.pr === c.pr &&
    origin.attempt === c.attempt
  );
}
function readyCandidateMatches(o, c) {
  return (
    c.protocolVersion === 2 &&
    o.admission?.verified === true &&
    verifiedReadyOrigin(o, c) &&
    sameCandidate(o.admission.candidate, c)
  );
}
const originOf = (o) => o.admission?.candidate ?? o.readiness?.candidate;
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
  const decision = (action) => {
    const original = originOf(o);
    const identity =
      c.protocolVersion === 2 && ['draft', 'invalidate'].includes(action) ? original : c;
    return { action, candidate: identity, target: c, key: operationKey(identity, action) };
  };
  if (o.lifecycle.closedSinceReady)
    return evidenceInvalidated
      ? none('Closed readiness attempt invalidated')
      : decision('invalidate');
  if (o.state !== 'open' || o.draft || o.readiness.kind !== 'ready_for_review')
    return none('Current native Ready required');
  if (event.type === 'synchronize') {
    if (event.head !== c.head) {
      // The earlier attempt check rejects unrelated deliveries. A signed head
      // change for this same attempt remains invalidating evidence after restore;
      // its stale target can never authorize Draft against the current snapshot.
      if (
        c.protocolVersion === 2 &&
        verifiedReadyOrigin(o, c) &&
        sha40(event.head) &&
        !evidenceInvalidated
      )
        return decision('invalidate');
      return none('Superseded synchronization');
    }
    if (!verifiedReadyOrigin(o, c)) return none('Authenticated readiness origin required');
    if (originOf(o).head !== c.head) return decision('draft');
    if (originOf(o).base !== c.base && !evidenceInvalidated) return decision('invalidate');
    return none('Synchronize never admits CI');
  }
  if (evidenceInvalidated) return none('Attempt evidence invalidated; new Ready required');
  if (verifiedReadyOrigin(o, c) && !sameCandidate(originOf(o), c)) return decision('invalidate');
  if (!readyCandidateMatches(o, c)) return none('Authenticated current v2 admission required');
  if (
    event.type === 'verified_readiness' &&
    c.protocolVersion === 2 &&
    sameCandidate(event.candidate, c) &&
    event.proofDigest === o.admission?.proofDigest
  ) {
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
    if (event.worker === 'ci') return { ...decision('start-ci'), event };
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
  const target = decision.target ?? c;
  const uncertain = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
  const row = (phase) => ({
    version: c.protocolVersion === 2 ? 2 : 1,
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
    if (!matches(await port.observe(c), target, decision.action))
      return blocked('Candidate changed before transition');
    if (decision.action.startsWith('start-')) {
      if (c.protocolVersion === 2 && decision.action === 'start-ci') {
        const continuation = await port.resolveCiContinuation?.(decision.event);
        const claim = continuation?.value;
        if (
          continuation?.kind !== 'verified' ||
          !claim ||
          claim.id !== decision.event?.claimId ||
          claim.status !== 'observed' ||
          claim.start !== null ||
          claim.worker !== 'ci' ||
          claim.requestId !== c.requestId ||
          !sameCandidate(claim.candidate, c) ||
          !claim.run ||
          claim.definitionSha !== claim.run.sha ||
          !sameExecution(claim.run, decision.event?.run)
        )
          return blocked('Bound unused CI continuation required');
        const consumed = await port.consumeCiStart?.(claim.id, claim.run);
        if (consumed?.kind === 'uncertain') return consumed;
        const v = consumed?.value;
        if (
          consumed?.kind !== 'verified' ||
          !exactFields(v?.claim, [
            'id',
            'candidate',
            'worker',
            'requestId',
            'definitionSha',
            'status',
            'run',
            'start',
          ]) ||
          ['id', 'worker', 'requestId', 'definitionSha', 'status'].some(
            (k) => v.claim[k] !== claim[k],
          ) ||
          v?.newlyConsumed !== true ||
          v.claim?.id !== claim.id ||
          !sameCandidate(v.claim?.candidate, c) ||
          !sameExecution(v.claim?.run, claim.run) ||
          v.claim?.start?.claimId !== claim.id ||
          v.claim.start.runId !== claim.run.id ||
          v.claim.start.runAttempt !== claim.run.attempt ||
          !sameCandidate(v.claim.start.candidate, c) ||
          v.claim.start.definitionSha !== claim.definitionSha ||
          v.claim.start.state !== 'consumed'
        )
          return blocked('Fresh durable CI start consumption required');
        if (!matches(await port.observe(c), c, decision.action))
          return blocked('Candidate changed after consumption; retain claim');
      }
      return verified(c);
    }
    const before = await port.readJournal(c);
    if (before?.kind !== 'verified') return blocked('Ledger unavailable');
    if (before.value.some((r) => r.key === decision.key))
      return blocked('Existing intent requires explicit reconciliation');
    if (!(await persist('intent'))) return uncertain('Intent read-back failed');
    if (!matches(await port.observe(c), target, decision.action)) {
      await persist('quarantine');
      return uncertain('Candidate changed after intent');
    }
    if (decision.action === 'draft') {
      await port.draft(target, c);
      const after = await port.observe(c);
      if (
        !sameCandidate(candidateOf(after), target) ||
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
    } else if (!matches(await port.observe(c), target, decision.action)) {
      await persist('quarantine');
      return uncertain('Candidate changed before result');
    }
    if (!(await persist('result'))) return uncertain('Result read-back failed; work not admitted');
    if (decision.action !== 'draft' && !matches(await port.observe(c), target, decision.action)) {
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
