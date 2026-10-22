import { blocked, verified, validReadinessRequest, exactFields } from './contracts.mjs';
import { digest } from './journal.mjs';
import { readinessRequestBinding } from './readiness-request.mjs';
import { withReadinessOperation } from './readiness-operation.mjs';
import { verifyArchive } from './worker-transport.mjs';

const uncertain = () => ({
  kind: 'uncertain',
  reason: 'Readiness requires reconciliation',
  evidence: [],
});
const hash = (value) => digest(JSON.stringify(value));
const pairFields = ['repositoryId', 'pr', 'prNodeId', 'baseRef', 'base', 'head'];
const matches = (request, window) => pairFields.every((key) => request[key] === window?.[key]);
/** The digest covers the complete bounded native snapshot and ordered timeline,
 * not a timestamp projection. The archive must independently establish creation-
 * to-tail completeness and native order; repeated reads alone grant no trust.
 */
export function readinessWindowDigest(window) {
  const { evidenceDigest: _ignored, ...evidence } = window;
  return hash(evidence);
}
function validWindow(window) {
  return (
    window &&
    window.complete === true &&
    window.order === 'native' &&
    Array.isArray(window.events) &&
    window.events.length <= 1000 &&
    Buffer.byteLength(JSON.stringify(window)) <= 2_100_000 &&
    window.evidenceDigest === readinessWindowDigest(window) &&
    ['open', 'closed'].includes(window.state) &&
    typeof window.draft === 'boolean' &&
    window.events.every(
      (e) =>
        exactFields(e, ['id', 'kind', 'actorId']) &&
        typeof e.id === 'string' &&
        e.id.length > 0 &&
        e.id.length <= 128 &&
        typeof e.kind === 'string' &&
        typeof e.actorId === 'string',
    ) &&
    new Set(window.events.map((e) => e.id)).size === window.events.length
  );
}
/** trust is trusted configuration plus signed archive evidence, never dispatch
 * input. A caller-shaped verified wrapper cannot replace an actual Task A
 * receipt or the signature over exact complete before/after/mutation evidence.
 * This admits an observed pair only: no CAS, uninterrupted equality, event-time
 * SHAs or unique causal attribution is asserted, even with covered writers.
 */
export function verifyReadinessWindow(request, before, mutation, after, trust) {
  try {
    const binding = readinessRequestBinding(trust?.requestAuthentication);
    if (
      !validReadinessRequest(request) ||
      !binding ||
      JSON.stringify(binding.request) !== JSON.stringify(request) ||
      !validWindow(before) ||
      !validWindow(after) ||
      !matches(request, before) ||
      !matches(request, after) ||
      before.state !== 'open' ||
      !before.draft ||
      after.state !== 'open' ||
      after.draft ||
      !exactFields(mutation, [
        'requestId',
        'prNodeId',
        'clientMutationId',
        'ready',
        'responseDigest',
      ]) ||
      mutation.requestId !== request.requestId ||
      mutation.prNodeId !== request.prNodeId ||
      mutation.clientMutationId !== request.requestId ||
      mutation.ready !== true ||
      !/^[a-f0-9]{64}$/.test(mutation.responseDigest)
    )
      return blocked('Readiness window precondition');
    const prefix = after.events.slice(0, before.events.length);
    const added = after.events.slice(before.events.length);
    if (
      JSON.stringify(prefix) !== JSON.stringify(before.events) ||
      added.length !== 1 ||
      added[0].kind !== 'ready_for_review' ||
      added[0].actorId !== trust.controllerRun?.actorId
    )
      return blocked('Ambiguous native lifecycle boundary');
    const expected = readinessWindowBindings(request, before, mutation, after, trust.controllerRun);
    if (verifyArchive(trust.envelope, expected, trust.publicKey).kind !== 'verified')
      return blocked('Complete registered writer coverage unavailable');
    const witnessId = added[0].id;
    return verified({
      version: 2,
      request: { ...request },
      candidate: {
        repositoryId: request.repositoryId,
        pr: request.pr,
        base: request.base,
        head: request.head,
        attempt: witnessId,
        baseRef: request.baseRef,
        requestId: request.requestId,
        protocolVersion: 2,
      },
      beforeDigest: before.evidenceDigest,
      afterDigest: after.evidenceDigest,
      mutationDigest: hash(mutation),
      witnessId,
      originalRunId: request.originalRunId,
      runAttempt: binding.run.attempt,
      definitionSha: request.definitionSha,
    });
  } catch {
    return blocked('Malformed or unauthenticated readiness evidence');
  }
}
export function readinessWindowBindings(request, before, mutation, after, run) {
  return {
    purpose: 'readiness-window',
    run,
    requestDigest: hash(request),
    beforeDigest: before.evidenceDigest,
    afterDigest: after.evidenceDigest,
    mutationDigest: hash(mutation),
    writerActorId: run?.actorId,
    writerCoverage: 'complete',
    writerPath: 'readiness-controller-v2',
  };
}
/** Single-lock standalone composition. D may compose the exported in-scope
 * implementation inside its own withReadinessOperation callback; it must not
 * call this wrapper from another PR lock. The store remains B's trusted facade.
 */
