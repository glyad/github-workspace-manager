import { authenticateReadinessRequest, readinessRequestBinding } from './readiness-request.mjs';
import { withReadinessOperation } from './readiness-operation.mjs';
import { runReadinessHandshakeInScope } from './readiness-handshake.mjs';
import { admitCandidate, admitCandidateInScope, inactivePort } from './admission.mjs';
import { boundedJson, verifyArchive } from './worker-transport.mjs';
import { digest } from './journal.mjs';
import { blocked } from './contracts.mjs';
/** Data-only event boundary. Trust configuration and transport are injected by
 * trusted code, never read from payload, PR files, environment or candidate checkout.
 */
export async function handleTrustedEvent(
  { body, archive },
  { port, expectedRun, publicKey, mode = 'production', productionBackend = null } = {},
) {
  if (mode !== 'offline-test' || productionBackend !== null)
    return admitCandidate(inactivePort(), {});
  try {
    const proof = verifyArchive(
      archive,
      { purpose: 'controller-event', run: expectedRun, bodyDigest: digest(body) },
      publicKey,
    );
    if (proof.kind !== 'verified') return proof;
    const raw = boundedJson(body, 262144);
    const pr = raw.pull_request;
    if (
      raw.repository?.id?.toString() !== expectedRun.repositoryId ||
      !Number.isSafeInteger(pr?.number) ||
      pr.number <= 0 ||
      ![
        'ready_for_review',
        'synchronize',
        'converted_to_draft',
        'closed',
        'reopened',
        'edited',
      ].includes(raw.action)
    )
      return blocked('Unmapped event');
    // Attempt identity comes from the authenticated archived delivery, not body assertions.
    if (typeof proof.value.readinessId !== 'string')
      return blocked('Missing native event identity');
    const event = {
      type: raw.action,
      repositoryId: expectedRun.repositoryId,
      pr: pr.number,
      readinessId: proof.value.readinessId,
      head: pr.head?.sha,
    };
    return await admitCandidate(port, event);
  } catch {
    return blocked('Unverified event input');
  }
}
/** Worker callbacks use the same Task6 lock and admission function. Candidate and
 * outcome claims are data until exact callback archive AND worker result pass.
 */
export async function handleTrustedWorkerCallback(
  { body, archive },
  { port, expectedRun, publicKey, mode = 'production', productionBackend = null } = {},
) {
  if (mode !== 'offline-test' || productionBackend !== null)
    return blocked('Production backend unselected');
  try {
    const raw = boundedJson(body, 262144);
    // Preserve the independently authenticated callback execution across awaits;
    // a mutable review mapping cannot rewrite the signed invocation in place.
    const callbackRun = Object.freeze({ ...expectedRun });
    const proof = verifyArchive(
      archive,
      {
        purpose: 'worker-callback',
        run: callbackRun,
        bodyDigest: digest(body),
        candidate: raw.candidate,
        worker: raw.worker,
      },
      publicKey,
    );
    if (
      proof.kind !== 'verified' ||
      !['ci', 'review'].includes(raw.worker) ||
      !['worker_start', 'worker_completed'].includes(raw.type)
    )
      return blocked('Callback binding');
    if ((await port.verifyWorkerCallback(raw, callbackRun))?.kind !== 'verified')
      return blocked('Unverified worker mapping');
    const c = raw.candidate;
    return await admitCandidate(port, {
      type: raw.type,
      repositoryId: c.repositoryId,
      pr: c.pr,
      readinessId: c.attempt,
      candidate: c,
      worker: raw.worker,
      outcome: raw.outcome,
      claimId: raw.claimId,
      run: callbackRun,
    });
  } catch {
    return blocked('Malformed worker callback');
  }
}

/** Authenticated dispatch request, one durable operation scope, one existing gate.
 * requestContext and its exact-byte evidence resolver are trusted configuration.
 */
export async function handleTrustedReadinessRequest({ body, archive }, context = {}) {
  if (context.mode !== 'offline-test' || context.productionBackend != null)
    return blocked('Production backend unselected');
  try {
    const authenticated = await authenticateReadinessRequest(body, {
      ...context.requestContext,
      verifyRequestEvidence: (exact, bindings) =>
        context.requestContext.verifyRequestEvidence(exact, bindings, archive),
    });
    if (authenticated.kind !== 'verified') return authenticated;
    const request = Object.freeze({ ...authenticated.value });
    const port = context.port;
    const binding = readinessRequestBinding(authenticated);
    const facade = {
      ...port.readinessStore,
      authorizeReadinessRequest: async (q) => {
        const receipt = await port.readinessStore.authorizeReadinessRequest(q);
        const checked = readinessRequestBinding(receipt);
        return checked &&
          [
            'id',
            'attempt',
            'repositoryId',
            'actorId',
            'workflowId',
            'sha',
            'executionSha',
            'ref',
            'event',
          ].every((k) => checked.run[k] === binding.run[k])
          ? receipt
          : blocked('Invocation receipt changed');
      },
    };
    return await withReadinessOperation(request, facade, async (scope) => {
      const result = await runReadinessHandshakeInScope(request, port, scope);
      if (result.kind !== 'verified') return result;
      const proof = result.value;
      return admitCandidateInScope(port, {
        type: 'verified_readiness',
        repositoryId: request.repositoryId,
        pr: request.pr,
        readinessId: proof.witnessId,
        candidate: proof.candidate,
        proofDigest: digest(JSON.stringify(proof)),
      });
    });
  } catch {
    return blocked('Readiness composition unavailable');
  }
}
