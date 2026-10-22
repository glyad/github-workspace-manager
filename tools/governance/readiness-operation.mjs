import {
  blocked,
  verified,
  validReadinessRequest,
  requestId as validId,
  exactFields,
} from './contracts.mjs';
import { readinessRequestBinding } from './readiness-request.mjs';
import { digest } from './journal.mjs';

const uncertain = () => ({
  kind: 'uncertain',
  reason: 'Readiness operation requires reconciliation',
  evidence: [],
});
const same = (a, b) =>
  validReadinessRequest(a) &&
  validReadinessRequest(b) &&
  Object.keys(a).every((k) => a[k] === b[k]);
const keyOf = (r) => `${r.repositoryId}:${r.pr}`;
const freeze = (v) => Object.freeze({ ...v, request: Object.freeze({ ...v.request }) });
const states = [
  'intent',
  'mutation-pending',
  'mutation-observed',
  'accepted',
  'quarantined',
  'reconciled',
];
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function validReadinessOperation(o) {
  return (
    exactFields(o, [
      'version',
      'request',
      'state',
      'beforeDigest',
      'mutationDigest',
      'proofDigest',
      'continuation',
    ]) &&
    o.version === 2 &&
    validReadinessRequest(o.request) &&
    states.includes(o.state) &&
    [o.beforeDigest, o.mutationDigest, o.proofDigest].every((v) => v === null || hex(v)) &&
    o.continuation === null &&
    (!['mutation-observed', 'accepted'].includes(o.state) ||
      (hex(o.beforeDigest) && hex(o.mutationDigest))) &&
    (o.state !== 'accepted' || hex(o.proofDigest)) &&
    (o.state !== 'intent' ||
      [o.beforeDigest, o.mutationDigest, o.proofDigest].every((v) => v === null)) &&
    (o.state !== 'mutation-pending' || (o.mutationDigest === null && o.proofDigest === null)) &&
    (o.state !== 'mutation-observed' || o.proofDigest === null)
  );
}
export function validOperationTransition(previous, next) {
  if (!validReadinessOperation(next)) return false;
  if (!previous)
    return (
      next.state === 'intent' &&
      next.beforeDigest === null &&
      next.mutationDigest === null &&
      next.proofDigest === null
    );
  if (!validReadinessOperation(previous) || !same(previous.request, next.request)) return false;
  const allowed = {
    intent: ['mutation-pending', 'quarantined', 'reconciled'],
    'mutation-pending': ['mutation-observed', 'quarantined', 'reconciled'],
    'mutation-observed': ['accepted', 'quarantined', 'reconciled'],
    accepted: ['quarantined', 'reconciled'],
    quarantined: ['reconciled'],
    reconciled: [],
  };
  const enrichment =
    previous.state === 'mutation-pending' &&
    next.state === 'mutation-pending' &&
    previous.beforeDigest === null &&
    hex(next.beforeDigest);
  return (
    (allowed[previous.state].includes(next.state) || enrichment) &&
    (!['quarantined', 'reconciled'].includes(next.state) ||
      ['beforeDigest', 'mutationDigest', 'proofDigest', 'continuation'].every(
        (k) => previous[k] === next[k],
      )) &&
    ['beforeDigest', 'mutationDigest', 'proofDigest', 'continuation'].every(
      (k) => previous[k] === null || previous[k] === next[k],
    )
  );
}
async function authorize(request, store) {
  if (!validReadinessRequest(request)) return false;
  const result = await store.authorizeReadinessRequest?.(request);
  return same(readinessRequestBinding(result)?.request, request);
}
async function persist(operation, store) {
  const saved = await store.appendOperation(operation);
  if (saved?.kind !== 'verified') return uncertain();
  const read = await store.readOperation(operation.request.requestId);
  if (read?.kind !== 'verified' || JSON.stringify(read.value) !== JSON.stringify(operation))
    return uncertain();
  return verified(freeze(operation));
}

/** One trusted PR-lock boundary for future handshake/admission composition.
 * request is the plain strict v2 schema. The store's trusted authorization port
 * must return an actual fresh Task A authentication Result, never a stored copy.
 * Callback scopes expire before lock release. No skip-lock input is accepted.
 */
