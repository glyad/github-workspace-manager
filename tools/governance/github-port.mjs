import { randomUUID } from 'node:crypto';
import { digest, parseJournal, sameCandidate, validCandidate } from './journal.mjs';
import {
  boundedJson,
  verifyArchive,
  readWorkerResult,
  resultDecision,
} from './worker-transport.mjs';
import { verified } from './contracts.mjs';
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
  const port = {
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
    async observe(input) {
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
        records = [];
      for (const comment of comments) {
        if (
          !numeric(comment.id) ||
          typeof comment.body !== 'string' ||
          comment.created_at !== comment.updated_at ||
          id(comment.user?.id) !== controllerRun.actorId
        )
          throw Error('Edited or untrusted journal');
        const row = boundedJson(comment.body, 16384);
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
    async draft(c) {
      if (!active.has(keyOf(c))) throw Error('Draft requires PR lock');
      const expectedNode = prNodes.get(c.pr);
      if (!expectedNode) throw Error('Missing authenticated PR node identity');
      // Reuse the complete native/provenance observation, including lifecycle
      // and immutable node identity, immediately before the non-atomic mutation.
      const current = await port.observe(c);
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
    async verifyWorkerCallback(event, callbackRun) {
      const expected = workers[event.worker];
      if (!expected || JSON.stringify(expected) !== JSON.stringify(callbackRun))
        throw Error('Unmapped worker callback');
      await lookupRun(expected);
      return verified(expected);
    },
    async verifyWorker(event) {
      const run = workers[event.worker];
      if (!run || !workerResults) throw Error('Worker mapping unselected');
      await lookupRun(run);
      const downloaded = await workerResults(run);
      const result = await readWorkerResult(run, async () => downloaded, {
        candidate: event.candidate,
        worker: event.worker,
        publicKey,
      });
      if (result.kind !== 'verified') throw Error('Worker envelope mismatch');
      const o = await port.observe(event.candidate),
        journal = await port.readJournal();
      if (journal.kind !== 'verified') throw Error('Worker admission ledger unavailable');
      const rows = journal.value.filter((r) => sameCandidate(r.candidate, event.candidate));
      const observed = {
        candidate: { repositoryId, pr: o.pr, base: o.base, head: o.head, attempt: o.readiness.id },
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
