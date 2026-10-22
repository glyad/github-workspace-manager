import { AsyncLocalStorage } from 'node:async_hooks';
import { LocalDurableStore } from './local-durable-store.mjs';
import { blocked, verified, exactFields, requestId, boundedId } from './contracts.mjs';
import { digest, sameCandidate, validCandidate, operationKey } from './journal.mjs';
import { sameExecution } from './worker-results.mjs';
const limitFields = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
const validLimits = (l) =>
  exactFields(l, limitFields) && limitFields.every((k) => Number.isSafeInteger(l[k]) && l[k] > 0);
const equalLimits = (a, b) =>
  validLimits(a) && validLimits(b) && limitFields.every((k) => a[k] === b[k]);
const v2 = (c) => validCandidate(c) && c.protocolVersion === 2;
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => freeze(structuredClone(value));
function canonical(value) {
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
const validRun = (r) =>
  sameExecution(r, r) &&
  /^[1-9][0-9]{0,19}$/.test(r.id) &&
  ['repositoryId', 'actorId', 'workflowId'].every((k) => boundedId(r[k]));
const authorityInstances = new WeakSet();
const authorityReceipts = new WeakMap();
/** Local fixture origin registry, provisioned independently before runtime construction. */
export function createOfflineReviewOriginAuthority(config) {
  if (
    !exactFields(config, ['registrations']) ||
    !Array.isArray(config.registrations) ||
    config.registrations.length > 10000
  )
    throw Error('Offline registrations required');
  const registrations = structuredClone(config.registrations);
  const registry = new Map(),
    receipts = new WeakMap();
  const key = (c, r) => operationKey(c, `review-reservation:${r}`);
  for (const row of registrations) {
    if (
      !exactFields(row, [
        'candidate',
        'reservationRequestId',
        'run',
        'approvedDefinition',
        'limits',
        'evidenceBody',
      ]) ||
      !v2(row.candidate) ||
      !requestId(row.reservationRequestId) ||
      !validLimits(row.limits) ||
      !validRun(row.run) ||
      row.run.repositoryId !== row.candidate.repositoryId ||
      row.run.executionSha !== row.candidate.head ||
      !exactFields(row.approvedDefinition, ['repositoryId', 'workflowId', 'sha', 'ref']) ||
      !['repositoryId', 'workflowId', 'sha', 'ref'].every(
        (k) => row.approvedDefinition[k] === row.run[k],
      )
    )
      throw Error('Invalid offline origin');
    const { evidenceBody, ...fields } = row;
    if (
      typeof evidenceBody !== 'string' ||
      Buffer.byteLength(evidenceBody) > 16384 ||
      evidenceBody !== canonical(fields)
    )
      throw Error('Noncanonical origin evidence');
    const id = key(row.candidate, row.reservationRequestId);
    if (registry.has(id)) throw Error('Duplicate/conflicting offline origin');
    registry.set(id, snapshot(row));
  }
  const authority = Object.freeze({
    resolve(query) {
      if (
        !exactFields(query, ['candidate', 'reservationRequestId']) ||
        !v2(query.candidate) ||
        !requestId(query.reservationRequestId)
      )
        return blocked('Exact registered origin required');
      const row = registry.get(key(query.candidate, query.reservationRequestId));
      if (!row || !sameCandidate(row.candidate, query.candidate))
        return blocked('Unregistered call request');
      const receipt = Object.freeze(Object.create(null));
      receipts.set(receipt, row);
      return verified(receipt);
    },
    inspect(receipt, binding) {
      const row = receipts.get(receipt);
      if (
        !row ||
        !exactFields(binding, ['candidate', 'reservationRequestId', 'limits']) ||
        !sameCandidate(row.candidate, binding.candidate) ||
        row.reservationRequestId !== binding.reservationRequestId ||
        !equalLimits(row.limits, binding.limits)
      )
        return blocked('Original exact origin receipt required');
      return verified(
        snapshot({
          run: row.run,
          approvedDefinition: row.approvedDefinition,
          evidenceDigest: digest(row.evidenceBody),
        }),
      );
    },
  });
  authorityInstances.add(authority);
  authorityReceipts.set(authority, (receipt) => receipts.get(receipt));
  return authority;
}
const ownership = new AsyncLocalStorage();
const ledgerInternals = new WeakMap();
const uncertain = () => ({
  kind: 'uncertain',
  reason: 'Local review funding unavailable; retain capacity',
  evidence: [],
});
const limitsDigest = (l) =>
  digest(JSON.stringify(['review-limits-v1', ...limitFields.map((k) => l[k])]));
const claimId = (key) => digest(JSON.stringify(['review-claim-v1', key]));
const same = (a, b) => canonical(a) === canonical(b);
function validReservation(r, limits) {
  return (
    exactFields(r, ['key', 'candidate', 'requestId', 'status', 'limits']) &&
    v2(r.candidate) &&
    requestId(r.requestId) &&
    r.key === operationKey(r.candidate, `review-reservation:${r.requestId}`) &&
    equalLimits(r.limits, limits) &&
    ['reserved', 'unknown', 'completed'].includes(r.status)
  );
}
function validClaim(c, r) {
  return (
    exactFields(c, [
      'id',
      'reservationKey',
      'candidate',
      'requestId',
      'limits',
      'run',
      'materialDigest',
      'invocationDigest',
      'start',
    ]) &&
    c.id === claimId(r.key) &&
    c.reservationKey === r.key &&
    sameCandidate(c.candidate, r.candidate) &&
    c.requestId === r.requestId &&
    equalLimits(c.limits, r.limits) &&
    validRun(c.run) &&
    c.run.repositoryId === r.candidate.repositoryId &&
    c.run.executionSha === r.candidate.head &&
    hash(c.materialDigest) &&
    hash(c.invocationDigest) &&
    (c.start === null ||
      (exactFields(c.start, ['state', 'claimId', 'run']) &&
        c.start.state === 'consumed' &&
        c.start.claimId === c.id &&
        sameExecution(c.start.run, c.run)))
  );
}
function validOutcome(o, r, c) {
  return (
    exactFields(o, [
      'reservationKey',
      'claimId',
      'candidate',
      'run',
      'invocationDigest',
      'executionEnded',
      'providerOutcome',
      'evidenceDigest',
    ]) &&
    o.reservationKey === r.key &&
    sameCandidate(o.candidate, r.candidate) &&
    typeof o.executionEnded === 'boolean' &&
    ['not-sent', 'completed', 'unknown'].includes(o.providerOutcome) &&
    hash(o.evidenceDigest) &&
    (c
      ? o.claimId === c.id &&
        sameExecution(o.run, c.run) &&
        o.invocationDigest === c.invocationDigest
      : o.claimId === null &&
        o.run === null &&
        o.invocationDigest === null &&
        o.providerOutcome !== 'completed')
  );
}
function transition(previous, event, limits, origin) {
  if (
    !exactFields(event, [
      'version',
      'sequence',
      'previousDigest',
      'kind',
      'reservation',
      'claim',
      'outcome',
    ]) ||
    event.version !== 1 ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    (event.previousDigest !== '' && !hash(event.previousDigest)) ||
    !validReservation(event.reservation, limits)
  )
    throw Error('Review event fields');
  const r = event.reservation,
    c = event.claim,
    o = event.outcome;
  const auth = origin(r);
  if (
    auth.kind !== 'verified' ||
    (c !== null && (!validClaim(c, r) || !sameExecution(c.run, auth.value.run))) ||
    (o !== null && !validOutcome(o, r, c))
  )
    throw Error('Review origin/claim/outcome binding');
  if (!previous) {
    if (event.kind !== 'reserved' || r.status !== 'reserved' || c !== null || o !== null)
      throw Error('First review event must reserve');
    return;
  }
  if (!same({ ...previous.reservation, status: r.status }, r) || previous.kind === 'contradiction')
    throw Error('Immutable reservation or quarantined history');
  const before = previous.claim;
  if (event.kind === 'claimed') {
    if (
      previous.kind !== 'reserved' ||
      !c ||
      c.start !== null ||
      o !== null ||
      r.status !== 'reserved'
    )
      throw Error('Claim transition');
  } else if (event.kind === 'consumed') {
    if (
      previous.kind !== 'claimed' ||
      !c?.start ||
      !same({ ...before, start: c.start }, c) ||
      o !== null ||
      r.status !== 'reserved'
    )
      throw Error('Consume transition');
  } else {
    if (!same(before, c)) throw Error('Immutable claim and start');
    if (event.kind === 'unknown') {
      if (
        !['reserved', 'claimed', 'consumed', 'unknown'].includes(previous.kind) ||
        r.status !== 'unknown' ||
        (o && o.providerOutcome !== 'unknown')
      )
        throw Error('Unknown transition');
    } else if (event.kind === 'completed') {
      if (
        !['reserved', 'claimed', 'consumed', 'unknown'].includes(previous.kind) ||
        r.status !== 'completed' ||
        !o ||
        o.executionEnded !== true ||
        !['not-sent', 'completed'].includes(o.providerOutcome)
      )
        throw Error('Completion transition');
    } else if (event.kind === 'contradiction') {
      if (
        !['completed', 'unknown'].includes(previous.kind) ||
        r.status !== 'unknown' ||
        !o ||
        same(previous.outcome, o)
      )
        throw Error('Contradiction transition');
    } else throw Error('Invalid lifecycle kind');
  }
}
/** Local TEST adapter only. No production backend or execution permission. */
export function createLocalReviewLedger(config) {
  if (
    !exactFields(config, [
      'store',
      'fundingScope',
      'approvedLimits',
      'observeUnderPrLock',
      'originAuthority',
      'verifyOutcome',
    ]) ||
    !(config.store instanceof LocalDurableStore) ||
    !requestId(config.fundingScope) ||
    !validLimits(config.approvedLimits) ||
    typeof config.observeUnderPrLock !== 'function' ||
    typeof config.verifyOutcome !== 'function' ||
    !authorityInstances.has(config.originAuthority)
  )
    throw Error('Explicit local funding configuration required');
  const store = config.store,
    scope = config.fundingScope,
    limits = snapshot(config.approvedLimits),
    lDigest = limitsDigest(limits);
  const observer = config.observeUnderPrLock,
    authority = config.originAuthority,
    inspect = authority.inspect.bind(authority),
    resolve = authority.resolve.bind(authority),
    verifyOutcome = config.verifyOutcome;
  const storageRead = store.readReviewFunding.bind(store),
    storageAppend = store.appendReviewFunding.bind(store),
    storageLock = store.withReviewFundingLock.bind(store);
  const instance = Object.freeze({});
  function owner() {
    const context = ownership.getStore();
    if (!context || context.instance !== instance || !context.active)
      throw Error('Live module-owned funding scope required');
    return context;
  }
  // Register before the first await. Escaped work is drained under the lock,
  // with ownership expired, and leaves an explicit uncertainty obligation.
  function owned(fn) {
    let context;
    try {
      context = owner();
    } catch {
      return Promise.resolve(uncertain());
    }
    const promise = (async () => {
      try {
        const result = await fn();
        if (result?.kind === 'uncertain') context.poisoned = true;
        return result;
      } catch {
        context.poisoned = true;
        return uncertain();
      }
    })();
    context.pending.add(promise);
    promise.then(() => context.pending.delete(promise));
    return promise;
  }
  function origin(r) {
    const query = { candidate: r.candidate, reservationRequestId: r.requestId };
    const receipt = resolve(query);
    return receipt.kind === 'verified'
      ? inspect(receipt.value, { ...query, limits: r.limits })
      : receipt;
  }
  async function history() {
    owner();
    const events = await storageRead(scope, lDigest);
    owner();
    const latest = new Map();
    for (const event of events) {
      transition(latest.get(event.reservation?.key), event, limits, origin);
      latest.set(event.reservation.key, event);
    }
    return { events, latest };
  }
  async function appendReviewEvent(input) {
    const event = snapshot(input);
    owner();
    const before = await history();
    owner();
    const previous = before.latest.get(event.reservation.key);
    transition(previous, event, limits, origin);
    const expected = before.events.length + 1;
    if (
      event.sequence !== expected ||
      event.previousDigest !==
        (before.events.length ? digest(JSON.stringify(before.events.at(-1))) : '')
    )
      throw Error('Event sequence');
    await storageAppend(scope, lDigest, event);
    owner();
    const after = await history();
    owner();
    if (!same(after.events.at(-1), event)) throw Error('Event readback');
    return verified(snapshot(event));
  }
  async function withFunding(fn) {
    if (ownership.getStore()) return blocked('Funding scope nesting forbidden');
    if (typeof fn !== 'function') return blocked('Funding callback required');
    try {
      return await storageLock(scope, lDigest, () => {
        const context = { instance, active: true, poisoned: false, pending: new Set() };
        return ownership.run(context, async () => {
          let result;
          try {
            result = await fn();
          } catch {
            result = uncertain();
          } finally {
            context.active = false;
          }
          const escaped = [...context.pending];
          if (escaped.length) {
            await Promise.allSettled(escaped);
            return uncertain();
          }
          return context.poisoned ? uncertain() : result;
        });
      });
    } catch {
      return uncertain();
    }
  }
  const read = () =>
    owned(async () => {
      const { latest } = await history();
      owner();
      return verified(
        snapshot({
          limitsApproved: true,
          limits,
          reservations: [...latest.values()].map((e) => e.reservation),
        }),
      );
    });
  const observe = (input) => {
    let c;
    try {
      c = snapshot(input);
    } catch {
      return Promise.resolve(blocked('Candidate snapshot required'));
    }
    return owned(async () => {
      if (!v2(c)) return blocked('Complete v2 candidate required');
      const value = await observer(c);
      owner();
      return snapshot(value);
    });
  };
  const readReservation = (input) => {
    const key = input;
    return owned(async () => {
      if (!hash(key)) return blocked('Reservation key required');
      const event = (await history()).latest.get(key);
      owner();
      return verified(
        event
          ? snapshot({ reservation: event.reservation, claim: event.claim, outcome: event.outcome })
          : null,
      );
    });
  };
  const readByClaimId = (input) => {
    const id = input;
    return owned(async () => {
      if (!hash(id)) return blocked('Claim ID required');
      const { latest } = await history();
      owner();
      const event = [...latest.values()].find((e) => e.claim?.id === id);
      if (event && event.claim.id !== claimId(event.reservation.key))
        throw Error('Hash-derived claim ID');
      return verified(
        event
          ? snapshot({ reservation: event.reservation, claim: event.claim, outcome: event.outcome })
          : null,
      );
    });
  };
  function forOrigin(receipt) {
    const row = authorityReceipts.get(authority)(receipt);
    const binding =
      row &&
      snapshot({
        candidate: row.candidate,
        reservationRequestId: row.reservationRequestId,
        limits,
      });
    const authentic = () => binding && inspect(receipt, binding).kind === 'verified';
    // Invalid receipts cannot reach any storage/lock/observation provider.
    if (!authentic())
      return Object.freeze({
        withReservationLock: () => blocked('Original authority receipt required'),
        read: () => blocked('Original authority receipt required'),
        append: () => blocked('Original authority receipt required'),
        observe: () => blocked('Original authority receipt required'),
      });
    return Object.freeze({
      withReservationLock: (fn) => (authentic() ? withFunding(fn) : blocked('Origin unavailable')),
      read: () => (authentic() ? read() : blocked('Origin unavailable')),
      observe: (c) =>
        authentic() && sameCandidate(c, binding.candidate)
          ? observe(c)
          : blocked('Candidate origin mismatch'),
      append(input) {
        let r;
        try {
          r = snapshot(input);
        } catch {
          return blocked('Reservation snapshot required');
        }
        if (
          !authentic() ||
          !validReservation(r, limits) ||
          r.status !== 'reserved' ||
          !sameCandidate(r.candidate, binding.candidate) ||
          r.requestId !== binding.reservationRequestId
        )
          return blocked('Exact authorized reservation required');
        return owned(async () => {
          const { events, latest } = await history();
          owner();
          if (
            latest.has(r.key) ||
            [...latest.values()].some(
              (e) =>
                e.reservation.candidate.repositoryId === r.candidate.repositoryId &&
                e.reservation.candidate.pr === r.candidate.pr &&
                e.reservation.candidate.attempt === r.candidate.attempt &&
                e.reservation.requestId === r.requestId,
            )
          )
            return blocked('Duplicate call request');
          const reservations = [...latest.values()].map((e) => e.reservation);
          if (
            reservations.filter(
              (x) =>
                x.candidate.repositoryId === r.candidate.repositoryId &&
                x.candidate.pr === r.candidate.pr &&
                x.candidate.attempt === r.candidate.attempt,
            ).length >= limits.callsPerAttempt ||
            reservations.filter((x) => x.status !== 'completed').length >= limits.maxConcurrentCalls
          )
            return blocked('Funding capacity occupied');
          const event = {
            version: 1,
            sequence: events.length + 1,
            previousDigest: events.length ? digest(JSON.stringify(events.at(-1))) : '',
            kind: 'reserved',
            reservation: r,
            claim: null,
            outcome: null,
          };
          return appendReviewEvent(event);
        });
      },
    });
  }
  const ledger = Object.freeze({
    forOrigin,
    withFunding,
    read,
    observe,
    readReservation,
    readByClaimId,
  });
  // Unit 2 extends this module using these private operations, never caller JSON.
  ledgerInternals.set(ledger, {
    owned,
    withFunding,
    history,
    appendReviewEvent,
    inspect,
    verifyOutcome,
    limits,
    owner,
  });
  return ledger;
}
