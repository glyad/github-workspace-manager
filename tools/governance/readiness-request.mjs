import { createHash } from 'node:crypto';
import {
  blocked,
  verified,
  boundedId,
  sha40,
  validBaseRef,
  validReadinessRequest,
} from './contracts.mjs';

const receipts = new WeakMap();
const hash = (body) => createHash('sha256').update(body).digest('hex');
/** Only authenticateReadinessRequest can create a receipt. Copies and wire-level verified wrappers have no authority. */
export const readinessRequestBinding = (result) => receipts.get(result);
const validRun = (run, request, definition, attempt) =>
  run &&
  run.id === request.originalRunId &&
  run.attempt === attempt &&
  run.repositoryId === request.repositoryId &&
  run.actorId === request.initiatingActorId &&
  run.workflowId === definition.workflowId &&
  run.sha === definition.sha &&
  run.executionSha === definition.sha &&
  run.ref === definition.ref &&
  run.event === 'workflow_dispatch';

/** Context is trusted configuration/transport, never dispatch input.
 * lookupRun(id, attempt) resolves original and current attempts independently.
 * verifyRequestEvidence(exactBody, bindings) authenticates original dispatch bytes AND current attempt attribution.
 * resolvePr(repositoryId, pr) resolves immutable PR identity; it must not replace the user-selected pair.
 * This function reads only; it grants no admission, mutation, storage, or worker permission.
 */
export async function authenticateReadinessRequest(body, context) {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 16384)
      return blocked('Readiness request byte limit');
    const request = JSON.parse(body);
    if (!validReadinessRequest(request)) return blocked('Malformed readiness request');
    const definition = context?.approvedDefinition;
    if (
      !definition ||
      !Object.isFrozen(definition) ||
      !boundedId(definition.repositoryId) ||
      !boundedId(definition.workflowId) ||
      !sha40(definition.sha) ||
      !validBaseRef(definition.ref) ||
      definition.repositoryId !== request.repositoryId ||
      definition.workflowId !== request.workflowId ||
      definition.sha !== request.definitionSha ||
      !Array.isArray(context.authorizedActorIds) ||
      !context.authorizedActorIds.includes(request.initiatingActorId) ||
      context.runId !== request.originalRunId ||
      !Number.isSafeInteger(context.runAttempt) ||
      context.runAttempt < 1
    )
      return blocked('Unapproved definition, initiator or invocation');
    // Snapshot trusted configuration before awaits; a rerun cannot substitute another request/run/actor.
    const approved = { ...definition },
      attempt = context.runAttempt;
    const originalResult = await context.lookupRun(request.originalRunId, 1);
    if (
      originalResult?.kind !== 'verified' ||
      !validRun(originalResult.value, request, approved, 1)
    )
      return blocked('Untrusted original dispatch');
    const originalRun = structuredClone(originalResult.value);
    const currentResult = await context.lookupRun(request.originalRunId, attempt);
    if (
      currentResult?.kind !== 'verified' ||
      !validRun(currentResult.value, request, approved, attempt)
    )
      return blocked('Untrusted rerun attribution');
    const currentRun = structuredClone(currentResult.value);
    const pr = await context.resolvePr(request.repositoryId, request.pr);
    if (
      pr?.kind !== 'verified' ||
      pr.value?.repositoryId !== request.repositoryId ||
      pr.value.pr !== request.pr ||
      pr.value.prNodeId !== request.prNodeId
    )
      return blocked('PR immutable identity mismatch');
    const evidence = await context.verifyRequestEvidence(body, {
      originalRun,
      currentRun,
      definition: approved,
    });
    const binding = evidence?.value;
    if (
      evidence?.kind !== 'verified' ||
      binding?.bodyDigest !== hash(body) ||
      binding.originalRunId !== request.originalRunId ||
      binding.runAttempt !== attempt ||
      binding.definitionSha !== request.definitionSha ||
      binding.triggeringActorId !== currentRun.actorId
    )
      return blocked('Dispatch bytes or attempt evidence unverified');
    const value = Object.freeze({ ...request });
    const result = verified(value, [
      {
        source: 'readiness-request',
        // Local authentication observation time, never a native event-time claim.
        observedAt: new Date().toISOString(),
        actorId: currentRun.actorId,
        resourceId: request.originalRunId,
        revision: String(attempt),
        digest: hash(body),
      },
    ]);
    // Freeze both receipt and attributed run snapshots so later mutation cannot turn one receipt into another.
    receipts.set(
      result,
      Object.freeze({
        request: value,
        run: Object.freeze(currentRun),
        originalRun: Object.freeze(originalRun),
        bodyDigest: hash(body),
      }),
    );
    return result;
  } catch {
    return blocked('Readiness authentication unavailable or malformed');
  }
}