export async function runReadinessHandshake(input, port) {
  // Capture plain schema values before B's authorization/lock awaits. The caller
  // keeps ownership of input and cannot replace this request during reservation.
  const request = Object.freeze({ ...input });
  if (!validReadinessRequest(request)) return blocked('Malformed readiness request');
  return withReadinessOperation(request, port.readinessStore, (scope) =>
    runReadinessHandshakeInScope(request, port, scope),
  );
}
export async function runReadinessHandshakeInScope(input, port, scope) {
  try {
    // D may enter with its own B scope. Validate the supplied identity once,
    // before observation, then use only the authenticated scope's value snapshot.
    const supplied = { ...input };
    const request = Object.freeze({ ...scope.operation?.request });
    if (
      !validReadinessRequest(supplied) ||
      !validReadinessRequest(request) ||
      Object.keys(request).some((key) => supplied[key] !== request[key])
    )
      return blocked('Request does not match authenticated operation');
    if (!scope.newReservation)
      return blocked('Existing readiness operation requires reconciliation');
    const first = await port.observeReadinessWindow(request);
    if (first?.kind !== 'verified')
      return first?.kind === 'uncertain' ? uncertain() : blocked('Draft observation unavailable');
    const before = structuredClone(first.value);
    if (
      !validWindow(before) ||
      !matches(request, before) ||
      before.state !== 'open' ||
      !before.draft
    )
      return blocked('Requested Draft pair changed');
    const prepared = await scope.recordPhase('mutation-pending', { before });
    if (prepared.kind !== 'verified') return prepared;
    const sent = await scope.mutate(async () => {
      const immediate = await port.observeReadinessWindow(request);
      if (
        immediate?.kind !== 'verified' ||
        JSON.stringify(immediate.value) !== JSON.stringify(before)
      )
        return blocked('Immediate Draft boundary changed');
      return port.markReady(request);
    });
    if (sent.kind !== 'verified') return sent;
    const observed = await port.observeReadinessWindow(request);
    if (observed?.kind !== 'verified') return uncertain();
    const after = structuredClone(observed.value),
      mutation = structuredClone(sent.value);
    const trust = await port.authenticateReadinessWindow(request, before, mutation, after);
    const checked = verifyReadinessWindow(request, before, mutation, after, trust);
    if (checked.kind !== 'verified') return checked;
    // Mandatory latest native tail/pair recheck before proof publication.
    const latest = await port.observeReadinessWindow(request);
    if (latest?.kind !== 'verified' || JSON.stringify(latest.value) !== JSON.stringify(after))
      return blocked('Latest native boundary changed');
    const recorded = await scope.recordPhase('mutation-observed', { before, mutation, after });
    if (recorded.kind !== 'verified') return recorded;
    const publication = await port.publishReadinessProof(checked.value);
    if (
      publication?.kind !== 'verified' ||
      JSON.stringify(publication.value) !== JSON.stringify(checked.value)
    )
      return uncertain();
    const final = await port.observeReadinessWindow(request);
    if (final?.kind !== 'verified' || JSON.stringify(final.value) !== JSON.stringify(after))
      return blocked('Native boundary changed during proof publication');
    const accepted = await scope.recordPhase('accepted', {
      before,
      mutation,
      after,
      proof: publication.value,
    });
    return accepted.kind === 'verified' ? checked : accepted;
  } catch {
    return uncertain();
  }
}
