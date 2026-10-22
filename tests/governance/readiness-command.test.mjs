import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as runtime from '../../tools/governance/controller-runtime.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { fixture, c, signed, workerRun } from './composed-adapter-fixture.mjs';

const inputs = () => ({
  pr: '2',
  expected_base_ref: 'refs/heads/develop',
  expected_base_sha: 'a'.repeat(40),
  expected_head_sha: 'b'.repeat(40),
  request_id: 'request-1',
  protocol_version: '2',
});
const compose = runtime.createReadinessRuntime;
async function setup(t, options = {}, config = {}) {
  const f = await fixture(t, { freshReadiness: true, concreteContinuation: true, ...options });
  const trusted = {
    mode: 'offline-test',
    portConfig: f.portConfig,
    requestContext: f.requestContext,
    ...config,
  };
  return { ...f, trusted, runtime: compose(trusted) };
}
function callback(
  claimId,
  type = 'worker_start',
  run = workerRun,
  candidate = {
    protocolVersion: 2,
    requestId: 'request-1',
    baseRef: 'refs/heads/develop',
    repositoryId: '1',
    pr: 2,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    attempt: '10',
  },
) {
  const body = JSON.stringify({ type, candidate, claimId, worker: 'ci', outcome: 'success' });
  return {
    body,
    archive: signed({
      purpose: 'worker-callback',
      run,
      candidate,
      worker: 'ci',
      bodyDigest: digest(body),
    }),
  };
}
const sends = (f) => f.calls.filter((r) => r.path.endsWith('/dispatches')).length;

test('inactive_workflow_cannot_mutate_or_dispatch', async (t) => {
  const controller = await readFile('.github/workflows/governance-controller.yml', 'utf8');
  const ci = await readFile('.github/workflows/candidate-ci.yml', 'utf8');
  for (const name of Object.keys(inputs())) assert.match(controller, new RegExp(`      ${name}:`));
  for (const source of [controller, ci]) {
    assert.match(source, /if: \$\{\{ false \}\}/);
    assert.match(source, /exit 1/);
    const first = source
      .match(/        run: \|\n((?:          .*\n)+)/)[1]
      .replace(/^          /gm, '');
    const preflight = spawnSync('sh', ['-c', first], { encoding: 'utf8' });
    assert.equal(preflight.status, 1);
    assert.match(preflight.stdout, /Inactive:/);
    for (const block of source.matchAll(/        run: \|\n((?:          .*\n)+)/g))
      assert.doesNotMatch(block[1], /\$\{\{\s*(inputs\.|github\.event\.)/);
  }
  assert.doesNotMatch(controller, /pull_request\.head|candidate-head|npm ci|npm run/);
  assert.match(controller, /READINESS_INPUTS: \$\{\{ toJSON\(inputs\) \}\}/);
  assert.match(ci, /steps\.start\.outputs\.execute == 'true'/);
  for (const config of [{ mode: 'production' }, { mode: 'offline-test', productionBackend: {} }]) {
    const f = await setup(t, {}, config);
    assert.equal((await f.runtime.command({ inputs: inputs() })).kind, 'blocked');
    assert.equal(f.calls.length, 0);
    assert.equal((await f.store.readOperation(c.requestId)).value, null);
  }
});

test('input_cannot_choose_new_candidate', async (t) => {
  for (const patch of [
    { expected_head_sha: 'f'.repeat(40) },
    { expected_base_sha: 'f'.repeat(40) },
    { expected_base_ref: 'refs/heads/other' },
    { protocol_version: '1' },
    { repositoryId: '99' },
    { actorId: '99' },
    { pr: '2;$(touch unsafe)' },
    { request_id: '${{ secrets.TOKEN }}' },
  ]) {
    const f = await setup(t);
    assert.notEqual(
      (await f.runtime.command({ inputs: { ...inputs(), ...patch } })).kind,
      'verified',
    );
    assert.equal(sends(f), 0);
    assert.equal(f.pr.draft, true);
  }
});

test('branch_definition_rejected', async (t) => {
  const f = await setup(t);
  f.trusted.requestContext.lookupRun = async () => ({
    kind: 'verified',
    value: {
      ...workerRun,
      id: '12',
      actorId: '9',
      workflowId: '4',
      executionSha: 'f'.repeat(40),
      ref: 'refs/heads/chore/unsafe',
    },
  });
  // A fresh composition sees the deliberately incorrect trusted lookup response.
  const result = await compose(f.trusted).command({ inputs: inputs() });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.message, 'Not admitted; reconciliation required');
  assert.equal(f.calls.length, 0);
  assert.equal(f.pr.draft, true);
});

test('complete_offline_handshake_continuation', async (t) => {
  const f = await setup(t);
  const result = await f.runtime.command({
    inputs: inputs(),
    archive: { synthetic: 'original-dispatch' },
  });
  assert.equal(result.kind, 'verified');
  assert.equal(result.message, 'Ready and admitted for these commits');
  assert.deepEqual(result.value.candidate, c);
  assert.equal(sends(f), 1);
  const id = result.value.claimId;
  assert.equal((await f.store.readOperation(c.requestId)).value.state, 'accepted');
  assert.equal((await f.store.readCiClaim(id)).value.start, null);
  assert.equal((await f.runtime.ciCallback(callback(id))).value.execute, true);
  assert.equal((await f.store.readCiClaim(id)).value.start.state, 'consumed');
  assert.equal((await f.runtime.ciCallback(callback(id))).kind, 'blocked');
  assert.equal(
    (await f.runtime.ciCallback(callback(id, 'worker_start', { ...workerRun, attempt: 2 }))).kind,
    'blocked',
  );
  assert.equal((await f.runtime.ciCallback(callback(id, 'worker_completed'))).kind, 'verified');
  assert.equal((await f.runtime.command({ inputs: inputs() })).kind, 'blocked');
  assert.equal(sends(f), 1);
});

test('native_button_explains_blocked_state', async (t) => {
  const f = await setup(t, { freshReadiness: false, seedAdmission: false });
  const result = await f.runtime.command({ inputs: inputs() });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.message, 'Not admitted; reconciliation required');
  assert.equal(sends(f), 0);
});

