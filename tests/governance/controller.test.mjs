import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReadiness, reconcileTransition } from '../../tools/governance/controller.mjs';
import { admitCandidate, inactivePort } from '../../tools/governance/admission.mjs';
import { operationKey } from '../../tools/governance/journal.mjs';
import scenario from './fixtures/readiness/scenarios.json' with { type: 'json' };
const candidate = {
  repositoryId: scenario.repositoryId,
  pr: scenario.pr,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-2',
  protocolVersion: 2,
  requestId: 'request-1',
  baseRef: 'refs/heads/develop',
};
const observed = () => ({
  ...candidate,
  baseRef: candidate.baseRef,
  admission: {
    candidate: { ...candidate },
    proof: { version: 2 },
    proofDigest: 'proof',
    verified: true,
  },
  state: 'open',
  draft: false,
  sameRepository: true,
  nativeVerified: true,
  lifecycle: { verified: true, attempt: 'ready-2', closedSinceReady: false },
  readiness: {
    id: 'ready-2',
    kind: 'ready_for_review',
    candidateVerified: true,
    candidate: { ...candidate },
  },
});
const ready = {
  type: 'verified_readiness',
  candidate,
  proofDigest: 'proof',
  claimId: 'claim',
  run: {
    id: '1',
    attempt: 1,
    sha: 'c'.repeat(40),
    executionSha: 'c'.repeat(40),
    actorId: '5',
    workflowId: '4',
    repositoryId: 'repo',
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  },
  readinessId: 'ready-2',
  repositoryId: 'repo',
  pr: 7,
};
const journal = (records = []) => ({ kind: 'verified', value: records, evidence: [] });
const record = (action, phase = 'result', c = candidate) => ({
  version: c.protocolVersion === 2 ? 2 : 1,
  key: operationKey(c, action),
  candidate: c,
  action,
  phase,
});
function fixture(records = []) {
  let state = observed();
  let active = 0;
  let maximum = 0;
  const rows = [...records];
  const mutations = [];
  const port = {
    withPrLock: async (_key, fn) => {
      const previous = port.tail;
      let done;
      port.tail = new Promise((r) => {
        done = r;
      });
      await previous;
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await fn();
      } finally {
        active--;
        done();
      }
    },
    observe: async () => structuredClone(state),
    readJournal: async () => journal(structuredClone(rows)),
    append: async (row) => {
      rows.push(structuredClone(row));
      return { kind: 'verified', value: row };
    },
    draft: async (c) => {
      mutations.push(c);
      state.draft = true;
      state.readiness.kind = 'converted_to_draft';
    },
    resolveCiContinuation: async (e) =>
      journal({
        id: 'claim',
        candidate: e.candidate,
        requestId: e.candidate.requestId,
        worker: 'ci',
        definitionSha: 'c'.repeat(40),
        status: 'observed',
        run: e.run,
        start: null,
      }),
    consumeCiStart: async (_id, run) =>
      journal({
        newlyConsumed: true,
        claim: {
          id: 'claim',
          candidate: state.admission.candidate,
          requestId: state.admission.candidate.requestId,
          worker: 'ci',
          definitionSha: run.sha,
          status: 'observed',
          run,
          start: {
            claimId: 'claim',
            candidate: state.admission.candidate,
            definitionSha: run.sha,
            runId: run.id,
            runAttempt: run.attempt,
            state: 'consumed',
          },
        },
      }),
    verifyWorkerCallback: async (_event, run) => journal(run),
    verifyWorker: async () => ({ kind: 'blocked', reason: 'Unresolved worker provenance' }),
  };
  return {
    port,
    rows,
    mutations,
    set: (v) => {
      // Trusted adapter fixture authenticates origin separately from current drift.
      const origin = v.readiness?.candidate ?? candidate;
      state = {
        ...v,
        admission: {
          candidate: origin,
          proof: { version: 2 },
          proofDigest: 'proof',
          verified:
            !!v.readiness?.candidateVerified &&
            ['base', 'head', 'attempt', 'baseRef'].every(
              (k) => (k === 'attempt' ? v.readiness.id : v[k]) === origin[k],
            ),
        },
      };
    },
    maximum: () => maximum,
  };
}
test('only authenticated verified readiness admits CI', () => {
  assert.equal(decideReadiness(observed(), ready, journal()).action, 'admit-ci');
  for (const event of [
    { ...ready, type: 'synchronize' },
    { ...ready, readinessId: 'ready-1' },
    { ...ready, type: 'opened' },
  ])
    assert.equal(decideReadiness(observed(), event, journal()).action, 'none');
});
test('Draft, close, fork and unverifiable native history deny expensive workers', () => {
  for (const extra of [
    { draft: true },
    { state: 'closed' },
    { sameRepository: false },
    { nativeVerified: false },
    { readiness: { id: 'ready-2', kind: 'convert_to_draft' } },
  ])
    assert.notEqual(
      decideReadiness({ ...observed(), ...extra }, ready, journal()).action,
      'admit-ci',
    );
});
test('duplicate and reordered events do not restart admitted work', async () => {
  const f = fixture();
  const values = await Promise.all(Array.from({ length: 6 }, () => admitCandidate(f.port, ready)));
  assert.equal(values.filter((v) => v.kind === 'verified').length, 1);
  assert.equal(f.rows.filter((v) => v.phase === 'result').length, 1);
  assert.equal(f.maximum(), 1);
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'converted_to_draft', readinessId: 'ready-1' }))
      .kind,
    'blocked',
  );
});
test('unexpected Ready head change drafts only the current attempt and never admits CI', async () => {
  const f = fixture([record('admit-ci')]);
  const current = { ...observed(), head: 'd'.repeat(40) };
  f.set(current);
  const result = await admitCandidate(f.port, {
    ...ready,
    type: 'synchronize',
    head: current.head,
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0].head, current.head);
});
test('old pending synchronize and failure cannot downgrade rapid Draft to Ready', async () => {
  const f = fixture([record('admit-ci')]);
  f.set({
    ...observed(),
    attempt: 'ready-3',
    readiness: { id: 'ready-3', kind: 'ready_for_review' },
  });
  for (const event of [
    { ...ready, type: 'synchronize', head: 'd'.repeat(40) },
    { ...ready, type: 'worker_completed', worker: 'ci', outcome: 'failure', candidate },
  ])
    assert.equal((await admitCandidate(f.port, event)).kind, 'blocked');
  assert.equal(f.mutations.length, 0);
});
test('base-only drift invalidates prior admission and review', async () => {
  const f = fixture([record('admit-ci'), record('ci-success')]);
  f.set({ ...observed(), base: 'd'.repeat(40) });
  const result = await admitCandidate(f.port, {
    ...ready,
    type: 'worker_start',
    worker: 'review',
    candidate,
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(f.mutations.length, 0);
});
test('missing ledger and forged worker evidence fail closed', async () => {
  const f = fixture([record('admit-ci')]);
  f.port.readJournal = async () => ({ kind: 'blocked', reason: 'missing ledger' });
  assert.equal((await admitCandidate(f.port, ready)).kind, 'blocked');
  f.port.readJournal = async () => journal([record('admit-ci')]);
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_completed',
        candidate,
        worker: 'ci',
        outcome: 'success',
        verified: true,
      })
    ).kind,
    'blocked',
  );
  assert.equal(f.rows.length, 1);
});
test('worker start and completion require exact candidate and current passing CI before review', async () => {
  const f = fixture([record('admit-ci')]);
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'ci' }))
      .kind,
    'verified',
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'review' }))
      .kind,
    'blocked',
  );
  f.port.verifyWorker = async () => ({
    kind: 'verified',
    value: { candidate, worker: 'ci', outcome: 'success' },
  });
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_completed',
        candidate,
        worker: 'ci',
        outcome: 'success',
      })
    ).kind,
    'verified',
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'review' }))
      .kind,
    'verified',
  );
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_completed',
        candidate: { ...candidate, head: 'd'.repeat(40) },
        worker: 'ci',
        outcome: 'failure',
      })
    ).kind,
    'blocked',
  );
});
test('post-mutation status race quarantines attempt without restoring Ready', async () => {
  const f = fixture([record('admit-ci')]);
  f.port.verifyWorker = async () => ({
    kind: 'verified',
    value: { candidate, worker: 'ci', outcome: 'failure' },
  });
  f.port.draft = async () => {
    f.mutations.push(candidate);
    f.set({
      ...observed(),
      attempt: 'ready-3',
      readiness: { id: 'ready-3', kind: 'ready_for_review' },
    });
  };
  const result = await admitCandidate(f.port, {
    ...ready,
    type: 'worker_completed',
    candidate,
    worker: 'ci',
    outcome: 'failure',
  });
  assert.equal(result.kind, 'uncertain');
  assert.equal(f.rows.at(-1).phase, 'quarantine');
  assert.equal(f.rows.at(-1).candidate.attempt, 'ready-2');
});
test('missing result readback and replaced pending intent never admit work', async () => {
  const f = fixture();
  f.port.append = async () => ({ kind: 'verified' });
  assert.notEqual((await admitCandidate(f.port, ready)).kind, 'verified');
  assert.notEqual(
    (await admitCandidate(fixture([record('admit-ci', 'intent')]).port, ready)).kind,
    'verified',
  );
});
test('reconciliation rejects a decision whose candidate changed before mutation', async () => {
  const f = fixture();
  const decision = decideReadiness(observed(), ready, journal());
  f.set({ ...observed(), head: 'd'.repeat(40) });
  assert.equal((await reconcileTransition(f.port, decision)).kind, 'blocked');
  assert.equal(f.rows.length, 0);
});
test('inactive live adapter performs no network or mutation', async () => {
  assert.equal((await admitCandidate(inactivePort(), ready)).kind, 'blocked');
});
test('unknown Draft mutation outcome prevents another worker start', async () => {
  const f = fixture([record('admit-ci')]);
  f.port.verifyWorker = async () => ({
    kind: 'verified',
    value: { candidate, worker: 'ci', outcome: 'failure' },
  });
  f.port.draft = async () => {
    throw Error('lost response');
  };
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_completed',
        candidate,
        worker: 'ci',
        outcome: 'failure',
      })
    ).kind,
    'uncertain',
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'ci' }))
      .kind,
    'blocked',
  );
});
test('result read-back race quarantines admission and denies subsequent workers', async () => {
  const f = fixture();
  const append = f.port.append;
  f.port.append = async (row) => {
    const result = await append(row);
    if (row.phase === 'result') f.set({ ...observed(), head: 'd'.repeat(40) });
    return result;
  };
  assert.equal((await admitCandidate(f.port, ready)).kind, 'uncertain');
  assert.equal(f.rows.at(-1).phase, 'quarantine');
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'ci' }))
      .kind,
    'blocked',
  );
});

