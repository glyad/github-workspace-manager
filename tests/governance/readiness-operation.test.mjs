import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import * as api from '../../tools/governance/readiness-operation.mjs';
const {
  beginReadinessOperation: begin,
  withReadinessOperation: within,
  recordReadinessPhase: phase,
  reconcileReadinessOperation: reconcile,
} = api;
const request = Object.freeze({
  protocolVersion: 2,
  requestId: 'one',
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
});
const hash = (s) => createHash('sha256').update(s).digest('hex');
async function authenticate(r) {
  const body = JSON.stringify(r);
  const run = {
    id: r.originalRunId,
    attempt: 1,
    repositoryId: r.repositoryId,
    actorId: r.initiatingActorId,
    workflowId: r.workflowId,
    sha: r.definitionSha,
    executionSha: r.definitionSha,
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  };
  return authenticateReadinessRequest(body, {
    runId: r.originalRunId,
    runAttempt: 1,
    authorizedActorIds: ['human'],
    approvedDefinition: Object.freeze({
      repositoryId: r.repositoryId,
      workflowId: r.workflowId,
      sha: r.definitionSha,
      ref: 'refs/heads/main',
    }),
    lookupRun: async () => verified(run),
    resolvePr: async () =>
      verified({ repositoryId: r.repositoryId, pr: r.pr, prNodeId: r.prNodeId }),
    verifyRequestEvidence: async () =>
      verified({
        bodyDigest: hash(body),
        originalRunId: r.originalRunId,
        runAttempt: 1,
        definitionSha: r.definitionSha,
        triggeringActorId: 'human',
      }),
  });
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'readiness-operation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root, options);
  store.authorizeReadinessRequest = authenticate;
  store.authenticateOperationEvidence = beforeEvidence;
  return { root, store };
}
const uncertain = () => ({ kind: 'uncertain', reason: 'lost response', evidence: [] });
const dig = 'd'.repeat(64);
function beforeEvidence(e, operation, phase) {
  return e === 'before' && phase === 'mutation-pending'
    ? verified({
        requestId: operation.request.requestId,
        operationDigest: hash(JSON.stringify(operation)),
        beforeDigest: dig,
      })
    : { kind: 'blocked' };
}
async function preparedMutation(scope, send) {
  if (scope.operation.beforeDigest === null) {
    const prepared = await scope.recordPhase('mutation-pending', 'before');
    if (prepared.kind !== 'verified') return prepared;
  }
  return scope.mutate(send);
}

test('duplicate_request_has_one_mutation_permit', async (t) => {
  const { store } = await fixture(t);
  let sends = 0;
  const first = await within(request, store, async (scope) => {
    assert.equal(scope.operation.state, 'mutation-pending');
    assert.equal((await store.readOperation('one')).value.state, 'mutation-pending');
    const sent = await preparedMutation(scope, async () => {
      sends++;
      return verified({ receipt: 'native' });
    });
    assert.equal(sent.kind, 'verified');
    assert.equal(
      (
        await preparedMutation(scope, async () => {
          sends++;
        })
      ).kind,
      'blocked',
    );
    return scope.recordPhase('quarantined', {});
  });
  assert.equal(first.kind, 'verified');
  await within(request, store, async (scope) =>
    preparedMutation(scope, async () => {
      sends++;
    }),
  );
  assert.equal(sends, 1);
  const rows = await store.readOperationHistory('one');
  assert.equal(rows.value.filter((r) => r.state === 'intent').length, 1);
});

test('uncertain_return_retains_obligation_after_restart', async (t) => {
  const { root, store } = await fixture(t);
  const result = await within(request, store, (scope) => preparedMutation(scope, uncertain));
  assert.equal(result.kind, 'uncertain');
  const restarted = new LocalDurableStore(root);
  restarted.authorizeReadinessRequest = authenticate;
  assert.equal((await restarted.readOperation('one')).value.state, 'mutation-pending');
  assert.notEqual((await begin(request, restarted)).kind, 'verified');
  assert.equal((await restarted.readObligations('repo:7')).value.length, 1);
});

