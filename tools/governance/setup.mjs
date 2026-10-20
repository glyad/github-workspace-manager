import { randomUUID } from 'node:crypto';
import { isEvidenceFor, isSetupPath, validateDesired, validateSnapshot } from './validate.mjs';
import { blocked, verified } from './contracts.mjs';

/** Read-only; verified preflight does not activate mutation authority or SDLC. */
export async function preflightSetup(port, desired) {
  const problem = validateDesired(desired);
  if (problem) return blocked(problem);
  let result;
  try { result = await port.observeSetup(desired); }
  catch { return { kind: 'uncertain', reason: 'Preflight observation unavailable', evidence: [] }; }
  if (result.kind !== 'verified') return result;
  const s = result.value;
  const evidence = result.evidence;
  const invalid = validateSnapshot({ ...s, desired, evidence });
  if (invalid) return blocked(invalid, evidence);
  return verified(structuredClone({ ...s, desired, evidence, observedAt: new Date().toISOString() }), evidence);
}

/** Pure scope record. No remote bypass is installed by opening a session. */
export function openSetupSession(snapshot, approvedPaths, existingActor) {
  if (validateSnapshot(snapshot)) return blocked('Verified preflight snapshot required');
  if (!snapshot.repository.exists || !snapshot.repository.id) return blocked('Actual repository ID required; rerun preflight after creation');
  if (existingActor?.login !== 'glyad' || existingActor.id !== snapshot.actor.id) return blocked('Existing authenticated maintainer account required');
  if (!Array.isArray(approvedPaths) || !approvedPaths.length || approvedPaths.some((path) => !isSetupPath(path))) return blocked('Out-of-scope setup path');
  return verified({ operationId: randomUUID(), repositoryId: snapshot.repository.id, fullName: snapshot.desired.fullName,
    actor: structuredClone(existingActor), destination: snapshot.desired.destination, snapshot: structuredClone(snapshot),
    beforeRules: structuredClone(snapshot.rules), desiredRules: { mainForcePushBlocked: true, mainDeletionBlocked: true, temporaryBypassAbsent: true, routingVerified: true },
    approvedPaths: [...new Set(approvedPaths)], approvedOperations: ['baseline-files', 'repository-settings', 'project-baseline', 'restore-protections'],
    startedAt: new Date().toISOString(), endedAt: null, state: 'open', ordinaryWorkAllowed: false,
    outstandingWork: ['Signed baseline', 'Project baseline', 'Effective safeguard restoration', 'Automation activation gates'],
  }, snapshot.evidence);
}
export function authorizeSetupPath(session, path) {
  return session?.state === 'open' && isSetupPath(path) && session.approvedPaths.includes(path)
    ? verified({ path, operationId: session.operationId }) : blocked('Path outside this open setup session');
}

/** A verified journal append identifies the exact durably persisted record. */
async function persistClosureRecord(port, session, record) {
  const result = await port.appendJournal(session.operationId, record);
  if (['blocked', 'conflict', 'uncertain'].includes(result?.kind)) return result;
  if (result?.kind !== 'verified' || !isEvidenceFor(result.evidence, session.actor?.id, [session.operationId]) ||
      ['operationId', 'repositoryId', 'phase'].some((key) => result.value?.[key] !== record[key])) {
    return blocked(`Unverified ${record.phase} journal persistence; session remains open`);
  }
  return result;
}

/** Task 4 supplies trusted restoration methods; acknowledgements never prove closure. */
export async function closeSetupSession(port, session) {
  if (session?.state !== 'open' || !session.repositoryId) return blocked('Open identified setup session required');
  session.ordinaryWorkAllowed = false;
  try {
    const intent = await persistClosureRecord(port, session, { phase: 'closure-intent', operationId: session.operationId, repositoryId: session.repositoryId });
    if (intent.kind !== 'verified') return intent;
    try { await port.restoreSetupProtections(structuredClone(session)); } catch { /* reconcile lost responses below */ }
    const observed = await port.observeProtections(session.repositoryId);
    const v = observed.value;
    const restored = observed.kind === 'verified' && isEvidenceFor(observed.evidence, session.actor?.id, [session.repositoryId]) && v?.repositoryId === session.repositoryId && ['mainForcePushBlocked', 'mainDeletionBlocked', 'temporaryBypassAbsent', 'routingVerified'].every((key) => v[key] === true);
    const persisted = await persistClosureRecord(port, session, { phase: restored ? 'closed' : 'closure-blocked', operationId: session.operationId, repositoryId: session.repositoryId, evidence: observed.evidence ?? [] });
    if (persisted.kind !== 'verified') return persisted;
    if (!restored) return blocked('Effective safeguard restoration unverified; ordinary work remains blocked', observed.evidence ?? []);
    session.state = 'closed'; session.endedAt = new Date().toISOString();
    return verified({ repositoryId: session.repositoryId, verified: true, observed: v, ordinaryWorkAllowed: false }, observed.evidence);
  } catch { return blocked('Restoration or journal persistence failed; session remains open'); }
}

/** Recovery only: never invokes create, including after an observed absence. */
export async function reconcileRepositoryCreation(port, operation) {
  if (operation?.fullName !== 'glyad/github-workspace-manager' || !operation.operationId || typeof operation.actorId !== 'string' || !operation.actorId) return blocked('Identified repository creation operation and expected authenticated actor required');
  try {
    const journal = await port.readJournal(operation.operationId);
    if (['blocked', 'conflict', 'uncertain'].includes(journal?.kind)) return journal;
    if (journal?.kind !== 'verified' || !isEvidenceFor(journal.evidence, operation.actorId, [operation.operationId]) || !Array.isArray(journal.value)) return blocked('Unverified repository creation journal read');
    if (!journal.value.some((row) => row.phase === 'create-intent' && row.operationId === operation.operationId && row.fullName === operation.fullName)) return blocked('Missing exact repository creation intent');
    const observed = await port.observeRepository(operation.fullName);
    if (observed.kind !== 'verified') return observed;
    const r = observed.value;
    if (!isEvidenceFor(observed.evidence, operation.actorId, [r?.id ?? operation.fullName])) return blocked('Repository observation evidence identity mismatch');
    if (!r) return { kind: 'uncertain', reason: 'Creation outcome unresolved; reconcile before an explicit retry decision', evidence: observed.evidence };
    if (!r.id || r.fullName !== operation.fullName || r.ownerLogin !== 'glyad' || r.visibility !== 'public') return { kind: 'conflict', reason: 'Observed repository differs from approved creation identity', evidence: observed.evidence };
    return verified(r, observed.evidence);
  } catch { return { kind: 'uncertain', reason: 'Creation reconciliation unavailable; do not retry blindly', evidence: [] }; }
}