export async function withReadinessOperation(request, store, fn) {
  try {
    if (!validReadinessRequest(request)) return blocked('Malformed readiness request');
    const snapshot = Object.freeze({ ...request });
    if (!(await authorize(snapshot, store))) return blocked('Request authentication required');
    return await store.withPrLock(keyOf(snapshot), async () => {
      let active = true,
        accepting = true,
        fresh = false,
        sent = false,
        settledSuccess = false,
        operation,
        unsettled = false;
      const tasks = new Set();
      let phaseTail = Promise.resolve();
      const invalidate = () => {
        fresh = false;
        settledSuccess = false;
        unsettled = true;
        return uncertain();
      };
      // If an accepted append succeeded but its acknowledgment/readback failed,
      // preserve its facts in quarantine when storage can establish that record.
      // Otherwise the uncertain Result retains exclusion; no blind write repairs
      // an unreadable history or makes an accepted record available to admission.
      const quarantineUncertainAcceptance = async () => {
        try {
          const read = await store.readOperation(snapshot.requestId);
          if (
            read?.kind === 'verified' &&
            validReadinessOperation(read.value) &&
            same(read.value.request, snapshot) &&
            read.value.state === 'accepted'
          ) {
            const saved = await persist({ ...read.value, state: 'quarantined' }, store);
            if (saved.kind === 'verified') operation = saved.value;
          }
        } catch {
          /* Retain uncertain exclusion if storage cannot resolve its history. */
        }
      };
      const track =
        (fn) =>
        (...args) => {
          if (!accepting) return Promise.resolve(blocked('Operation scope expired'));
          const task = Promise.resolve()
            .then(() => fn(...args))
            .catch(() => invalidate())
            .then((result) => {
              if (result?.kind === 'uncertain') invalidate();
              return result;
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return task;
        };
      try {
        await store.registerOperationOwner?.(snapshot);
        const current = await store.readOperation(snapshot.requestId);
        const obligations = await store.readObligations(keyOf(snapshot));
        if (
          current?.kind !== 'verified' ||
          obligations?.kind !== 'verified' ||
          !Array.isArray(obligations.value) ||
          !obligations.value.every(
            (o) => validReadinessOperation(o) && keyOf(o.request) === keyOf(snapshot),
          )
        )
          return uncertain();
        if (current.value) {
          if (!validReadinessOperation(current.value) || !same(current.value.request, snapshot))
            return blocked('Request identity cannot be replaced');
          operation = freeze(current.value);
        } else {
          if (obligations.value.length) return blocked('Unresolved PR operation');
          operation = freeze({
            version: 2,
            request: snapshot,
            state: 'intent',
            beforeDigest: null,
            mutationDigest: null,
            proofDigest: null,
            continuation: null,
          });
          let written = await persist(operation, store);
          if (written.kind !== 'verified') return written;
          operation = freeze({ ...operation, state: 'mutation-pending' });
          written = await persist(operation, store);
          if (written.kind !== 'verified') return written;
          fresh = true;
        }
        const recordPhase = async (phase, evidence) => {
          if (!active) return blocked('Operation scope expired');
          if (phase === 'quarantined' && !['reconciled', 'quarantined'].includes(operation.state)) {
            const result = await persist({ ...operation, state: phase }, store);
            if (result.kind === 'verified') operation = result.value;
            else invalidate();
            return result;
          }
          const before =
            phase === 'mutation-pending' &&
            operation.state === 'mutation-pending' &&
            operation.beforeDigest === null &&
            !sent;
          const next = { 'mutation-pending': 'mutation-observed', 'mutation-observed': 'accepted' }[
            operation.state
          ];
          if (!fresh || unsettled || (!before && (phase !== next || !settledSuccess)))
            return blocked('Invalid or unsettled phase');
          const predecessor = operation;
          const auth = await store.authenticateOperationEvidence?.(evidence, predecessor, phase);
          if (
            !active ||
            !fresh ||
            unsettled ||
            operation !== predecessor ||
            (!before && !settledSuccess)
          )
            return blocked('Phase authority changed');
          const v = auth?.value;
          if (
            auth?.kind !== 'verified' ||
            v?.requestId !== snapshot.requestId ||
            v.operationDigest !== digest(JSON.stringify(operation))
          )
            return blocked('Phase evidence unauthenticated');
          const updated = {
            ...operation,
            state: phase,
            beforeDigest: v.beforeDigest,
            mutationDigest: before ? null : v.mutationDigest,
            proofDigest: phase === 'accepted' ? v.proofDigest : operation.proofDigest,
          };
          if (!validReadinessOperation(updated)) return blocked('Incomplete phase evidence');
          if (
            (operation.beforeDigest !== null && operation.beforeDigest !== updated.beforeDigest) ||
            (operation.mutationDigest !== null &&
              operation.mutationDigest !== updated.mutationDigest)
          )
            return blocked('Immutable evidence changed');
          const result = await persist(updated, store);
          if (result.kind === 'verified') operation = result.value;
          else invalidate();
          return result;
        };
        const queuedPhase = track((phase, evidence) => {
          const task = phaseTail.then(() => recordPhase(phase, evidence)).catch(() => invalidate());
          phaseTail = task.then(() => undefined);
          return task;
        });
        const scope = Object.freeze({
          get operation() {
            return operation;
          },
          get newReservation() {
            return fresh;
          },
          recordPhase: (phase, evidence) => {
            if (!accepting) return Promise.resolve(blocked('Operation scope expired'));
            // Revocation takes effect on request, even while an earlier phase is
            // authenticating. The serialized write retains all existing facts.
            if (
              active &&
              phase === 'quarantined' &&
              !['quarantined', 'reconciled'].includes(operation.state)
            ) {
              fresh = false;
              settledSuccess = false;
            }
            return queuedPhase(phase, evidence);
          },
          mutate: track(async (send) => {
            if (
              !active ||
              !fresh ||
              unsettled ||
              sent ||
              operation.state !== 'mutation-pending' ||
              !hex(operation.beforeDigest)
            )
              return blocked('No mutation permit');
            // Consume in memory before any await: concurrent calls cannot race.
            sent = true;
            const pending = operation;
            // Reverify the exact eligible pending snapshot, not the mutable
            // current phase. Quarantine/uncertainty revokes this permit across
            // the asynchronous read, even if that read returns a newer record.
            const read = await store.readOperation(snapshot.requestId);
            if (
              !active ||
              !fresh ||
              unsettled ||
              operation !== pending ||
              operation.state !== 'mutation-pending'
            )
              return blocked('Mutation authority changed before send');
            if (read?.kind !== 'verified' || JSON.stringify(read.value) !== JSON.stringify(pending))
              return invalidate();
            try {
              const result = await send();
              if (
                result?.kind !== 'verified' ||
                !Object.hasOwn(result, 'value') ||
                !Array.isArray(result.evidence)
              )
                return invalidate();
              // Consumption alone grants no phase authority. Only the original
              // callback's successfully settled Result can establish this flag.
              settledSuccess = fresh && !unsettled && operation === pending;
              return result;
            } catch {
              return invalidate();
            }
          }),
        });
        const result = await fn(scope);
        accepting = false;
        if (result?.kind === 'uncertain') invalidate();
        const callbackOperation = operation;
        // Close admission to new scope calls while work accepted during the
        // callback drains under ownership, including queued revocation writes.
        await Promise.allSettled([...tasks]);
        if (unsettled) return uncertain();
        if (
          result?.kind === 'verified' &&
          operation.state === 'quarantined' &&
          (operation !== callbackOperation ||
            (validReadinessOperation(result.value) && result.value.state === 'accepted'))
        )
          return blocked('Operation quarantined during scope completion');
        return result;
      } catch {
        return invalidate();
      } finally {
        accepting = false;
        await Promise.allSettled([...tasks]);
        active = false;
        if (unsettled) await quarantineUncertainAcceptance();
        store.finishOperationOwner?.(snapshot);
      }
    });
  } catch {
    return uncertain();
  }
}

/** Data-only reservation. Use the scoped composition API to consume its permit. */
export async function beginReadinessOperation(request, store) {
  return withReadinessOperation(request, store, async (scope) =>
    scope.newReservation
      ? verified(scope.operation)
      : blocked('Existing operation grants no new permit'),
  );
}
export async function recordReadinessPhase(requestId, phase, evidence, store) {
  try {
    if (!validId(requestId)) return blocked('Malformed request ID');
    const read = await store.readOperation(requestId);
    if (read?.kind !== 'verified') return uncertain();
    if (!read.value) return blocked('Unknown request');
    return withReadinessOperation(read.value.request, store, (s) => s.recordPhase(phase, evidence));
  } catch {
    return uncertain();
  }
}
export async function reconcileReadinessOperation(requestId, evidence, store) {
  try {
    if (!validId(requestId)) return blocked('Malformed request ID');
    const read = await store.readOperation(requestId);
    if (read?.kind !== 'verified') return uncertain();
    if (!read.value || !(await authorize(read.value.request, store)))
      return blocked('Authenticated original request required');
    // Authenticate the exact resolution before invoking the optional local-only
    // retained-owner recovery port. The locked callback rechecks the full digest.
    const preflight = await store.authenticateOperationEvidence?.(
      evidence,
      read.value,
      'reconciled',
    );
    if (!validResolution(preflight, read.value))
      return blocked('Authenticated original outcome required');
    const lock = store.withOperationReconciliationLock
      ? (fn) => store.withOperationReconciliationLock(read.value.request, evidence, fn)
      : (fn) => store.withPrLock(keyOf(read.value.request), fn);
    return await lock(async () => {
      const current = await store.readOperation(requestId);
      if (current?.kind !== 'verified') return uncertain();
      const operation = current.value;
      if (!validReadinessOperation(operation) || operation.state === 'reconciled')
        return blocked('No unresolved operation');
      const auth = await store.authenticateOperationEvidence?.(evidence, operation, 'reconciled');
      if (!validResolution(auth, operation))
        return blocked('Original outcome and human Draft reconciliation required');
      return persist({ ...operation, state: 'reconciled' }, store);
    });
  } catch {
    return uncertain();
  }
}

export function validResolution(auth, operation) {
  const v = auth?.value;
  return (
    auth?.kind === 'verified' &&
    v?.requestId === operation.request.requestId &&
    v.operationDigest === digest(JSON.stringify(operation)) &&
    v.humanActorId === operation.request.initiatingActorId &&
    v.returnedToDraft === true &&
    ['not-sent', 'applied', 'not-applied'].includes(v.outcome)
  );
}
