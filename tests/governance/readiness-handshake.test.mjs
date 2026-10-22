import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import * as api from '../../tools/governance/readiness-handshake.mjs';
import { withReadinessOperation } from '../../tools/governance/readiness-operation.mjs';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const request = Object.freeze({
  protocolVersion: 2,
  requestId: 'request-1',
  repositoryId: '1',
  pr: 2,
  prNodeId: 'PR_2',
  baseRef: 'refs/heads/develop',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  initiatingActorId: '9',
  originalRunId: '12',
  workflowId: '4',
  definitionSha: 'c'.repeat(40),
});
const run = {
  id: '12',
  attempt: 1,
  repositoryId: '1',
  workflowId: '4',
  actorId: '9',
  sha: request.definitionSha,
  executionSha: request.definitionSha,
  ref: 'refs/heads/main',
  event: 'workflow_dispatch',
};
const controller = { ...run, actorId: '5' };
const signed = (value) => {
  const body = JSON.stringify({ version: 1, ...value });
  return { body, signature: sign(null, Buffer.from(body), privateKey).toString('base64') };
};
async function auth(r) {
  const body = JSON.stringify(r);
  return authenticateReadinessRequest(body, {
    runId: '12',
    runAttempt: 1,
    authorizedActorIds: ['9'],
    approvedDefinition: Object.freeze({
      repositoryId: '1',
      workflowId: '4',
      sha: request.definitionSha,
      ref: run.ref,
    }),
    lookupRun: async () => verified(run),
    resolvePr: async () => verified({ repositoryId: '1', pr: 2, prNodeId: 'PR_2' }),
    verifyRequestEvidence: async () =>
      verified({
        bodyDigest: digest(body),
        originalRunId: '12',
        runAttempt: 1,
        definitionSha: request.definitionSha,
        triggeringActorId: '9',
      }),
  });
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'handshake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root);
  store.authorizeReadinessRequest = options.authorize ?? auth;
  let pr = {
    number: 2,
    node_id: 'PR_2',
    state: 'open',
    draft: true,
    base: { sha: request.base, ref: 'develop', repo: { id: 1 } },
    head: { sha: request.head, repo: { id: 1 } },
  };
  let events = options.initialEvents ?? [
    { id: 1, event: 'converted_to_draft', actor: { id: 9 }, created_at: '2026-01-01T00:00:00Z' },
  ];
  const calls = [],
    archives = [],
    proofs = new Map(),
    phases = new Map();
  let reads = 0,
    locks = 0;
  const lock = store.withPrLock.bind(store);
  store.withPrLock = async (...args) => {
    locks++;
    await options.beforeLock?.({ pr, events });
    return lock(...args);
  };
  const archive = async (purpose, input) => {
    archives.push({ purpose, input });
    if (options.archive) {
      const override = options.archive(purpose, input);
      if (override !== undefined) return override;
    }
    if (purpose === 'readiness-phase') {
      const envelope = signed({ purpose, run: controller, ...input.bindings });
      phases.set(input.body, envelope);
      return envelope;
    }
    if (purpose === 'readiness-phase-read')
      return { body: input.body, envelope: phases.get(input.body) };
    if (purpose === 'readiness-proof-write') {
      proofs.set(
        input.body,
        signed({ purpose: 'readiness-proof', run: controller, bodyDigest: digest(input.body) }),
      );
      return proofs.get(input.body);
    }
    if (purpose === 'readiness-proof-read')
      return options.readbackFailure
        ? null
        : {
            body: options.changedProofBytes ? input.body + ' ' : input.body,
            envelope: proofs.get(input.body),
          };
    return signed({ purpose, run: controller, ...input.bindings });
  };
  const http = async (call) => {
    calls.push(call);
    let body,
      headers = {};
    if (call.path.endsWith('/pulls/2')) {
      reads++;
      options.onRead?.({ reads, pr, events });
      body = structuredClone(pr);
    } else if (call.path.includes('/timeline?')) {
      body = structuredClone(events);
      if (options.unstable) body.push({ id: 100 + calls.length, event: 'closed' });
      if (options.badPages) headers.link = '<https://evil.invalid>; rel="next"';
      if (options.paginated) {
        const page = Number(new URL('https://api.github.com' + call.path).searchParams.get('page'));
        body = body.slice((page - 1) * 100, page * 100);
        if (events.length > page * 100)
          headers.link = `<https://api.github.com/repos/owner/repo/issues/2/timeline?per_page=100&page=${page + 1}>; rel="next"`;
      }
    } else if (call.path.includes('/actions/runs/'))
      body = {
        id: 12,
        run_attempt: 1,
        repository: { id: 1 },
        workflow_id: 4,
        actor: { id: 5 },
        event: controller.event,
        head_sha: controller.executionSha,
      };
    else if (call.path === '/graphql') {
      const op = (await store.readOperation(request.requestId)).value;
      assert.equal(op.state, 'mutation-pending');
      assert.match(op.beforeDigest, /^[a-f0-9]{64}$/);
      const payload = JSON.parse(call.body);
      assert.deepEqual(payload.variables, { id: 'PR_2', clientMutationId: 'request-1' });
      pr.draft = false;
      events.push({
        id: Number(events.at(-1)?.id ?? 0) + 1,
        event: 'ready_for_review',
        actor: { id: 5 },
        created_at: '2026-01-01T00:00:00Z',
      });
      options.afterMutation?.({ pr, events });
      if (options.lost) throw Error('response lost');
      body = {
        data: {
          markPullRequestReadyForReview: {
            clientMutationId: 'request-1',
            pullRequest: { id: 'PR_2', isDraft: false },
          },
        },
      };
    } else throw Error('Unexpected request ' + call.path);
    return { status: 200, headers, body: JSON.stringify(body) };
  };
  const port = createGithubPort({
    http,
    archive,
    publicKey,
    store,
    repository: 'owner/repo',
    repositoryId: '1',
    ledgerNumber: 7,
    ledgerId: '7',
    controllerRun: controller,
  });
  return {
    port,
    store,
    calls,
    archives,
    root,
    get locks() {
      return locks;
    },
    get sends() {
      return calls.filter((c) => c.path === '/graphql').length;
    },
  };
}
const execute = (f) => api.runReadinessHandshake(request, f.port);
test('success_binds_request_window_mutation_witness_run_and_one_lock', async (t) => {
  const f = await fixture(t);
  const result = await execute(f);
  assert.equal(result.kind, 'verified');
  assert.deepEqual(result.value.request, request);
  assert.equal(result.value.witnessId, '2');
  assert.equal(result.value.candidate.attempt, '2');
  assert.equal(result.value.runAttempt, 1);
  assert.equal(result.value.originalRunId, '12');
  assert.equal(result.value.definitionSha, request.definitionSha);
  for (const k of ['beforeDigest', 'afterDigest', 'mutationDigest'])
    assert.match(result.value[k], /^[a-f0-9]{64}$/);
  assert.equal(f.sends, 1);
  assert.equal(f.locks, 1);
  assert.equal((await f.store.readOperation(request.requestId)).value.state, 'accepted');
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 1);
});
test('stale_pair_while_queued', async (t) => {
  let release, entered;
  const gate = new Promise((r) => {
      release = r;
    }),
    waiting = new Promise((r) => {
      entered = r;
    });
  const f = await fixture(t, {
    beforeLock: async ({ pr }) => {
      entered();
      await gate;
      pr.head.sha = 'd'.repeat(40);
    },
  });
  const running = execute(f);
  await waiting;
  release();
  assert.notEqual((await running).kind, 'verified');
  assert.equal(f.sends, 0);
});
test('base_only_or_ref_drift', async (t) => {
  for (const field of ['sha', 'ref']) {
    const f = await fixture(t, {
      onRead: ({ reads, pr }) => {
        if (reads >= 3) pr.base[field] = field === 'sha' ? 'd'.repeat(40) : 'elsewhere';
      },
    });
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 0);
  }
});
test('manual_ready_before_intent', async (t) => {
  const f = await fixture(t, {
    onRead: ({ pr }) => {
      pr.draft = false;
    },
  });
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 0);
});
test('multiple_ready_or_lifecycle_boundaries', async (t) => {
  for (const event of [
    'ready_for_review',
    'converted_to_draft',
    'closed',
    'reopened',
    'head_ref_force_pushed',
    'base_ref_changed',
  ]) {
    const f = await fixture(t, {
      afterMutation: ({ events }) => events.push({ id: 3, event, actor: { id: 5 } }),
    });
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 1);
  }
});
test('missing_or_unstable_pages', async (t) => {
  for (const options of [
    { badPages: true },
    { unstable: true },
    { archive: (p) => (p === 'readiness-observation' ? null : undefined) },
  ]) {
    const f = await fixture(t, options);
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 0);
  }
});
test('wrong_or_uncovered_actor', async (t) => {
  for (const options of [
    {
      afterMutation: ({ events }) => {
        events.at(-1).actor.id = 88;
      },
    },
    {
      archive: (p, i) =>
        p === 'readiness-window'
          ? signed({ purpose: p, run: controller, ...i.bindings, writerCoverage: 'unknown' })
          : undefined,
    },
  ]) {
    const f = await fixture(t, options);
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 1);
  }
});
test('lost_mutation_response', async (t) => {
  const f = await fixture(t, { lost: true });
  assert.equal((await execute(f)).kind, 'uncertain');
  assert.equal((await f.store.readOperation(request.requestId)).value.state, 'mutation-pending');
  const restarted = new LocalDurableStore(f.root);
  restarted.authorizeReadinessRequest = auth;
  f.port.readinessStore.readOperation = restarted.readOperation.bind(restarted);
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 1);
});
test('proof_write_readback_failure', async (t) => {
  const f = await fixture(t, { readbackFailure: true });
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.notEqual((await f.store.readOperation(request.requestId)).value.state, 'accepted');
  assert.equal(f.sends, 1);
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 1);
});
test('aba_does_not_claim_event_time_equality', async (t) => {
  const f = await fixture(t, {
    afterMutation: ({ pr }) => {
      pr.head.sha = 'd'.repeat(40);
      pr.head.sha = request.head;
    },
  });
  const result = await execute(f);
  assert.equal(result.kind, 'verified');
  assert.deepEqual(
    Object.keys(result.value).sort(),
    [
      'version',
      'request',
      'candidate',
      'beforeDigest',
      'afterDigest',
      'mutationDigest',
      'witnessId',
      'originalRunId',
      'runAttempt',
      'definitionSha',
    ].sort(),
  );
  assert.equal(result.value.candidate.head, request.head);
});
test('forged_coverage_wrapper_and_signed_wrong_phase_predecessor_deny', async (t) => {
  for (const options of [
    {
      archive: (p) =>
        p === 'readiness-window' ? verified({ writerCoverage: 'complete' }) : undefined,
    },
    {
      archive: (p, i) =>
        p === 'readiness-phase'
          ? signed({ purpose: p, run: controller, ...i.bindings, operationDigest: 'f'.repeat(64) })
          : undefined,
    },
  ]) {
    const f = await fixture(t, options);
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal((await f.store.readOperation(request.requestId)).value.state, 'mutation-pending');
  }
});

