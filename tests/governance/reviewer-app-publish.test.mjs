import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  validatePayload,
  dispatchBody,
  publishOperation,
  trustedExecution,
  pages,
  runPublisher,
} from '../../tools/governance/reviewer-app-publish.mjs';

const repo = { id: 1427426748, full_name: 'glyad/github-workspace-manager' };
const bot = { id: 348541410, login: 'glyad-workspace-reviewer[bot]', type: 'Bot' };
const workflow = 'trusted Ready workflow';
function payload(operation = 'review') {
  return {
    version: 1,
    operationId: 'review-test-001',
    repository: repo.full_name,
    repositoryId: repo.id,
    prNumber: 12,
    prId: 333,
    baseRepositoryId: repo.id,
    headRepositoryId: repo.id,
    baseRef: 'develop',
    headRef: 'chore/test',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    reviewer: { model: 'gpt-6-astra', effort: 'high', evidence: 'local-review-001' },
    operation:
      operation === 'review'
        ? {
            type: 'review',
            event: 'REQUEST_CHANGES',
            summary: 'Fix the defect.',
            complete: true,
            comments: [{ path: 'file.mjs', line: 2, side: 'RIGHT', body: 'Defect here.' }],
          }
        : { type: 'reply', commentId: 77, body: 'Rechecked the fix.' },
  };
}
function fixture(p = payload(), options = {}) {
  const calls = [],
    reviews = [],
    comments = [];
  let observations = 0,
    posts = 0;
  const pr = {
    id: p.prId,
    number: p.prNumber,
    state: 'open',
    draft: options.draft ?? false,
    base: { ref: p.baseRef, sha: p.baseSha, repo },
    head: { ref: p.headRef, sha: p.headSha, repo },
  };
  const run = {
    id: 100,
    workflow_id: 55,
    path: '.github/workflows/ready-ci.yml',
    event: 'pull_request',
    head_sha: p.headSha,
    head_repository: repo,
    repository: repo,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [
      {
        id: p.prId,
        number: p.prNumber,
        base: { ref: p.baseRef, repo },
        head: { ref: p.headRef, sha: p.headSha, repo },
      },
    ],
  };
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/pulls/12') && method === 'GET') {
      observations++;
      return {
        ...pr,
        ...(options.changeAt === observations ? { base: { ...pr.base, sha: 'c'.repeat(40) } } : {}),
      };
    }
    if (path.includes('/git/ref/heads/')) return { object: { sha: p.baseSha } };
    if (path.startsWith('/users/')) return bot;
    if (path.endsWith('/actions/workflows/ready-ci.yml'))
      return { id: 55, path: run.path, state: 'active' };
    if (path.includes('/actions/workflows/55/runs?'))
      return { total_count: 1, workflow_runs: [{ ...run, ...options.run }] };
    if (path.includes('/compare/'))
      return { merge_base_commit: { sha: options.ancestor ?? p.baseSha } };
    if (path.includes('/contents/'))
      return {
        encoding: 'base64',
        content: Buffer.from(options.workflow ?? workflow).toString('base64'),
      };
    if (path.includes('/actions/runs/100/jobs?'))
      return {
        total_count: 2,
        jobs: ['checks', 'Confirm current Ready candidate'].map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      };
    if (path.includes('/files?'))
      return [
        {
          filename: 'file.mjs',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          ...options.file,
          patch: options.patch ?? '@@ -1,2 +1,3 @@\n one\n+two\n three',
        },
      ];
    if (path.endsWith('/pulls/comments/77'))
      return options.wrongPr
        ? {
            id: 77,
            pull_request_url:
              'https://api.github.com/repos/glyad/github-workspace-manager/pulls/13',
          }
        : {
            id: 77,
            pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/12`,
            original_commit_id: 'd'.repeat(40),
          };
    if (method === 'POST') {
      posts++;
      if (options.failWrite === 'absent') throw Error('private raw transport');
      if (p.operation.type === 'review') {
        const review = {
          id: 88,
          user: bot,
          commit_id: p.headSha,
          state: {
            APPROVE: 'APPROVED',
            REQUEST_CHANGES: 'CHANGES_REQUESTED',
            COMMENT: 'COMMENTED',
          }[body.event],
          body: body.body,
          html_url:
            'https://github.com/glyad/github-workspace-manager/pull/12#pullrequestreview-88',
        };
        reviews.push(review);
        comments.push(
          ...body.comments.map((c, i) => ({
            ...c,
            id: 90 + i,
            user: bot,
            pull_request_review_id: 88,
            commit_id: p.headSha,
            pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/12`,
          })),
        );
      } else
        comments.push({
          id: 99,
          body: body.body,
          user: bot,
          in_reply_to_id: 77,
          pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/12`,
        });
      if (options.failWrite) throw Error('private raw transport');
      return p.operation.type === 'review' ? reviews[0] : comments.at(-1);
    }
    if (path.includes('/reviews/88/comments?')) return options.missingComments ? [] : comments;
    if (path.endsWith('/reviews/88')) return reviews[0];
    if (path.endsWith('/pulls/comments/99')) return comments.at(-1);
    if (path.includes('/reviews?'))
      return options.collision
        ? [{ id: 87, user: bot, body: `<!-- local-review:${p.operationId}:wrong -->` }]
        : reviews;
    if (path.includes('/comments?')) return comments;
    throw Error(`Unmocked ${method} ${path}`);
  };
  return {
    p,
    request,
    calls,
    reviews,
    comments,
    posts: () => posts,
    run: () => publishOperation(p, request, { readyWorkflow: workflow }),
  };
}

test('strict contract bounds complete serialized dispatch bytes, including escaping', () => {
  const p = payload();
  assert.equal(validatePayload(p).operationId, p.operationId);
  assert.ok(Buffer.byteLength(dispatchBody(p)) <= 48 * 1024);
  for (const change of [
    (p) => (p.extra = true),
    (p) => (p.headSha = 'bad'),
    (p) => (p.headRef = 'x\n'),
    (p) => (p.operation.complete = false),
    (p) => (p.operation.comments[0].line = 0),
    (p) => (p.reviewer.model = 'other'),
    (p) => p.repositoryId++,
    (p) => (p.operation.summary = '\u0001'.repeat(9000)),
  ]) {
    const bad = payload();
    change(bad);
    assert.throws(() => validatePayload(bad));
  }
  const large = payload();
  large.operation.summary = '😀\\"'.repeat(9000);
  assert.throws(() => dispatchBody(large));
});
test('one native submitted review carries exact pair, explicit commit, all anchors and digest; rediscovery never reposts', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.state, 'verified');
  assert.equal(result.nativeId, 88);
  assert.equal(result.authorId, bot.id);
  assert.equal(f.posts(), 1);
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.commit_id, f.p.headSha);
  assert.equal(post.body.event, 'REQUEST_CHANGES');
  assert.match(post.body.body, /base a{40}/);
  assert.match(post.body.body, /local-review:review-test-001:/);
  assert.equal((await f.run()).state, 'verified');
  assert.equal(f.posts(), 1);
});
test('candidate drift, Draft, wrong CI, altered workflow and bad anchors fail before writes', async () => {
  for (const options of [
    { changeAt: 1 },
    { changeAt: 2 },
    { draft: true },
    { run: { workflow_id: 99 } },
    { run: { event: 'push' } },
    { run: { status: 'in_progress' } },
    { run: { pull_requests: [] } },
    { workflow: 'altered workflow' },
  ]) {
    const f = fixture(payload(), options);
    await assert.rejects(f.run());
    assert.equal(f.posts(), 0);
  }
  const p = payload();
  p.operation.comments[0].line = 200;
  const f = fixture(p);
  await assert.rejects(f.run());
  assert.equal(f.posts(), 0);
});
test('post-write base drift marks receipt stale', async () => {
  const f = fixture(payload(), { changeAt: 3 });
  assert.equal((await f.run()).state, 'stale');
});
test('reply allows Draft and an older thread, uses native reply, and reconciles without repost', async () => {
  const f = fixture(payload('reply'), { draft: true });
  assert.equal((await f.run()).state, 'verified');
  assert.ok(f.calls.find((c) => c.method === 'POST').path.endsWith('/comments/77/replies'));
  assert.equal((await f.run()).nativeId, 99);
  assert.equal(f.posts(), 1);
});
test('write response loss reconciles applied result, absent result remains uncertain', async () => {
  for (const type of ['review', 'reply']) {
    const applied = fixture(payload(type), { failWrite: 'applied' });
    assert.equal((await applied.run()).state, 'verified');
    assert.equal(applied.posts(), 1);
    const absent = fixture(payload(type), { failWrite: 'absent' });
    assert.equal((await absent.run()).state, 'uncertain');
    assert.equal(absent.posts(), 1);
  }
});
test('marker collision and incomplete readback stop safely', async () => {
  const conflict = fixture(payload(), { collision: true });
  await assert.rejects(conflict.run());
  assert.equal(conflict.posts(), 0);
  const partial = fixture(payload(), { missingComments: true });
  assert.equal((await partial.run()).state, 'uncertain');
});

test('wrong-PR reply and forged bot readback cannot complete', async () => {
  const wrong = fixture(payload('reply'), { wrongPr: true });
  await assert.rejects(wrong.run());
  assert.equal(wrong.posts(), 0);
  const f = fixture();
  await f.run();
  f.reviews[0].user = { ...bot, id: 1 };
  await assert.rejects(f.run());
  assert.equal(f.posts(), 1);
});
test('bounded pagination requires complete totals and stops on limits', async () => {
  await assert.rejects(pages(async () => ({ total_count: 2, jobs: [{}] }), '/jobs', 'jobs'));
  let calls = 0;
  await assert.rejects(
    pages(async () => {
      calls++;
      return Array(20).fill({});
    }, '/comments'),
  );
  assert.equal(calls, 15);
});
test('trusted main execution is owner-only and workflows never interpolate payload into shell', async () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: repo.full_name,
    GITHUB_ACTOR: 'glyad',
    GITHUB_ACTOR_ID: '4238205',
  };
  assert.equal(trustedExecution(env), true);
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/develop',
    GITHUB_REPOSITORY: 'other/repo',
    GITHUB_ACTOR: 'other',
    GITHUB_ACTOR_ID: '1',
  }))
    assert.equal(trustedExecution({ ...env, [key]: value }), false);
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../.github/workflows/reviewer-app-publish.yml', import.meta.url),
    'utf8',
  );
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /actions: read/);
  assert.match(source, /persist-credentials: false/);
  assert.equal(
    source
      .split('run:')
      .slice(1)
      .some((s) => s.split('\n')[0].includes('${{')),
    false,
  );
  assert.doesNotMatch(source, /pull_request_target|npm|artifact|head.sha/);
});

test('truncated diff hunks and unsynchronized parent cannot admit review', async () => {
  for (const options of [{ patch: '@@ -1,2 +1,3 @@\n one\n+two' }, { ancestor: 'c'.repeat(40) }]) {
    const f = fixture(payload(), options);
    await assert.rejects(f.run());
    assert.equal(f.posts(), 0);
  }
});

test('escaped dispatch envelope enforces byte limit independently of individual text limits', () => {
  const p = payload();
  p.operation.summary = '\t'.repeat(11000);
  p.operation.comments = Array.from({ length: 5 }, () => ({
    ...p.operation.comments[0],
    body: '\t'.repeat(5000),
  }));
  assert.throws(() => validatePayload(p));
});
test('prior ambiguous workflow and rerun cannot repeat POST when no marker exists', async () => {
  for (const options of [{ runAttempt: 2 }, { currentRunId: 201 }]) {
    const f = fixture();
    const request = async (method, path, body, status) =>
      path.includes('reviewer-app-publish.yml/runs?')
        ? {
            total_count: 1,
            workflow_runs: [{ id: 200, display_title: 'Local review review-test-001' }],
          }
        : f.request(method, path, body, status);
    assert.equal(
      (await publishOperation(f.p, request, { readyWorkflow: workflow, ...options })).state,
      'uncertain',
    );
    assert.equal(f.posts(), 0);
  }
});

test('approval without inline findings rejects incomplete diff hunks', async () => {
  const p = payload();
  p.operation.event = 'APPROVE';
  p.operation.comments = [];
  const f = fixture(p, { patch: '@@ -1,2 +1,3 @@\n one\n+two' });
  await assert.rejects(f.run());
  assert.equal(f.posts(), 0);
});

test('approval rejects complete-prefix patches whose change counts omit later whole hunks', async () => {
  const p = payload();
  p.operation.event = 'APPROVE';
  p.operation.comments = [];
  for (const file of [
    { additions: 2, deletions: 0, changes: 2 },
    { additions: 1, deletions: 1, changes: 2 },
    { additions: 1, deletions: 0, changes: 2 },
    { additions: '1', deletions: 0, changes: 1 },
    { additions: 1, deletions: -1, changes: 0 },
  ]) {
    const f = fixture(p, { patch: '@@ -0,0 +1 @@\n+first', file });
    await assert.rejects(f.run());
    assert.equal(f.posts(), 0);
  }
});
test('approval accepts exact native change counts for every parsed patch', async () => {
  const p = payload();
  p.operation.event = 'APPROVE';
  p.operation.comments = [];
  assert.equal((await fixture(p).run()).state, 'verified');
  assert.equal(
    (
      await fixture(p, {
        patch: '@@ -1 +1 @@\n-old\n+new',
        file: { additions: 1, deletions: 1, changes: 2 },
      }).run()
    ).state,
    'verified',
  );
});

// Synthetic public API-shaped metadata: no live responses or credentials are recorded.
function fullRepository() {
  const owner = {
    login: 'glyad',
    id: 4238205,
    node_id: 'MDQ6VXNlcjQyMzgyMDU=',
    type: 'User',
    site_admin: false,
  };
  for (const key of [
    'avatar_url',
    'url',
    'html_url',
    'followers_url',
    'following_url',
    'gists_url',
    'starred_url',
    'subscriptions_url',
    'organizations_url',
    'repos_url',
    'events_url',
    'received_events_url',
  ])
    owner[key] = `https://api.github.com/users/glyad/${key}`;
  const result = {
    ...repo,
    name: 'github-workspace-manager',
    private: false,
    owner,
    description: 'Portable AI-assisted GitHub provisioning and configuration management',
    fork: false,
  };
  for (const key of [
    'url',
    'html_url',
    'forks_url',
    'keys_url',
    'collaborators_url',
    'teams_url',
    'hooks_url',
    'issue_events_url',
    'events_url',
    'assignees_url',
    'branches_url',
    'tags_url',
    'blobs_url',
    'git_tags_url',
    'git_refs_url',
    'trees_url',
    'statuses_url',
    'languages_url',
    'stargazers_url',
    'contributors_url',
    'subscribers_url',
    'subscription_url',
    'commits_url',
    'git_commits_url',
    'comments_url',
    'issue_comment_url',
    'contents_url',
    'compare_url',
    'merges_url',
    'archive_url',
    'downloads_url',
    'issues_url',
    'pulls_url',
    'milestones_url',
    'notifications_url',
    'labels_url',
    'releases_url',
    'deployments_url',
  ])
    result[key] = `https://api.github.com/repos/${repo.full_name}/${key}/{ref}`;
  return result;
}
function fullRun(id, p, publisher = false) {
  return {
    id,
    node_id: `WFR_${id}`,
    name: publisher ? 'Local reviewer App publication' : 'Ready CI',
    workflow_id: publisher ? 56 : 55,
    path: publisher
      ? '.github/workflows/reviewer-app-publish.yml'
      : '.github/workflows/ready-ci.yml',
    display_title: publisher
      ? `Local review ${id === 201 ? p.operationId : 'other-operation-' + id}`
      : 'chore: a real source increment',
    event: publisher ? 'workflow_dispatch' : 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_branch: publisher ? 'main' : p.headRef,
    head_sha: p.headSha,
    run_number: id,
    run_attempt: 1,
    created_at: '2026-10-27T00:00:00Z',
    updated_at: '2026-10-27T00:05:00Z',
    url: `https://api.github.com/repos/${repo.full_name}/actions/runs/${id}`,
    html_url: `https://github.com/${repo.full_name}/actions/runs/${id}`,
    jobs_url: `https://api.github.com/repos/${repo.full_name}/actions/runs/${id}/jobs`,
    logs_url: `https://api.github.com/repos/${repo.full_name}/actions/runs/${id}/logs`,
    artifacts_url: `https://api.github.com/repos/${repo.full_name}/actions/runs/${id}/artifacts`,
    check_suite_url: `https://api.github.com/repos/${repo.full_name}/check-suites/${id}`,
    check_suite_id: id,
    actor: fullRepository().owner,
    triggering_actor: fullRepository().owner,
    head_commit: {
      id: p.headSha,
      tree_id: 'c'.repeat(40),
      message: 'chore: source increment',
      timestamp: '2026-10-27T00:00:00Z',
      author: { name: 'Example', email: 'example@example.com' },
      committer: { name: 'Example', email: 'example@example.com' },
    },
    repository: fullRepository(),
    head_repository: fullRepository(),
    pull_requests: publisher
      ? []
      : [
          {
            id: p.prId,
            number: p.prNumber,
            url: `https://api.github.com/repos/${repo.full_name}/pulls/${p.prNumber}`,
            base: { ref: p.baseRef, sha: p.baseSha, repo: fullRepository() },
            head: { ref: p.headRef, sha: p.headSha, repo: fullRepository() },
          },
        ],
  };
}
test('real publisher HTTP composition reads 80-KiB compare/file data, twenty full run records, and twenty-comment readback', async () => {
  const p = payload();
  p.operation.comments = Array.from({ length: 20 }, (_, index) => ({
    ...p.operation.comments[0],
    body: `Finding ${index}: ` + 'x'.repeat(900),
  }));
  const f = fixture(p, { patch: '@@ -1,2 +1,3 @@\n ' + 'x'.repeat(80 * 1024) + '\n+two\n three' });
  const readyRuns = Array.from({ length: 20 }, (_, i) => fullRun(100 + i, p));
  // Only newest run is associated; later historical records exercise full native metadata.
  for (const run of readyRuns.slice(1)) run.pull_requests[0].id++;
  const priorRuns = Array.from({ length: 20 }, (_, i) => fullRun(201 + i, p, true));
  assert.ok(
    Buffer.byteLength(JSON.stringify({ total_count: 20, workflow_runs: readyRuns })) > 65536,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ total_count: 20, workflow_runs: priorRuns })) > 65536,
  );
  const granted = { contents: 'read', metadata: 'read', pull_requests: 'write' };
  const owner = { id: 4238205, login: 'glyad' };
  let revoked = 0;
  const sizes = [];
  const routes = [];
  const fetchImpl = async (url, init) => {
    const path = url.slice('https://api.github.com'.length);
    routes.push({ path, credential: init.headers.Authorization });
    if (path === '/installation/token') {
      revoked++;
      return new Response(null, { status: 204 });
    }
    let value;
    if (path === '/app')
      value = {
        id: 5487224,
        client_id: 'Iv23ctaEdWaFhBYqhbZg',
        slug: 'glyad-workspace-reviewer',
        owner,
        permissions: granted,
      };
    else if (path === '/app/installations/175625005')
      value = {
        id: 175625005,
        app_id: 5487224,
        app_slug: 'glyad-workspace-reviewer',
        account: owner,
        repository_selection: 'selected',
        permissions: granted,
        suspended_at: null,
        suspended_by: null,
      };
    else if (path === '/app/installations/175625005/access_tokens')
      value = {
        token: 'synthetic-installation-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        repository_selection: 'selected',
        permissions: granted,
        repositories: [{ ...repo, owner }],
      };
    else if (path === '/installation/repositories')
      value = { total_count: 1, repositories: [{ ...repo, owner }] };
    else if (path.includes('/actions/workflows/55/runs?'))
      value = { total_count: 20, workflow_runs: path.endsWith('page=1') ? readyRuns : [] };
    else if (path.includes('/actions/workflows/reviewer-app-publish.yml/runs?'))
      value = { total_count: 20, workflow_runs: path.endsWith('page=1') ? priorRuns : [] };
    else if (path.includes('/compare/'))
      value = {
        merge_base_commit: { sha: p.baseSha },
        files: [{ filename: 'file.mjs', patch: 'x'.repeat(80 * 1024) }],
      };
    else if (path.includes('/reviews/88/comments?') && path.endsWith('page=2')) value = [];
    else {
      value = await f.request(init.method, path, init.body ? JSON.parse(init.body) : undefined);
    }
    if (path.includes('/reviews/88/comments?'))
      value = value.map((c) => ({
        ...c,
        diff_hunk: '@@ -1 +1 @@\n-' + 'x'.repeat(4000) + '\n+updated',
        url: `https://api.github.com/repos/${repo.full_name}/pulls/comments/${c.id}`,
        html_url: `https://github.com/${repo.full_name}/pull/12#discussion_r${c.id}`,
      }));
    sizes.push({ path, bytes: Buffer.byteLength(JSON.stringify(value)) });
    return Response.json(value, { status: init.method === 'POST' ? 201 : 200 });
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const receipt = await runPublisher({
    payload: p,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    actionsToken: 'synthetic-actions-token',
    fetchImpl,
    readyWorkflow: workflow,
    currentRunId: 201,
  });
  assert.equal(receipt.state, 'verified');
  assert.equal(receipt.revoked, true);
  assert.equal(revoked, 1);
  assert.equal(f.posts(), 1);
  for (const pattern of ['/compare/', '/files?', '/reviews/88/comments?'])
    assert.ok(sizes.find((r) => r.path.includes(pattern)).bytes > 80 * 1024);
  assert.ok(
    routes
      .filter((r) => r.path.includes('/actions/'))
      .every((r) => r.credential === 'Bearer synthetic-actions-token'),
  );
});
