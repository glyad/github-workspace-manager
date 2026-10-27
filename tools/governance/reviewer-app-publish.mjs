import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { appRequest, withReviewerApp, safeAuthError } from './reviewer-app-auth.mjs';

export const repository = 'glyad/github-workspace-manager';
const repositoryId = 1427426748;
const root = `/repos/${repository}`;
const maxDispatchBytes = 48 * 1024;
const fail = () => {
  throw Error('Publication validation failed');
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const text = (s, size) =>
  typeof s === 'string' &&
  s.length > 0 &&
  Buffer.byteLength(s) <= size &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) &&
  !s.includes('<!-- local-review:');
const identifier = (s) => text(s, 240) && !/[\x00-\x20\x7f]/.test(s);
const exact = (o, fields) =>
  o &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  Object.keys(o).length === fields.length &&
  fields.every((k) => Object.hasOwn(o, k));
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(',')}}`
      : JSON.stringify(value);
export const payloadDigest = (p) => createHash('sha256').update(canonical(p)).digest('hex');
export function dispatchBody(p) {
  const body = JSON.stringify({ ref: 'main', inputs: { payload: JSON.stringify(p) } });
  if (Buffer.byteLength(body) > maxDispatchBytes) fail();
  return body;
}
export function validatePayload(value) {
  // Round trip ensures the public interface is inert JSON, then retain only that snapshot.
  const p = JSON.parse(JSON.stringify(value));
  if (
    !exact(p, [
      'version',
      'operationId',
      'repository',
      'repositoryId',
      'prNumber',
      'prId',
      'baseRepositoryId',
      'headRepositoryId',
      'baseRef',
      'headRef',
      'baseSha',
      'headSha',
      'reviewer',
      'operation',
    ]) ||
    p.version !== 1 ||
    typeof p.operationId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(p.operationId) ||
    p.repository !== repository ||
    p.repositoryId !== repositoryId ||
    p.baseRepositoryId !== repositoryId ||
    ![p.prNumber, p.prId, p.headRepositoryId].every(positive) ||
    p.baseRef !== 'develop' ||
    !identifier(p.headRef) ||
    ![p.baseSha, p.headSha].every((s) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s)) ||
    !exact(p.reviewer, ['model', 'effort', 'evidence']) ||
    p.reviewer.model !== 'gpt-6-astra' ||
    p.reviewer.effort !== 'high' ||
    !identifier(p.reviewer.evidence)
  )
    fail();
  const o = p.operation;
  if (o?.type === 'review') {
    if (
      !exact(o, ['type', 'event', 'summary', 'complete', 'comments']) ||
      !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(o.event) ||
      !text(o.summary, 12000) ||
      o.complete !== true ||
      !Array.isArray(o.comments) ||
      o.comments.length > 20
    )
      fail();
    for (const c of o.comments) {
      const range = Object.hasOwn(c, 'start_line') || Object.hasOwn(c, 'start_side');
      if (
        !exact(
          c,
          range
            ? ['path', 'line', 'side', 'body', 'start_line', 'start_side']
            : ['path', 'line', 'side', 'body'],
        ) ||
        !identifier(c.path) ||
        c.path.startsWith('/') ||
        c.path.includes('\\') ||
        c.path.split('/').some((x) => !x || x === '.' || x === '..') ||
        !positive(c.line) ||
        !['LEFT', 'RIGHT'].includes(c.side) ||
        !text(c.body, 6000) ||
        (range &&
          (!positive(c.start_line) ||
            c.start_line >= c.line ||
            c.start_side !== c.side ||
            c.line - c.start_line > 200))
      )
        fail();
    }
  } else if (o?.type === 'reply') {
    if (!exact(o, ['type', 'commentId', 'body']) || !positive(o.commentId) || !text(o.body, 12000))
      fail();
  } else fail();
  dispatchBody(p);
  return p;
}
export async function pages(request, path, key) {
  const rows = [];
  for (let page = 1; page <= 15; page++) {
    const result = await request(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=20&page=${page}`,
    );
    const values = key ? result?.[key] : result;
    if (
      !Array.isArray(values) ||
      values.length > 20 ||
      (key && (!Number.isSafeInteger(result.total_count) || result.total_count < 0))
    )
      fail();
    rows.push(...values);
    if (values.length < 20) {
      if (key && rows.length !== result.total_count) fail();
      return rows;
    }
  }
  fail();
}
function current(p, pr) {
  return (
    pr?.id === p.prId &&
    pr.number === p.prNumber &&
    pr.state === 'open' &&
    (p.operation.type === 'reply' || pr.draft === false) &&
    ['base', 'head'].every(
      (k) =>
        pr[k]?.repo?.id === p[`${k}RepositoryId`] &&
        pr[k]?.ref === p[`${k}Ref`] &&
        pr[k]?.sha === p[`${k}Sha`],
    ) &&
    pr.base.repo.full_name === repository
  );
}
async function candidate(p, request) {
  const pr = await request('GET', `${root}/pulls/${p.prNumber}`);
  const base = await request('GET', `${root}/git/ref/heads/develop`);
  return current(p, pr) && base?.object?.sha === p.baseSha;
}
async function ready(p, request, readyWorkflow) {
  const workflow = await request('GET', `${root}/actions/workflows/ready-ci.yml`);
  if (
    !positive(workflow?.id) ||
    workflow.path !== '.github/workflows/ready-ci.yml' ||
    workflow.state !== 'active'
  )
    fail();
  const runs = await pages(
    request,
    `${root}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${p.headSha}`,
    'workflow_runs',
  );
  const matches = runs.filter((r) =>
    r.pull_requests?.some((pr) => pr.id === p.prId && pr.number === p.prNumber),
  );
  // GitHub returns newest first. A newer pending/failed rerun supersedes older success.
  const run = matches[0];
  if (
    !positive(run?.id) ||
    run.workflow_id !== workflow.id ||
    run.path !== workflow.path ||
    run.event !== 'pull_request' ||
    run.head_sha !== p.headSha ||
    run.repository?.id !== repositoryId ||
    run.head_repository?.id !== p.headRepositoryId ||
    !run.pull_requests.some(
      (pr) =>
        pr.id === p.prId &&
        pr.number === p.prNumber &&
        pr.base?.ref === p.baseRef &&
        pr.base?.repo?.id === p.baseRepositoryId &&
        pr.head?.ref === p.headRef &&
        pr.head?.repo?.id === p.headRepositoryId,
    ) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    fail();
  const compare = await request('GET', `${root}/compare/${p.baseSha}...${p.headSha}`);
  if (compare?.merge_base_commit?.sha !== p.baseSha) fail();
  const source = await request(
    'GET',
    `${root}/contents/.github/workflows/ready-ci.yml?ref=${run.head_sha}`,
  );
  if (
    source?.encoding !== 'base64' ||
    typeof source.content !== 'string' ||
    Buffer.from(source.content, 'base64').toString('utf8') !== readyWorkflow
  )
    fail();
  const jobs = await pages(request, `${root}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
  for (const name of ['checks', 'Confirm current Ready candidate']) {
    const found = jobs.filter((j) => j.name === name);
    if (found.length !== 1 || found[0].status !== 'completed' || found[0].conclusion !== 'success')
      fail();
  }
  return run.id;
}
function patchLines(patch) {
  if (typeof patch !== 'string') fail();
  const lines = { LEFT: new Set(), RIGHT: new Set() };
  let left,
    right,
    remainingLeft = 0,
    remainingRight = 0,
    additions = 0,
    deletions = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (remainingLeft || remainingRight) fail();
      left = Number(hunk[1]);
      right = Number(hunk[3]);
      remainingLeft = Number(hunk[2] ?? 1);
      remainingRight = Number(hunk[4] ?? 1);
      continue;
    }
    if (left === undefined) continue;
    if (line.startsWith(' ')) {
      remainingLeft--;
      remainingRight--;
      lines.LEFT.add(left++);
      lines.RIGHT.add(right++);
    } else if (line.startsWith('-')) {
      deletions++;
      remainingLeft--;
      lines.LEFT.add(left++);
    } else if (line.startsWith('+')) {
      additions++;
      remainingRight--;
      lines.RIGHT.add(right++);
    }
    if (remainingLeft < 0 || remainingRight < 0) fail();
  }
  if (remainingLeft || remainingRight) fail();
  if (patch.length && left === undefined) fail();
  return { ...lines, additions, deletions };
}
function anchors(p, files) {
  if (!files.length || new Set(files.map((f) => f.filename)).size !== files.length) fail();
  if (p.operation.event === 'APPROVE')
    for (const file of files) {
      const parsed = patchLines(file.patch);
      if (
        ![file.additions, file.deletions, file.changes].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        file.changes !== file.additions + file.deletions ||
        parsed.additions !== file.additions ||
        parsed.deletions !== file.deletions
      )
        fail();
    }
  for (const comment of p.operation.comments) {
    const file = files.find((f) => f.filename === comment.path);
    if (typeof file?.patch !== 'string') fail();
    const lines = patchLines(file?.patch);
    for (let line = comment.start_line ?? comment.line; line <= comment.line; line++)
      if (!lines[comment.side].has(line)) fail();
  }
}
const expectedState = (event) =>
  ({ APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' })[event];
export async function publishOperation(
  value,
  request,
  { readyWorkflow, reconcileOnly = false, currentRunId, runAttempt = 1 } = {},
) {
  const p = validatePayload(value),
    digest = payloadDigest(p),
    o = p.operation;
  const markerPrefix = `<!-- local-review:${p.operationId}:`;
  const marker = `${markerPrefix}${digest} -->`;
  const note = `Local ${p.reviewer.model}/${p.reviewer.effort}; base ${p.baseSha}; head ${p.headSha}.`;
  const body = `${o.type === 'review' ? o.summary : o.body}\n\n${note}\n${marker}`;
  const basePath = `${root}/pulls/${p.prNumber}`;
  if (!(await candidate(p, request))) fail();
  const bot = await request('GET', '/users/glyad-workspace-reviewer%5Bbot%5D');
  if (bot?.id !== 348541410 || bot.login !== 'glyad-workspace-reviewer[bot]' || bot.type !== 'Bot')
    fail();
  const author = (obj) =>
    obj?.user?.id === bot.id && obj.user.login === bot.login && obj.user.type === 'Bot';
  let ciRunId;
  if (o.type === 'review') {
    ciRunId = await ready(p, request, readyWorkflow);
    anchors(p, await pages(request, `${basePath}/files`));
  } else {
    const original = await request('GET', `${root}/pulls/comments/${o.commentId}`);
    if (
      original?.id !== o.commentId ||
      original.pull_request_url !== `https://api.github.com${basePath}` ||
      original.in_reply_to_id
    )
      fail();
  }
  async function discover() {
    const list = await pages(
      request,
      `${basePath}/${o.type === 'review' ? 'reviews' : 'comments'}`,
    );
    const found = list.filter((r) => typeof r.body === 'string' && r.body.includes(markerPrefix));
    if (
      found.length > 1 ||
      found.some((r) => !author(r) || r.body !== body || !r.body.includes(marker))
    )
      fail();
    return found[0];
  }
  async function verify(object) {
    if (!positive(object?.id)) fail();
    const r = await request(
      'GET',
      o.type === 'review'
        ? `${basePath}/reviews/${object.id}`
        : `${root}/pulls/comments/${object.id}`,
    );
    if (r?.id !== object.id || !author(r) || r.body !== body) fail();
    if (o.type === 'review') {
      if (r.commit_id !== p.headSha || r.state !== expectedState(o.event)) fail();
      const comments = await pages(request, `${basePath}/reviews/${r.id}/comments`);
      if (comments.length !== o.comments.length) fail();
      const unmatched = [...comments];
      for (const c of o.comments) {
        const index = unmatched.findIndex(
          (actual) =>
            author(actual) &&
            actual.pull_request_review_id === r.id &&
            actual.commit_id === p.headSha &&
            ['path', 'line', 'side', 'body', 'start_line', 'start_side'].every(
              (k) => (actual[k] ?? undefined) === c[k],
            ),
        );
        if (index < 0) fail();
        unmatched.splice(index, 1);
      }
    } else if (
      r.in_reply_to_id !== o.commentId ||
      r.pull_request_url !== `https://api.github.com${basePath}`
    )
      fail();
    const isCurrent = await candidate(p, request);
    return {
      version: 1,
      operationId: p.operationId,
      digest,
      state: isCurrent ? 'verified' : 'stale',
      nativeId: r.id,
      authorId: bot.id,
      prNumber: p.prNumber,
      baseSha: p.baseSha,
      headSha: p.headSha,
      ...(ciRunId ? { ciRunId } : {}),
      url: `https://github.com/${repository}/pull/${p.prNumber}#${o.type === 'review' ? 'pullrequestreview' : 'discussion_r'}${o.type === 'review' ? '-' : ''}${r.id}`,
    };
  }
  const existing = await discover();
  if (existing) {
    try {
      return await verify(existing);
    } catch {
      return { operationId: p.operationId, digest, state: 'uncertain' };
    }
  }
  if (reconcileOnly) return { operationId: p.operationId, digest, state: 'uncertain' };
  if (runAttempt !== 1) return { operationId: p.operationId, digest, state: 'uncertain' };
  if (currentRunId) {
    const prior = await pages(
      request,
      `${root}/actions/workflows/reviewer-app-publish.yml/runs?event=workflow_dispatch&branch=main`,
      'workflow_runs',
    );
    if (
      prior.some(
        (r) => r.display_title === `Local review ${p.operationId}` && r.id !== currentRunId,
      )
    )
      return { operationId: p.operationId, digest, state: 'uncertain' };
  }
  if (!(await candidate(p, request))) fail();
  let posted;
  try {
    posted = await request(
      'POST',
      o.type === 'review' ? `${basePath}/reviews` : `${basePath}/comments/${o.commentId}/replies`,
      o.type === 'review'
        ? { commit_id: p.headSha, event: o.event, body, comments: o.comments }
        : { body },
      201,
    );
    return await verify(posted);
  } catch {
    // POST may have applied even when its response was lost. Never repeat it here.
    try {
      const found = await discover();
      if (found) return await verify(found);
    } catch {
      /* Keep ambiguity. */
    }
    return {
      operationId: p.operationId,
      digest,
      state: 'uncertain',
      ...(positive(posted?.id) ? { nativeId: posted.id } : {}),
    };
  }
}
export function trustedExecution(env) {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_REPOSITORY === repository &&
    env.GITHUB_ACTOR === 'glyad' &&
    env.GITHUB_ACTOR_ID === '4238205'
  );
}
export async function runPublisher({
  payload,
  privateKey,
  actionsToken,
  fetchImpl = globalThis.fetch,
  mask = () => {},
  readyWorkflow,
  currentRunId,
  runAttempt = 1,
} = {}) {
  const p = validatePayload(payload);
  if (typeof actionsToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(actionsToken)) fail();
  mask(actionsToken);
  let receipt;
  try {
    const result = await withReviewerApp({
      privateKey,
      fetchImpl,
      mask,
      profile: 'publish',
      operation: async (app) => {
        const request = (method, path, body, status) =>
          path.includes('/actions/')
            ? appRequest(
                fetchImpl,
                method,
                path,
                actionsToken,
                body,
                status ?? 200,
                'ready-ci',
                'publication',
              )
            : app(method, path, body, status);
        receipt = await publishOperation(p, request, { readyWorkflow, currentRunId, runAttempt });
        return receipt;
      },
    });
    return { ...receipt, revoked: result.revoked };
  } catch (error) {
    if (receipt)
      return {
        ...receipt,
        revoked: false,
        state: receipt.state === 'stale' ? 'stale' : 'uncertain',
        publicationState: receipt.state,
      };
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let privateKey = process.env.REVIEWER_APP_PRIVATE_KEY;
  const actionsToken = process.env.GH_TOKEN;
  delete process.env.REVIEWER_APP_PRIVATE_KEY;
  delete process.env.GH_TOKEN;
  try {
    if (
      !trustedExecution(process.env) ||
      !positive(Number(process.env.GITHUB_RUN_ID)) ||
      !positive(Number(process.env.GITHUB_RUN_ATTEMPT))
    )
      fail();
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (
      !exact(event.inputs, ['payload']) ||
      typeof event.inputs.payload !== 'string' ||
      Buffer.byteLength(JSON.stringify({ ref: 'main', inputs: event.inputs })) > maxDispatchBytes
    )
      fail();
    const receipt = await runPublisher({
      payload: JSON.parse(event.inputs.payload),
      privateKey,
      actionsToken,
      currentRunId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      readyWorkflow: await readFile(
        new URL('../../.github/workflows/ready-ci.yml', import.meta.url),
        'utf8',
      ),
      mask: (value) => console.log(`::add-mask::${value}`),
    });
    privateKey = undefined;
    console.log(`LOCAL_REVIEW_RECEIPT ${JSON.stringify(receipt)}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\nLocal review receipt: \`${JSON.stringify(receipt)}\`\n`,
      );
    if (receipt.state !== 'verified' || !receipt.revoked) process.exitCode = 1;
  } catch (error) {
    console.error(safeAuthError(error));
    process.exitCode = 1;
  }
}