test('current CI failure returns Draft and invalidates workers with native Draft history', async () => {
  const f = fixture([record('admit-ci')]);
  f.port.verifyWorker = async () => ({
    kind: 'verified',
    value: { candidate, worker: 'ci', outcome: 'failure' },
  });
  f.port.draft = async (c) => {
    f.mutations.push(c);
    f.set({ ...observed(), draft: true, readiness: { id: 'ready-2', kind: 'converted_to_draft' } });
  };
  const result = await admitCandidate(f.port, {
    ...ready,
    type: 'worker_completed',
    candidate,
    worker: 'ci',
    outcome: 'failure',
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(f.rows.at(-1).phase, 'result');
  assert.equal(f.rows.at(-1).action, 'draft');
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', candidate, worker: 'ci' }))
      .kind,
    'blocked',
  );
});

for (const field of ['head', 'base']) {
  for (const synchronizeFirst of [true, false]) {
    test(`delayed first Ready rejects intervening ${field} drift with synchronizeFirst=${synchronizeFirst}`, async () => {
      const f = fixture();
      const current = { ...observed(), [field]: 'd'.repeat(40) };
      f.set(current);
      if (synchronizeFirst) {
        const sync = await admitCandidate(f.port, {
          ...ready,
          type: 'synchronize',
          head: current.head,
        });
        assert.notEqual(sync.kind, 'verified');
        assert.equal(f.mutations.length, field === 'head' ? 1 : 0);
      }
      const delayed = await admitCandidate(f.port, { ...ready, candidate, head: candidate.head });
      assert.notEqual(delayed.kind, 'verified');
      assert.equal(
        f.rows.some((r) => r.action === 'admit-ci'),
        false,
      );
      const worker = await admitCandidate(f.port, {
        ...ready,
        type: 'worker_start',
        worker: 'ci',
        candidate: { ...candidate, [field]: current[field] },
      });
      assert.equal(worker.kind, 'blocked');
    });
  }
}
test('PR event claims cannot supply missing authenticated event-time Ready identity', async () => {
  const f = fixture();
  f.set({ ...observed(), readiness: { id: 'ready-2', kind: 'ready_for_review' } });
  assert.equal(
    (await admitCandidate(f.port, { ...ready, candidate, readyCandidateVerified: true })).kind,
    'blocked',
  );
  assert.equal(f.rows.length, 0);
});
test('worker start rejects drifted Ready origin even with an exact current ledger result', async () => {
  const pushed = { ...candidate, head: 'd'.repeat(40) };
  const f = fixture([record('admit-ci', 'result', pushed)]);
  f.set({ ...observed(), head: pushed.head });
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_start',
        worker: 'ci',
        candidate: pushed,
      })
    ).kind,
    'blocked',
  );
});
test('fresh authenticated result read may reconcile earlier result read-back uncertainty', async () => {
  const f = fixture();
  const append = f.port.append;
  const read = f.port.readJournal;
  let unavailable = false;
  f.port.append = async (row) => {
    const result = await append(row);
    if (row.phase === 'result') unavailable = true;
    return result;
  };
  f.port.readJournal = async () => {
    if (unavailable) {
      unavailable = false;
      return { kind: 'blocked', reason: 'temporary read outage' };
    }
    return read();
  };
  const uncertain = await admitCandidate(f.port, ready);
  assert.equal(uncertain.kind, 'uncertain');
  assert.equal(f.rows.at(-1).phase, 'result');
  const recovered = await admitCandidate(f.port, {
    ...ready,
    type: 'worker_start',
    worker: 'ci',
    candidate,
  });
  assert.equal(recovered.kind, 'verified');
  assert.equal(f.mutations.length, 0);
});