test('lost_response_discovery_retains_original_callback_identity', async (t) => {
  const f = await setup(t, { loseResponse: true });
  const result = await f.runtime.command({ inputs: inputs() });
  assert.equal(result.kind, 'uncertain');
  assert.equal(result.message, 'Not admitted; reconciliation required');
  const id = f.claim.id;
  assert.equal((await f.store.readCiClaim(id)).value.status, 'pending');
  const found = await f.runtime.reconcileCi(id);
  assert.equal(found.kind, 'verified');
  assert.deepEqual(found.value.run, workerRun);
  for (const patch of [{ id: '99' }, { attempt: 2 }]) {
    assert.equal(
      (await f.runtime.ciCallback(callback(id, 'worker_start', { ...workerRun, ...patch }))).kind,
      'blocked',
    );
  }
  assert.equal((await f.runtime.ciCallback(callback(id))).value.execute, true);
  for (const patch of [{ id: '99' }, { attempt: 2 }]) {
    assert.equal(
      (await f.runtime.ciCallback(callback(id, 'worker_completed', { ...workerRun, ...patch })))
        .kind,
      'blocked',
    );
  }
  assert.equal((await f.runtime.ciCallback(callback(id, 'worker_completed'))).kind, 'verified');
  assert.equal(sends(f), 1);
});

