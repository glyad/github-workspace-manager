import { sameExecution } from './worker-results.mjs';
import { randomUUID } from 'node:crypto';
import { digest, parseJournal, sameCandidate, validCandidate } from './journal.mjs';
import {
  boundedJson,
  verifyArchive,
  readWorkerResult,
  resultDecision,
} from './worker-transport.mjs';
import { verified, blocked, validReadinessRequest } from './contracts.mjs';
import { readinessWindowDigest, readinessWindowBindings } from './readiness-handshake.mjs';
import { readinessRequestBinding } from './readiness-request.mjs';
import { validReadinessOperation } from './readiness-operation.mjs';
import { candidateOf } from './controller.mjs';
const keyOf = (c) => `${c.repositoryId}:${c.pr}`;
const numeric = (n) => Number.isSafeInteger(n) && n > 0;
const id = (n) => (numeric(n) ? String(n) : null);
/** HTTP has no default implementation. Credentials and network are externally
 * injected; this module never fetches, inspects environment, or retries mutations.
 * archive is a protocol evidence resolver, NOT a currently supported GitHub API.
 */
export function createGithubPort({
  http,
  archive,
  publicKey,
  store,
  repository,
  repositoryId,
  ledgerNumber,
  ledgerId,
  controllerRun,
  workerResults,
  workers = {},
  ciContinuation,
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !numeric(ledgerNumber) ||
    typeof repositoryId !== 'string' ||
    !http ||
    !archive ||
    !store
  )
    throw Error('Unselected transport configuration');
  const root = `/repos/${repository}`;
  const active = new Set();
  const prNodes = new Map();
  const readinessActive = new Set(),
    readinessSent = new Set();
  async function request(method, path, body, status = 200) {
    const response = await http({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' },
    });
    if (response?.status !== status || !response.headers || typeof response.body !== 'string')
      throw Error('HTTP status or incomplete response');
    return { value: boundedJson(response.body, 2_000_000), headers: response.headers };
  }
  async function pages(path) {
    const rows = [];
    let bytes = 0;
    for (let page = 1; page <= 10; page++) {
      const exact = `${path}?per_page=100&page=${page}`;
      const { value, headers } = await request('GET', exact);
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        (bytes += Buffer.byteLength(JSON.stringify(value))) > 2_000_000
      )
        throw Error('Incomplete/oversized page');
      rows.push(...value);
      const link = headers.link;
      if (link === undefined || link === '') return rows;
      if (typeof link !== 'string') throw Error('Malformed pagination');
      const links = link.split(',').map((s) => s.trim());
      let next = null;
      for (const part of links) {
        const m = /^<([^>]+)>; rel="(next|prev|first|last)"$/.exec(part);
        if (!m) throw Error('Unknown pagination');
        if (m[2] === 'next') {
          if (next) throw Error('Duplicate next');
          next = m[1];
        }
      }
      if (!next) return rows;
      if (next !== `https://api.github.com${path}?per_page=100&page=${page + 1}`)
        throw Error('Untrusted or skipped pagination');
    }
    throw Error('Pagination limit; completeness unavailable');
  }
  async function proof(purpose, input, expected) {
    const result = verifyArchive(
      await archive(purpose, input),
      { purpose, ...expected },
      publicKey,
    );
    if (result.kind !== 'verified') throw Error('Archive evidence unavailable or mismatched');
    return result.value;
  }
  async function lookupRun(run) {
    if (
      !run ||
      !/^\d+$/.test(run.id) ||
      !numeric(run.attempt) ||
      run.repositoryId !== repositoryId ||
      !/^[a-f0-9]{40}$/.test(run.sha) ||
      !/^[a-f0-9]{40}$/.test(run.executionSha)
    )
      throw Error('Unselected definition/execution identity');
    const { value: r } = await request(
      'GET',
      `${root}/actions/runs/${run.id}/attempts/${run.attempt}`,
    );
    if (
      id(r.id) !== run.id ||
      r.run_attempt !== run.attempt ||
      id(r.repository?.id) !== repositoryId ||
      id(r.workflow_id) !== run.workflowId ||
      id(r.actor?.id) !== run.actorId ||
      r.event !== run.event ||
      r.head_sha !== run.executionSha
    )
      throw Error('Run identity mismatch');
    // head_sha is execution identity, NEVER asserted to prove workflow definition revision.
    return run;
  }
  async function safety(c, reason) {
    const key = keyOf(c),
      obligation = `safety:${c.attempt}:${reason}`;
    const persist = async () => {
      if (!(await store.pending(key)).some((p) => p.id === obligation))
        await store.append(key, { type: 'pending', id: obligation, candidate: c, reason });
    };
    if (active.has(key)) await persist();
    else await store.withPrLock(key, persist);
  }
  // The trusted operation facade shares the existing PR lock; it never takes
  // the old admission wrapper recursively. B authenticates real Task A receipts.
  const readinessStore = {};
  for (const method of [
    'authorizeReadinessRequest',
    'readOperation',
    'appendOperation',
    'readObligations',
    'registerOperationOwner',
    'finishOperationOwner',
    'withOperationReconciliationLock',
  ])
    if (typeof store[method] === 'function') readinessStore[method] = store[method].bind(store);
  readinessStore.withPrLock = (key, fn) =>
    store.withPrLock(key, async () => {
      if ((await store.pending(key)).length) return blocked('Pending durable obligations');
      active.add(key);
      readinessActive.add(key);
      readinessSent.delete(key);
      try {
        return await fn();
      } finally {
        active.delete(key);
        readinessActive.delete(key);
        readinessSent.delete(key);
      }
    });
  readinessStore.authenticateOperationEvidence = async (evidence, operation, phase) => {
    try {
      const beforeDigest = evidence.before?.evidenceDigest;
      const body = JSON.stringify(evidence);
      boundedJson(body, 4_500_000);
      const bindings = {
        retained: true,
        requestId: operation.request.requestId,
        operationDigest: digest(JSON.stringify(operation)),
        phase,
        evidenceDigest: digest(body),
        beforeDigest,
      };
      if (phase !== 'mutation-pending')
        bindings.mutationDigest = digest(JSON.stringify(evidence.mutation));
      if (phase === 'accepted') bindings.proofDigest = digest(JSON.stringify(evidence.proof));
      const authenticated = await proof(
        'readiness-phase',
        { operation, evidence, body, bindings },
        { run: controllerRun, ...bindings },
      );
      const retrieved = await archive('readiness-phase-read', { body, bindings });
      if (retrieved?.body !== body) return blocked('Full phase evidence readback unavailable');
      const read = verifyArchive(
        retrieved.envelope,
        { purpose: 'readiness-phase', run: controllerRun, ...bindings },
        publicKey,
      );
      return read.kind === 'verified' ? verified(authenticated) : read;
    } catch {
      return blocked('Operation evidence authentication unavailable');
    }
  };
  function validStart(claim) {
    const start = claim?.start;
    return (
      start?.state === 'consumed' &&
      start.claimId === claim.id &&
      start.runId === claim.run?.id &&
      start.runAttempt === claim.run?.attempt &&
      sameCandidate(start.candidate, claim.candidate) &&
      start.definitionSha === claim.definitionSha
    );
  }
  const port = {
    readinessStore,
    async observeReadinessWindow(input) {
      try {
        if (!validReadinessRequest(input) || input.repositoryId !== repositoryId)
          return blocked('Unrelated readiness observation');
        const read = async () => {
          const { value: p } = await request('GET', `${root}/pulls/${input.pr}`);
          const events = await pages(`${root}/issues/${input.pr}/timeline`);
          return { p, events };
        };
        const first = await read(),
          second = await read();
        if (JSON.stringify(first) !== JSON.stringify(second))
          throw Error('Unstable native pages/snapshot');
        const { p, events } = second;
        if (
          p.number !== input.pr ||
          p.node_id !== input.prNodeId ||
          id(p.base?.repo?.id) !== repositoryId ||
          id(p.head?.repo?.id) !== repositoryId ||
          !['open', 'closed'].includes(p.state) ||
          typeof p.draft !== 'boolean' ||
          !/^[a-f0-9]{40}$/.test(p.base?.sha) ||
          !/^[a-f0-9]{40}$/.test(p.head?.sha) ||
          typeof p.base?.ref !== 'string'
        )
          throw Error('Native readiness schema/identity');
        // Preserve API native sequence; timestamps are neither order nor causality.
        const ordered = events.map((e) => {
          if (
            !numeric(e.id) ||
            typeof e.event !== 'string' ||
            e.event.length > 128 ||
            !id(e.actor?.id)
          )
            throw Error('Native timeline schema');
          return { id: String(e.id), kind: e.event, actorId: id(e.actor.id) };
        });
        if (new Set(ordered.map((e) => e.id)).size !== ordered.length)
          throw Error('Duplicate timeline boundary');
        const window = {
          repositoryId,
          pr: input.pr,
          prNodeId: p.node_id,
          state: p.state,
          draft: p.draft,
          baseRef: `refs/heads/${p.base.ref}`,
          base: p.base.sha,
          head: p.head.sha,
          events: ordered,
          complete: true,
          order: 'native',
          nativeDigest: digest(JSON.stringify(second)),
        };
        window.evidenceDigest = readinessWindowDigest(window);
        const bindings = {
          requestDigest: digest(JSON.stringify(input)),
          evidenceDigest: window.evidenceDigest,
          nativeDigest: window.nativeDigest,
          historyStart: 'creation',
          complete: true,
          order: 'native',
        };
        await proof(
          'readiness-observation',
          { request: input, native: second, window, bindings },
          { run: controllerRun, ...bindings },
        );
        return verified(window);
      } catch {
        return blocked('Complete ordered readiness observation unavailable');
      }
    },
    async markReady(input) {
      const key = keyOf(input);
      if (
        !validReadinessRequest(input) ||
        input.repositoryId !== repositoryId ||
        !readinessActive.has(key) ||
        readinessSent.has(key)
      )
        return blocked('Ready requires scoped unused PR ownership');
      readinessSent.add(key);
      try {
        const { value } = await request('POST', '/graphql', {
          query:
            'mutation($id:ID!,$clientMutationId:String!){markPullRequestReadyForReview(input:{pullRequestId:$id,clientMutationId:$clientMutationId}){clientMutationId pullRequest{id isDraft}}}',
          variables: { id: input.prNodeId, clientMutationId: input.requestId },
        });
        const result = value.data?.markPullRequestReadyForReview;
        if (
          value.errors ||
          result?.pullRequest?.id !== input.prNodeId ||
          result.pullRequest.isDraft !== false ||
          result.clientMutationId !== input.requestId
        )
          throw Error('Unsettled Ready response');
        // Echoed clientMutationId binds the response only; it is not idempotency
        // or the native Ready witness. The handshake independently verifies it.
        return verified({
          requestId: input.requestId,
          prNodeId: input.prNodeId,
          clientMutationId: input.requestId,
          ready: true,
          responseDigest: digest(JSON.stringify(value)),
        });
      } catch {
        return { kind: 'uncertain', reason: 'Ready response unavailable', evidence: [] };
      }
    },
    async authenticateReadinessWindow(input, before, mutation, after) {
      const requestAuthentication = await store.authorizeReadinessRequest(input);
      await lookupRun(controllerRun);
      const bindings = readinessWindowBindings(input, before, mutation, after, controllerRun);
      const envelope = await archive('readiness-window', {
        request: input,
        before,
        mutation,
        after,
        bindings,
      });
      return { requestAuthentication, controllerRun, publicKey, envelope };
    },
    async publishReadinessProof(value) {
      try {
        const body = JSON.stringify(value);
        boundedJson(body, 16384);
        const expected = {
          purpose: 'readiness-proof',
          run: controllerRun,
          bodyDigest: digest(body),
        };
        const written = verifyArchive(
          await archive('readiness-proof-write', { body }),
          expected,
          publicKey,
        );
        const retrieved = await archive('readiness-proof-read', { body });
        if (retrieved?.body !== body) throw Error('Exact proof bytes missing from readback');
        const read = verifyArchive(retrieved.envelope, expected, publicKey);
        if (written.kind !== 'verified' || read.kind !== 'verified')
          throw Error('Exact authenticated proof readback unavailable');
        return verified(value);
      } catch {
        return {
          kind: 'uncertain',
          reason: 'Proof publication requires reconciliation',
          evidence: [],
        };
      }
    },
    async withPrLock(key, fn) {
      return store.withPrLock(key, async () => {
        if ((await store.pending(key)).length)
          throw Error('Pending durable obligations require reconciliation');
        active.add(key);
        try {
          return await fn();
        } finally {
          active.delete(key);
        }
      });
    },
    async observeAdmission(input) {
      // Resolve only authenticated durable operations, never a payload verified bit.
      const key = keyOf(input);
      const all = await store.readObligations?.(key);
      if (all?.kind !== 'verified' || !Array.isArray(all.value)) return null;
      const requested = input.requestId ?? input.candidate?.requestId;
      const operations = all.value.filter(
        (o) => o.state === 'accepted' && (!requested || o.request.requestId === requested),
      );
      if (operations.length !== 1) return null;
      const operation = operations[0];
      if (!validReadinessOperation(operation)) throw Error('Invalid durable operation');
      const authentication = await store.authorizeReadinessRequest?.(operation.request);
      const binding = readinessRequestBinding(authentication);
      if (
        !binding ||
        Object.keys(operation.request).some((k) => binding.request[k] !== operation.request[k])
      )
        throw Error('Request receipt unavailable');
      const retained = await archive('readiness-admission', {
        requestId: operation.request.requestId,
        proofDigest: operation.proofDigest,
      });
      if (!retained || digest(retained.body) !== operation.proofDigest)
        throw Error('Retained proof unavailable');
      const proofBody = boundedJson(retained.body, 16384);
      const checked = verifyArchive(
        retained.envelope,
        { purpose: 'readiness-proof', run: controllerRun, bodyDigest: operation.proofDigest },
        publicKey,
      );
      const c = proofBody.candidate;
      const originalAfter = retained.after;
      if (
        !originalAfter ||
        originalAfter.evidenceDigest !== proofBody.afterDigest ||
        readinessWindowDigest(originalAfter) !== proofBody.afterDigest ||
        !Array.isArray(originalAfter.events)
      )
        throw Error('Retained admitted window unavailable');
      if (
        checked.kind !== 'verified' ||
        JSON.stringify(Object.keys(proofBody).sort()) !==
          JSON.stringify(
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
          ) ||
        proofBody.version !== 2 ||
        !validCandidate(c) ||
        c.protocolVersion !== 2 ||
        !validReadinessRequest(proofBody.request) ||
        Object.keys(operation.request).some((k) => proofBody.request[k] !== operation.request[k]) ||
        ['repositoryId', 'pr', 'base', 'head', 'baseRef', 'requestId', 'protocolVersion'].some(
          (k) => c[k] !== operation.request[k],
        ) ||
        c.attempt !== proofBody.witnessId ||
        proofBody.originalRunId !== operation.request.originalRunId ||
        proofBody.runAttempt !== binding.run.attempt ||
        proofBody.definitionSha !== operation.request.definitionSha ||
        proofBody.beforeDigest !== operation.beforeDigest ||
        proofBody.mutationDigest !== operation.mutationDigest ||
        !/^[a-f0-9]{64}$/.test(proofBody.afterDigest)
      )
        throw Error('Proof identity mismatch');
      const read = await port.observeReadinessWindow(operation.request);
      if (read.kind !== 'verified') throw Error('Current native observation unavailable');
      const w = read.value;
      const index = w.events.findIndex((e) => e.id === c.attempt && e.kind === 'ready_for_review');
      if (index < 0) throw Error('Original native witness absent');
      const prefixMatches =
        JSON.stringify(w.events.slice(0, originalAfter.events.length)) ===
        JSON.stringify(originalAfter.events);
      const tail = w.events.slice(index + 1);
      const intervened = tail.some((e) =>
        [
          'head_ref_force_pushed',
          'base_ref_changed',
          'base_ref_force_pushed',
          'ready_for_review',
          'converted_to_draft',
          'closed',
          'reopened',
        ].includes(e.kind),
      );
      const latest = [...w.events]
        .reverse()
        .find((e) => ['ready_for_review', 'converted_to_draft'].includes(e.kind));
      const ready = [...w.events].reverse().find((e) => e.kind === 'ready_for_review');
      const closed = tail.some((e) => e.kind === 'closed');
      const current = { ...c, base: w.base, head: w.head, baseRef: w.baseRef, attempt: ready?.id };
      prNodes.set(c.pr, w.prNodeId);
      if (
        closed ||
        (ready?.id === c.attempt && (!prefixMatches || intervened || !sameCandidate(current, c)))
      )
        await safety(c, closed ? 'closed' : 'drift');
      return {
        repositoryId,
        pr: c.pr,
        nodeId: w.prNodeId,
        base: w.base,
        head: w.head,
        baseRef: w.baseRef,
        state: w.state,
        draft: w.draft,
        nativeVerified: true,
        sameRepository: true,
        readiness: { id: ready?.id, kind: latest?.kind, candidate: c, candidateVerified: false },
        lifecycle: { verified: true, attempt: ready?.id, closedSinceReady: closed },
        admission: {
          candidate: c,
          proof: proofBody,
          proofDigest: operation.proofDigest,
          verified:
            prefixMatches &&
            !intervened &&
            sameCandidate(current, c) &&
            w.state === 'open' &&
            !w.draft &&
            !closed &&
            !tail.some((e) => ['ready_for_review', 'converted_to_draft'].includes(e.kind)),
        },
      };
    },
    async observe(input) {
      const admitted = await port.observeAdmission(input);
      if (admitted) return admitted;
      if (input.repositoryId !== repositoryId || !numeric(input.pr))
        throw Error('Unrelated observation');
      const { value: p } = await request('GET', `${root}/pulls/${input.pr}`);
      const events = await pages(`${root}/issues/${input.pr}/timeline`);
      if (
        p.number !== input.pr ||
        typeof p.node_id !== 'string' ||
        p.node_id.length === 0 ||
        p.node_id.length > 256 ||
        (prNodes.has(input.pr) && prNodes.get(input.pr) !== p.node_id) ||
        !['open', 'closed'].includes(p.state) ||
        typeof p.draft !== 'boolean' ||
        !/^[a-f0-9]{40}$/.test(p.base?.sha) ||
        !/^[a-f0-9]{40}$/.test(p.head?.sha) ||
        id(p.base?.repo?.id) !== repositoryId ||
        id(p.head?.repo?.id) !== repositoryId
      )
        throw Error('Native PR schema/fork');
      const ids = new Set();
      let time = -Infinity;
      let ready = null;
      let nativeKind = null;
      let closed = false;
      for (const event of events) {
        const current = Date.parse(event.created_at);
        if (
          !numeric(event.id) ||
          ids.has(event.id) ||
          !Number.isFinite(current) ||
          current < time ||
          typeof event.event !== 'string'
        )
          throw Error('Incomplete/reordered timeline schema');
        ids.add(event.id);
        time = current;
        if (event.event === 'ready_for_review') {
          ready = event;
          nativeKind = event.event;
          closed = false;
        }
        if (event.event === 'converted_to_draft') nativeKind = event.event;
        if (ready && event.event === 'closed') closed = true;
      }
      if (!ready) throw Error('No native Ready history');
      await lookupRun(controllerRun);
      const evidence = await proof(
        'native-history',
        { pr: input.pr },
        {
          run: controllerRun,
          readyEventId: String(ready.id),
          historyStart: 'creation',
          timelineDigest: digest(JSON.stringify(events)),
          snapshotDigest: digest(JSON.stringify(p)),
        },
      );
      const origin = evidence.candidate;
      if (
        !validCandidate(origin) ||
        origin.repositoryId !== repositoryId ||
        origin.pr !== input.pr ||
        origin.attempt !== String(ready.id)
      )
        throw Error('Missing exact event-time Ready origin');
      const candidate = {
        repositoryId,
        pr: input.pr,
        base: p.base.sha,
        head: p.head.sha,
        attempt: String(ready.id),
      };
      prNodes.set(input.pr, p.node_id);
      if (closed || !sameCandidate(origin, candidate))
        await safety(candidate, closed ? 'closed' : 'drift');
      return {
        repositoryId,
        pr: input.pr,
        nodeId: p.node_id,
        base: p.base.sha,
        head: p.head.sha,
        state: p.state,
        draft: p.draft,
        nativeVerified: true,
        sameRepository: true,
        readiness: {
          id: origin.attempt,
          kind: nativeKind,
          candidate: origin,
          candidateVerified: true,
        },
        lifecycle: { verified: true, attempt: origin.attempt, closedSinceReady: closed },
      };
    },
    async readJournal() {
      const { value: issue } = await request('GET', `${root}/issues/${ledgerNumber}`);
      if (
        id(issue.id) !== ledgerId ||
        id(issue.user?.id) !== controllerRun.actorId ||
        issue.pull_request
      )
        throw Error('Ledger identity');
      const comments = await pages(`${root}/issues/${ledgerNumber}/comments`);
      await proof(
        'journal-index',
        {},
        {
          run: controllerRun,
          ledgerId,
          entriesDigest: digest(JSON.stringify(comments.map((e) => [e.id, digest(e.body)]))),
        },
      );
      const entries = [],
        records = [],
        readinessRequests = [];
      for (const comment of comments) {
        if (
          !numeric(comment.id) ||
          typeof comment.body !== 'string' ||
          comment.created_at !== comment.updated_at ||
          id(comment.user?.id) !== controllerRun.actorId
        )
          throw Error('Edited or untrusted journal');
        const row = boundedJson(comment.body, 16384);
        if (row.candidate?.protocolVersion === 2) {
          const op = await store.readOperation?.(row.candidate.requestId);
          if (op?.kind !== 'verified' || !op.value) throw Error('Journal request unavailable');
          readinessRequests.push(await store.authorizeReadinessRequest?.(op.value.request));
        }
        const a = await proof(
          'journal',
          { body: comment.body },
          { bodyDigest: digest(comment.body), candidate: row.candidate },
        );
        const run = a.run;
        await lookupRun(run);
        entries.push({ body: comment.body, ledgerId, authorId: id(comment.user.id), run });
        records.push({ runId: run.id, runAttempt: run.attempt, digest: digest(comment.body) });
      }
      return parseJournal(entries, {
        ledgerId,
        controllerActorId: controllerRun.actorId,
        workflowId: controllerRun.workflowId,
        trustedSha: controllerRun.sha,
        repositoryId,
        records,
        readinessRequests,
      });
    },
    async append(row) {
      const key = keyOf(row.candidate);
      if (!active.has(key) || !validCandidate(row.candidate))
        throw Error('Append requires PR lock');
      const body = JSON.stringify({
        ...row,
        run: { id: controllerRun.id, attempt: controllerRun.attempt },
      });
      boundedJson(body, 16384);
      const obligation = randomUUID();
      await store.append(key, {
        type: 'pending',
        id: obligation,
        candidate: row.candidate,
        bodyDigest: digest(body),
      });
      await request('POST', `${root}/issues/${ledgerNumber}/comments`, { body }, 201);
      const read = await port.readJournal(row.candidate);
      if (read.kind !== 'verified' || !read.value.some((r) => JSON.stringify(r) === body))
        throw Error('Append exact authenticated readback unavailable');
      await store.append(key, { type: 'resolved', id: obligation });
      if (row.action === 'invalidate' && row.phase === 'result') {
        for (const p of await store.pending(key))
          if (p.id.startsWith('safety:') && p.candidate.attempt === row.candidate.attempt)
            await store.append(key, { type: 'resolved', id: p.id });
      }
      return verified(row);
    },
    async draft(c, admissionIdentity = c) {
      if (!active.has(keyOf(c))) throw Error('Draft requires PR lock');
      const expectedNode = prNodes.get(c.pr);
      if (!expectedNode) throw Error('Missing authenticated PR node identity');
      // Reuse the complete native/provenance observation, including lifecycle
      // and immutable node identity, immediately before the non-atomic mutation.
      const current = await port.observe(admissionIdentity);
      if (
        !sameCandidate(candidateOf(current), c) ||
        current.nodeId !== expectedNode ||
        current.state !== 'open' ||
        current.draft !== false ||
        current.readiness.kind !== 'ready_for_review' ||
        current.lifecycle.closedSinceReady
      )
        throw Error('Observed candidate or readiness changed before Draft');
      const { value } = await request('POST', '/graphql', {
        query:
          'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
        variables: { id: expectedNode },
      });
      if (
        value.errors ||
        value.data?.convertPullRequestToDraft?.pullRequest?.id !== expectedNode ||
        value.data.convertPullRequestToDraft.pullRequest.isDraft !== true
      )
        throw Error('Draft outcome uncertain');
      // Controller performs its mandatory post-mutation current-candidate readback.
    },
    async readCiContinuation(claimId) {
      return ciContinuation?.readCiContinuation
        ? ciContinuation.readCiContinuation(claimId)
        : blocked('CI continuation provider unselected');
    },
    async resolveCiContinuation(event) {
      if (
        !event ||
        event.worker !== 'ci' ||
        event.candidate?.protocolVersion !== 2 ||
        typeof event.claimId !== 'string'
      )
        return blocked('CI claim identity required');
      const read = await port.readCiContinuation(event.claimId);
      const claim = read?.value,
        c = event.candidate;
      const op = await store.readOperation?.(c.requestId);
      if (
        read?.kind !== 'verified' ||
        !claim ||
        claim.id !== event.claimId ||
        claim.worker !== 'ci' ||
        claim.status !== 'observed' ||
        claim.requestId !== c.requestId ||
        !sameCandidate(claim.candidate, c) ||
        op?.kind !== 'verified' ||
        op.value?.state !== 'accepted' ||
        claim.definitionSha !== op.value.request.definitionSha ||
        !claim.run ||
        claim.run.sha !== claim.definitionSha ||
        claim.run.repositoryId !== c.repositoryId ||
        claim.run.event !== 'workflow_dispatch'
      )
        return blocked('Authenticated bound CI claim required');
      await lookupRun(claim.run);
      return verified(structuredClone(claim));
    },
    async consumeCiStart(claimId, run) {
      if (!active.has(keyOf((await port.readCiContinuation(claimId))?.value?.candidate ?? {})))
        return blocked('CI consumption requires held PR lock');
      return ciContinuation?.consumeCiStart
        ? ciContinuation.consumeCiStart(claimId, run)
        : blocked('CI consumption provider unselected');
    },
    async verifyWorkerCallback(event, callbackRun) {
      const continuation =
        event.candidate?.protocolVersion === 2 && event.worker === 'ci'
          ? await port.resolveCiContinuation(event)
          : null;
      const expected = continuation ? continuation.value?.run : workers[event.worker];
      if (
        !expected ||
        (event.candidate?.protocolVersion === 2
          ? !sameExecution(expected, callbackRun)
          : JSON.stringify(expected) !== JSON.stringify(callbackRun))
      )
        throw Error('Unmapped worker callback');
      if (
        continuation &&
        (continuation.kind !== 'verified' ||
          (event.type === 'worker_completed' && !validStart(continuation.value)))
      )
        return blocked('CI start consumption required');
      await lookupRun(expected);
      return verified(expected);
    },
    async verifyWorker(event) {
      const continuation =
        event.candidate?.protocolVersion === 2 && event.worker === 'ci'
          ? await port.resolveCiContinuation(event)
          : null;
      if (continuation && (continuation.kind !== 'verified' || !validStart(continuation.value)))
        return blocked('Persisted CI start required');
      const selectedRun = continuation ? continuation.value?.run : workers[event.worker];
      // Keep the selected scalar execution independent of mutable provider/mapping
      // objects across native lookup, result retrieval and envelope verification.
      const run = selectedRun && Object.freeze({ ...selectedRun });
      if (event.candidate?.protocolVersion === 2 && !sameExecution(event.run, run))
        return blocked('Worker completion run mismatch');
      if (!run || !workerResults) throw Error('Worker mapping unselected');
      await lookupRun(run);
      const downloaded = await workerResults(run);
      const result = await readWorkerResult(run, async () => downloaded, {
        candidate: event.candidate,
        worker: event.worker,
        publicKey,
        claimId: continuation?.value?.id,
      });
      if (result.kind !== 'verified') throw Error('Worker envelope mismatch');
      const o = await port.observe(event.candidate),
        journal = await port.readJournal();
      if (journal.kind !== 'verified') throw Error('Worker admission ledger unavailable');
      const rows = journal.value.filter((r) => sameCandidate(r.candidate, event.candidate));
      const observed = {
        candidate: candidateOf(o),
        nativeVerified: o.nativeVerified,
        lifecycleVerified: o.lifecycle.verified,
        ready: o.state === 'open' && !o.draft && o.readiness.kind === 'ready_for_review',
        sameRepository: o.sameRepository,
        admitted: rows.some((r) => r.action === 'admit-ci' && r.phase === 'result'),
        invalidated:
          o.lifecycle.closedSinceReady ||
          journal.value.some(
            (r) =>
              r.candidate.attempt === event.candidate.attempt &&
              r.candidate.pr === event.pr &&
              ['invalidate', 'draft'].includes(r.action),
          ),
        expectedRun: run,
        expectedClaimId: continuation?.value?.id,
        expectedWorker: event.worker,
        ci: {
          verified: rows.some((r) => r.action === 'ci-success' && r.phase === 'result'),
          candidate: event.candidate,
          outcome: 'success',
        },
      };
      const { envelope } = downloaded;
      const decision = resultDecision(
        event.candidate,
        run,
        result.value,
        observed,
        envelope,
        publicKey,
      );
      if (decision.action === 'none') throw Error('Task7 result policy denied');
      // Findings must map to failure before Task6 sees completion.
      if ((decision.action === 'draft') !== (event.outcome === 'failure'))
        throw Error('Worker outcome contradicts policy');
      return verified({ candidate: event.candidate, worker: event.worker, outcome: event.outcome });
    },
  };
  return port;
}
