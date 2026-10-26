import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as dispatch from '../../tools/governance/worker-dispatch.mjs';
import { admitCandidate } from '../../tools/governance/admission.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import { handleTrustedWorkerCallback } from '../../tools/governance/controller-runtime.mjs';
import {
  publicKey,
  signed,
  c,
  run,
  workerRun,
  fixture as composedFixture,
} from './composed-adapter-fixture.mjs';
const fixture = (t, options = {}) => composedFixture(t, { ...options, concreteContinuation: true });

async function admitted(t, options) {
  const f = await fixture(t, options);
  assert.equal(
    (
      await admitCandidate(f.port, {
        type: 'verified_readiness',
        repositoryId: '1',
        pr: 2,
        readinessId: c.attempt,
        candidate: c,
        proofDigest: f.proofDigest,
      })
    ).kind,
    'verified',
  );
  return f;
}
const sends = (f) => f.calls.filter((x) => x.path.endsWith('/dispatches'));
const callback = async (f, type = 'worker_start', r = workerRun) => {
  const claim = await f.port.readCiContinuation(
    `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`,
  );
  const body = JSON.stringify({
    type,
    candidate: c,
    worker: 'ci',
    outcome: 'success',
    claimId: claim.value?.id,
  });
  return handleTrustedWorkerCallback(
    {
      body,
      archive: signed({
        purpose: 'worker-callback',
        run: r,
        candidate: c,
        worker: 'ci',
        bodyDigest: digest(body),
      }),
    },
    { port: f.port, expectedRun: r, publicKey, mode: 'offline-test' },
  );
};
test('bot_event_suppressed_explicit_dispatch_still_works', async (t) => {
  const f = await admitted(t);
  const r = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(r.kind, 'verified');
  assert.equal(r.value.status, 'observed');
  assert.equal(sends(f).length, 1);
  assert.equal(
    f.calls.filter((x) => x.path.includes('review') || x.path.includes('api.openai')).length,
    0,
  );
});
test('duplicate_continuation_sends_once', async (t) => {
  const f = await admitted(t);
  await dispatch.dispatchAdmittedCi(c, f.port);
  await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(sends(f).length, 1);
});
test('dispatch_success_lost_response_reconciles', async (t) => {
  const f = await admitted(t, { loseResponse: true });
  const first = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(first.kind, 'uncertain');
  const id = `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`;
  const found = await dispatch.reconcileCiDispatch(id, f.port);
  assert.equal(found.kind, 'verified');
  assert.equal(found.value.run.id, workerRun.id);
  await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(sends(f).length, 1);
});
test('unknown_run_keeps_claim_occupied', async (t) => {
  const f = await admitted(t, { discovery: 'unavailable' });
  await dispatch.dispatchAdmittedCi(c, f.port);
  await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(sends(f).length, 1);
  const r = await f.port.readCiContinuation(
    `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`,
  );
  assert.equal(r.value.status, 'pending');
});
test('drift_before_dispatch_denies', async (t) => {
  const f = await admitted(t);
  f.pr.head.sha = 'f'.repeat(40);
  const r = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.notEqual(r.kind, 'verified');
  assert.equal(sends(f).length, 0);
});
test('forged_run_cannot_claim_completion', async (t) => {
  const f = await admitted(t);
  await dispatch.dispatchAdmittedCi(c, f.port);
  assert.notEqual(
    (await callback(f, 'worker_completed', { ...workerRun, id: '99' })).kind,
    'verified',
  );
});
test('composed_dispatch_binds_callback_gate', async (t) => {
  const f = await admitted(t);
  const r = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal(r.kind, 'verified');
  assert.equal((await callback(f)).kind, 'verified');
  assert.equal((await callback(f, 'worker_completed')).kind, 'verified');
  const persisted = await f.store.readCiClaim(r.value.id);
  assert.equal(persisted.value.start.state, 'consumed');
});
test('composed_lost_response_discovers_original_run', async (t) => {
  const f = await admitted(t, { loseResponse: true });
  await dispatch.dispatchAdmittedCi(c, f.port);
  const found = await dispatch.reconcileCiDispatch(
    `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`,
    f.port,
  );
  assert.equal(found.kind, 'verified');
  assert.equal(found.value.run.id, '6');
  assert.equal(found.value.start, null);
  assert.equal(sends(f).length, 1);
});
test('ambiguous_or_unavailable_discovery_retains_claim', async (t) => {
  for (const discovery of ['ambiguous', 'unavailable']) {
    const f = await admitted(t, { discovery });
    await dispatch.dispatchAdmittedCi(c, f.port);
    const id = `ci-${digest(JSON.stringify([c.repositoryId, c.pr, c.attempt]))}`;
    assert.notEqual((await dispatch.reconcileCiDispatch(id, f.port)).kind, 'verified');
    assert.equal((await f.store.readCiClaim(id)).value.status, 'pending');
    await dispatch.dispatchAdmittedCi(c, f.port);
    assert.equal(sends(f).length, 1);
  }
});
test('run_or_attempt_substitution_denied_at_start_and_completion', async (t) => {
  const f = await admitted(t);
  await dispatch.dispatchAdmittedCi(c, f.port);
  for (const r of [
    { ...workerRun, id: '99' },
    { ...workerRun, attempt: 2 },
  ])
    for (const type of ['worker_start', 'worker_completed'])
      assert.notEqual((await callback(f, type, r)).kind, 'verified');
  assert.equal((await callback(f)).kind, 'verified');
  for (const r of [
    { ...workerRun, id: '99' },
    { ...workerRun, attempt: 2 },
  ])
    assert.notEqual((await callback(f, 'worker_completed', r)).kind, 'verified');
});
test('concurrent_duplicate_starts_grant_one_permission', async (t) => {
  const f = await admitted(t);
  await dispatch.dispatchAdmittedCi(c, f.port);
  const outcomes = await Promise.all([callback(f), callback(f), callback(f)]);
  assert.equal(outcomes.filter((x) => x.kind === 'verified').length, 1);
});
test('ci_workflow_rerun_cannot_replace_claimed_run_or_restart', async (t) => {
  const f = await admitted(t);
  const r = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal((await callback(f)).kind, 'verified');
  assert.notEqual(
    (await callback(f, 'worker_start', { ...workerRun, attempt: 2 })).kind,
    'verified',
  );
  assert.notEqual((await callback(f)).kind, 'verified');
  const reconciled = await dispatch.reconcileCiDispatch(r.value.id, f.port);
  assert.equal(reconciled.kind, 'verified');
  assert.equal(reconciled.value.start.state, 'consumed');
  assert.notEqual((await callback(f)).kind, 'verified');
  assert.equal(sends(f).length, 1);
});