test('ambiguous_discovery_stays_pending_without_execution', async (t) => {
  const f = await setup(t, { discovery: 'ambiguous' });
  assert.equal((await f.runtime.command({ inputs: inputs() })).kind, 'uncertain');
  assert.equal((await f.runtime.reconcileCi(f.claim.id)).kind, 'uncertain');
  assert.equal((await f.store.readCiClaim(f.claim.id)).value.status, 'pending');
  assert.equal((await f.runtime.ciCallback(callback(f.claim.id))).kind, 'blocked');
  assert.equal((await f.store.readCiClaim(f.claim.id)).value.start, null);
  assert.equal(sends(f), 1);
});

test('input_and_config_are_snapshotted_before_awaits', async (t) => {
  const f = await setup(t),
    payload = inputs(),
    trusted = f.trusted;
  const lookup = trusted.requestContext.lookupRun;
  trusted.requestContext.lookupRun = async (...args) => {
    payload.expected_head_sha = 'f'.repeat(40);
    trusted.requestContext.approvedDefinition = Object.freeze({
      ...trusted.requestContext.approvedDefinition,
      sha: 'f'.repeat(40),
    });
    trusted.portConfig.controllerRun.actorId = '99';
    return lookup(...args);
  };
  const result = await compose(trusted).command({ inputs: payload });
  assert.equal(result.kind, 'verified');
  assert.deepEqual(result.value.candidate, c);
  assert.equal(sends(f), 1);
});

test('worker_dispatch_assertions_cannot_replace_durable_authority', async (t) => {
  const f = await setup(t);
  const result = await f.runtime.command({ inputs: inputs() });
  assert.equal(result.kind, 'verified');
  const claim = (await f.store.readCiClaim(result.value.claimId)).value;
  const original = {
    claim_id: claim.id,
    request_id: claim.requestId,
    candidate: JSON.stringify(claim.candidate),
    definition_sha: claim.definitionSha,
  };
  for (const patch of [
    { request_id: 'other' },
    { definition_sha: 'f'.repeat(40) },
    { claim_id: 'other' },
    { candidate: JSON.stringify({ ...claim.candidate, head: 'f'.repeat(40) }) },
  ]) {
    assert.equal(
      (
        await f.runtime.ciCallback({
          ...callback(claim.id),
          dispatchInputs: { ...original, ...patch },
        })
      ).kind,
      'blocked',
    );
    assert.equal((await f.store.readCiClaim(claim.id)).value.start, null);
  }
  assert.equal(
    (await f.runtime.ciCallback({ ...callback(claim.id), dispatchInputs: original })).value.execute,
    true,
  );
});

// This recipe-level boundary deliberately omits the unrelated production preflight:
// even after that gate, source trust must deny before checkout/import. Nothing in
// the dispatch-selected workflow context is an independently approved capability.
test('dispatch_selected_source_cannot_reach_checkout_or_import', async (t) => {
  for (const path of [
    '.github/workflows/governance-controller.yml',
    '.github/workflows/candidate-ci.yml',
  ]) {
    const text = await readFile(path, 'utf8');
    const steps = text.split(/\n      - /).slice(1);
    for (const source of [
      { GITHUB_REF: 'refs/heads/chore/untrusted', GITHUB_WORKFLOW_SHA: 'f'.repeat(40) },
      { GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_SHA: 'f'.repeat(40) },
    ]) {
      await t.test(`${path}:${source.GITHUB_REF}`, () => {
        const trace = [];
        let denied = false,
          reason = '';
        for (const step of steps.slice(1)) {
          if (step.startsWith('uses: actions/checkout')) {
            trace.push('checkout');
            break;
          }
          const block = step.match(/        run: \|\n((?:          .*\n)+)/);
          if (!block) continue;
          const script = block[1].replace(/^          /gm, '');
          if (script.includes('import ')) {
            trace.push('import');
            break;
          }
          const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: source });
          if (result.status !== 0) {
            denied = true;
            reason = result.stdout;
            break;
          }
        }
        assert.equal(denied, true, `${path}: source capability must deny before loading code`);
        assert.match(reason, /independently approved runtime source capability unavailable/i);
        assert.deepEqual(trace, []);
      });
    }
  }
});
