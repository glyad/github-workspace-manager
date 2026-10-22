import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseJournal, operationKey } from '../../tools/governance/journal.mjs';
const candidate = {
  repositoryId: 'repo',
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: 'ready-2',
};
function fixture(action = 'admit-ci') {
  const record = {
    version: 1,
    key: operationKey(candidate, action),
    phase: 'intent',
    action,
    candidate,
    run: { id: '12', attempt: 1 },
  };
  const body = JSON.stringify(record);
  const context = {
    ledgerId: 'ledger',
    repositoryId: 'repo',
    controllerActorId: 'actor',
    workflowId: 'workflow',
    trustedSha: 'c'.repeat(40),
    records: [
      { runId: '12', runAttempt: 1, digest: createHash('sha256').update(body).digest('hex') },
    ],
  };
  return {
    context,
    entries: [
      {
        ledgerId: 'ledger',
        authorId: 'actor',
        body,
        run: {
          id: '12',
          attempt: 1,
          repositoryId: 'repo',
          actorId: 'actor',
          workflowId: 'workflow',
          sha: 'c'.repeat(40),
          ref: 'refs/heads/main',
          event: 'pull_request_target',
        },
      },
    ],
  };
}
test('authentic journal preserves the candidate and stable operation identity', () => {
  const { entries, context } = fixture();
  assert.equal(parseJournal(entries, context).kind, 'verified');
  assert.equal(operationKey(candidate, 'admit-ci'), operationKey({ ...candidate }, 'admit-ci'));
  assert.notEqual(
    operationKey(candidate, 'admit-ci'),
    operationKey({ ...candidate, attempt: 'ready-3' }, 'admit-ci'),
  );
});
for (const field of ['authorId', 'ledgerId'])
  test(`reject forged ${field}`, () => {
    const { entries, context } = fixture();
    entries[0][field] = 'forged';
    assert.equal(parseJournal(entries, context).kind, 'blocked');
  });
for (const field of [
  'actorId',
  'workflowId',
  'repositoryId',
  'sha',
  'ref',
  'event',
  'id',
  'attempt',
])
  test(`reject forged run ${field}`, () => {
    const { entries, context } = fixture();
    entries[0].run[field] = 'forged';
    assert.equal(parseJournal(entries, context).kind, 'blocked');
  });
test('reject edited body even when the actor and run match', () => {
  const { entries, context } = fixture();
  entries[0].body = entries[0].body.replace('intent', 'result');
  assert.equal(parseJournal(entries, context).kind, 'blocked');
});
test('reject missing ledger, unbounded input and malformed records', () => {
  const { entries, context } = fixture();
  for (const [input, trust] of [
    [entries, {}],
    [Array(1001).fill(entries[0]), context],
    [[{ ...entries[0], body: 'x'.repeat(16385) }], context],
    [[{ ...entries[0], body: '{' }], context],
  ])
    assert.equal(parseJournal(input, trust).kind, 'blocked');
});

test('public ledger rejects undeclared payload fields even with authentic run bytes', () => {
  const { entries, context } = fixture();
  const row = JSON.parse(entries[0].body);
  row.unrestrictedPayload = 'private transport material must not become ledger data';
  entries[0].body = JSON.stringify(row);
  context.records[0].digest = createHash('sha256').update(entries[0].body).digest('hex');
  assert.equal(parseJournal(entries, context).kind, 'blocked');
});

test('authenticated lifecycle invalidation can be durably read back', () => {
  const { entries, context } = fixture('invalidate');
  const result = parseJournal(entries, context);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value[0].action, 'invalidate');
});

test('historical journal cannot promote a v2 candidate in a v1 envelope', () => {
  const { entries, context } = fixture();
  const row = JSON.parse(entries[0].body);
  row.candidate = {
    ...row.candidate,
    protocolVersion: 2,
    baseRef: 'refs/heads/develop',
    requestId: 'request-1',
  };
  row.key = operationKey(row.candidate, row.action);
  entries[0].body = JSON.stringify(row);
  context.records[0].digest = createHash('sha256').update(entries[0].body).digest('hex');
  assert.equal(parseJournal(entries, context).kind, 'blocked');
});