// Each child runs the real composed adapters, stops at a durable boundary, and
// is killed by its parent. No timeout-based lock takeover is exercised.
async function killedChild(t, phase) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-kill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ownSource = await readFile(new URL(import.meta.url), 'utf8');
  const prefix = ownSource.slice(0, ownSource.indexOf("test('bot_event_suppressed"));
  const program =
    prefix +
    `
 const phase=${JSON.stringify(phase)}, dir=${JSON.stringify(dir)};
 const pause=async name=>{if(name===phase){process.send({phase:name});await new Promise(()=>{});}};
 const f=await admitted({after(){}},{storeRoot:dir,boundary:async(name)=>{if(name==='after-send')await appendFile(join(dir,'sent'),'one\\n'); await pause(name);}});
 if(phase==='consumed-before-response') f.store.fault=async(name,value)=>{if(name==='after-fsync' && value?.start) await pause(phase);};
 const result=await dispatch.dispatchAdmittedCi(c,f.port);
 if(phase==='permission-lost'){
   await writeFile(join(dir,'comments.json'),JSON.stringify(f.comments));
   const permission=await callback(f);
   assert.equal(permission.kind,'verified');
   await pause(phase);
 } else if(phase==='consumed-before-response') await callback(f);
 else throw Error('missed boundary '+phase+JSON.stringify(result));
 `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: new URL('.', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', (x) => (errors += x));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('child boundary timeout ' + errors));
    }, 15000);
    child.once('message', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(Error('child exited early ' + code + signal + errors));
    });
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  return { dir, store: new LocalDurableStore(dir) };
}
for (const phase of ['before-send', 'after-send', 'consumed-before-response'])
  test(`process_kill_restart_${phase}`, async (t) => {
    const f = await killedChild(t, phase);
    const id = dispatch.ciClaimId(c);
    const retained = await f.store.readCiClaim(id);
    assert.equal(retained.kind, 'verified');
    assert.equal(
      retained.value.start?.state ?? null,
      phase === 'consumed-before-response' ? 'consumed' : null,
    );
    assert.equal(
      retained.value.status,
      phase === 'consumed-before-response' ? 'observed' : 'pending',
    );
    await assert.rejects(f.store.withPrLock('1:2', async () => verified('unexpected lock access')));
    let calls = 0;
    const port = createGithubPort({
      store: f.store,
      http: async () => {
        calls++;
        throw Error('no sends');
      },
      archive: async () => null,
      publicKey,
      repository: 'o/r',
      repositoryId: '1',
      ledgerNumber: 7,
      ledgerId: '7',
      controllerRun: run,
      ciContinuation: { approvedDefinition: workerRun },
    });
    assert.equal((await dispatch.reconcileCiDispatch(id, port)).kind, 'uncertain');
    assert.notEqual((await dispatch.dispatchAdmittedCi(c, port)).kind, 'verified');
    assert.equal(calls, 0);
    let sent = '';
    try {
      sent = await readFile(join(f.dir, 'sent'), 'utf8');
    } catch {}
    assert.equal(sent.length > 0, phase !== 'before-send');
  });