test('a fresh deliberate Ready attempt binds and admits its own new candidate', async () => {
  const f = fixture([record('admit-ci')]);
  const next = { ...candidate, head: 'd'.repeat(40), attempt: 'ready-3' };
  f.set({
    ...observed(),
    ...next,
    lifecycle: { verified: true, attempt: 'ready-3', closedSinceReady: false },
    readiness: {
      id: 'ready-3',
      kind: 'ready_for_review',
      candidateVerified: true,
      candidate: next,
    },
  });
  const result = await admitCandidate(f.port, {
    ...ready,
    candidate: next,
    readinessId: 'ready-3',
  });
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.attempt, 'ready-3');
  assert.equal(result.value.head, 'd'.repeat(40));
  assert.equal(f.mutations.length, 0);
});

async function admittedAndPassed() {
  const f = fixture();
  assert.equal((await admitCandidate(f.port, ready)).kind, 'verified');
  f.port.verifyWorker = async (e) => ({
    kind: 'verified',
    value: { candidate: e.candidate, worker: e.worker, outcome: e.outcome },
  });
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        type: 'worker_completed',
        candidate,
        worker: 'ci',
        outcome: 'success',
      })
    ).kind,
    'verified',
  );
  return f;
}
for (const closeHandler of [true, false])
  for (const firstWorkerEvent of ['worker_start', 'worker_completed']) {
    test(`close then reopen invalidates ${firstWorkerEvent} with closeHandler=${closeHandler}`, async () => {
      const f = await admittedAndPassed();
      const closure = { verified: true, attempt: 'ready-2', closedSinceReady: true };
      if (closeHandler) {
        f.set({ ...observed(), state: 'closed', lifecycle: closure });
        assert.equal((await admitCandidate(f.port, { ...ready, type: 'closed' })).kind, 'blocked');
      }
      f.set({ ...observed(), lifecycle: closure });
      const start = await admitCandidate(f.port, {
        ...ready,
        type: firstWorkerEvent,
        worker: 'review',
        outcome: 'success',
        candidate,
      });
      assert.equal(start.kind, 'blocked');
      assert.equal(
        (
          await admitCandidate(f.port, {
            ...ready,
            type: 'worker_completed',
            worker: 'review',
            candidate,
            outcome: 'success',
          })
        ).kind,
        'blocked',
      );
      assert.equal(
        f.rows.some((r) => r.action === 'invalidate' && r.phase === 'result'),
        true,
      );
      // A later snapshot alone cannot erase the durable invalidation already observed.
      f.set(observed());
      assert.equal(
        (
          await admitCandidate(f.port, {
            ...ready,
            type: 'worker_start',
            worker: 'review',
            candidate,
          })
        ).kind,
        'blocked',
      );
      assert.equal(f.mutations.length, 0);
    });
  }
