import { dispatchAdmittedCi, reconcileCiDispatch } from './worker-dispatch.mjs';
import { authenticateReadinessRequest, readinessRequestBinding } from './readiness-request.mjs';
import { withReadinessOperation } from './readiness-operation.mjs';
import { runReadinessHandshakeInScope } from './readiness-handshake.mjs';
import { admitCandidate, admitCandidateInScope, inactivePort } from './admission.mjs';
import { boundedJson, verifyArchive } from './worker-transport.mjs';
import { digest } from './journal.mjs';
import {
  blocked,
  verified,
  exactFields,
  boundedId,
  sha40,
  validBaseRef,
  requestId,
} from './contracts.mjs';
import { createGithubPort } from './github-port.mjs';
import { sameCandidate } from './journal.mjs';
import { validDispatchClaim } from './worker-transport.mjs';
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

/** Explicit trusted continuation entry, closed in every unselected live mode.
 * Candidate input supplies no authority; E reuses D's fresh shared admission. */
export async function handleTrustedCiContinuation(input, context = {}) {
  if (context.mode !== 'offline-test' || context.productionBackend != null)
    return blocked('Production backend unselected');
  const snapshot = structuredClone(input);
  return snapshot?.claimId
    ? reconcileCiDispatch(snapshot.claimId, context.port)
    : dispatchAdmittedCi(snapshot?.candidate, context.port);
}

/** Dormant composition. Only trusted code supplies providers/configuration; no
 * input, environment or candidate checkout can select an identity or backend.
 * The store authorizer must retain/revalidate the original dispatch evidence.
 */
export function createReadinessRuntime(config = {}) {
  const enabled = config.mode === 'offline-test' && config.productionBackend == null;
  const denied = () => blocked('Production backend unselected');
  const message = (result) => ({
    ...result,
    message:
      result.kind === 'verified'
        ? 'Ready and admitted for these commits'
        : 'Not admitted; reconciliation required',
  });
  if (!enabled)
    return Object.freeze({
      command: async () => message(denied()),
      ciCallback: async () => denied(),
      reconcileCi: async () => denied(),
    });
  // Copy authoritative scalar configuration at construction, before any await.
  const source = config.portConfig,
    q = config.requestContext,
    publicKey = source.publicKey;
  const requestContext = Object.freeze({
    ...q,
    authorizedActorIds: Object.freeze([...q.authorizedActorIds]),
    approvedDefinition: Object.freeze({ ...q.approvedDefinition }),
  });
  const port = createGithubPort({
    ...source,
    controllerRun: Object.freeze({ ...source.controllerRun }),
    workers: Object.freeze(
      Object.fromEntries(
        Object.entries(source.workers ?? {}).map(([name, run]) => [
          name,
          Object.freeze({ ...run }),
        ]),
      ),
    ),
    // Deliberately select E's concrete store adapters, never D's injection seam.
    ciContinuation: {
      approvedDefinition: Object.freeze({ ...source.ciContinuation?.approvedDefinition }),
    },
  });
  const context = Object.freeze({ mode: 'offline-test', port, requestContext });
  return Object.freeze({
    async command(input) {
      try {
        const data = structuredClone(input);
        const i = data?.inputs;
        if (
          !exactFields(i, [
            'pr',
            'expected_base_ref',
            'expected_base_sha',
            'expected_head_sha',
            'request_id',
            'protocol_version',
          ]) ||
          Object.values(i).some((value) => typeof value !== 'string' || value.length > 255) ||
          !sha40(i.expected_base_sha) ||
          !sha40(i.expected_head_sha) ||
          !validBaseRef(i.expected_base_ref) ||
          !requestId(i.request_id) ||
          !/^[1-9][0-9]{0,15}$/.test(i.pr) ||
          !Number.isSafeInteger(Number(i.pr)) ||
          i.protocol_version !== '2'
        )
          return message(blocked('Malformed command inputs'));
        const original = await requestContext.lookupRun(requestContext.runId, 1);
        if (original?.kind !== 'verified')
          return message(blocked('Original invocation unavailable'));
        const initiatingActorId = original.value?.actorId;
        const pr = await requestContext.resolvePr(
          requestContext.approvedDefinition.repositoryId,
          Number(i.pr),
        );
        if (pr?.kind !== 'verified') return message(blocked('PR identity unavailable'));
        const request = {
          protocolVersion: 2,
          requestId: i.request_id,
          repositoryId: requestContext.approvedDefinition.repositoryId,
          pr: Number(i.pr),
          prNodeId: pr.value?.prNodeId,
          baseRef: i.expected_base_ref,
          base: i.expected_base_sha,
          head: i.expected_head_sha,
          initiatingActorId,
          originalRunId: requestContext.runId,
          workflowId: requestContext.approvedDefinition.workflowId,
          definitionSha: requestContext.approvedDefinition.sha,
        };
        const admitted = await handleTrustedReadinessRequest(
          { body: JSON.stringify(request), archive: data.archive },
          context,
        );
        if (admitted.kind !== 'verified') return message(admitted);
        const candidate = Object.freeze(structuredClone(admitted.value));
        const continued = await handleTrustedCiContinuation({ candidate }, context);
        if (continued.kind !== 'verified') return message(continued);
        return message(verified({ candidate, claimId: continued.value.id }));
      } catch {
        return message(blocked('Command evidence unavailable'));
      }
    },
    async ciCallback(input) {
      try {
        const data = structuredClone(input),
          raw = boundedJson(data.body, 262144);
        if (
          !exactFields(raw, ['type', 'candidate', 'worker', 'outcome', 'claimId']) ||
          raw.worker !== 'ci' ||
          !['worker_start', 'worker_completed'].includes(raw.type) ||
          !['success', 'failure'].includes(raw.outcome) ||
          !boundedId(raw.claimId)
        )
          return blocked('Malformed CI callback');
        const read = await port.readCiContinuation(raw.claimId);
        if (read?.kind !== 'verified' || !validDispatchClaim(read.value))
          return blocked('CI claim unavailable');
        const claim = structuredClone(read.value);
        if (
          data.dispatchInputs &&
          (!exactFields(data.dispatchInputs, [
            'claim_id',
            'request_id',
            'candidate',
            'definition_sha',
          ]) ||
            data.dispatchInputs.claim_id !== claim.id ||
            data.dispatchInputs.request_id !== claim.requestId ||
            data.dispatchInputs.definition_sha !== claim.definitionSha ||
            !sameCandidate(boundedJson(data.dispatchInputs.candidate, 16384), claim.candidate))
        )
          return blocked('Dispatch input assertions do not match durable claim');
        if (
          claim.status !== 'observed' ||
          !claim.run ||
          !sameCandidate(raw.candidate, claim.candidate)
        )
          return blocked('CI callback does not match durable claim');
        // The durable original run is authority. Callback candidate/run assertions
        // must match it at D's signed archive, native lookup and in-lock boundaries.
        const result = await handleTrustedWorkerCallback(data, {
          ...context,
          publicKey,
          expectedRun: Object.freeze({ ...claim.run }),
        });
        return result.kind === 'verified'
          ? verified({ candidate: claim.candidate, execute: raw.type === 'worker_start' })
          : result;
      } catch {
        return blocked('CI callback evidence unavailable');
      }
    },
    reconcileCi: (claimId) => handleTrustedCiContinuation({ claimId }, context),
  });
}
