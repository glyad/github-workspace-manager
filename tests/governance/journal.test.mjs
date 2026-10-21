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