test('unverified or absent closure history cannot authorize a worker', async () => {
  const f = await admittedAndPassed();
  for (const lifecycle of [
    undefined,
    { verified: false, attempt: 'ready-2', closedSinceReady: false },
    { verified: true, attempt: 'ready-1', closedSinceReady: false },
  ]) {
    f.set({ ...observed(), lifecycle });
    assert.equal(
      (
        await admitCandidate(f.port, {
          ...ready,
          type: 'worker_start',
          worker: 'review',
          candidate,
        })
      ).kind,
      'blocked',
    );
  }
});
for (const restore of ['head', 'base'])
  for (const outcome of ['throws', 'races']) {
    test(`Draft ${outcome} stays invalidated when original ${restore} returns`, async () => {
      const f = await admittedAndPassed();
      const moved = {
        ...observed(),
        head: 'd'.repeat(40),
        ...(restore === 'base' ? { base: 'e'.repeat(40) } : {}),
      };
      f.set(moved);
      f.port.draft = async () => {
        if (outcome === 'throws') throw Error('unknown Draft transport outcome');
        f.set(observed());
      };
      assert.equal(
        (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
        'uncertain',
      );
      f.set(observed());
      assert.equal(
        (
          await admitCandidate(f.port, {
            ...ready,
            type: 'worker_start',
            worker: 'review',
            candidate,
          })
        ).kind,
        'blocked',
      );
      assert.equal(
        (
          await admitCandidate(f.port, {
            ...ready,
            type: 'worker_completed',
            worker: 'ci',
            outcome: 'success',
            candidate,
          })
        ).kind,
        'blocked',
      );
      assert.equal(
        f.rows.some((r) => r.phase === 'quarantine' && r.candidate.head === candidate.head),
        true,
      );
    });
  }
test('later genuine Ready survives earlier attempt invalidation and reordered close', async () => {
  const f = await admittedAndPassed();
  f.set({
    ...observed(),
    state: 'closed',
    lifecycle: { verified: true, attempt: 'ready-2', closedSinceReady: true },
  });
  await admitCandidate(f.port, { ...ready, type: 'closed' });
  const next = { ...candidate, attempt: 'ready-3', head: 'd'.repeat(40) };
  f.set({
    ...observed(),
    ...next,
    readiness: {
      id: 'ready-3',
      kind: 'ready_for_review',
      candidateVerified: true,
      candidate: next,
    },
    lifecycle: { verified: true, attempt: 'ready-3', closedSinceReady: false },
  });
  assert.equal((await admitCandidate(f.port, { ...ready, type: 'closed' })).kind, 'blocked');
  const nextReady = { ...ready, candidate: next, readinessId: 'ready-3' };
  assert.equal((await admitCandidate(f.port, nextReady)).kind, 'verified');
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...nextReady,
        type: 'worker_start',
        worker: 'ci',
        candidate: next,
      })
    ).kind,
    'verified',
  );
  assert.equal(
    f.rows.some((r) => r.action === 'invalidate' && r.candidate.attempt === 'ready-3'),
    false,
  );
  assert.equal(f.mutations.length, 0);
});