test('restart_lost_start_permission_never_renews_execution', async (t) => {
  const crashed = await killedChild(t, 'permission-lost');
  const comments = JSON.parse(await readFile(join(crashed.dir, 'comments.json'), 'utf8'));
  const f = await fixture(t, { storeRoot: crashed.dir, restoredComments: comments });
  const claim = await f.port.readCiContinuation(dispatch.ciClaimId(c));
  assert.equal(claim.value.start.state, 'consumed');
  assert.notEqual((await callback(f)).kind, 'verified');
  assert.notEqual(
    (await callback(f, 'worker_start', { ...workerRun, attempt: 2 })).kind,
    'verified',
  );
  assert.equal((await dispatch.reconcileCiDispatch(claim.value.id, f.port)).kind, 'verified');
  assert.notEqual((await callback(f)).kind, 'verified');
  assert.equal(sends(f).length, 0);
  assert.equal((await callback(f, 'worker_completed')).kind, 'verified');
});
test('storage_outage_retains_lock_and_pending_membership', async (t) => {
  const f = await admitted(t);
  f.store.fault = async (phase) => {
    if (phase === 'ci-before-append') throw Error('disk outage');
  };
  assert.equal((await dispatch.dispatchAdmittedCi(c, f.port)).kind, 'uncertain');
  const restarted = new LocalDurableStore(f.dir);
  assert.equal((await restarted.readCiClaim(dispatch.ciClaimId(c))).kind, 'uncertain');
  await assert.rejects(restarted.withPrLock('1:2', async () => verified('unexpected lock access')));
  assert.equal(sends(f).length, 0);
});
test('claim_send_authority_expires_with_lock', async (t) => {
  const f = await admitted(t);
  const claimed = await f.port.withPrLock('1:2', () => f.port.claimCiContinuation(c));
  assert.equal(claimed.kind, 'verified');
  const result = await f.port.withPrLock('1:2', () => f.port.dispatchCi(claimed.value));
  assert.notEqual(result.kind, 'verified');
  assert.equal(sends(f).length, 0);
});
test('discovery_uncertainty_with_storage_outage_retains_ownership', async (t) => {
  const f = await admitted(t, {
    discovery: 'unavailable',
    boundary: async (phase) => {
      if (phase === 'after-send')
        f.store.fault = async (point) => {
          if (point === 'ci-readback') throw Error('storage unavailable');
        };
    },
  });
  assert.equal((await dispatch.dispatchAdmittedCi(c, f.port)).kind, 'uncertain');
  await assert.rejects(
    new LocalDurableStore(f.dir).withPrLock('1:2', async () => verified('unexpected lock access')),
  );
});