test('exact_proof_bytes_and_write_ack_are_required', async (t) => {
  for (const options of [
    { changedProofBytes: true },
    { archive: (p) => (p === 'readiness-proof-write' ? null : undefined) },
  ]) {
    const f = await fixture(t, options);
    assert.equal((await execute(f)).kind, 'uncertain');
    assert.equal(f.sends, 1);
    assert.notEqual((await f.store.readOperation(request.requestId)).value.state, 'accepted');
  }
});
test('latest_event_and_pair_rechecks_deny_late_changes', async (t) => {
  for (const options of [
    {
      onRead: ({ reads, events }) => {
        if (reads === 7) events.push({ id: 3, event: 'converted_to_draft', actor: { id: 9 } });
      },
    },
    {
      onRead: ({ reads, pr }) => {
        if (reads === 9) pr.base.sha = 'e'.repeat(40);
      },
    },
  ]) {
    const f = await fixture(t, options);
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 1);
    assert.notEqual((await f.store.readOperation(request.requestId)).value.state, 'accepted');
  }
});
test('post_mutation_identity_state_pair_and_history_drift_deny', async (t) => {
  for (const change of [
    ({ pr }) => {
      pr.state = 'closed';
    },
    ({ pr }) => {
      pr.node_id = 'PR_OTHER';
    },
    ({ pr }) => {
      pr.head.sha = 'd'.repeat(40);
    },
    ({ pr }) => {
      pr.base.ref = 'elsewhere';
    },
    ({ events }) => {
      events.shift();
    },
    ({ events }) => {
      events.reverse();
    },
  ]) {
    const f = await fixture(t, { afterMutation: change });
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 1);
    assert.notEqual((await f.store.readOperation(request.requestId)).value.state, 'accepted');
  }
});
test('bounded_pagination_preserves_native_order_without_timestamp_sorting', async (t) => {
  const initialEvents = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    event: i === 100 ? 'converted_to_draft' : 'labeled',
    actor: { id: 9 },
    created_at: i % 2 ? '2026-01-02' : '2026-01-01',
  }));
  const f = await fixture(t, { initialEvents, paginated: true });
  const result = await execute(f);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.witnessId, '102');
  assert.equal(f.sends, 1);
  assert.ok(f.calls.some((c) => c.path.endsWith('page=2')));
});
test('pure_verifier_requires_genuine_request_receipt_and_exact_signed_window', async (t) => {
  const f = await fixture(t);
  let captured;
  const authenticate = f.port.authenticateReadinessWindow;
  f.port.authenticateReadinessWindow = async (...args) => {
    const trust = await authenticate(...args);
    captured = { args, trust };
    return trust;
  };
  assert.equal((await execute(f)).kind, 'verified');
  const { args, trust } = captured;
  assert.equal(api.verifyReadinessWindow(...args, trust).kind, 'verified');
  assert.equal(
    api.verifyReadinessWindow(...args, {
      ...trust,
      requestAuthentication: structuredClone(trust.requestAuthentication),
    }).kind,
    'blocked',
  );
  assert.equal(
    api.verifyReadinessWindow(...args, {
      ...trust,
      envelope: verified({ writerCoverage: 'complete' }),
    }).kind,
    'blocked',
  );
  for (const index of [1, 3]) {
    const changed = structuredClone(args);
    changed[index].head = 'e'.repeat(40);
    changed[index].evidenceDigest = api.readinessWindowDigest(changed[index]);
    assert.equal(api.verifyReadinessWindow(...changed, trust).kind, 'blocked');
  }
  const changed = structuredClone(args);
  changed[2].responseDigest = 'f'.repeat(64);
  assert.equal(api.verifyReadinessWindow(...changed, trust).kind, 'blocked');
});
test('malformed_or_missing_mutation_success_remains_pending', async (t) => {
  for (const response of [{ kind: 'verified' }, { kind: 'verified', value: {}, evidence: [] }]) {
    const f = await fixture(t);
    const mark = f.port.markReady;
    f.port.markReady = async (r) => {
      await mark(r);
      return response;
    };
    assert.notEqual((await execute(f)).kind, 'verified');
    assert.equal(f.sends, 1);
    assert.equal((await f.store.readOperation(request.requestId)).value.state, 'mutation-pending');
  }
});
test('direct_unscoped_mutation_and_substituted_request_never_send', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.port.markReady(request)).kind, 'blocked');
  assert.equal(f.sends, 0);
  f.port.readinessStore.authorizeReadinessRequest = async () => verified(request);
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 0);
  assert.equal((await f.store.readOperation(request.requestId)).value, null);
});