test('later Ready remains eligible after prior head quarantine and delayed synchronize', async () => {
  const f = await admittedAndPassed();
  const moved = { ...observed(), head: 'd'.repeat(40) };
  f.set(moved);
  f.port.draft = async () => {
    throw Error('unknown outcome');
  };
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
    'uncertain',
  );
  const next = { ...candidate, attempt: 'ready-3', head: moved.head };
  f.set({
    ...observed(),
    ...next,
    readiness: {
      id: 'ready-3',
      kind: 'ready_for_review',
      candidateVerified: true,
      candidate: next,
    },
    lifecycle: { verified: true, attempt: 'ready-3', closedSinceReady: false },
  });
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
    'blocked',
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, candidate: next, readinessId: 'ready-3' })).kind,
    'verified',
  );
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        readinessId: 'ready-3',
        type: 'worker_start',
        worker: 'ci',
        candidate: next,
      })
    ).kind,
    'verified',
  );
});
for (const field of ['base', 'head'])
  test(`observed ${field} drift is sticky without a synchronize handler`, async () => {
    const f = await admittedAndPassed();
    f.set({ ...observed(), [field]: 'd'.repeat(40) });
    assert.equal(
      (
        await admitCandidate(f.port, {
          ...ready,
          type: 'worker_start',
          worker: 'review',
          candidate,
        })
      ).kind,
      'blocked',
    );
    f.set(observed());
    assert.equal(
      (
        await admitCandidate(f.port, {
          ...ready,
          type: 'worker_start',
          worker: 'review',
          candidate,
        })
      ).kind,
      'blocked',
    );
    assert.equal(
      f.rows.some((r) => r.action === 'invalidate' && r.phase === 'result'),
      true,
    );
  });