async function crashScenario(t, afterUncertain = false) {
  const { root } = await fixture(t);
  const childCode = `import {LocalDurableStore} from ${JSON.stringify(resolve('tools/governance/local-durable-store.mjs'))};
    import {withReadinessOperation} from ${JSON.stringify(resolve('tools/governance/readiness-operation.mjs'))};
    import {authenticateReadinessRequest} from ${JSON.stringify(resolve('tools/governance/readiness-request.mjs'))};
    import {verified} from ${JSON.stringify(resolve('tools/governance/contracts.mjs'))};
    import {createHash} from 'node:crypto';
    const hash=${hash.toString()}; const authenticate=${authenticate.toString()};
    const dig='d'.repeat(64);const beforeEvidence=${beforeEvidence.toString()};const preparedMutation=${preparedMutation.toString()};
    const store=new LocalDurableStore(${JSON.stringify(root)}); store.authorizeReadinessRequest=authenticate;store.authenticateOperationEvidence=beforeEvidence;
    if (${afterUncertain === 'storage'}) {
      const append=store.appendOperation.bind(store);
      store.appendOperation=async(record)=>{const saved=await append(record);return record.state==='mutation-pending'?{kind:'uncertain',reason:'lost storage response',evidence:[]}:saved;};
    }
    const operationResult=await withReadinessOperation(${JSON.stringify(request)},store,async(scope)=>{
      if (${afterUncertain === 'storage'}) throw Error('Unexpected scope after storage uncertainty');
      if (${Boolean(afterUncertain)}) await preparedMutation(scope,async()=>({kind:'uncertain',reason:'lost',evidence:[]}));
      process.stdout.write('PERSISTED\\n'); await new Promise(()=>{setInterval(()=>{},1000);});
    });
    if (${afterUncertain === 'storage'} && operationResult.kind==='uncertain') {
      process.stdout.write('PERSISTED\\n');await new Promise(()=>{setInterval(()=>{},1000);});
    }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([b]) => String(b)),
    once(child, 'exit').then(() => 'EXIT ' + stderr),
  ]);
  assert.equal(ready, 'PERSISTED\n');
  const live = new LocalDurableStore(root);
  live.authorizeReadinessRequest = authenticate;
  live.authenticateOperationEvidence = async (e, op) =>
    verified({
      requestId: 'one',
      operationDigest: hash(JSON.stringify(op)),
      outcome: 'not-sent',
      returnedToDraft: true,
      humanActorId: 'human',
    });
  assert.equal((await reconcile('one', 'human-resolution', live)).kind, 'blocked');
  const contenderCode =
    childCode.slice(0, childCode.indexOf('    const operationResult=')) +
    `const result=await withReadinessOperation(${JSON.stringify(request)},store,async()=>verified({})); console.log(result.kind);`;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', contenderCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let competing = '';
  contender.stdout.on('data', (b) => {
    competing += b;
  });
  await once(contender, 'exit');
  assert.equal(competing.trim(), 'uncertain');
  child.kill('SIGKILL');
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL');
  const restarted = new LocalDurableStore(root);
  restarted.authorizeReadinessRequest = authenticate;
  assert.equal((await restarted.readOperation('one')).value.state, 'mutation-pending');
  let sends = 0;
  await within(request, restarted, (s) =>
    preparedMutation(s, async () => {
      sends++;
    }),
  );
  assert.equal(sends, 0);
  restarted.authenticateOperationEvidence = live.authenticateOperationEvidence;
  assert.equal((await reconcile('one', 'human-resolution', restarted)).value.state, 'reconciled');
  assert.notEqual((await begin(request, restarted)).kind, 'verified');
  assert.equal((await begin({ ...request, requestId: 'two' }, restarted)).kind, 'verified');
}
test('crash_before_send_is_not_blindly_retried', (t) => crashScenario(t));
test('returned_uncertainty_then_process_death_retains_original_obligation', (t) =>
  crashScenario(t, true));

test('deleted_tail_denies_recovery', async (t) => {
  const { root, store } = await fixture(t);
  assert.equal((await begin(request, store)).kind, 'verified');
  const log = join(root, hash('readiness-operation:one') + '.jsonl');
  const body = await fs.readFile(log, 'utf8');
  await fs.writeFile(log, body.split('\n').slice(0, -2).join('\n') + '\n');
  assert.equal((await store.readOperation('one')).kind, 'uncertain');
  assert.notEqual((await begin(request, store)).kind, 'verified');
});

test('rerun_never_refunds_or_replaces_request', async (t) => {
  const { store } = await fixture(t);
  assert.equal((await begin(request, store)).kind, 'verified');
  for (const patch of [
    { head: 'e'.repeat(40) },
    { initiatingActorId: 'other' },
    { pr: 8 },
    { requestId: 'two' },
  ])
    assert.notEqual((await begin({ ...request, ...patch }, store)).kind, 'verified');
  assert.deepEqual((await store.readOperation('one')).value.request, request);
});

test('serialized_authentication_and_untrusted_phase_evidence_have_no_authority', async (t) => {
  const { store } = await fixture(t);
  const auth = await authenticate(request);
  store.authorizeReadinessRequest = async () => structuredClone(auth);
  assert.equal((await begin(request, store)).kind, 'blocked');
  store.authorizeReadinessRequest = authenticate;
  await begin(request, store);
  assert.equal((await phase('one', 'accepted', { proofDigest: dig }, store)).kind, 'blocked');
  assert.equal((await reconcile('one', verified({ ready: true }), store)).kind, 'blocked');
  assert.equal((await store.readOperation('one')).value.state, 'mutation-pending');
});

test('one_shared_PR_lock_and_expired_scope_prevent_late_or_nested_mutation', async (t) => {
  const { store } = await fixture(t);
  let saved,
    sends = 0,
    locks = 0;
  const lock = store.withPrLock.bind(store);
  store.withPrLock = async (key, fn) => {
    assert.equal(key, 'repo:7');
    locks++;
    return lock(key, fn);
  };
  assert.equal(
    (
      await within(request, store, async (s) => {
        saved = s;
        return verified(s.operation);
      })
    ).kind,
    'verified',
  );
  assert.equal(
    (
      await preparedMutation(saved, async () => {
        sends++;
      })
    ).kind,
    'blocked',
  );
  assert.equal(locks, 1);
  assert.equal(sends, 0);
});

test('write_or_read_outage_never_sends_or_releases_uncertain_exclusion', async (t) => {
  const { root, store } = await fixture(t, {
    fault: async (point) => {
      if (point === 'operation-before-append') throw Error('disk');
    },
  });
  let sends = 0;
  assert.equal(
    (
      await within(request, store, (s) =>
        preparedMutation(s, async () => {
          sends++;
        }),
      )
    ).kind,
    'uncertain',
  );
  assert.equal(sends, 0);
  const restarted = new LocalDurableStore(root);
  restarted.authorizeReadinessRequest = authenticate;
  assert.notEqual((await begin({ ...request, requestId: 'two' }, restarted)).kind, 'verified');
});

test('explicit_authenticated_reconciliation_resolves_original_only_without_rearming', async (t) => {
  const { store } = await fixture(t);
  await begin(request, store);
  store.authenticateOperationEvidence = async (e, operation, phase) =>
    e === 'human-resolution' && phase === 'reconciled'
      ? verified({
          requestId: 'one',
          operationDigest: hash(JSON.stringify(operation)),
          outcome: 'not-sent',
          returnedToDraft: true,
          humanActorId: 'human',
        })
      : { kind: 'blocked' };
  assert.equal((await reconcile('one', { ready: true }, store)).kind, 'blocked');
  assert.equal((await reconcile('one', 'human-resolution', store)).value.state, 'reconciled');
  assert.notEqual((await begin(request, store)).kind, 'verified');
  assert.equal((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
});

test('actual_uncertain_result_and_read_outage_retain_original_pending', async (t) => {
  const { root, store } = await fixture(t);
  const append = store.appendOperation.bind(store);
  store.appendOperation = async (record) => {
    const saved = await append(record);
    return record.state === 'mutation-pending' ? uncertain() : saved;
  };
  let sends = 0;
  assert.equal(
    (
      await within(request, store, (s) =>
        preparedMutation(s, async () => {
          sends++;
        }),
      )
    ).kind,
    'uncertain',
  );
  assert.equal(sends, 0);
  const restarted = new LocalDurableStore(root);
  restarted.authorizeReadinessRequest = authenticate;
  assert.equal((await restarted.readOperation('one')).value.state, 'mutation-pending');
  assert.notEqual((await begin({ ...request, requestId: 'two' }, restarted)).kind, 'verified');
});

test('real_store_rejects_nonmonotonic_or_rewritten_operation_records', async (t) => {
  const { store } = await fixture(t);
  await begin(request, store);
  const op = (await store.readOperation('one')).value;
  for (const bad of [
    { ...op, state: 'intent' },
    { ...op, request: { ...op.request, head: 'e'.repeat(40) } },
    { ...op, state: 'accepted' },
    { ...op, unexpected: true },
  ]) {
    assert.notEqual((await store.appendOperation(bad)).kind, 'verified');
  }
  assert.deepEqual((await store.readOperation('one')).value, op);
});

test('authenticated_phase_evidence_is_exact_and_never_replaces_prior_facts', async (t) => {
  const { store } = await fixture(t);
  let sends = 0;
  store.authenticateOperationEvidence = async (e, operation, phase) =>
    phase === 'mutation-pending'
      ? beforeEvidence(e, operation, phase)
      : e === 'valid'
        ? verified({
            requestId: 'one',
            operationDigest: hash(JSON.stringify(operation)),
            beforeDigest: dig,
            mutationDigest: 'e'.repeat(64),
            proofDigest: 'f'.repeat(64),
          })
        : verified({ requestId: 'wrong' });
  assert.equal(
    (
      await within(request, store, async (scope) => {
        await preparedMutation(scope, async () => {
          sends++;
          return verified({});
        });
        assert.equal((await scope.recordPhase('accepted', 'valid')).kind, 'blocked');
        assert.equal((await scope.recordPhase('mutation-observed', 'forged')).kind, 'blocked');
        assert.equal(
          (await scope.recordPhase('mutation-observed', 'valid')).value.state,
          'mutation-observed',
        );
        return scope.recordPhase('accepted', 'valid');
      })
    ).value.state,
    'accepted',
  );
  assert.equal(sends, 1);
  assert.equal((await store.readObligations('repo:7')).value.length, 1);
});

test('uncertain_transport_cannot_be_promoted_from_current_Ready_alone', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = async (e, op, phase) =>
    phase === 'mutation-pending' ? beforeEvidence(e, op, phase) : verified({ ready: true });
  const outcomes = [];
  assert.equal(
    (
      await within(request, store, async (scope) => {
        outcomes.push((await preparedMutation(scope, uncertain)).kind);
        outcomes.push((await scope.recordPhase('mutation-observed', { ready: true })).kind);
        outcomes.push((await scope.recordPhase('accepted', { ready: true })).kind);
        return verified({});
      })
    ).kind,
    'uncertain',
  );
  assert.deepEqual(outcomes, ['uncertain', 'blocked', 'blocked']);
  assert.equal((await store.readOperation('one')).value.state, 'mutation-pending');
  assert.equal((await reconcile('one', { ready: true }, store)).kind, 'blocked');
});

test('authenticated_reconciliation_of_retained_uncertain_lock_does_not_rearm', async (t) => {
  const { store } = await fixture(t);
  await within(request, store, (s) => preparedMutation(s, uncertain));
  store.authenticateOperationEvidence = async (e, operation) =>
    e === 'human-resolution'
      ? verified({
          requestId: 'one',
          operationDigest: hash(JSON.stringify(operation)),
          outcome: 'not-applied',
          returnedToDraft: true,
          humanActorId: 'human',
        })
      : { kind: 'blocked' };
  assert.equal((await reconcile('one', 'human-resolution', store)).value.state, 'reconciled');
  assert.notEqual((await begin(request, store)).kind, 'verified');
});

test('parallel_calls_cannot_consume_the_single_permit_twice', async (t) => {
  const { store } = await fixture(t);
  let sends = 0;
  assert.equal(
    (
      await within(request, store, async (scope) => {
        await scope.recordPhase('mutation-pending', 'before');
        await Promise.all([
          preparedMutation(scope, async () => {
            sends++;
            return verified({});
          }),
          preparedMutation(scope, async () => {
            sends++;
            return verified({});
          }),
        ]);
        return verified({});
      })
    ).kind,
    'verified',
  );
  assert.equal(sends, 1);
});

test('unawaited_external_callback_cannot_outlive_PR_ownership', async (t) => {
  const { store } = await fixture(t);
  let finish, started;
  const entered = new Promise((r) => {
    started = r;
  });
  const release = new Promise((r) => {
    finish = r;
  });
  let unlocked = false;
  const lock = store.withPrLock.bind(store);
  store.withPrLock = async (k, f) => {
    const result = await lock(k, f);
    unlocked = true;
    return result;
  };
  const running = within(request, store, async (scope) => {
    void preparedMutation(scope, async () => {
      started();
      await release;
      return uncertain();
    });
    await entered;
    return verified({});
  });
  await entered;
  await new Promise((r) => setImmediate(r));
  assert.equal(unlocked, false);
  finish();
  assert.equal((await running).kind, 'uncertain');
});

test('read_outage_immediately_before_send_denies_send_and_retains_pending', async (t) => {
  let outage = false;
  const { root, store } = await fixture(t, {
    fault: async (point) => {
      if (outage && point === 'operation-before-read') throw Error('read down');
    },
  });
  let sends = 0;
  const result = await within(request, store, async (scope) => {
    outage = true;
    return preparedMutation(scope, async () => {
      sends++;
      return verified({});
    });
  });
  assert.equal(result.kind, 'uncertain');
  assert.equal(sends, 0);
  const restarted = new LocalDurableStore(root);
  assert.equal((await restarted.readOperation('one')).value.state, 'mutation-pending');
});

test('malformed_requests_and_missing_auth_port_cannot_write_intent', async (t) => {
  const { store } = await fixture(t);
  for (const bad of [
    { ...request, extra: true },
    { ...request, pr: 0 },
    { ...request, head: 'bad' },
    { ...request, baseRef: 'refs/heads/../evil' },
  ])
    assert.equal((await begin(bad, store)).kind, 'blocked');
  delete store.authorizeReadinessRequest;
  assert.equal((await begin(request, store)).kind, 'blocked');
  assert.equal((await store.readOperation('one')).value, null);
});

test('deleted_operation_index_or_entire_history_denies_a_fresh_request', async (t) => {
  for (const mode of ['index', 'history']) {
    const { root, store } = await fixture(t);
    await begin(request, store);
    if (mode === 'index') await fs.unlink(join(root, hash('repo:7') + '.operations', 'one'));
    else {
      await fs.unlink(join(root, hash('readiness-operation:one') + '.jsonl'));
      await fs.rm(join(root, hash('readiness-operation:one') + '.members'), { recursive: true });
    }
    assert.equal((await store.readObligations('repo:7')).kind, 'uncertain');
    assert.notEqual((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
  }
});

test('required_store_interface_composes_without_local_only_extensions', async (t) => {
  const { store } = await fixture(t);
  let locks = 0;
  const injected = {
    authorizeReadinessRequest: authenticate,
    withPrLock: async (key, fn) => {
      locks++;
      return store.withPrLock(key, fn);
    },
    readOperation: store.readOperation.bind(store),
    appendOperation: store.appendOperation.bind(store),
    readObligations: store.readObligations.bind(store),
  };
  const reserved = await begin(request, injected);
  assert.equal(reserved.kind, 'verified');
  assert.equal(reserved.value.state, 'mutation-pending');
  assert.equal(reserved.value.mutate, undefined);
  assert.equal(locks, 1);
  assert.equal((await begin(request, injected)).kind, 'blocked');
});

test('missing_or_wrong_before_evidence_never_sends', async (t) => {
  const { store } = await fixture(t);
  let sends = 0;
  assert.equal(
    (
      await within(request, store, async (scope) => {
        assert.equal(
          (
            await scope.mutate(async () => {
              sends++;
              return verified({});
            })
          ).kind,
          'blocked',
        );
        assert.equal((await scope.recordPhase('mutation-pending', 'wrong')).kind, 'blocked');
        assert.equal(
          (
            await scope.mutate(async () => {
              sends++;
              return verified({});
            })
          ).kind,
          'blocked',
        );
        return verified({});
      })
    ).kind,
    'verified',
  );
  assert.equal(sends, 0);
});

test('stale_or_cross_request_authenticated_before_digest_cannot_send', async (t) => {
  for (const patch of [{ requestId: 'other' }, { operationDigest: 'f'.repeat(64) }]) {
    const { store } = await fixture(t);
    let sends = 0;
    const outcomes = [];
    store.authenticateOperationEvidence = async (e, op) =>
      verified({
        requestId: 'one',
        operationDigest: hash(JSON.stringify(op)),
        beforeDigest: dig,
        ...patch,
      });
    assert.equal(
      (
        await within(request, store, async (scope) => {
          outcomes.push((await scope.recordPhase('mutation-pending', 'before')).kind);
          outcomes.push(
            (
              await scope.mutate(async () => {
                sends++;
                return verified({});
              })
            ).kind,
          );
          return verified({});
        })
      ).kind,
      'verified',
    );
    assert.deepEqual(outcomes, ['blocked', 'blocked']);
    assert.equal(sends, 0);
  }
});

test('accepted_operation_can_be_quarantined_without_erasing_claims', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = async (e, op, phase) =>
    phase === 'mutation-pending'
      ? beforeEvidence(e, op, phase)
      : verified({
          requestId: 'one',
          operationDigest: hash(JSON.stringify(op)),
          beforeDigest: dig,
          mutationDigest: 'e'.repeat(64),
          proofDigest: 'f'.repeat(64),
        });
  const accepted = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'observed');
    return scope.recordPhase('accepted', 'proof');
  });
  assert.equal(accepted.value.state, 'accepted');
  const quarantined = await phase('one', 'quarantined', {}, store);
  assert.equal(quarantined.kind, 'verified');
  assert.equal(quarantined.value.state, 'quarantined');
  assert.equal(quarantined.value.proofDigest, 'f'.repeat(64));
  assert.equal(quarantined.value.mutationDigest, 'e'.repeat(64));
  assert.notEqual((await begin(request, store)).kind, 'verified');
});

test('returned_storage_uncertainty_then_process_death_retains_exclusion', (t) =>
  crashScenario(t, 'storage'));

test('malformed_authenticated_obligation_result_does_not_grant_a_permit', async (t) => {
  const { store } = await fixture(t);
  let sends = 0;
  store.readObligations = async () => verified({});
  assert.equal(
    (
      await within(request, store, (s) =>
        preparedMutation(s, async () => {
          sends++;
          return verified({});
        }),
      )
    ).kind,
    'uncertain',
  );
  assert.equal(sends, 0);
  assert.equal((await store.readOperation('one')).value, null);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function phaseEvidence(e, op, phase) {
  return phase === 'mutation-pending'
    ? beforeEvidence(e, op, phase)
    : verified({
        requestId: op.request.requestId,
        operationDigest: hash(JSON.stringify(op)),
        beforeDigest: dig,
        mutationDigest: 'e'.repeat(64),
        proofDigest: 'f'.repeat(64),
      });
}

test('round1_quarantine_during_immediate_reread_revokes_send', async (t) => {
  const { store } = await fixture(t);
  const entered = deferred(),
    resume = deferred();
  const read = store.readOperation.bind(store);
  let armed = false,
    sends = 0;
  const outcomes = [];
  store.readOperation = async (id) => {
    if (armed) {
      armed = false;
      entered.resolve();
      await resume.promise;
    }
    return read(id);
  };
  const result = await within(request, store, async (scope) => {
    await scope.recordPhase('mutation-pending', 'before');
    armed = true;
    const sending = scope.mutate(async () => {
      sends++;
      return verified({});
    });
    await entered.promise;
    outcomes.push((await scope.recordPhase('quarantined', {})).kind);
    resume.resolve();
    outcomes.push((await sending).kind);
    return verified({});
  });
  assert.equal(result.kind, 'verified');
  assert.equal(sends, 0);
  assert.deepEqual(outcomes, ['verified', 'blocked']);
  assert.equal((await read('one')).value.state, 'quarantined');
});

test('round1_unsettled_callback_cannot_advance_and_uncertainty_stays_pending', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const entered = deferred(),
    resume = deferred();
  const outcomes = [];
  let before;
  const result = await within(request, store, async (scope) => {
    await scope.recordPhase('mutation-pending', 'before');
    const sending = scope.mutate(async () => {
      entered.resolve();
      await resume.promise;
      return uncertain();
    });
    await entered.promise;
    outcomes.push((await scope.recordPhase('mutation-observed', 'valid')).kind);
    outcomes.push((await scope.recordPhase('accepted', 'valid')).kind);
    before = (await store.readOperation('one')).value.state;
    resume.resolve();
    outcomes.push((await sending).kind);
    return verified({});
  });
  assert.equal(result.kind, 'uncertain');
  assert.deepEqual(outcomes, ['blocked', 'blocked', 'uncertain']);
  assert.equal(before, 'mutation-pending');
  assert.equal((await store.readOperation('one')).value.state, 'mutation-pending');
  assert.notEqual((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
});

test('round1_failed_immediate_reread_cannot_enable_observed_or_accepted', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const entered = deferred(),
    resume = deferred();
  const read = store.readOperation.bind(store);
  let armed = false,
    sends = 0;
  const outcomes = [];
  store.readOperation = async (id) => {
    if (armed) {
      armed = false;
      entered.resolve();
      await resume.promise;
      return uncertain();
    }
    return read(id);
  };
  const result = await within(request, store, async (scope) => {
    await scope.recordPhase('mutation-pending', 'before');
    armed = true;
    const sending = scope.mutate(async () => {
      sends++;
      return verified({});
    });
    await entered.promise;
    outcomes.push((await scope.recordPhase('mutation-observed', 'valid')).kind);
    outcomes.push((await scope.recordPhase('accepted', 'valid')).kind);
    resume.resolve();
    outcomes.push((await sending).kind);
    outcomes.push((await scope.recordPhase('mutation-observed', 'valid')).kind);
    outcomes.push((await scope.recordPhase('accepted', 'valid')).kind);
    return verified({});
  });
  assert.equal(result.kind, 'uncertain');
  assert.equal(sends, 0);
  assert.deepEqual(outcomes, ['blocked', 'blocked', 'uncertain', 'blocked', 'blocked']);
  assert.equal((await read('one')).value.state, 'mutation-pending');
});

test('round1_parallel_phase_writes_are_serialized_without_poisoning_history', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  let outcomes;
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    outcomes = await Promise.all([
      scope.recordPhase('mutation-observed', 'valid'),
      scope.recordPhase('mutation-observed', 'valid'),
    ]);
    return verified({});
  });
  assert.equal(result.kind, 'verified');
  assert.deepEqual(
    outcomes.map((r) => r.kind),
    ['verified', 'blocked'],
  );
  assert.equal((await store.readOperation('one')).value.state, 'mutation-observed');
});

test('round1_uncertain_acceptance_storage_cannot_leave_an_available_accepted_claim', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const append = store.appendOperation.bind(store);
  store.appendOperation = async (record) => {
    const result = await append(record);
    return record.state === 'accepted' ? uncertain() : result;
  };
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    return scope.recordPhase('accepted', 'valid');
  });
  assert.equal(result.kind, 'uncertain');
  assert.equal((await store.readOperation('one')).value.state, 'quarantined');
  assert.notEqual((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
});

test('round1_concurrent_quarantine_revokes_an_authenticating_phase', async (t) => {
  const { store } = await fixture(t);
  const entered = deferred(),
    resume = deferred();
  let outcomes;
  store.authenticateOperationEvidence = async (e, op, phase) => {
    if (phase === 'mutation-observed') {
      entered.resolve();
      await resume.promise;
    }
    return phaseEvidence(e, op, phase);
  };
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    const observed = scope.recordPhase('mutation-observed', 'valid');
    await entered.promise;
    const quarantine = scope.recordPhase('quarantined', {});
    resume.resolve();
    outcomes = await Promise.all([observed, quarantine]);
    return verified({});
  });
  assert.equal(result.kind, 'verified');
  assert.deepEqual(
    outcomes.map((r) => r.kind),
    ['blocked', 'verified'],
  );
  assert.equal((await store.readOperation('one')).value.state, 'quarantined');
});

test('round1_explicit_scope_uncertainty_preserves_accepted_facts_in_quarantine', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    await scope.recordPhase('accepted', 'valid');
    return uncertain();
  });
  assert.equal(result.kind, 'uncertain');
  const record = (await store.readOperation('one')).value;
  assert.equal(record.state, 'quarantined');
  assert.equal(record.proofDigest, 'f'.repeat(64));
});

test('round1_thrown_or_malformed_callback_never_establishes_settlement', async (t) => {
  for (const send of [
    async () => {
      throw Error('lost');
    },
    async () => ({ kind: 'verified' }),
  ]) {
    const { store } = await fixture(t);
    store.authenticateOperationEvidence = phaseEvidence;
    let outcomes;
    const result = await within(request, store, async (scope) => {
      const sent = await preparedMutation(scope, send);
      outcomes = [
        sent.kind,
        (await scope.recordPhase('mutation-observed', 'valid')).kind,
        (await scope.recordPhase('accepted', 'valid')).kind,
      ];
      return verified({});
    });
    assert.equal(result.kind, 'uncertain');
    assert.deepEqual(outcomes, ['uncertain', 'blocked', 'blocked']);
    assert.equal((await store.readOperation('one')).value.state, 'mutation-pending');
  }
});

test('round1_acceptance_outage_retains_exclusion_when_quarantine_cannot_persist', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const append = store.appendOperation.bind(store),
    read = store.readOperation.bind(store);
  let outage = false;
  store.appendOperation = async (record) => {
    const result = await append(record);
    if (record.state === 'accepted') {
      outage = true;
      return uncertain();
    }
    return result;
  };
  store.readOperation = async (id) => (outage ? uncertain() : read(id));
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    return scope.recordPhase('accepted', 'valid');
  });
  assert.equal(result.kind, 'uncertain');
  outage = false;
  assert.equal((await read('one')).value.proofDigest, 'f'.repeat(64));
  assert.notEqual((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
  assert.equal((await store.readObligations('repo:7')).value.length, 1);
});

test('round2_unawaited_quarantine_after_acceptance_drains_before_scope_release', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  let quarantine, saved;
  const result = await within(request, store, async (scope) => {
    saved = scope;
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    const accepted = await scope.recordPhase('accepted', 'valid');
    quarantine = scope.recordPhase('quarantined', {});
    return accepted;
  });
  assert.equal((await quarantine).kind, 'verified');
  assert.equal((await store.readOperation('one')).value.state, 'quarantined');
  assert.equal(result.kind, 'blocked');
  assert.equal((await saved.recordPhase('quarantined', {})).kind, 'blocked');
});

test('round2_quarantine_queued_behind_inflight_acceptance_survives_callback_return', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const entered = deferred(),
    resume = deferred();
  const append = store.appendOperation.bind(store);
  store.appendOperation = async (record) => {
    if (record.state === 'accepted') {
      entered.resolve();
      await resume.promise;
    }
    return append(record);
  };
  let acceptance, quarantine;
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    acceptance = scope.recordPhase('accepted', 'valid');
    await entered.promise;
    quarantine = scope.recordPhase('quarantined', {});
    resume.resolve();
    return verified({});
  });
  assert.equal((await acceptance).kind, 'verified');
  assert.equal((await quarantine).kind, 'verified');
  assert.equal((await store.readOperation('one')).value.state, 'quarantined');
  assert.equal(result.kind, 'blocked');
});

test('round2_unawaited_quarantine_write_failure_retains_exclusion', async (t) => {
  const { store } = await fixture(t);
  store.authenticateOperationEvidence = phaseEvidence;
  const append = store.appendOperation.bind(store);
  let quarantine;
  store.appendOperation = async (record) =>
    record.state === 'quarantined' ? uncertain() : append(record);
  const result = await within(request, store, async (scope) => {
    await preparedMutation(scope, async () => verified({}));
    await scope.recordPhase('mutation-observed', 'valid');
    const accepted = await scope.recordPhase('accepted', 'valid');
    quarantine = scope.recordPhase('quarantined', {});
    return accepted;
  });
  assert.equal((await quarantine).kind, 'uncertain');
  assert.equal(result.kind, 'uncertain');
  assert.notEqual((await begin({ ...request, requestId: 'two' }, store)).kind, 'verified');
});

test(
  'round2_new_calls_during_drain_are_denied_without_expiring_started_work',
  { timeout: 5000 },
  async (t) => {
    const { store } = await fixture(t);
    store.authenticateOperationEvidence = phaseEvidence;
    const entered = deferred(),
      resume = deferred();
    t.after(() => resume.resolve());
    const append = store.appendOperation.bind(store);
    let saved,
      quarantine,
      sends = 0;
    store.appendOperation = async (record) => {
      if (record.state === 'quarantined') {
        entered.resolve();
        await resume.promise;
      }
      return append(record);
    };
    const running = within(request, store, async (scope) => {
      saved = scope;
      await preparedMutation(scope, async () => verified({}));
      await scope.recordPhase('mutation-observed', 'valid');
      const accepted = await scope.recordPhase('accepted', 'valid');
      quarantine = scope.recordPhase('quarantined', {});
      return accepted;
    });
    await entered.promise;
    await new Promise((r) => setImmediate(r));
    const latePhase = await saved.recordPhase('accepted', 'valid');
    const lateSend = await saved.mutate(async () => {
      sends++;
      return verified({});
    });
    resume.resolve();
    const result = await running;
    assert.equal(latePhase.kind, 'blocked');
    assert.equal(lateSend.kind, 'blocked');
    assert.equal(sends, 0);
    assert.equal((await quarantine).kind, 'verified');
    assert.equal(result.kind, 'blocked');
    assert.equal((await store.readOperation('one')).value.state, 'quarantined');
  },
);
