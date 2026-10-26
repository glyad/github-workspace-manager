import { createHash } from 'node:crypto';
import {
  blocked,
  verified,
  validCandidate,
  exactFields,
  legacyCandidateFields,
  v2CandidateFields,
} from './contracts.mjs';
import { readinessRequestBinding } from './readiness-request.mjs';
export { validCandidate } from './contracts.mjs';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function operationKey(c, action) {
  const identity = Object.hasOwn(c, 'protocolVersion')
    ? [
        c.protocolVersion,
        c.repositoryId,
        c.pr,
        c.baseRef,
        c.base,
        c.head,
        c.attempt,
        c.requestId,
        action,
      ]
    : [c.repositoryId, c.pr, c.base, c.head, c.attempt, action];
  return digest(JSON.stringify(identity));
}
export const sameCandidate = (a, b) =>
  validCandidate(a) &&
  validCandidate(b) &&
  a.protocolVersion === b.protocolVersion &&
  (a.protocolVersion === 2 ? v2CandidateFields : legacyCandidateFields).every((k) => a[k] === b[k]);
const dispatchRunFields = [
  'id',
  'attempt',
  'repositoryId',
  'actorId',
  'workflowId',
  'sha',
  'executionSha',
  'ref',
  'event',
];
export const actions = ['admit-ci', 'ci-success', 'review-success', 'draft', 'invalidate'];
/** Context is independently authenticated API evidence, never fields copied from comments.
 * records binds exact comment bytes to trusted controller-run output. A run URL alone is insufficient.
 * No live issuer/attestation resolver is implemented or enabled by this module.
 */
export function parseJournal(entries, context) {
  try {
    if (
      !context?.ledgerId ||
      !context.controllerActorId ||
      !context.workflowId ||
      !/^[a-f0-9]{40}$/.test(context.trustedSha) ||
      !context.repositoryId ||
      !Array.isArray(context.records)
    )
      return blocked('Unresolved ledger/run provenance');
    if (!Array.isArray(entries) || entries.length > 1000)
      return blocked('Journal count limit or incomplete history');
    let bytes = 0;
    const rows = [];
    const unique = new Map();
    for (const e of entries) {
      if (
        typeof e.body !== 'string' ||
        Buffer.byteLength(e.body) > 16384 ||
        (bytes += Buffer.byteLength(e.body)) > 1_000_000
      )
        return blocked('Journal byte limit');
      const r = e.run;
      if (
        e.ledgerId !== context.ledgerId ||
        e.authorId !== context.controllerActorId ||
        !r ||
        r.repositoryId !== context.repositoryId ||
        (r.event !== 'workflow_dispatch' && r.actorId !== context.controllerActorId) ||
        r.workflowId !== context.workflowId ||
        r.sha !== context.trustedSha ||
        r.ref !== 'refs/heads/main' ||
        !['pull_request_target', 'workflow_run', 'workflow_dispatch'].includes(r.event) ||
        !context.records.some(
          (a) => a.runId === r.id && a.runAttempt === r.attempt && a.digest === digest(e.body),
        )
      )
        return blocked('Unauthenticated journal entry');
      const row = JSON.parse(e.body);
      if (
        !exactFields(row, ['version', 'key', 'phase', 'action', 'candidate', 'run']) ||
        !exactFields(row.run, ['id', 'attempt']) ||
        ![1, 2].includes(row.version) ||
        (row.version === 2) !== (row.candidate?.protocolVersion === 2) ||
        !validCandidate(row.candidate) ||
        row.candidate.repositoryId !== context.repositoryId ||
        !actions.includes(row.action) ||
        !['intent', 'result', 'quarantine'].includes(row.phase) ||
        row.key !== operationKey(row.candidate, row.action) ||
        row.run?.id !== r.id ||
        row.run?.attempt !== r.attempt
      )
        return blocked('Malformed journal record');
      const receipt =
        row.version === 2 &&
        context.readinessRequests?.map(readinessRequestBinding).find((binding) => {
          const q = binding?.request,
            c = row.candidate;
          return (
            q &&
            ['repositoryId', 'pr', 'baseRef', 'base', 'head', 'requestId', 'protocolVersion'].every(
              (k) => q[k] === c[k],
            ) &&
            (r.event !== 'workflow_dispatch' ||
              dispatchRunFields.every((k) => binding.run[k] === r[k]))
          );
        });
      if (row.version === 2 && !receipt) return blocked('Authenticated v2 request required');
      if (
        r.event === 'workflow_dispatch' &&
        (row.version !== 2 || !receipt || dispatchRunFields.some((k) => receipt.run[k] !== r[k]))
      )
        return blocked('Unbound readiness dispatch journal');
      const key = `${row.key}:${row.phase}`;
      if (unique.has(key) && unique.get(key) !== e.body)
        return blocked('Conflicting operation records');
      if (!unique.has(key)) rows.push(row);
      unique.set(key, e.body);
    }
    for (const row of rows)
      if (row.phase === 'result' && !rows.some((r) => r.key === row.key && r.phase === 'intent'))
        return blocked('Result without intent');
    return verified(rows);
  } catch {
    return blocked('Malformed journal');
  }
}