test('issuer_must_bind_claim_request_full_candidate_definition_and_original_execution', async (t) => {
  for (const discovery of [
    'wrong-claim',
    'wrong-request',
    'wrong-candidate',
    'wrong-definition',
    'rerun',
    'wrong-actor',
    'unsigned',
  ]) {
    const f = await admitted(t, { discovery });
    const result = await dispatch.dispatchAdmittedCi(c, f.port);
    assert.equal(result.kind, 'uncertain', discovery);
    assert.equal((await f.store.readCiClaim(dispatch.ciClaimId(c))).value.run, null, discovery);
    assert.notEqual((await callback(f)).kind, 'verified', discovery);
    await dispatch.dispatchAdmittedCi(c, f.port);
    assert.equal(sends(f).length, 1, discovery);
  }
});
test('missing_proof_or_definition_cannot_claim_or_send', async (t) => {
  const noProof = await fixture(t, { proof: false });
  assert.notEqual((await dispatch.dispatchAdmittedCi(c, noProof.port)).kind, 'verified');
  assert.equal(sends(noProof).length, 0);
  const f = await admitted(t);
  const port = createGithubPort({
    store: f.store,
    http: async () => assert.fail('no transport'),
    archive: async () => null,
    publicKey,
    repository: 'o/r',
    repositoryId: '1',
    ledgerNumber: 7,
    ledgerId: '7',
    controllerRun: run,
  });
  const result = await port.withPrLock('1:2', () => port.claimCiContinuation(c));
  assert.equal(result.kind, 'blocked');
  assert.equal((await f.store.readCiClaim(dispatch.ciClaimId(c))).value, null);
});
test('conflicting_run_binding_and_removed_start_tail_fail_closed', async (t) => {
  const f = await admitted(t);
  const claim = await dispatch.dispatchAdmittedCi(c, f.port);
  assert.equal((await callback(f)).kind, 'verified');
  const substituted = await f.port.withPrLock('1:2', () =>
    f.port.bindCiRun(claim.value.id, { ...workerRun, attempt: 2 }),
  );
  assert.equal(substituted.kind, 'blocked');
  const file = join(f.dir, `${digest('ci-claim:' + claim.value.id)}.jsonl`);
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  await writeFile(file, lines.slice(0, -1).join('\n') + '\n');
  assert.equal((await new LocalDurableStore(f.dir).readCiClaim(claim.value.id)).kind, 'uncertain');
  assert.notEqual((await callback(f)).kind, 'verified');
});

test('issuer_cannot_rewrite_authoritative_claim_across_await', async (t) => {
  const f = await admitted(t, { discovery: 'mutate-issuer-input' });
  assert.equal((await dispatch.dispatchAdmittedCi(c, f.port)).kind, 'uncertain');
  assert.equal((await f.store.readCiClaim(dispatch.ciClaimId(c))).value.run, null);
});
test('local_store_cannot_create_alternate_slot_for_same_ready_attempt', async (t) => {
  const f = await admitted(t);
  const claim = await dispatch.dispatchAdmittedCi(c, f.port);
  const alternate = { ...claim.value, id: 'alternate', status: 'pending', run: null, start: null };
  assert.notEqual((await f.store.appendCiClaim(alternate)).kind, 'verified');
});

for (const operation of ['dispatch', 'reconcile']) {
  for (const storageAvailable of [false, true]) {
    test(`post_send_${operation}_second_discovery_outage_${storageAvailable ? 'releases_verified_obligation' : 'retains_unknown_storage'}`, async (t) => {
      let discoveries = 0;
      const f = await admitted(t, {
        loseResponse: operation === 'reconcile',
        archiveBoundary: async (_purpose, _input, { store }) => {
          if (++discoveries !== 2) return;
          if (!storageAvailable)
            store.fault = async (point) => {
              if (point === 'ci-readback') throw Error('storage failed during binding discovery');
            };
          return false;
        },
      });
      let result = await dispatch.dispatchAdmittedCi(c, f.port);
      const id = dispatch.ciClaimId(c);
      if (operation === 'reconcile') result = await dispatch.reconcileCiDispatch(id, f.port);
      assert.equal(discoveries, 2);
      assert.equal(sends(f).length, 1);
      const restarted = new LocalDurableStore(f.dir);
      if (storageAvailable) {
        assert.equal(
          (await restarted.withPrLock('1:2', async () => verified('released'))).value,
          'released',
        );
        assert.equal((await restarted.readCiClaim(id)).value.status, 'pending');
        await dispatch.dispatchAdmittedCi(c, f.port);
        assert.equal(sends(f).length, 1);
      } else {
        assert.equal((await f.port.readCiContinuation(id)).kind, 'uncertain');
        await assert.rejects(
          restarted.withPrLock('1:2', async () => verified('unexpected lock access')),
        );
      }
      assert.equal(result.kind, 'uncertain');
    });
  }
}