async function dispatchFixture(attempt = 1, requestId = 'request-1') {
  const { authenticateReadinessRequest } =
    await import('../../tools/governance/readiness-request.mjs');
  const request = {
    protocolVersion: 2,
    requestId,
    repositoryId: 'repo',
    pr: 7,
    prNodeId: 'PR_7',
    baseRef: 'refs/heads/develop',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    initiatingActorId: 'human',
    originalRunId: '12',
    workflowId: 'workflow',
    definitionSha: 'c'.repeat(40),
  };
  const dispatch = {
    id: '12',
    attempt,
    repositoryId: 'repo',
    actorId: 'human',
    workflowId: 'workflow',
    sha: 'c'.repeat(40),
    executionSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  };
  const requestBody = JSON.stringify(request);
  const authenticated = await authenticateReadinessRequest(requestBody, {
    runId: '12',
    runAttempt: attempt,
    authorizedActorIds: ['human'],
    approvedDefinition: Object.freeze({
      repositoryId: 'repo',
      workflowId: 'workflow',
      sha: 'c'.repeat(40),
      ref: 'refs/heads/main',
    }),
    lookupRun: async (_id, n) => ({ kind: 'verified', value: { ...dispatch, attempt: n } }),
    resolvePr: async () => ({
      kind: 'verified',
      value: { repositoryId: 'repo', pr: 7, prNodeId: 'PR_7' },
    }),
    verifyRequestEvidence: async () => ({
      kind: 'verified',
      value: {
        bodyDigest: createHash('sha256').update(requestBody).digest('hex'),
        originalRunId: '12',
        runAttempt: attempt,
        definitionSha: 'c'.repeat(40),
        triggeringActorId: 'human',
      },
    }),
  });
  assert.equal(authenticated.kind, 'verified');
  const f = fixture();
  const c = {
    ...candidate,
    baseRef: request.baseRef,
    requestId: request.requestId,
    protocolVersion: 2,
  };
  f.row = {
    version: 2,
    key: operationKey(c, 'admit-ci'),
    phase: 'intent',
    action: 'admit-ci',
    candidate: c,
    run: { id: '12', attempt },
  };
  f.entries[0].run = dispatch;
  f.context.readinessRequests = [authenticated];
  f.refresh = () => {
    f.entries[0].body = JSON.stringify(f.row);
    f.context.records = [
      {
        runId: '12',
        runAttempt: attempt,
        digest: createHash('sha256').update(f.entries[0].body).digest('hex'),
      },
    ];
  };
  f.refresh();
  return f;
}
test('v2 dispatch journal binds native Ready ID, original request and authenticated rerun separately from bot author', async () => {
  for (const attempt of [1, 2]) {
    const f = await dispatchFixture(attempt);
    const result = parseJournal(f.entries, f.context);
    assert.equal(result.kind, 'verified');
    assert.equal(result.value[0].candidate.attempt, 'ready-2');
    assert.equal(result.value[0].run.attempt, attempt);
  }
});
test('dispatch journal rejects forged receipt wrappers, substituted request, run, definition and envelope versions', async () => {
  const changes = [
    (f) => {
      f.context.readinessRequests = [];
    },
    (f) => {
      f.context.readinessRequests = [structuredClone(f.context.readinessRequests[0])];
    },
    (f) => {
      f.row.candidate.requestId = 'request-2';
      f.row.key = operationKey(f.row.candidate, f.row.action);
    },
    (f) => {
      f.row.candidate.baseRef = 'refs/heads/main';
      f.row.key = operationKey(f.row.candidate, f.row.action);
    },
    (f) => {
      f.entries[0].run.executionSha = 'd'.repeat(40);
    },
    (f) => {
      f.entries[0].run.actorId = 'actor';
    },
    (f) => {
      f.entries[0].run.attempt = 2;
      f.row.run.attempt = 2;
    },
    (f) => {
      f.row.version = 1;
    },
  ];
  for (const change of changes) {
    const f = await dispatchFixture();
    change(f);
    f.refresh();
    assert.equal(parseJournal(f.entries, f.context).kind, 'blocked');
  }
  const f = fixture();
  f.entries[0].run.event = 'workflow_dispatch';
  assert.equal(parseJournal(f.entries, f.context).kind, 'blocked');
});

