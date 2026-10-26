// Local test provisioning only. These positive limits are NOT activation decisions.
export const candidate = Object.freeze({
  repositoryId: 'repo-1',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-1',
  protocolVersion: 2,
  baseRef: 'refs/heads/develop',
  requestId: 'ready-request-1',
});
export const limits = Object.freeze({
  callsPerAttempt: 2,
  maxOutputTokens: 300,
  maxInputBytes: 10000,
  maxRunSeconds: 20,
  maxConcurrentCalls: 2,
});
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function registration(c = candidate, request = 'paid-1', l = limits) {
  const run = {
    id: '123',
    attempt: 1,
    repositoryId: c.repositoryId,
    actorId: 'actor-1',
    workflowId: 'review-1',
    sha: 'c'.repeat(40),
    executionSha: c.head,
    ref: 'refs/heads/develop',
    event: 'workflow_dispatch',
  };
  const approvedDefinition = {
    repositoryId: run.repositoryId,
    workflowId: run.workflowId,
    sha: run.sha,
    ref: run.ref,
  };
  const fields = structuredClone({
    candidate: c,
    reservationRequestId: request,
    run,
    approvedDefinition,
    limits: l,
  });
  return { ...fields, evidenceBody: canonical(fields) };
}
export function observation(c = candidate) {
  return {
    candidate: c,
    ready: true,
    admitted: true,
    nativeVerified: true,
    lifecycleVerified: true,
    invalidated: false,
    sameRepository: true,
    ci: { verified: true, candidate: c, outcome: 'success' },
    fundingActivated: true,
    credentialsActivated: true,
    trustVerified: true,
    actionPinVerified: true,
    ceilingsEnforced: true,
    keyExposedToCheckout: false,
    untrustedTools: false,
    inputBytes: 30,
  };
}

