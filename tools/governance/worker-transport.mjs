import { verify } from 'node:crypto';
import { digest, sameCandidate, validCandidate } from './journal.mjs';
import { acceptWorkerResult } from './worker-results.mjs';
import { blocked, verified, exactFields, requestId, sha40 } from './contracts.mjs';
export function boundedJson(body, max = 1_000_000) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > max) throw Error('Body limit');
  return JSON.parse(body);
}
/** External archive authority must bind exact bytes to execution/event history.
 * No GitHub artifact/run URL or caller-supplied boolean is such authority.
 * This verifier implements the offline protocol; no production issuer is selected.
 */
export function verifyArchive(envelope, expected, publicKey) {
  try {
    // Ed25519 signatures are exactly 64 bytes: canonical padded base64 is 88
    // ASCII characters. Bound the outer encoding BEFORE allocating decoded bytes.
    if (
      typeof envelope?.signature !== 'string' ||
      envelope.signature.length !== 88 ||
      !/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(envelope.signature)
    )
      return blocked('Archive signature encoding');
    const a = boundedJson(envelope.body);
    const r = a.run;
    if (
      !r ||
      typeof r.id !== 'string' ||
      !/^[0-9]+$/.test(r.id) ||
      !Number.isSafeInteger(r.attempt) ||
      r.attempt <= 0 ||
      typeof r.repositoryId !== 'string' ||
      typeof r.workflowId !== 'string' ||
      typeof r.actorId !== 'string' ||
      !/^[a-f0-9]{40}$/.test(r.sha) ||
      !/^[a-f0-9]{40}$/.test(r.executionSha) ||
      !['pull_request_target', 'workflow_run', 'workflow_dispatch'].includes(r.event)
    )
      return blocked('Archive execution identity');
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64) return blocked('Archive signature size');
    if (!publicKey || !verify(null, Buffer.from(envelope.body), publicKey, signature))
      return blocked('Archive signature');
    if (
      (Object.hasOwn(a, 'candidate') && !validCandidate(a.candidate)) ||
      a.version !== (a.candidate?.protocolVersion === 2 ? 2 : 1) ||
      Object.entries(expected).some(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v))
    )
      return blocked('Archive binding');
    return verified(a);
  } catch {
    return blocked('Malformed archive');
  }
}
export function encodeWorkerResult(result) {
  const fields =
    result?.worker === 'review'
      ? ['candidate', 'worker', 'outcome', 'model', 'effort', 'fresh', 'findings']
      : ['candidate', 'worker', 'outcome'];
  if (result?.worker === 'ci' && result.candidate?.protocolVersion === 2) fields.push('claimId');
  if (
    !result ||
    Object.keys(result).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(result, k)) ||
    !validCandidate(result.candidate) ||
    (result.candidate?.protocolVersion === 2 &&
      result.worker === 'ci' &&
      (typeof result.claimId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.claimId))) ||
    !['ci', 'review'].includes(result.worker) ||
    !['success', 'failure'].includes(result.outcome)
  )
    throw Error('Malformed result');
  if (
    result.worker === 'review' &&
    (result.model !== 'gpt-6-astra' ||
      result.effort !== 'high' ||
      result.fresh !== true ||
      !Number.isSafeInteger(result.findings) ||
      result.findings < 0)
  )
    throw Error('Unexpected candidate or review schema');
  const body = JSON.stringify(result);
  boundedJson(body);
  return body;
}
export function verifyResultEnvelope(body, envelope, run, candidate, worker, publicKey, claimId) {
  try {
    const result = boundedJson(body);
    if (
      encodeWorkerResult(result) !== body ||
      !sameCandidate(result.candidate, candidate) ||
      result.worker !== worker ||
      (candidate?.protocolVersion === 2 && worker === 'ci' && result.claimId !== claimId)
    )
      return blocked('Result schema or candidate');
    const proof = verifyArchive(
      envelope,
      { purpose: 'worker-result', run, candidate, worker, bodyDigest: digest(body) },
      publicKey,
    );
    return proof.kind === 'verified' ? verified(result) : proof;
  } catch {
    return blocked('Malformed result envelope');
  }
}
export async function readWorkerResult(run, transport, expected) {
  try {
    const { body, envelope } = await transport(run);
    return verifyResultEnvelope(
      body,
      envelope,
      run,
      expected.candidate,
      expected.worker,
      expected.publicKey,
      expected.claimId,
    );
  } catch {
    return blocked('Incomplete result download');
  }
}
export function resultDecision(candidate, run, result, observed, envelope, publicKey) {
  const body = encodeWorkerResult(result);
  const proof = verifyResultEnvelope(
    body,
    envelope,
    run,
    candidate,
    observed.expectedWorker,
    publicKey,
    observed.expectedClaimId,
  );
  if (proof.kind !== 'verified') return { action: 'none', reason: proof.reason };
  return acceptWorkerResult(candidate, run, result, {
    ...observed,
    attestation: { verified: true, run, bodyDigest: digest(body) },
  });
}

/** Exact data schemas for the local continuation log and authenticated issuer. */
export function validCiRun(r) {
  return (
    exactFields(r, [
      'id',
      'attempt',
      'repositoryId',
      'actorId',
      'workflowId',
      'sha',
      'executionSha',
      'ref',
      'event',
    ]) &&
    /^\d+$/.test(r.id) &&
    Number.isSafeInteger(r.attempt) &&
    r.attempt > 0 &&
    ['repositoryId', 'actorId', 'workflowId', 'ref'].every(
      (k) => typeof r[k] === 'string' && r[k].length > 0 && Buffer.byteLength(r[k]) <= 255,
    ) &&
    sha40(r.sha) &&
    sha40(r.executionSha) &&
    r.event === 'workflow_dispatch'
  );
}
export function validDispatchClaim(c) {
  if (
    !exactFields(c, [
      'id',
      'candidate',
      'worker',
      'requestId',
      'definitionSha',
      'status',
      'run',
      'start',
    ]) ||
    !requestId(c.id) ||
    !validCandidate(c.candidate) ||
    c.candidate.protocolVersion !== 2 ||
    c.worker !== 'ci' ||
    c.requestId !== c.candidate.requestId ||
    !sha40(c.definitionSha) ||
    !['pending', 'observed', 'quarantined'].includes(c.status)
  )
    return false;
  if (c.run === null) return c.start === null && c.status !== 'observed';
  if (
    !validCiRun(c.run) ||
    c.run.repositoryId !== c.candidate.repositoryId ||
    c.run.sha !== c.definitionSha ||
    c.status === 'pending'
  )
    return false;
  const s = c.start;
  return (
    s === null ||
    (exactFields(s, ['claimId', 'runId', 'runAttempt', 'candidate', 'definitionSha', 'state']) &&
      s.claimId === c.id &&
      s.runId === c.run.id &&
      s.runAttempt === c.run.attempt &&
      sameCandidate(s.candidate, c.candidate) &&
      s.definitionSha === c.definitionSha &&
      s.state === 'consumed')
  );
}