for (const firstEvent of ['worker_start', 'ready_for_review'])
  test(`completed drift invalidation permits safety Draft after ${firstEvent}`, async () => {
    const f = await admittedAndPassed();
    const moved = { ...observed(), head: 'd'.repeat(40) };
    f.set(moved);
    assert.equal(
      (await admitCandidate(f.port, { ...ready, type: firstEvent, candidate, worker: 'review' }))
        .kind,
      'blocked',
    );
    assert.equal(
      f.rows.some((r) => r.action === 'invalidate' && r.phase === 'result'),
      true,
    );
    assert.equal(f.mutations.length, 0);
    assert.equal(
      (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
      'blocked',
    );
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].head, moved.head);
    assert.equal(
      f.rows.some((r) => r.action === 'draft' && r.phase === 'result'),
      true,
    );
    f.set(observed());
    assert.equal(
      (
        await admitCandidate(f.port, {
          ...ready,
          type: 'worker_start',
          worker: 'review',
          candidate,
        })
      ).kind,
      'blocked',
    );
  });
for (const field of ['head', 'base'])
  test(`observed ${field} invalidation survives restoration before the first journal append`, async () => {
    const f = await admittedAndPassed();
    const moved = { ...observed(), [field]: 'd'.repeat(40) };
    const read = f.port.observe;
    let first = true;
    f.port.observe = async () => {
      if (first) {
        first = false;
        f.set(observed());
        return structuredClone(moved);
      }
      return read();
    };
    const denied = await admitCandidate(f.port, {
      ...ready,
      type: 'worker_start',
      worker: 'review',
      candidate,
    });
    assert.equal(denied.kind, 'blocked');
    assert.equal(
      f.rows.some(
        (r) =>
          r.action === 'invalidate' &&
          r.phase === 'result' &&
          r.candidate[field] === candidate[field],
      ),
      true,
    );
    assert.equal(
      (
        await admitCandidate(f.port, {
          ...ready,
          type: 'worker_start',
          worker: 'review',
          candidate,
        })
      ).kind,
      'blocked',
    );
    assert.equal(f.mutations.length, 0);
  });