async function mixedDispatchHistory() {
  const original = await dispatchFixture(1);
  const rerun = await dispatchFixture(2);
  const unrelated = await dispatchFixture(3, 'unrelated-request');
  // Both individual controls have genuine receipts and exact record digests.
  assert.equal(parseJournal(original.entries, original.context).kind, 'verified');
  assert.equal(parseJournal(rerun.entries, rerun.context).kind, 'verified');
  rerun.row.phase = 'result';
  rerun.refresh();
  return {
    entries: [...original.entries, ...rerun.entries],
    context: {
      ...original.context,
      records: [...original.context.records, ...rerun.context.records],
    },
    receipts: [original.context.readinessRequests[0], rerun.context.readinessRequests[0]],
    unrelated: unrelated.context.readinessRequests[0],
  };
}
for (const receiptOrder of ['original-first', 'rerun-first'])
  test(`original intent and rerun result parse with exact receipts ${receiptOrder}`, async () => {
    const f = await mixedDispatchHistory();
    const receipts = receiptOrder === 'original-first' ? f.receipts : [...f.receipts].reverse();
    for (const entries of [f.entries, [...f.entries].reverse()]) {
      const result = parseJournal(entries, {
        ...f.context,
        readinessRequests: [f.unrelated, ...receipts, f.unrelated],
      });
      assert.equal(result.kind, 'verified');
      assert.equal(result.value.length, 2);
      assert.deepEqual(result.value.map((row) => [row.phase, row.run.attempt]).sort(), [
        ['intent', 1],
        ['result', 2],
      ]);
      assert.equal(
        result.value.every((row) => row.candidate.attempt === 'ready-2'),
        true,
      );
      assert.equal(result.value[0].key, result.value[1].key);
    }
  });
test('mixed history rejects missing or cloned exact-attempt receipts despite other genuine receipts', async () => {
  const f = await mixedDispatchHistory();
  for (const missing of [0, 1]) {
    const other = f.receipts[1 - missing];
    for (const replacement of [f.unrelated, structuredClone(f.receipts[missing])]) {
      for (const receipts of [
        [other, replacement],
        [replacement, other],
      ]) {
        assert.equal(
          parseJournal(f.entries, { ...f.context, readinessRequests: receipts }).kind,
          'blocked',
        );
      }
    }
  }
});
test('mixed history still binds each record to exact actor definition execution and attempt proof', async () => {
  for (const [field, value] of [
    ['id', '99'],
    ['attempt', 3],
    ['actorId', 'other'],
    ['workflowId', 'other'],
    ['sha', 'd'.repeat(40)],
    ['executionSha', 'd'.repeat(40)],
    ['ref', 'refs/heads/feature/other'],
    ['event', 'repository_dispatch'],
  ]) {
    const f = await mixedDispatchHistory();
    const entry = f.entries[1];
    entry.run[field] = value;
    if (field === 'id' || field === 'attempt') {
      const row = JSON.parse(entry.body);
      row.run[field] = value;
      entry.body = JSON.stringify(row);
    }
    f.context.records[1] = {
      runId: entry.run.id,
      runAttempt: entry.run.attempt,
      digest: createHash('sha256').update(entry.body).digest('hex'),
    };
    assert.equal(
      parseJournal(f.entries, { ...f.context, readinessRequests: [...f.receipts, f.unrelated] })
        .kind,
      'blocked',
    );
  }
  const f = await mixedDispatchHistory();
  f.entries[1].body += ' ';
  assert.equal(
    parseJournal(f.entries, { ...f.context, readinessRequests: f.receipts }).kind,
    'blocked',
  );
});
