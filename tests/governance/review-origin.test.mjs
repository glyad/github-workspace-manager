import test from 'node:test';
import assert from 'node:assert/strict';
import * as worker from '../../tools/governance/worker-ledger.mjs';
import { candidate, limits, registration } from './fixtures/review-authority-fixture.mjs';
test('exact registration issues only opaque original authority receipts', () => {
  const original = registration();
  const authority = worker.createOfflineReviewOriginAuthority({ registrations: [original] });
  const query = { candidate, reservationRequestId: 'paid-1' };
  const receipt = authority.resolve(query);
  assert.equal(receipt.kind, 'verified');
  const binding = { ...query, limits };
  assert.equal(authority.inspect(receipt.value, binding).kind, 'verified');
  for (const fake of [
    {},
    structuredClone(receipt.value),
    JSON.parse(JSON.stringify(receipt.value)),
  ])
    assert.equal(authority.inspect(fake, binding).kind, 'blocked');
  const other = worker.createOfflineReviewOriginAuthority({ registrations: [registration()] });
  assert.equal(other.inspect(receipt.value, binding).kind, 'blocked');
  assert.equal(authority.resolve({ ...query, reservationRequestId: 'invented' }).kind, 'blocked');
  assert.equal(
    authority.inspect(receipt.value, { ...binding, limits: { ...limits, maxInputBytes: 2 } }).kind,
    'blocked',
  );
  original.run.id = '999';
  assert.equal(authority.inspect(receipt.value, binding).value.run.id, '123');
  assert.throws(() =>
    worker.createOfflineReviewOriginAuthority({ registrations: [registration(), registration()] }),
  );
});
test('malformed registration, canonical bytes, definition and full execution deny construction', () => {
  for (const change of [
    (r) => (r.extra = true),
    (r) => (r.evidenceBody += ' '),
    (r) => (r.run.executionSha = 'f'.repeat(40)),
    (r) => (r.run.extra = true),
    (r) => (r.run.id = 'run-123'),
    (r) => (r.approvedDefinition.sha = 'd'.repeat(40)),
    (r) => delete r.candidate.protocolVersion,
    (r) => (r.limits.maxRunSeconds = 0),
  ]) {
    const r = registration();
    change(r);
    assert.throws(() => worker.createOfflineReviewOriginAuthority({ registrations: [r] }));
  }
});

test('unrelated_real_run_denied and new_request_id_without_registration_denied', () => {
  const authority = worker.createOfflineReviewOriginAuthority({ registrations: [registration()] });
  assert.equal(authority.resolve({ candidate, reservationRequestId: 'paid-new' }).kind, 'blocked');
  assert.equal(
    authority.resolve({
      candidate: { ...candidate, head: 'd'.repeat(40) },
      reservationRequestId: 'paid-1',
    }).kind,
    'blocked',
  );
  const receipt = authority.resolve({ candidate, reservationRequestId: 'paid-1' }).value;
  assert.equal(
    authority.inspect(receipt, {
      candidate,
      reservationRequestId: 'paid-1',
      limits,
      run: { ...registration().run, id: '999' },
    }).kind,
    'blocked',
  );
});
test('resolver_output_mutation_denied and constructor snapshots remain independent', () => {
  const input = registration(),
    authority = worker.createOfflineReviewOriginAuthority({ registrations: [input] });
  const binding = { candidate, reservationRequestId: 'paid-1', limits };
  const receipt = authority.resolve({ candidate, reservationRequestId: 'paid-1' }).value;
  const a = authority.inspect(receipt, binding);
  assert.throws(() => {
    a.value.run.id = '999';
  });
  assert.throws(() => {
    a.value.approvedDefinition.workflowId = 'untrusted';
  });
  input.run.attempt = 2;
  const b = authority.inspect(receipt, binding);
  assert.notEqual(a.value, b.value);
  assert.equal(b.value.run.attempt, 1);
});