test('old observed invalidation persists without mutating a Ready attempt that appears before append', async () => {
  const f = await admittedAndPassed();
  const next = { ...candidate, attempt: 'ready-3', head: 'e'.repeat(40) };
  const newState = {
    ...observed(),
    ...next,
    readiness: {
      id: next.attempt,
      kind: 'ready_for_review',
      candidateVerified: true,
      candidate: next,
    },
    lifecycle: { verified: true, attempt: next.attempt, closedSinceReady: false },
  };
  const read = f.port.observe;
  let first = true;
  f.port.observe = async () => {
    if (first) {
      first = false;
      f.set(newState);
      return { ...observed(), head: 'd'.repeat(40) };
    }
    return read();
  };
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', worker: 'review', candidate }))
      .kind,
    'blocked',
  );
  assert.equal(
    f.rows.some(
      (r) => r.action === 'invalidate' && r.phase === 'result' && r.candidate.attempt === 'ready-2',
    ),
    true,
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, candidate: next, readinessId: next.attempt })).kind,
    'verified',
  );
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: 'd'.repeat(40) })).kind,
    'blocked',
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(
    (
      await admitCandidate(f.port, {
        ...ready,
        readinessId: next.attempt,
        type: 'worker_start',
        worker: 'ci',
        candidate: next,
      })
    ).kind,
    'verified',
  );
});

test('completed invalidation cannot let an in-flight synchronize mutate a later Ready attempt', async () => {
  const f = await admittedAndPassed();
  const moved = { ...observed(), head: 'd'.repeat(40) };
  f.set(moved);
  await admitCandidate(f.port, { ...ready, type: 'worker_start', worker: 'review', candidate });
  const next = { ...candidate, attempt: 'ready-3', head: moved.head };
  const newState = {
    ...observed(),
    ...next,
    readiness: {
      id: next.attempt,
      kind: 'ready_for_review',
      candidateVerified: true,
      candidate: next,
    },
    lifecycle: { verified: true, attempt: next.attempt, closedSinceReady: false },
  };
  const read = f.port.observe;
  let first = true;
  f.port.observe = async () => {
    if (first) {
      first = false;
      f.set(newState);
      return structuredClone(moved);
    }
    return read();
  };
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
    'blocked',
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(
    (await admitCandidate(f.port, { ...ready, candidate: next, readinessId: next.attempt })).kind,
    'verified',
  );
});
for (const phase of ['intent', 'quarantine'])
  test(`${phase} invalidation does not permit safety Draft before reconciliation`, async () => {
    const f = await admittedAndPassed();
    const moved = { ...candidate, head: 'd'.repeat(40) };
    f.rows.push(record('invalidate', phase, moved));
    f.set({ ...observed(), head: moved.head });
    assert.equal(
      (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
      'blocked',
    );
    assert.equal(f.mutations.length, 0);
  });
test('invalidation intent read-back uncertainty never grants work or implicit safety recovery', async () => {
  const f = await admittedAndPassed();
  const read = f.port.readJournal;
  const append = f.port.append;
  let unread = false;
  f.port.append = async (row) => {
    const result = await append(row);
    if (row.action === 'invalidate' && row.phase === 'intent') unread = true;
    return result;
  };
  f.port.readJournal = async () => {
    if (unread) {
      unread = false;
      return { kind: 'blocked', reason: 'temporary missing readback' };
    }
    return read();
  };
  const moved = { ...observed(), head: 'd'.repeat(40) };
  f.set(moved);
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', worker: 'review', candidate }))
      .kind,
    'uncertain',
  );
  assert.equal(f.rows.at(-1).phase, 'intent');
  f.set(observed());
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'worker_start', worker: 'review', candidate }))
      .kind,
    'blocked',
  );
  f.set(moved);
  assert.equal(
    (await admitCandidate(f.port, { ...ready, type: 'synchronize', head: moved.head })).kind,
    'blocked',
  );
  assert.equal(f.mutations.length, 0);
});
