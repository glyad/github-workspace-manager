import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticateReadinessRequest } from '../../tools/governance/readiness-request.mjs';
import { readinessWindowDigest } from '../../tools/governance/readiness-handshake.mjs';
import { verified } from '../../tools/governance/contracts.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { createGithubPort } from '../../tools/governance/github-port.mjs';
import { ciClaimId } from '../../tools/governance/worker-dispatch.mjs';
import { encodeWorkerResult } from '../../tools/governance/worker-transport.mjs';

// Shared synthetic issuer/HTTP setup; all concrete continuation behavior uses
// the actual local store and GitHub port. Historical runtime fixtures explicitly
// select the D provider seam; E fixtures explicitly select concreteContinuation.
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
const snapshot = (candidate = c) => ({
  number: candidate.pr,
  node_id: `PR_${candidate.pr}`,
  state: 'open',
  draft: false,
  base: { sha: candidate.base, ref: 'develop', repo: { id: 1 } },
  head: { sha: candidate.head, repo: { id: 1 } },
});
export async function fixture(
  t,
  {
    candidate = c,
    workerExecution = workerRun,
    freshReadiness = false,
    seedAdmission = !freshReadiness,
    events = freshReadiness
      ? [
          {
            id: 9,
            actor: { id: 9 },
            event: 'converted_to_draft',
            created_at: '2026-01-01T00:00:00Z',
          },
        ]
      : timeline,
    pr = { ...snapshot(candidate), draft: freshReadiness },
    proof = true,
    modify = () => {},
    concreteContinuation = false,
    loseResponse = false,
    discovery = 'exact',
    storeRoot,
    restoredComments = [],
    boundary,
    archiveBoundary,
    workerResult = { candidate: c, worker: 'ci', outcome: 'success', claimId: 'claim-1' },
  } = {},
) {
  const c = candidate;
  const dir = storeRoot ?? (await mkdtemp(join(tmpdir(), 'dispatch-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new LocalDurableStore(dir);
  const request = {
    protocolVersion: 2,
    requestId: c.requestId,
    repositoryId: c.repositoryId,
    pr: c.pr,
    prNodeId: pr.node_id,
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
  const requestContext = {
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
    resolvePr: async () => verified({ repositoryId: '1', pr: c.pr, prNodeId: pr.node_id }),
    verifyRequestEvidence: async (body) =>
      verified({
        bodyDigest: digest(body),
        originalRunId: '12',
        runAttempt: 1,
        definitionSha: run.sha,
        triggeringActorId: '9',
      }),
  };
  const retainedRequestContext = { ...requestContext };
  store.authorizeReadinessRequest = async (q) =>
    authenticateReadinessRequest(JSON.stringify(q), retainedRequestContext);
  const originalAfter = {
    repositoryId: '1',
    pr: c.pr,
    prNodeId: pr.node_id,
    state: 'open',
    draft: false,
    baseRef: c.baseRef,
    base: c.base,
    head: c.head,
    events: timeline.map((e) => ({ id: String(e.id), kind: e.event, actorId: '5' })),
    complete: true,
    order: 'native',
    nativeDigest: digest(JSON.stringify({ p: snapshot(c), events: timeline })),
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
  if (seedAdmission && (await store.readOperation(c.requestId)).value === null)
    await store.withPrLock(`1:${c.pr}`, async () => {
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
    id: concreteContinuation ? ciClaimId(c) : 'claim-1',
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
  const comments = restoredComments;
  const calls = [];
  const records = new Map(
    restoredComments.map((row) => [
      row.body,
      signed({
        purpose: 'journal',
        run,
        candidate: JSON.parse(row.body).candidate,
        bodyDigest: digest(row.body),
      }),
    ]),
  );
  const phases = new Map(),
    proofs = new Map(),
    admittedWindows = new Map(),
    dispatches = [];
  const archive = async (purpose, input) => {
    if (!proof) return null;
    if (purpose === 'ci-dispatch-discovery' && concreteContinuation) {
      if ((await archiveBoundary?.(purpose, input, { store, dir, calls })) === false) return null;
      if (discovery === 'unavailable') return null;
      const data = {
        dispatchDigest: input.bodyDigest,
        claimId: input.claim.id,
        requestId: c.requestId,
        candidate: freshReadiness ? JSON.parse(dispatches[0].inputs.candidate) : c,
        definitionSha: workerRun.sha,
        runs: discovery === 'ambiguous' ? [workerRun, { ...workerRun, id: '99' }] : [workerRun],
      };
      if (discovery === 'mutate-issuer-input') {
        input.claim.candidate = { ...c, head: 'f'.repeat(40) };
        data.candidate = input.claim.candidate;
      }
      if (discovery === 'wrong-claim') data.claimId = 'another';
      if (discovery === 'wrong-request') data.requestId = 'another';
      if (discovery === 'wrong-candidate') data.candidate = { ...c, head: 'f'.repeat(40) };
      if (discovery === 'wrong-definition') data.definitionSha = 'f'.repeat(40);
      if (discovery === 'rerun') data.runs = [{ ...workerRun, attempt: 2 }];
      if (discovery === 'wrong-actor') data.runs = [{ ...workerRun, actorId: '99' }];
      if (discovery === 'unsigned') return { body: JSON.stringify(data), envelope: null };
      const body = JSON.stringify(data);
      return {
        body,
        envelope: signed({ purpose, run, bodyDigest: digest(body), candidate: data.candidate }),
      };
    }
    if (freshReadiness && purpose === 'readiness-phase') {
      const envelope = signed({ purpose, run, ...input.bindings });
      phases.set(input.body, envelope);
      if (input.evidence?.proof)
        admittedWindows.set(
          digest(JSON.stringify(input.evidence.proof)),
          structuredClone(input.evidence.after),
        );
      return envelope;
    }
    if (freshReadiness && purpose === 'readiness-phase-read')
      return { body: input.body, envelope: phases.get(input.body) };
    if (freshReadiness && purpose === 'readiness-proof-write') {
      proofs.set(
        input.body,
        signed({ purpose: 'readiness-proof', run, bodyDigest: digest(input.body) }),
      );
      return proofs.get(input.body);
    }
    if (freshReadiness && purpose === 'readiness-proof-read')
      return { body: input.body, envelope: proofs.get(input.body) };
    if (freshReadiness && purpose === 'readiness-admission') {
      const entry = [...proofs].find(([body]) => digest(body) === input.proofDigest);
      return entry
        ? { body: entry[0], envelope: entry[1], after: admittedWindows.get(input.proofDigest) }
        : null;
    }
    if (freshReadiness && purpose === 'readiness-window')
      return signed({ purpose, run, ...input.bindings });
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
    if (req.path.endsWith('/dispatches') && concreteContinuation) {
      await boundary?.('before-send', { store, dir, calls });
      const persisted = await store.readCiClaim(JSON.parse(req.body).inputs.claim_id);
      assert.equal(persisted.kind, 'verified');
      assert.equal(persisted.value.status, 'pending');
      dispatches.push(JSON.parse(req.body));
      await boundary?.('after-send', { store, dir, calls });
      if (loseResponse) throw Error('response lost after accepted send');
      return { status: 204, headers: {}, body: '' };
    }
    if (req.path.endsWith(`/pulls/${c.pr}`)) body = pr;
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
      const r = req.path.includes('/runs/6/') ? workerExecution : run;
      body = {
        id: Number(r.id),
        run_attempt: r.attempt,
        repository: { id: 1 },
        workflow_id: Number(r.workflowId),
        actor: { id: 5 },
        event: r.event,
        head_sha: r.executionSha,
      };
    } else if (
      req.path === '/graphql' &&
      JSON.parse(req.body).query.includes('markPullRequestReadyForReview')
    ) {
      const op = (await store.readOperation(c.requestId)).value;
      assert.equal(op.state, 'mutation-pending');
      assert.match(op.beforeDigest, /^[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(req.body).variables, {
        id: 'PR_2',
        clientMutationId: c.requestId,
      });
      pr.draft = false;
      events.push({
        id: 10,
        actor: { id: 5 },
        event: 'ready_for_review',
        created_at: '2026-01-01T00:00:00Z',
      });
      body = {
        data: {
          markPullRequestReadyForReview: {
            clientMutationId: c.requestId,
            pullRequest: { id: 'PR_2', isDraft: false },
          },
        },
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
  const portConfig = {
    http,
    archive,
    publicKey,
    store,
    repository: 'o/r',
    repositoryId: '1',
    ledgerNumber: 7,
    ledgerId: '7',
    controllerRun: { ...run },
    ciContinuation: concreteContinuation
      ? { approvedDefinition: workerRun }
      : {
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
      const candidate = freshReadiness ? JSON.parse(dispatches[0].inputs.candidate) : c;
      const body = encodeWorkerResult({ ...workerResult, candidate, claimId: claim.id });
      return {
        body,
        envelope: signed({
          purpose: 'worker-result',
          run: workerRun,
          candidate,
          worker: 'ci',
          bodyDigest: digest(body),
        }),
      };
    },
  };
  const port = createGithubPort(portConfig);
  port.fixtureProofDigest = proofDigest;
  return {
    port,
    portConfig,
    requestContext,
    request,
    store,
    calls,
    comments,
    events,
    dir,
    pr,
    claim,
    proofDigest,
  };
}

export { publicKey, signed, c, run, workerRun, timeline, snapshot };
