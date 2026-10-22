import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { admitCandidate } from '../../tools/governance/admission.mjs';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
import { readinessWindowDigest } from '../../tools/governance/readiness-handshake.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest, operationKey } from '../../tools/governance/journal.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import {
  handleTrustedEvent as handleNativeEvent,
  handleTrustedWorkerCallback,
} from '../../tools/governance/controller-runtime.mjs';
import {
  encodeWorkerResult,
  verifyResultEnvelope,
  resultDecision,
  verifyArchive,
} from '../../tools/governance/worker-transport.mjs';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const c = {
  repositoryId: '1',
  pr: 2,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  attempt: '10',
  protocolVersion: 2,
  requestId: 'request-1',
  baseRef: 'refs/heads/develop',
};
const run = {
  id: '3',
  attempt: 1,
  repositoryId: '1',
  workflowId: '4',
  sha: 'c'.repeat(40),
  executionSha: 'e'.repeat(40),
  actorId: '5',
  event: 'pull_request_target',
  ref: 'refs/heads/main',
};
const signed = (a) => {
  const body = JSON.stringify({ version: a.candidate?.protocolVersion === 2 ? 2 : 1, ...a });
  return { body, signature: sign(null, Buffer.from(body), privateKey).toString('base64') };
};
const workerRun = { ...run, id: '6', workflowId: '8', event: 'workflow_dispatch' };
const timeline = [
  { id: 10, actor: { id: 5 }, event: 'ready_for_review', created_at: '2026-01-01T00:00:00Z' },
];
const snapshot = () => ({
  number: 2,
  node_id: 'PR_2',
  state: 'open',
  draft: false,
  base: { sha: c.base, ref: 'develop', repo: { id: 1 } },
  head: { sha: c.head, repo: { id: 1 } },
});
async function fixture(
  t,
  {
    events = timeline,
    pr = snapshot(),
    proof = true,
    modify = () => {},
    workerResult = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' },
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new LocalDurableStore(dir);
  const request = {
    protocolVersion: 2,
    requestId: c.requestId,
    repositoryId: c.repositoryId,
    pr: c.pr,
    prNodeId: 'PR_2',
    baseRef: c.baseRef,
    base: c.base,
    head: c.head,
    initiatingActorId: '9',
    originalRunId: '12',
    workflowId: run.workflowId,
    definitionSha: run.sha,
  };
  const dispatchRun = {
    ...run,
    id: '12',
    actorId: '9',
    event: 'workflow_dispatch',
    executionSha: run.sha,
  };
  store.authorizeReadinessRequest = async (q) =>
    authenticateReadinessRequest(JSON.stringify(q), {
      runId: '12',
      runAttempt: 1,
      authorizedActorIds: ['9'],
      approvedDefinition: Object.freeze({
        repositoryId: '1',
        workflowId: run.workflowId,
        sha: run.sha,
        ref: run.ref,
      }),
      lookupRun: async () => verified(dispatchRun),
      resolvePr: async () => verified({ repositoryId: '1', pr: 2, prNodeId: 'PR_2' }),
      verifyRequestEvidence: async (body) =>
        verified({
          bodyDigest: digest(body),
          originalRunId: '12',
          runAttempt: 1,
          definitionSha: run.sha,
          triggeringActorId: '9',
        }),
    });
  const originalAfter = {
    repositoryId: '1',
    pr: 2,
    prNodeId: 'PR_2',
    state: 'open',
    draft: false,
    baseRef: c.baseRef,
    base: c.base,
    head: c.head,
    events: timeline.map((e) => ({ id: String(e.id), kind: e.event, actorId: '5' })),
    complete: true,
    order: 'native',
    nativeDigest: digest(JSON.stringify({ p: snapshot(), events: timeline })),
  };
  originalAfter.evidenceDigest = readinessWindowDigest(originalAfter);
  const retainedProof = {
    version: 2,
    request,
    candidate: c,
    beforeDigest: '1'.repeat(64),
    afterDigest: originalAfter.evidenceDigest,
    mutationDigest: '3'.repeat(64),
    witnessId: c.attempt,
    originalRunId: '12',
    runAttempt: 1,
    definitionSha: run.sha,
  };
  const proofBody = JSON.stringify(retainedProof),
    proofDigest = digest(proofBody);
  await store.withPrLock('1:2', async () => {
    let o = {
      version: 2,
      request,
      state: 'intent',
      beforeDigest: null,
      mutationDigest: null,
      proofDigest: null,
      continuation: null,
    };
    assert.equal((await store.appendOperation(o)).kind, 'verified');
    for (const patch of [
      { state: 'mutation-pending' },
      { state: 'mutation-pending', beforeDigest: retainedProof.beforeDigest },
      { state: 'mutation-observed', mutationDigest: retainedProof.mutationDigest },
      { state: 'accepted', proofDigest },
    ]) {
      o = { ...o, ...patch };
      assert.equal((await store.appendOperation(o)).kind, 'verified');
    }
  });
  const claim = {
    id: 'claim-1',
    candidate: c,
    worker: 'ci',
    requestId: c.requestId,
    definitionSha: workerRun.sha,
    status: 'observed',
    run: workerRun,
    start:
      workerResult.outcome === 'failure'
        ? {
            claimId: 'claim-1',
            candidate: c,
            definitionSha: workerRun.sha,
            runId: workerRun.id,
            runAttempt: workerRun.attempt,
            state: 'consumed',
          }
        : null,
  };
  const comments = [];
  const calls = [];
  const records = new Map();
  const archive = async (purpose, input) => {
    if (!proof) return null;
    if (purpose === 'readiness-admission')
      return {
        body: proofBody,
        envelope: signed({ purpose: 'readiness-proof', run, bodyDigest: proofDigest }),
        after: originalAfter,
      };
    if (purpose === 'readiness-observation') return signed({ purpose, run, ...input.bindings });
    if (purpose === 'native-history')
      return signed({
        purpose,
        run,
        candidate: c,
        readyEventId: '10',
        historyStart: 'creation',
        timelineDigest: digest(JSON.stringify(events)),
        snapshotDigest: digest(JSON.stringify(pr)),
      });
    if (purpose === 'journal') return records.get(input.body);
    if (purpose === 'journal-index')
      return signed({
        purpose,
        run,
        ledgerId: '7',
        entriesDigest: digest(JSON.stringify(comments.map((e) => [e.id, digest(e.body)]))),
      });
  };
  const http = async (req) => {
    calls.push(req);
    let body;
    if (req.path.endsWith('/pulls/2')) body = pr;
    else if (req.path.endsWith('/issues/7')) body = { id: 7, user: { id: 5 } };
    else if (req.path.includes('/timeline?')) body = events;
    else if (req.path.includes('/comments?')) body = comments;
    else if (req.path.endsWith('/comments') && req.method === 'POST') {
      const b = JSON.parse(req.body).body;
      const row = JSON.parse(b);
      records.set(
        b,
        signed({ purpose: 'journal', run, candidate: row.candidate, bodyDigest: digest(b) }),
      );
      body = {
        id: comments.length + 1,
        body: b,
        user: { id: 5 },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      comments.push(body);
    } else if (req.path.includes('/actions/runs/')) {
      const r = req.path.includes('/runs/6/') ? workerRun : run;
      body = {
        id: Number(r.id),
        run_attempt: r.attempt,
        repository: { id: 1 },
        workflow_id: Number(r.workflowId),
        actor: { id: 5 },
        event: r.event,
        head_sha: r.executionSha,
      };
    } else if (req.path === '/graphql') {
      pr.draft = true;
      body = {
        data: { convertPullRequestToDraft: { pullRequest: { id: pr.node_id, isDraft: true } } },
      };
    } else throw Error('Unexpected request');
    const response = {
      status: req.method === 'POST' && req.path.endsWith('/comments') ? 201 : 200,
      headers: {},
      body: JSON.stringify(body),
    };
    modify(req, response);
    return response;
  };
  const port = createGithubPort({
    http,
    archive,
    publicKey,
    store,
    repository: 'o/r',
    repositoryId: '1',
    ledgerNumber: 7,
    ledgerId: '7',
    controllerRun: run,
    ciContinuation: {
      readCiContinuation: async () => verified(structuredClone(claim)),
      consumeCiStart: async () => {
        if (claim.start) return verified({ newlyConsumed: false, claim });
        claim.start = {
          claimId: claim.id,
          runId: workerRun.id,
          runAttempt: workerRun.attempt,
          candidate: c,
          definitionSha: workerRun.sha,
          state: 'consumed',
        };
        return verified({ newlyConsumed: true, claim: structuredClone(claim) });
      },
    },
    workers: { ci: workerRun },
    workerResults: async () => {
      const body = encodeWorkerResult({ ...workerResult, claimId: claim.id });
      return {
        body,
        envelope: signed({
          purpose: 'worker-result',
          run: workerRun,
          candidate: c,
          worker: 'ci',
          bodyDigest: digest(body),
        }),
      };
    },
  });
  port.fixtureProofDigest = proofDigest;
  return {
    port,
    store,
    calls,
    comments,
    dir,
  };
}
// Positive runtime regressions begin with a separately authenticated retained v2
// operation. Metadata alone is tested through handleNativeEvent below.
async function admitRetainedFixture(input, context) {
  const native = await handleNativeEvent(input, context);
  if (
    verifyArchive(
      input.archive,
      { purpose: 'controller-event', run: context?.expectedRun, bodyDigest: digest(input.body) },
      publicKey,
    ).kind !== 'verified'
  )
    return native;
  if (
    context?.mode !== 'offline-test' ||
    !input.archive ||
    JSON.parse(input.archive.body).bodyDigest !== digest(input.body)
  )
    return native;
  const raw = JSON.parse(input.body),
    envelope = JSON.parse(input.archive.body);
  if (
    raw.action !== 'ready_for_review' ||
    JSON.stringify(envelope.run) !== JSON.stringify(context.expectedRun)
  )
    return native;
  return admitCandidate(context.port, {
    type: 'verified_readiness',
    repositoryId: '1',
    pr: 2,
    readinessId: c.attempt,
    candidate: c,
    proofDigest: context.port.fixtureProofDigest,
  });
}
test('concrete bridge admits exact Ready through existing policy and journal readback', async (t) => {
  const { port, comments } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2, head: { sha: c.head } },
    workerVerified: true,
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const result = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(result.kind, 'verified');
  assert.equal(comments.length, 2);
});
test('production default denies without invoking injected HTTP', async () => {
  const r = await admitRetainedFixture(
    { body: '{}' },
    {
      port: {
        observe() {
          throw Error('called');
        },
      },
    },
  );
  assert.equal(r.kind, 'blocked');
});
test('event exact body and definition substitution denied before any observation', async (t) => {
  const { port, calls } = await fixture(t);
  const body = '{}';
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  for (const input of [
    { body: body + ' ', archive },
    {
      body,
      archive: signed({
        purpose: 'controller-event',
        run: { ...run, sha: 'd'.repeat(40) },
        bodyDigest: digest(body),
      }),
    },
  ])
    assert.equal(
      (
        await admitRetainedFixture(input, {
          port,
          expectedRun: run,
          publicKey,
          mode: 'offline-test',
        })
      ).kind,
      'blocked',
    );
  assert.equal(calls.length, 0);
});
test('native proof missing denies rather than trusting snapshot or booleans', async (t) => {
  const { port } = await fixture(t, { proof: false });
  await assert.rejects(() => port.observe(c));
});
test('history validates Ready origin and closure survives reopen', async (t) => {
  const events = [
    ...timeline,
    { id: 11, event: 'closed', actor: { id: 5 }, created_at: '2026-01-02T00:00:00Z' },
    { id: 12, event: 'reopened', actor: { id: 5 }, created_at: '2026-01-03T00:00:00Z' },
  ];
  const { port, store } = await fixture(t, { events });
  const o = await port.observe(c);
  assert.equal(o.lifecycle.closedSinceReady, true);
  assert.equal((await store.pending('1:2')).length, 1);
});
test('origin cannot be replaced with current candidate after head drift', async (t) => {
  const pr = snapshot();
  pr.head.sha = 'd'.repeat(40);
  const { port } = await fixture(t, { pr });
  const o = await port.observe(c);
  assert.equal(o.readiness.candidate.head, c.head);
  assert.equal(o.head, pr.head.sha);
});
test('malformed native schema and incomplete pagination deny', async (t) => {
  for (const modify of [
    (_q, r) => {
      r.body = '{}';
    },
    (q, r) => {
      if (q.path.includes('timeline')) r.headers.link = '<https://evil.invalid/page>; rel="next"';
    },
  ]) {
    const { port } = await fixture(t, { modify });
    await assert.rejects(() => port.observe(c));
  }
});
test('pagination follows only bounded exact next URL, includes all lifecycle pages', async (t) => {
  const { port, calls } = await fixture(t, {
    modify: (q, r) => {
      if (q.path.endsWith('timeline?per_page=100&page=1'))
        r.headers.link =
          '<https://api.github.com/repos/o/r/issues/2/timeline?per_page=100&page=2>; rel="next"';
      if (q.path.endsWith('timeline?per_page=100&page=2')) r.body = '[]';
    },
  });
  await port.observe(c);
  assert.ok(calls.some((q) => q.path.endsWith('page=2')));
});
test('durable pending survives process restart and blocks later admission', async (t) => {
  const { store, dir, port } = await fixture(t);
  await store.withPrLock('1:2', () =>
    store.append('1:2', { type: 'pending', id: 'uncertain', candidate: c }),
  );
  assert.equal((await new LocalDurableStore(dir).pending('1:2')).length, 1);
  await assert.rejects(() => port.withPrLock('1:2', async () => assert.fail('must not execute')));
});
test('fsync crash uncertainty persists and partial writes deny without repair', async (t) => {
  const { dir } = await fixture(t);
  const store = new LocalDurableStore(dir, {
    fault: () => {
      throw Error('crash');
    },
  });
  await assert.rejects(() =>
    store.withPrLock('x', () => store.append('x', { type: 'pending', id: 'p' })),
  );
  assert.equal((await new LocalDurableStore(dir).pending('x')).length, 1);
  await appendFile(join(dir, `${digest('x')}.jsonl`), '{');
  await assert.rejects(() => store.read('x'));
});
test('separate process cannot enter held local lock; no timeout reclaim', async (t) => {
  const { dir, store } = await fixture(t);
  await store.withPrLock('x', async () => {
    const url = new URL('../../tools/governance/local-durable-store.mjs', import.meta.url).href;
    const code = `import {LocalDurableStore} from ${JSON.stringify(url)};try {await new LocalDurableStore(${JSON.stringify(dir)}).withPrLock('x',()=>{});process.exitCode=9;}catch(e){process.exitCode=e.code==='EEXIST'?0:8;}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
    assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
  });
  assert.deepEqual(await store.read('x'), []);
});
test('result protocol composes existing Task7 policy and rejects changed bytes/run', () => {
  const result = { candidate: c, worker: 'ci', outcome: 'failure', claimId: 'claim-1' };
  const body = encodeWorkerResult(result);
  const envelope = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(body),
  });
  const observed = {
    candidate: c,
    nativeVerified: true,
    lifecycleVerified: true,
    ready: true,
    admitted: true,
    invalidated: false,
    sameRepository: true,
    expectedWorker: 'ci',
    expectedClaimId: 'claim-1',
    expectedRun: workerRun,
  };
  assert.equal(resultDecision(c, workerRun, result, observed, envelope, publicKey).action, 'draft');
  assert.equal(
    verifyResultEnvelope(body + ' ', envelope, workerRun, c, 'ci', publicKey, 'claim-1').kind,
    'blocked',
  );
  assert.equal(
    verifyResultEnvelope(
      body,
      envelope,
      { ...workerRun, attempt: 2 },
      c,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
});
test('unknown append outcome keeps durable obligation across restart', async (t) => {
  const { port, store } = await fixture(t, {
    modify: (q, r) => {
      if (q.method === 'POST') r.status = 503;
    },
  });
  const row = {
    version: 2,
    candidate: c,
    action: 'invalidate',
    phase: 'intent',
    key: operationKey(c, 'invalidate'),
  };
  await assert.rejects(() => port.withPrLock('1:2', () => port.append(row)));
  assert.equal((await store.pending('1:2')).length, 1);
});
test('forged worker run metadata and journal body edits deny', async (t) => {
  for (const modify of [
    (q, r) => {
      if (q.path.includes('/actions/runs/')) {
        const v = JSON.parse(r.body);
        v.actor.id = 99;
        r.body = JSON.stringify(v);
      }
    },
    (q, r) => {
      if (q.path.includes('/comments?')) {
        const v = JSON.parse(r.body);
        if (v.length) v[0].body += ' ';
        r.body = JSON.stringify(v);
      }
    },
  ]) {
    const { port } = await fixture(t, { modify });
    const body = JSON.stringify({
      repository: { id: 1 },
      action: 'ready_for_review',
      pull_request: { number: 2 },
    });
    const archive = signed({
      purpose: 'controller-event',
      run,
      readinessId: '10',
      bodyDigest: digest(body),
    });
    assert.notEqual(
      (
        await admitRetainedFixture(
          { body, archive },
          { port, expectedRun: run, publicKey, mode: 'offline-test' },
        )
      ).kind,
      'verified',
    );
  }
});
test('killed holder retains lock and fsynced pending; recovery never grants eligibility', async (t) => {
  const { dir } = await fixture(t);
  const url = new URL('../../tools/governance/local-durable-store.mjs', import.meta.url).href;
  const code = `import {LocalDurableStore} from ${JSON.stringify(url)};const s=new LocalDurableStore(${JSON.stringify(dir)});await s.withPrLock('crashed',async()=>{await s.append('crashed',{type:'pending',id:'persisted'});process.kill(process.pid,'SIGKILL');});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
  assert.equal(
    await new Promise((resolve) => child.on('exit', (_code, signal) => resolve(signal))),
    'SIGKILL',
  );
  const recovered = new LocalDurableStore(dir);
  assert.equal((await recovered.pending('crashed')).length, 1);
  await assert.rejects(
    () => recovered.withPrLock('crashed', () => assert.fail('must not reclaim')),
    { code: 'EEXIST' },
  );
});
test('trusted worker start/completion use same admitted Task6 gate and Task7 policy', async (t) => {
  const { port } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  for (const type of ['worker_start', 'worker_completed']) {
    const b = JSON.stringify({
      type,
      claimId: 'claim-1',
      candidate: c,
      worker: 'ci',
      outcome: 'success',
      workerVerified: true,
    });
    const a = signed({
      purpose: 'worker-callback',
      run: workerRun,
      candidate: c,
      worker: 'ci',
      bodyDigest: digest(b),
    });
    assert.equal(
      (
        await handleTrustedWorkerCallback(
          { body: b, archive: a },
          { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
        )
      ).kind,
      'verified',
    );
  }
});
test('outage before append retains local lock even when no pending row exists', async (t) => {
  const { dir, store } = await fixture(t);
  await assert.rejects(() =>
    store.withPrLock('outage', async () => {
      throw Error('storage unavailable before append');
    }),
  );
  assert.deepEqual(await store.pending('outage'), []);
  await assert.rejects(
    () => new LocalDurableStore(dir).withPrLock('outage', () => assert.fail('must deny')),
    { code: 'EEXIST' },
  );
});
test('current authenticated worker failure returns exact admitted candidate to Draft', async (t) => {
  const pr = snapshot();
  const { port } = await fixture(t, {
    pr,
    workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
  });
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  const b = JSON.stringify({
    claimId: 'claim-1',
    type: 'worker_completed',
    candidate: c,
    worker: 'ci',
    outcome: 'failure',
  });
  const a = signed({
    purpose: 'worker-callback',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(b),
  });
  assert.equal(
    (
      await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'blocked',
  );
  assert.equal(pr.draft, true);
});
test('archive rejects candidate-body, event and run-attempt substitutions', () => {
  const result = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' };
  const body = encodeWorkerResult(result);
  const envelope = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(body),
  });
  for (const altered of [
    { ...workerRun, event: 'pull_request_target' },
    { ...workerRun, sha: 'f'.repeat(40) },
    { ...workerRun, attempt: 3 },
  ])
    assert.equal(
      verifyResultEnvelope(body, envelope, altered, c, 'ci', publicKey, 'claim-1').kind,
      'blocked',
    );
  const changed = { ...result, candidate: { ...c, attempt: '11' } };
  assert.equal(
    verifyResultEnvelope(
      encodeWorkerResult(changed),
      envelope,
      workerRun,
      changed.candidate,
      'ci',
      publicKey,
      'claim-1',
    ).kind,
    'blocked',
  );
});

test('runtime returned uncertainty before WAL retains lock and blocks fresh holder/replay', async (t) => {
  const { port, store, dir, comments } = await fixture(t);
  const originalAppend = store.append.bind(store);
  store.append = async () => {
    throw Error('pre-WAL storage outage');
  };
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const first = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(first.kind, 'uncertain');
  assert.deepEqual(await store.pending('1:2'), []);
  assert.equal(comments.length, 0);
  const fresh = new LocalDurableStore(dir);
  await assert.rejects(
    () => fresh.withPrLock('1:2', () => assert.fail('uncertainty must retain lock')),
    { code: 'EEXIST' },
  );
  store.append = originalAppend;
  const replay = await admitRetainedFixture(
    { body, archive },
    { port, expectedRun: run, publicKey, mode: 'offline-test' },
  );
  assert.equal(replay.kind, 'blocked');
  assert.equal(comments.length, 0);
});

test('runtime Draft refuses already observed final-read candidate or PR identity drift', async (t) => {
  const cases = {
    head: (p) => {
      p.head.sha = 'd'.repeat(40);
    },
    base: (p) => {
      p.base.sha = 'd'.repeat(40);
    },
    state: (p) => {
      p.state = 'closed';
    },
    draft: (p) => {
      p.draft = true;
    },
    wrongNumber: (p) => {
      p.number = 999;
      p.node_id = 'PR_OTHER';
    },
    wrongNode: (p) => {
      p.node_id = 'PR_OTHER';
    },
    wrongBaseRepository: (p) => {
      p.base.repo.id = 999;
    },
    wrongHeadRepository: (p) => {
      p.head.repo.id = 999;
    },
    malformed: (p) => {
      delete p.number;
    },
  };
  for (const [name, change] of Object.entries(cases))
    await t.test(name, async (t) => {
      const pr = snapshot();
      let draftIntent = false;
      let readsAfterIntent = 0;
      const { port, calls } = await fixture(t, {
        pr,
        workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
        modify(q, r) {
          if (q.method === 'POST' && q.path.endsWith('/comments')) {
            const row = JSON.parse(JSON.parse(q.body).body);
            if (row.action === 'draft' && row.phase === 'intent') draftIntent = true;
          }
          if (q.path.endsWith('/pulls/2') && draftIntent && ++readsAfterIntent === 2) {
            change(pr);
            r.body = JSON.stringify(pr);
          }
        },
      });
      const body = JSON.stringify({
        repository: { id: 1 },
        action: 'ready_for_review',
        pull_request: { number: 2 },
      });
      const archive = signed({
        purpose: 'controller-event',
        run,
        readinessId: '10',
        bodyDigest: digest(body),
      });
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'verified',
      );
      const b = JSON.stringify({
        claimId: 'claim-1',
        type: 'worker_completed',
        candidate: c,
        worker: 'ci',
        outcome: 'failure',
      });
      const a = signed({
        purpose: 'worker-callback',
        run: workerRun,
        candidate: c,
        worker: 'ci',
        bodyDigest: digest(b),
      });
      const completion = await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      );
      assert.notEqual(completion.kind, 'verified');
      assert.equal(readsAfterIntent >= 2, true);
      assert.equal(
        calls.filter((q) => q.path === '/graphql').length,
        0,
        'must not mutate already observed unrelated or changed PR',
      );
    });
});

test('runtime Draft refuses new native attempt or closure visible at final read', async (t) => {
  for (const event of ['ready_for_review', 'closed'])
    await t.test(event, async (t) => {
      const events = structuredClone(timeline);
      let draftIntent = false;
      let readsAfterIntent = 0;
      const { port, calls } = await fixture(t, {
        events,
        workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
        modify(q) {
          if (q.method === 'POST' && q.path.endsWith('/comments')) {
            const row = JSON.parse(JSON.parse(q.body).body);
            if (row.action === 'draft' && row.phase === 'intent') draftIntent = true;
          }
          if (q.path.endsWith('/pulls/2') && draftIntent && ++readsAfterIntent === 2)
            events.push({ id: 13, actor: { id: 5 }, event, created_at: '2026-01-02T00:00:00Z' });
        },
      });
      const body = JSON.stringify({
        repository: { id: 1 },
        action: 'ready_for_review',
        pull_request: { number: 2 },
      });
      const archive = signed({
        purpose: 'controller-event',
        run,
        readinessId: '10',
        bodyDigest: digest(body),
      });
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'verified',
      );
      const b = JSON.stringify({
        claimId: 'claim-1',
        type: 'worker_completed',
        candidate: c,
        worker: 'ci',
        outcome: 'failure',
      });
      const a = signed({
        purpose: 'worker-callback',
        run: workerRun,
        candidate: c,
        worker: 'ci',
        bodyDigest: digest(b),
      });
      const completion = await handleTrustedWorkerCallback(
        { body: b, archive: a },
        { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
      );
      assert.notEqual(completion.kind, 'verified');
      assert.equal(readsAfterIntent >= 2, true);
      assert.equal(calls.filter((q) => q.path === '/graphql').length, 0);
    });
});

test('public runtime and result verifier bound malformed signature before base64 decoding', async (t) => {
  const { port, calls } = await fixture(t);
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  const result = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' };
  const resultBody = encodeWorkerResult(result);
  const resultArchive = signed({
    purpose: 'worker-result',
    run: workerRun,
    candidate: c,
    worker: 'ci',
    bodyDigest: digest(resultBody),
  });
  const invalid = [
    'A'.repeat(2_000_000),
    '!'.repeat(88),
    'A'.repeat(85) + 'B==',
    'A'.repeat(87),
    Buffer.alloc(64),
    null,
  ];
  const original = Buffer.from;
  let base64Decodes = 0;
  Buffer.from = function (value, encoding, ...args) {
    if (encoding === 'base64') base64Decodes++;
    return original(value, encoding, ...args);
  };
  try {
    for (const signature of invalid) {
      assert.equal(
        (
          await admitRetainedFixture(
            { body, archive: { ...archive, signature } },
            { port, expectedRun: run, publicKey, mode: 'offline-test' },
          )
        ).kind,
        'blocked',
      );
      assert.equal(
        verifyResultEnvelope(
          resultBody,
          { ...resultArchive, signature },
          workerRun,
          c,
          'ci',
          publicKey,
        ).kind,
        'blocked',
      );
    }
  } finally {
    Buffer.from = original;
  }
  assert.equal(base64Decodes, 0);
  assert.equal(calls.length, 0);
});

test('runtime failed-worker uncertainty before WAL survives restart and denies later start', async (t) => {
  const { port, store, dir, comments } = await fixture(t, {
    workerResult: { candidate: c, worker: 'ci', outcome: 'failure' },
  });
  const body = JSON.stringify({
    repository: { id: 1 },
    action: 'ready_for_review',
    pull_request: { number: 2 },
  });
  const archive = signed({
    purpose: 'controller-event',
    run,
    readinessId: '10',
    bodyDigest: digest(body),
  });
  assert.equal(
    (
      await admitRetainedFixture(
        { body, archive },
        { port, expectedRun: run, publicKey, mode: 'offline-test' },
      )
    ).kind,
    'verified',
  );
  const call = async (type, outcome) => {
    const b = JSON.stringify({ type, claimId: 'claim-1', candidate: c, worker: 'ci', outcome });
    const a = signed({
      purpose: 'worker-callback',
      run: workerRun,
      candidate: c,
      worker: 'ci',
      bodyDigest: digest(b),
    });
    return handleTrustedWorkerCallback(
      { body: b, archive: a },
      { port, expectedRun: workerRun, publicKey, mode: 'offline-test' },
    );
  };
  const original = store.append.bind(store);
  store.append = async () => {
    throw Error('pre-WAL failure');
  };
  assert.equal((await call('worker_completed', 'failure')).kind, 'uncertain');
  assert.deepEqual(await store.pending('1:2'), []);
  assert.equal(comments.length, 2);
  store.append = original;
  assert.equal((await call('worker_start', 'success')).kind, 'blocked');
  await assert.rejects(
    () =>
      new LocalDurableStore(dir).withPrLock('1:2', () =>
        assert.fail('failed candidate must stay blocked'),
      ),
    { code: 'EEXIST' },
  );
  assert.equal(comments.length, 2);
});
