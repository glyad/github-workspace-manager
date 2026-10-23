import { createPublicKey, KeyObject } from 'node:crypto';
import { types } from 'node:util';
import { isAbsolute } from 'node:path';
import { validCandidate } from './journal.mjs';
import { v2CandidateFields } from './contracts.mjs';
import { reserveReviewBudget } from './review-budget.mjs';
import { extractReviewMaterial, buildReviewInvocation } from './review-material.mjs';
import { runBoundedReview } from './review-runner.mjs';
import {
  claimReservation,
  withClaimedReview,
  reconcileReservation,
  createConsumedReviewResolver,
} from './worker-ledger.mjs';
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
    // Retain supplied candidate observations from the authenticated exact body.
    // GitHub's base.ref is a short branch name; policy uses the canonical ref.
    const observed = {};
    if (Object.hasOwn(pr, 'head')) {
      if (!sha40(pr.head?.sha)) return blocked('Malformed candidate observation');
      observed.head = pr.head.sha;
    }
    if (Object.hasOwn(pr, 'base')) {
      if (!pr.base || typeof pr.base !== 'object' || Array.isArray(pr.base))
        return blocked('Malformed candidate observation');
      if (Object.hasOwn(pr.base, 'sha')) {
        if (!sha40(pr.base.sha)) return blocked('Malformed candidate observation');
        observed.base = pr.base.sha;
      }
      if (Object.hasOwn(pr.base, 'ref')) {
        if (typeof pr.base.ref !== 'string' || !validBaseRef(`refs/heads/${pr.base.ref}`))
          return blocked('Malformed candidate observation');
        observed.baseRef = `refs/heads/${pr.base.ref}`;
      }
    }
    const event = {
      type: raw.action,
      repositoryId: expectedRun.repositoryId,
      pr: pr.number,
      readinessId: proof.value.readinessId,
      ...observed,
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
    if (
      raw.worker === 'review' &&
      (raw.candidate?.protocolVersion !== 2 ||
        raw.type !== 'worker_completed' ||
        !exactFields(raw, ['type', 'candidate', 'worker', 'outcome', 'claimId']))
    )
      return blocked('Review completion requires consumed v2 claim');
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

/** Exact dormant review composition. Only independently provisioned local
 * providers and opaque ledger authority can authorize this synthetic call path. */
export function createReviewRuntime(config = {}) {
  const denied = async () => blocked('Production backend unselected');
  const closed = Object.freeze({ run: denied, complete: denied, reconcile: denied });
  // Inspect mode first: unselected production must not touch any provider/key.
  if (!config || types.isProxy(config)) return closed;
  if (
    Object.getOwnPropertyDescriptor(config, 'mode')?.value !== 'offline-test' ||
    Object.getOwnPropertyDescriptor(config, 'productionBackend')?.value !== null
  )
    return closed;
  try {
    const q = reviewRecord(config, [
      'mode',
      'productionBackend',
      'port',
      'ledger',
      'originAuthority',
      'materialTransport',
      'runnerPort',
      'proxyPort',
      'localConfig',
      'limits',
      'callbackContext',
    ]);
    const limits = Object.freeze(reviewRecord(q.limits, reviewLimitFields));
    if (reviewLimitFields.some((k) => !Number.isSafeInteger(limits[k]) || limits[k] <= 0))
      throw Error('Positive fixture limits required');
    const duration = limits.maxRunSeconds * 1000;
    if (!Number.isSafeInteger(duration) || duration > 2147483647)
      throw Error('Safe timer duration required');
    const local = reviewRecord(q.localConfig, [
      'executable',
      'childScript',
      'sourceDigest',
      'trustedInstructions',
      'env',
    ]);
    if (!local.env || typeof local.env !== 'object' || types.isProxy(local.env))
      throw Error('Plain environment required');
    const envKeys = Reflect.ownKeys(local.env);
    if (envKeys.some((k) => !['PATH', 'LANG', 'TZ'].includes(k)))
      throw Error('Allowlisted environment required');
    local.env = Object.freeze(reviewRecord(local.env, envKeys));
    if (
      Object.values(local.env).some(
        (v) =>
          typeof v !== 'string' || v.includes('\0') || Buffer.byteLength(v) > limits.maxInputBytes,
      ) ||
      ['executable', 'childScript', 'sourceDigest', 'trustedInstructions'].some(
        (k) =>
          typeof local[k] !== 'string' ||
          !local[k].length ||
          local[k].includes('\0') ||
          Buffer.byteLength(local[k]) > limits.maxInputBytes,
      ) ||
      !isAbsolute(local.executable) ||
      !isAbsolute(local.childScript) ||
      !/^[a-f0-9]{64}$/.test(local.sourceDigest)
    )
      throw Error('Exact trusted local config required');
    const localConfig = Object.freeze(local);
    const port = captureReviewMethods(q.port, [
      'withPrLock',
      'observe',
      'readJournal',
      'verifyWorkerCallback',
      'verifyWorker',
      'append',
      'draft',
    ]);
    const ledger = q.ledger;
    const resolver = createConsumedReviewResolver({ ledger, originAuthority: q.originAuthority });
    const ledgerMethods = captureReviewMethods(ledger, [
      'withFunding',
      'read',
      'observe',
      'forOrigin',
    ]);
    const resolve = q.originAuthority.resolve.bind(q.originAuthority);
    const material = captureReviewMethods(q.materialTransport, ['open', 'verifyCompletion']);
    const runner = captureReviewMethods(q.runnerPort, [
      'now',
      'spawn',
      'abortGroup',
      'joinGroup',
      'disposeHome',
    ]);
    const proxy = captureReviewMethods(q.proxyPort, ['open', 'verifyCompletion']);
    const context = reviewRecord(q.callbackContext, ['publicKey']);
    if (!(context.publicKey instanceof KeyObject) || context.publicKey.type !== 'public')
      throw Error('Synthetic public verification key required');
    const keyBytes = context.publicKey.export({ type: 'spki', format: 'der' });
    const publicKey = createPublicKey({ key: Buffer.from(keyBytes), type: 'spki', format: 'der' });
    const snapshotCandidate = (value) => {
      const candidate = reviewRecord(value, v2CandidateFields);
      if (!validCandidate(candidate) || candidate.protocolVersion !== 2)
        throw Error('Complete v2 candidate required');
      return Object.freeze(candidate);
    };
    return Object.freeze({
      async run(input) {
        let timer, controller;
        try {
          const data = reviewRecord(input, ['candidate', 'reservationRequestId']);
          const candidate = snapshotCandidate(data.candidate),
            reservationRequestId = data.reservationRequestId;
          if (!requestId(reservationRequestId)) return blocked('Registered call request required');
          controller = new AbortController();
          const started = runner.now(),
            expiresAt = started + duration;
          if (!Number.isFinite(started) || !Number.isFinite(expiresAt) || expiresAt <= started)
            return blocked('Monotonic deadline unavailable');
          const remainingMs = () => {
            const current = runner.now();
            if (!Number.isFinite(current) || current < started) {
              controller.abort('Clock unavailable');
              return 0;
            }
            return Math.max(0, expiresAt - current);
          };
          const live = () => {
            if (controller.signal.aborted || remainingMs() <= 0) {
              controller.abort('Review deadline');
              throw Error('Review deadline');
            }
          };
          const arm = () => {
            const remaining = remainingMs();
            if (remaining <= 0) {
              controller.abort('Review deadline');
              return;
            }
            timer = setTimeout(arm, Math.min(duration, remaining));
          };
          arm();
          const deadline = Object.freeze({
            signal: controller.signal,
            expiresAt,
            remainingMs,
            cancel: (reason) => controller.abort(reason),
          });
          const wait = (operation) => reviewAwait(operation, controller.signal, live);
          const origin = await wait(() => resolve({ candidate, reservationRequestId }));
          if (origin.kind !== 'verified') return origin;
          const receipt = origin.value;
          const extracted = await wait(() =>
            extractReviewMaterial(candidate, material, limits, deadline.signal),
          );
          if (extracted.kind !== 'verified') return extracted;
          live();
          const invocation = buildReviewInvocation(localConfig, extracted.value, limits);
          if (invocation.kind !== 'verified') return invocation;
          const observed = await wait(() =>
            ledgerMethods.withFunding(() => ledgerMethods.observe(candidate)),
          );
          live();
          const facade = ledgerMethods.forOrigin(receipt, deadline);
          // Every facade continuation checks the original deadline. A late write
          // remains occupied; its late result cannot mint further permission.
          const boundedFacade = Object.fromEntries(
            ['withReservationLock', 'read', 'append', 'observe'].map((name) => [
              name,
              (...args) => {
                live();
                return facade[name](...args);
              },
            ]),
          );
          const reserved = await wait(() =>
            reserveReviewBudget(
              { candidate, requestId: reservationRequestId, observed },
              limits,
              boundedFacade,
            ),
          );
          if (reserved.kind !== 'verified') return reserved;
          const claimed = await wait(() =>
            claimReservation(
              reserved.value.key,
              {
                originReceipt: receipt,
                materialDigest: invocation.value.materialDigest,
                invocationDigest: invocation.value.bodyDigest,
              },
              ledger,
              deadline,
            ),
          );
          if (claimed.kind !== 'verified') return claimed;
          live();
          // The lifecycle releases funding/PR locks before invoking this closure.
          // No late consume response may execute after the shared deadline.
          let executing = false;
          const completion = withClaimedReview(
            claimed.value.id,
            ledger,
            async (claim, guard) => {
              live();
              executing = true;
              return runBoundedReview(claim, invocation.value, guard, {
                runnerPort: runner,
                proxyPort: proxy,
                localConfig,
                deadline,
              });
            },
            deadline,
          );
          // A hung consume must return at the same deadline. Once supervision
          // has begun, let its bounded termination window return actual evidence.
          return await new Promise((resolve, reject) => {
            const abort = () => {
              if (!executing) reject(Error('Review consumption deadline'));
            };
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
            completion
              .then(resolve, reject)
              .finally(() => controller.signal.removeEventListener('abort', abort));
          });
        } catch {
          return {
            kind: 'uncertain',
            reason: 'Review deadline or preparation unavailable; retain any occupied capacity',
            evidence: [],
          };
        } finally {
          clearTimeout(timer);
          controller?.abort('Review runtime finalized');
        }
      },
      async complete(input) {
        try {
          const data = reviewRecord(input, ['body', 'archive']);
          const body = data.body,
            archive = Object.freeze(reviewRecord(data.archive, ['body', 'signature']));
          if (
            typeof archive.body !== 'string' ||
            Buffer.byteLength(archive.body) > 1_000_000 ||
            typeof archive.signature !== 'string' ||
            archive.signature.length !== 88
          )
            return blocked('Bounded archive required');
          const raw = boundedJson(body, 262144);
          if (
            !exactFields(raw, ['type', 'candidate', 'worker', 'outcome', 'claimId']) ||
            raw.type !== 'worker_completed' ||
            raw.worker !== 'review' ||
            !['success', 'failure'].includes(raw.outcome) ||
            !/^[a-f0-9]{64}$/.test(raw.claimId)
          )
            return blocked('Exact consumed review callback required');
          const candidate = snapshotCandidate(raw.candidate),
            claimId = raw.claimId;
          return await ledgerMethods.withFunding(async () => {
            const resolved = await resolver.resolve({ claimId, candidate });
            if (resolved.kind !== 'verified') return resolved;
            const expectedRun = Object.freeze({ ...resolved.value.run });
            return handleTrustedWorkerCallback(
              { body, archive },
              { mode: 'offline-test', productionBackend: null, port, expectedRun, publicKey },
            );
          });
        } catch {
          return blocked('Review completion evidence unavailable');
        }
      },
      async reconcile(input) {
        try {
          const data = reviewRecord(input, ['reservationKey', 'evidence']);
          if (typeof data.evidence !== 'string' || Buffer.byteLength(data.evidence) > 1_000_000)
            return blocked('Bounded retained evidence required');
          return reconcileReservation(data.reservationKey, data.evidence, ledger);
        } catch {
          return blocked('Exact retained reconciliation evidence required');
        }
      },
    });
  } catch {
    return closed;
  }
}
const reviewLimitFields = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
function reviewRecord(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Plain exact record required');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((k) => !fields.includes(k)))
    throw Error('Exact fields required');
  const result = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Data properties required');
    result[key] = descriptor.value;
  }
  return result;
}
function captureReviewMethods(value, names) {
  if (!value || types.isProxy(value)) throw Error('Captured trusted provider required');
  return Object.freeze(
    Object.fromEntries(
      names.map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        const method = descriptor?.value;
        if (typeof method !== 'function') throw Error('Provider method required');
        return [name, method.bind(value)];
      }),
    ),
  );
}
function reviewAwait(operation, signal, live) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(Error('Review deadline'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    Promise.resolve()
      .then(() => {
        live();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          try {
            live();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}
