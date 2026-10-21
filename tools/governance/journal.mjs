import { createHash } from 'node:crypto';
import { blocked, verified } from './contracts.mjs';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function validCandidate(c) {
  return (
    !!c &&
    typeof c.repositoryId === 'string' &&
    c.repositoryId.length > 0 &&
    c.repositoryId.length < 128 &&
    Number.isSafeInteger(c.pr) &&
    c.pr > 0 &&
    /^[a-f0-9]{40}$/.test(c.base) &&
    /^[a-f0-9]{40}$/.test(c.head) &&
    typeof c.attempt === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(c.attempt)
  );
}
export function operationKey(c, action) {
  return digest(JSON.stringify([c.repositoryId, c.pr, c.base, c.head, c.attempt, action]));
}
export const sameCandidate = (a, b) =>
  validCandidate(a) &&
  validCandidate(b) &&
  ['repositoryId', 'pr', 'base', 'head', 'attempt'].every((k) => a[k] === b[k]);
export const actions = ['admit-ci', 'ci-success', 'review-success', 'draft', 'invalidate'];
const exactFields = (value, keys) =>
  !!value &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
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
        r.actorId !== context.controllerActorId ||
        r.workflowId !== context.workflowId ||
        r.sha !== context.trustedSha ||
        r.ref !== 'refs/heads/main' ||
        !['pull_request_target', 'workflow_run'].includes(r.event) ||
        !context.records.some(
          (a) => a.runId === r.id && a.runAttempt === r.attempt && a.digest === digest(e.body),
        )
      )
        return blocked('Unauthenticated journal entry');
      const row = JSON.parse(e.body);
      if (
        !exactFields(row, ['version', 'key', 'phase', 'action', 'candidate', 'run']) ||
        !exactFields(row.candidate, ['repositoryId', 'pr', 'base', 'head', 'attempt']) ||
        !exactFields(row.run, ['id', 'attempt']) ||
        row.version !== 1 ||
        !validCandidate(row.candidate) ||
        row.candidate.repositoryId !== context.repositoryId ||
        !actions.includes(row.action) ||
        !['intent', 'result', 'quarantine'].includes(row.phase) ||
        row.key !== operationKey(row.candidate, row.action) ||
        row.run?.id !== r.id ||
        row.run?.attempt !== r.attempt
      )
        return blocked('Malformed journal record');
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