test('full_boundary_phase_archive_readback_precedes_any_mutation', async (t) => {
  const f = await fixture(t, { archive: (p) => (p === 'readiness-phase-read' ? null : undefined) });
  assert.notEqual((await execute(f)).kind, 'verified');
  assert.equal(f.sends, 0);
  const op = (await f.store.readOperation(request.requestId)).value;
  assert.equal(op.state, 'mutation-pending');
  assert.equal(op.beforeDigest, null);
});

const pinnedAuthorization = (r) =>
  Object.keys(request).every((k) => r[k] === request[k])
    ? auth(r)
    : Promise.resolve({ kind: 'blocked', reason: 'Original dispatch only', evidence: [] });
test('round1_standalone_caller_mutation_at_lock_cannot_retarget', async (t) => {
  const caller = { ...request };
  const f = await fixture(t, {
    authorize: pinnedAuthorization,
    beforeLock: ({ pr }) => {
      caller.head = 'd'.repeat(40);
      pr.head.sha = caller.head;
    },
  });
  const result = await api.runReadinessHandshake(caller, f.port);
  assert.notEqual(result.kind, 'verified');
  assert.equal(f.sends, 0);
  assert.deepEqual((await f.store.readOperation(request.requestId)).value.request, request);
});
test('round1_mismatched_in_scope_request_has_no_observation_or_send', async (t) => {
  const f = await fixture(t, {
    authorize: pinnedAuthorization,
    beforeLock: ({ pr }) => {
      pr.head.sha = 'd'.repeat(40);
    },
  });
  const result = await withReadinessOperation(request, f.port.readinessStore, (scope) =>
    api.runReadinessHandshakeInScope({ ...request, head: 'd'.repeat(40) }, f.port, scope),
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(f.sends, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.store.readOperation(request.requestId)).value.request, request);
});
test('round1_in_scope_caller_mutation_during_first_observation_cannot_retarget', async (t) => {
  const caller = { ...request };
  const f = await fixture(t, {
    authorize: pinnedAuthorization,
    onRead: ({ reads, pr }) => {
      if (reads === 1) {
        caller.head = 'd'.repeat(40);
        pr.head.sha = caller.head;
      }
    },
  });
  const result = await withReadinessOperation(request, f.port.readinessStore, (scope) =>
    api.runReadinessHandshakeInScope(caller, f.port, scope),
  );
  assert.notEqual(result.kind, 'verified');
  assert.equal(f.sends, 0);
  assert.deepEqual((await f.store.readOperation(request.requestId)).value.request, request);
});
test('round1_caller_mutation_alone_preserves_original_authorized_proof', async (t) => {
  const caller = { ...request };
  const f = await fixture(t, {
    authorize: pinnedAuthorization,
    beforeLock: () => {
      caller.head = 'd'.repeat(40);
      caller.requestId = 'substituted';
    },
  });
  const result = await api.runReadinessHandshake(caller, f.port);
  assert.equal(result.kind, 'verified');
  assert.equal(f.sends, 1);
  assert.deepEqual(result.value.request, request);
  assert.equal(result.value.candidate.head, request.head);
  assert.equal(result.value.candidate.requestId, request.requestId);
  assert.deepEqual((await f.store.readOperation(request.requestId)).value.request, request);
});
