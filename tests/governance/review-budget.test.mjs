import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveReviewBudget } from '../../tools/governance/review-budget.mjs';
const candidate = {
  repositoryId: 'repo-1',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-1',
};
// Fixture numbers are deliberately NOT activation decisions.
const limits = {
  callsPerAttempt: 2,
  maxOutputTokens: 300,
  maxInputBytes: 100,
  maxRunSeconds: 20,
  maxConcurrentCalls: 1,
};
const observation = {
  candidate,
  ready: true,
  admitted: true,
  nativeVerified: true,
  lifecycleVerified: true,
  invalidated: false,
  sameRepository: true,
  ci: { verified: true, candidate, outcome: 'success' },
  fundingActivated: true,
  credentialsActivated: true,
  trustVerified: true,
  actionPinVerified: true,
  ceilingsEnforced: true,
  keyExposedToCheckout: false,
  untrustedTools: false,
  inputBytes: 30,
};
const attempt = (requestId = 'request-1') => ({ candidate, requestId, observed: observation });
function ledger() {
  const rows = [];
  let queue = Promise.resolve();
  return {
    rows,
    observe: async () => structuredClone(observation),
    withReservationLock: async (fn) => {
      const before = queue;
      let release;
      queue = new Promise((r) => {
        release = r;
      });
      await before;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    read: async () => ({
      kind: 'verified',
      value: { limitsApproved: true, limits, reservations: structuredClone(rows) },
    }),
    append: async (row) => {
      rows.push(structuredClone(row));
      return { kind: 'verified' };
    },
  };
}
test('atomically reserves exact candidate and explicit approved ceilings without making API calls', async () => {
  const l = ledger();
  const r = await reserveReviewBudget(attempt(), limits, l);
  assert.equal(r.kind, 'verified');
  assert.deepEqual(r.value.candidate, candidate);
  assert.deepEqual(r.value.limits, limits);
  assert.equal(l.rows.length, 1);
});
test('duplicate and simultaneous requests cannot reserve twice or exceed global concurrency', async () => {
  const l = ledger();
  const out = await Promise.all([
    reserveReviewBudget(attempt(), limits, l),
    reserveReviewBudget(attempt(), limits, l),
    reserveReviewBudget(attempt('request-2'), limits, l),
  ]);
  assert.equal(out.filter((r) => r.kind === 'verified').length, 1);
  assert.equal(l.rows.length, 1);
});
test('completed calls consume attempt budget while ambiguous outcomes consume concurrency until reconciled', async () => {
  const l = ledger();
  assert.equal((await reserveReviewBudget(attempt(), limits, l)).kind, 'verified');
  l.rows[0].status = 'unknown';
  assert.equal((await reserveReviewBudget(attempt('request-2'), limits, l)).kind, 'blocked');
  l.rows[0].status = 'completed';
  assert.equal((await reserveReviewBudget(attempt('request-2'), limits, l)).kind, 'verified');
  l.rows[1].status = 'completed';
  assert.equal((await reserveReviewBudget(attempt('request-3'), limits, l)).kind, 'blocked');
});
test('no reservation for unapproved/invalid limits, Draft, oversized diff, or exposed key', async () => {
  for (const patch of [
    { ready: false },
    { fundingActivated: false },
    { credentialsActivated: false },
    { ci: null },
    { inputBytes: 101 },
    { keyExposedToCheckout: true },
    { untrustedTools: true },
  ]) {
    const l = ledger();
    assert.equal(
      (
        await reserveReviewBudget(
          { ...attempt(), observed: { ...observation, ...patch } },
          limits,
          l,
        )
      ).kind,
      'blocked',
    );
    assert.equal(l.rows.length, 0);
  }
  for (const value of [0, -1, NaN, Infinity, 1.1, undefined]) {
    const l = ledger();
    assert.equal(
      (await reserveReviewBudget(attempt(), { ...limits, maxOutputTokens: value }, l)).kind,
      'blocked',
    );
    assert.equal(l.rows.length, 0);
  }
  const l = ledger();
  l.read = async () => ({
    kind: 'verified',
    value: { limitsApproved: false, limits, reservations: [] },
  });
  assert.equal((await reserveReviewBudget(attempt(), limits, l)).kind, 'blocked');
});
test('outage or uncertain append/readback grants no authorization and does not release persisted reservation', async () => {
  const l = ledger();
  l.append = async (row) => {
    l.rows.push(row);
    return { kind: 'uncertain' };
  };
  assert.notEqual((await reserveReviewBudget(attempt(), limits, l)).kind, 'verified');
  assert.equal(l.rows.length, 1);
  l.append = async (row) => {
    l.rows.push(row);
    return { kind: 'verified' };
  };
  assert.equal((await reserveReviewBudget(attempt('request-2'), limits, l)).kind, 'blocked');
  assert.equal((await reserveReviewBudget(attempt(), limits, {})).kind, 'blocked');
});
test('fresh admission drift before or after append blocks authorization and retains any written slot', async () => {
  for (const afterAppend of [false, true]) {
    const l = ledger();
    let reads = 0;
    l.observe = async () =>
      ++reads > (afterAppend ? 1 : 0) ? { ...observation, ready: false } : observation;
    const r = await reserveReviewBudget(attempt(), limits, l);
    assert.equal(r.kind, 'blocked');
    assert.equal(l.rows.length, afterAppend ? 1 : 0);
  }
});
test('unverified or malformed history cannot reset exhausted budget', async () => {
  const l = ledger();
  l.read = async () => ({
    kind: 'verified',
    value: { limitsApproved: true, limits, reservations: [{ status: 'completed' }] },
  });
  assert.equal((await reserveReviewBudget(attempt(), limits, l)).kind, 'blocked');
  assert.equal(l.rows.length, 0);
});
test('missing request identity cannot poison durable history or reserve a slot', async () => {
  const l = ledger();
  const r = await reserveReviewBudget({ candidate, observed: observation }, limits, l);
  assert.equal(r.kind, 'blocked');
  assert.equal(l.rows.length, 0);
});
test('budget survives base drift within attempt and concurrency spans PRs', async () => {
  const l = ledger();
  assert.equal((await reserveReviewBudget(attempt(), limits, l)).kind, 'verified');
  const other = { ...candidate, pr: 8, attempt: 'ready-2' };
  const otherObs = {
    ...observation,
    candidate: other,
    ci: { ...observation.ci, candidate: other },
  };
  l.observe = async () => otherObs;
  assert.equal(
    (
      await reserveReviewBudget(
        { candidate: other, requestId: 'other', observed: otherObs },
        limits,
        l,
      )
    ).kind,
    'blocked',
  );
  l.rows[0].status = 'completed';
  const drifted = { ...candidate, base: 'd'.repeat(40) };
  const driftObs = {
    ...observation,
    candidate: drifted,
    ci: { ...observation.ci, candidate: drifted },
  };
  l.observe = async () => driftObs;
  assert.equal(
    (
      await reserveReviewBudget(
        { candidate: drifted, requestId: 'request-1', observed: driftObs },
        limits,
        l,
      )
    ).kind,
    'blocked',
  );
});

test('request_change_cannot_reset_same_ready_budget', async () => {
  const l = ledger();
  for (let i = 0; i < 3; i++) {
    const c = {
      ...candidate,
      protocolVersion: 2,
      baseRef: 'refs/heads/develop',
      requestId: `readiness-${i}`,
      base: String(i).repeat(40),
      head: String(i + 1).repeat(40),
    };
    const o = {
      ...observation,
      candidate: c,
      ci: { verified: true, candidate: c, outcome: 'success' },
    };
    l.observe = async () => o;
    const result = await reserveReviewBudget(
      { candidate: c, requestId: `paid-${i}`, observed: o },
      limits,
      l,
    );
    assert.equal(result.kind, i < 2 ? 'verified' : 'blocked');
    if (i < 2) l.rows[i].status = 'completed';
  }
  assert.equal(l.rows.length, 2);
});

test('local funding facade requires the independently registered exact call origin', async (t) => {
  const { promises: fs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LocalDurableStore } = await import('../../tools/governance/local-durable-store.mjs');
  const { createLocalReviewLedger, createOfflineReviewOriginAuthority } =
    await import('../../tools/governance/worker-ledger.mjs');
  const fixture = await import('./fixtures/review-authority-fixture.mjs');
  const { digest } = await import('../../tools/governance/journal.mjs');
  const root = await fs.mkdtemp(join(tmpdir(), 'review-budget-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root);
  const l = fixture.limits;
  await store.initializeReviewFunding(
    'fixture',
    digest(
      JSON.stringify([
        'review-limits-v1',
        l.callsPerAttempt,
        l.maxOutputTokens,
        l.maxInputBytes,
        l.maxRunSeconds,
        l.maxConcurrentCalls,
      ]),
    ),
  );
  const authority = createOfflineReviewOriginAuthority({ registrations: [fixture.registration()] });
  const local = createLocalReviewLedger({
    store,
    fundingScope: 'fixture',
    approvedLimits: l,
    originAuthority: authority,
    observeUnderPrLock: async (c) => fixture.observation(c),
    verifyOutcome: async () => ({ kind: 'blocked' }),
  });
  const c = fixture.candidate,
    observed = fixture.observation(c);
  assert.equal(
    (
      await reserveReviewBudget(
        { candidate: c, requestId: 'paid-1', observed },
        l,
        local.forOrigin({ verified: true }),
      )
    ).kind,
    'blocked',
  );
  const receipt = authority.resolve({ candidate: c, reservationRequestId: 'paid-1' }).value;
  assert.equal(
    (
      await reserveReviewBudget(
        { candidate: c, requestId: 'paid-1', observed },
        l,
        local.forOrigin(receipt),
      )
    ).kind,
    'verified',
  );
  assert.equal((await local.withFunding(() => local.read())).value.reservations.length, 1);
});