import { createOfflineReviewOriginAuthority } from '../../../tools/governance/worker-ledger.mjs';
import { blocked, verified, exactFields } from '../../../tools/governance/contracts.mjs';
import { digest } from '../../../tools/governance/journal.mjs';
/** Trusted local fixture setup only. No runtime registration or caller attestation. */
export function createReviewAuthorityFixture(config) {
  if (!exactFields(config, ['registrations', 'outcomes']) || !Array.isArray(config.outcomes))
    throw Error('Exact fixture configuration required');
  const originAuthority = createOfflineReviewOriginAuthority({
    registrations: config.registrations,
  });
  const rows = structuredClone(config.outcomes),
    registry = new Map();
  for (const row of rows) {
    if (
      !exactFields(row, ['evidenceBody', 'outcome', 'binding']) ||
      typeof row.evidenceBody !== 'string' ||
      Buffer.byteLength(row.evidenceBody) > 1_000_000 ||
      row.outcome?.evidenceDigest !== digest(row.evidenceBody) ||
      registry.has(row.evidenceBody)
    )
      throw Error('Exact retained outcome evidence required');
    const proof = JSON.parse(row.evidenceBody);
    if (
      canonical(proof) !== row.evidenceBody ||
      !exactFields(proof, [
        'originEvidenceDigest',
        'phase',
        'guardConsumed',
        'sendObserved',
        'executionEnded',
        'completion',
      ]) ||
      !['guardConsumed', 'sendObserved', 'executionEnded'].every(
        (k) => typeof proof[k] === 'boolean',
      ) ||
      !exactFields(row.binding, ['reservation', 'claim', 'outcome', 'events', 'origin'])
    )
      throw Error('Exact retained local proof required');
    registry.set(row.evidenceBody, row);
  }
  return Object.freeze({
    originAuthority,
    verifyOutcome(evidence, binding) {
      const row = registry.get(evidence);
      if (!row) return blocked('Retained original outcome/history required');
      const identical = canonical(binding) === canonical(row.binding);
      const old = row.binding;
      const repeated =
        exactFields(binding, ['reservation', 'claim', 'outcome', 'events', 'origin']) &&
        binding.reservation?.status === 'completed' &&
        canonical(binding.outcome) === canonical(row.outcome) &&
        canonical(binding.claim) === canonical(old.claim) &&
        canonical(binding.origin) === canonical(old.origin) &&
        canonical({ ...binding.reservation, status: old.reservation.status }) ===
          canonical(old.reservation) &&
        canonical(binding.events.slice(0, old.events.length)) === canonical(old.events) &&
        binding.events
          .slice(old.events.length)
          .every(
            (e) =>
              e.reservation.key !== old.reservation.key ||
              (e.kind === 'completed' && canonical(e.outcome) === canonical(row.outcome)),
          );
      if (!identical && !repeated) return blocked('Retained original outcome/history required');
      if (repeated) binding = structuredClone(old);
      const { reservation: r, claim: c, events, origin } = binding,
        p = JSON.parse(row.evidenceBody),
        o = row.outcome;
      const receipt = originAuthority.resolve({
        candidate: r.candidate,
        reservationRequestId: r.requestId,
      });
      const auth =
        receipt.kind === 'verified'
          ? originAuthority.inspect(receipt.value, {
              candidate: r.candidate,
              reservationRequestId: r.requestId,
              limits: r.limits,
            })
          : receipt;
      const last = events.filter((e) => e.reservation.key === r.key).at(-1);
      if (
        auth.kind !== 'verified' ||
        canonical(auth.value) !== canonical(origin) ||
        p.originEvidenceDigest !== origin.evidenceDigest ||
        last?.kind !== p.phase ||
        canonical(last.reservation) !== canonical(r) ||
        canonical(last.claim) !== canonical(c) ||
        canonical(last.outcome) !== canonical(binding.outcome) ||
        o.executionEnded !== p.executionEnded
      )
        return blocked('Original origin and ledger phase required');
      // A new resolution authenticates the complete retained history, not merely
      // its latest row. Earlier positive guard/send evidence cannot become absent.
      for (const event of events.filter((e) => e.reservation.key === r.key && e.outcome)) {
        const retained = [...registry.values()].find(
          (item) =>
            item.outcome.evidenceDigest === event.outcome.evidenceDigest &&
            canonical(item.outcome) === canonical(event.outcome),
        );
        if (!retained) return blocked('Full original outcome evidence must be retained');
        const retainedProof = JSON.parse(retained.evidenceBody);
        if (
          o.providerOutcome === 'not-sent' &&
          (retainedProof.sendObserved || retainedProof.guardConsumed)
        )
          return blocked('Retained guard consumption or positive send cannot resolve not-sent');
      }
      if (
        o.providerOutcome === 'not-sent' &&
        (!p.executionEnded ||
          p.sendObserved ||
          p.guardConsumed ||
          p.completion !== null ||
          (!c && events.some((e) => e.reservation.key === r.key && e.claim)))
      )
        return blocked('Independent no-send and termination proof required');
      if (o.providerOutcome === 'completed') {
        const m = p.completion;
        if (
          !c?.start ||
          !p.executionEnded ||
          !p.guardConsumed ||
          !p.sendObserved ||
          !exactFields(m, ['body', 'outputTokens', 'inputBytes']) ||
          typeof m.body !== 'string' ||
          Buffer.byteLength(m.body) > 1_000_000 ||
          !Number.isSafeInteger(m.outputTokens) ||
          m.outputTokens < 0 ||
          m.outputTokens > r.limits.maxOutputTokens ||
          !Number.isSafeInteger(m.inputBytes) ||
          m.inputBytes < 0 ||
          m.inputBytes > r.limits.maxInputBytes
        )
          return blocked('Complete bounded measured provider and termination proof required');
        try {
          const result = JSON.parse(m.body);
          if (!exactFields(result, ['outcome']) || !['success', 'failure'].includes(result.outcome))
            return blocked('Exact completion required');
        } catch {
          return blocked('Exact completion required');
        }
      }
      return verified(structuredClone(o));
    },
  });
}
