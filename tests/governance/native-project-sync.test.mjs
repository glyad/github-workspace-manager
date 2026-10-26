import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStatus,
  synchronize,
  createApi,
  run,
} from '../../tools/governance/native-project-sync.mjs';

const issue = (extra = {}) => ({
  id: 'I1',
  number: 1,
  body: '## Acceptance\n- [x] Delivered',
  state: 'OPEN',
  stateReason: null,
  status: 'Planned',
  prs: [],
  children: [],
  dependencies: [],
  ...extra,
});
const pr = (extra = {}) => ({
  id: 'P1',
  state: 'OPEN',
  isDraft: true,
  baseRefName: 'develop',
  ci: false,
  ...extra,
});
test('intake remains unchanged and active/Draft work progresses', () => {
  assert.equal(decideStatus(issue()).status, null);
  assert.equal(decideStatus(issue({ prs: [pr()] })).status, 'In progress');
});
test('review requires every active PR Ready with current CI', () => {
  assert.equal(
    decideStatus(issue({ prs: [pr({ isDraft: false, ci: true })] })).status,
    'In review',
  );
  assert.equal(
    decideStatus(issue({ prs: [pr({ isDraft: false, ci: true }), pr()] })).status,
    'In progress',
  );
});
test('all delivery PRs and own acceptance are needed for integration', () => {
  const merged = pr({ state: 'MERGED' });
  assert.equal(decideStatus(issue({ prs: [merged, merged] })).status, 'Integrated');
  assert.equal(decideStatus(issue({ prs: [merged, pr()] })).status, 'In progress');
  assert.equal(
    decideStatus(issue({ prs: [merged], body: '## Acceptance\n- [ ] Pending' })).complete,
    false,
  );
  assert.equal(decideStatus(issue({ prs: [merged], body: 'No acceptance' })).complete, false);
});
test('aggregate needs valid children without inventing its own PR', () => {
  assert.equal(
    decideStatus(issue({ children: [{ complete: true, started: true }] })).complete,
    true,
  );
  assert.equal(
    decideStatus(issue({ children: [{ complete: false, started: true }] })).complete,
    false,
  );
});
test('closed-unmerged, cancelled children, dependencies, owner closure and Released are protected', () => {
  assert.ok(decideStatus(issue({ prs: [pr({ state: 'CLOSED' })] })).reason);
  assert.equal(
    decideStatus(issue({ children: [{ complete: false, reason: 'not planned' }] })).complete,
    false,
  );
  assert.equal(
    decideStatus(issue({ prs: [pr({ state: 'MERGED' })], dependencies: [{ complete: false }] }))
      .complete,
    false,
  );
  assert.equal(
    decideStatus(issue({ state: 'CLOSED', stateReason: 'NOT_PLANNED', prs: [pr()] })).status,
    null,
  );
  assert.equal(decideStatus(issue({ status: 'Released', prs: [pr()] })).status, null);
});

const config = {
  repository: 'glyad/github-workspace-manager',
  repositoryId: 'R1',
  native: {
    repositoryId: 'R1',
    projectId: 'PROJECT',
    fields: {
      Status: {
        id: 'STATUS',
        options: ['Backlog', 'Planned', 'In progress', 'In review', 'Integrated', 'Released'].map(
          (name) => ({ name, id: name }),
        ),
      },
    },
  },
};
const repository = { id: 'R1', nameWithOwner: config.repository };
const sha = 'a'.repeat(40),
  base = 'b'.repeat(40);
const nativePr = (extra = {}) => ({
  ...pr(),
  number: 8,
  repository,
  headRepository: repository,
  baseRefOid: base,
  headRefOid: sha,
  merged: false,
  mergedAt: null,
  updatedAt: '2026-10-26T01:00:00Z',
  ...extra,
});
const nativeIssue = (number, extra = {}) => ({
  ...issue(),
  id: `I${number}`,
  number,
  repository,
  parent: null,
  milestone: { id: 'M1' },
  updatedAt: '2026-10-26T01:00:00Z',
  ...extra,
});
const runRecord = (extra = {}) => ({
  id: 3,
  run_attempt: 1,
  name: 'Ready CI',
  path: '.github/workflows/ready-ci.yml',
  event: 'pull_request',
  repository: { full_name: config.repository },
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  pull_requests: [{ number: 8, head: { sha }, base: { sha: base } }],
  ...extra,
});
function fixture(records = [nativeIssue(1)], options = {}) {
  const calls = [],
    mutations = [];
  for (const parent of records)
    for (const n of parent.children) {
      const child = records.find((i) => i.number === n);
      if (child) child.parent = { id: parent.id, number: parent.number, repository };
    }
  const ref = (n) => ({ id: `I${n}`, number: n, repository });
  const api = async (request) => {
    calls.push(structuredClone(request));
    if (options.intercept) {
      const override = await options.intercept(request, { records, calls, mutations });
      if (override !== undefined) return override;
    }
    if (request.query?.startsWith('query Issue')) {
      return {
        repository: {
          issue: structuredClone(records.find((i) => i.number === request.variables.number)),
        },
      };
    }
    if (request.query?.startsWith('query Relation')) {
      const record = records.find((i) => i.id === request.variables.id);
      const key = /\{ (prs|children|dependencies|items|issues):/.exec(request.query)?.[1];
      let nodes =
        key === 'items'
          ? [
              {
                id: `ITEM${record.number}`,
                isArchived: false,
                project: { id: 'PROJECT' },
                fieldValueByName: {
                  name: record.status,
                  optionId: record.status,
                  field: { id: 'STATUS' },
                },
              },
            ]
          : key === 'issues'
            ? [ref(1)]
            : structuredClone(record[key]).map((x) => (typeof x === 'number' ? ref(x) : x));
      return {
        node: {
          [key]: {
            nodes,
            totalCount: nodes.length,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    }
    if (request.query?.startsWith('mutation Status')) {
      mutations.push(request);
      if (!options.badStatusReadback)
        records.find((i) => `ITEM${i.number}` === request.variables.input.itemId).status =
          request.variables.input.value.singleSelectOptionId;
      return {
        updateProjectV2ItemFieldValue: { projectV2Item: { id: request.variables.input.itemId } },
      };
    }
    if (request.method === 'PATCH') {
      mutations.push(request);
      if (!options.badClosureReadback) {
        const r = records.find((i) => i.number === Number(request.path.split('/').at(-1)));
        r.state = 'CLOSED';
        r.stateReason = 'COMPLETED';
      }
      return {};
    }
    if (request.path?.endsWith('/branches/develop'))
      return { commit: { sha: options.branchSha ?? base } };
    if (request.path?.includes('/compare/'))
      return (
        options.comparison ?? {
          status: 'ahead',
          base_commit: { sha: options.branchSha ?? base },
          merge_base_commit: { sha: options.branchSha ?? base },
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          commits: [{ sha }],
        }
      );
    if (request.path?.includes('/actions/workflows/'))
      return {
        total_count: (options.runs ?? [runRecord()]).length,
        workflow_runs: structuredClone(options.runs ?? [runRecord()]),
      };
    if (request.path?.includes('/actions/runs/'))
      return structuredClone(
        options.currentRun ??
          (options.runs ?? [runRecord()]).find(
            (r) => r.id === Number(request.path.split('/').at(-1)),
          ),
      );
    throw Error('Unexpected fake API request');
  };
  return {
    api,
    calls,
    mutations,
    records,
    sync: (numbers = [1]) => synchronize({ api, config, numbers, log: () => {} }),
  };
}

test('real adapter sets only Status, independently reads it, then closes completed', async () => {
  const f = fixture([
    nativeIssue(1, {
      prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: '2026-10-26T01:00:00Z' })],
    }),
  ]);
  const before = structuredClone(f.records[0]);
  await f.sync();
  assert.deepEqual(
    f.mutations.map((r) => r.method ?? 'graphql'),
    ['graphql', 'PATCH'],
  );
  assert.equal(f.records[0].status, 'Integrated');
  assert.equal(f.records[0].stateReason, 'COMPLETED');
  assert.deepEqual(f.records[0].milestone, before.milestone);
  assert.deepEqual(f.mutations[0].variables.input, {
    projectId: 'PROJECT',
    itemId: 'ITEM1',
    fieldId: 'STATUS',
    value: { singleSelectOptionId: 'Integrated' },
  });
  const writes = f.mutations.length;
  await f.sync();
  assert.equal(f.mutations.length, writes, 'idempotent rerun has no writes');
});
for (const [label, runs, currentRun, expected] of [
  ['current success', [runRecord()], null, 'In review'],
  [
    'live association base is not historical proof',
    [runRecord({ pull_requests: [{ number: 8, head: { sha }, base: { sha: 'c'.repeat(40) } }] })],
    null,
    'In review',
  ],
  ['stale head', [runRecord({ head_sha: 'c'.repeat(40) })], null, 'In progress'],
  [
    'failed latest',
    [runRecord(), runRecord({ id: 4, conclusion: 'failure' })],
    null,
    'In progress',
  ],
  ['cancelled', [runRecord({ conclusion: 'cancelled' })], null, 'In progress'],
  [
    'rerun pending',
    [runRecord()],
    runRecord({ run_attempt: 2, status: 'in_progress', conclusion: null }),
    'In progress',
  ],
  ['wrong workflow', [runRecord({ path: '.github/workflows/other.yml' })], null, 'In progress'],
  [
    'wrong repository',
    [runRecord({ repository: { full_name: 'other/repo' } })],
    null,
    'In progress',
  ],
])
  test(`adapter Ready CI gate: ${label}`, async () => {
    const f = fixture([nativeIssue(1, { prs: [nativePr({ isDraft: false })] })], {
      runs,
      ...(currentRun ? { currentRun } : {}),
    });
    await f.sync();
    assert.equal(f.records[0].status, expected);
    assert.equal(f.mutations.length, 1);
    assert.ok(!f.mutations.some((r) => r.method === 'PATCH'));
  });
test('refreshes actual parent after child completion without parent PR', async () => {
  const f = fixture([
    nativeIssue(1, {
      prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })],
      parent: { id: 'I2', number: 2, repository },
    }),
    nativeIssue(2, { children: [1] }),
  ]);
  await f.sync();
  assert.equal(f.records[1].state, 'CLOSED');
  assert.deepEqual(
    f.mutations.filter((r) => r.method === 'PATCH').map((r) => r.path.split('/').at(-1)),
    ['1', '2'],
  );
});
test('parent never completes from raw closed-child count', async () => {
  const f = fixture([
    nativeIssue(1, { children: [2] }),
    nativeIssue(2, { state: 'CLOSED', stateReason: 'COMPLETED', prs: [] }),
  ]);
  await f.sync();
  assert.equal(f.records[0].state, 'OPEN');
  assert.equal(f.mutations.length, 0);
});
for (const extra of [
  { state: 'CLOSED', stateReason: 'NOT_PLANNED' },
  { body: '## Acceptance\n- [ ] Pending' },
  { body: '## Acceptance\n```md\n- [x] Example\n```' },
  { prs: [nativePr({ state: 'CLOSED' })] },
])
  test(`incomplete/cancelled child blocks parent: ${JSON.stringify(extra)}`, async () => {
    const f = fixture([nativeIssue(1, { children: [2] }), nativeIssue(2, extra)]);
    await f.sync();
    assert.equal(f.records[0].state, 'OPEN');
    assert.ok(!f.mutations.some((r) => r.method === 'PATCH'));
  });
test('Released history stays intact but is not fabricated child evidence', async () => {
  const f = fixture([
    nativeIssue(1, { children: [2] }),
    nativeIssue(2, { status: 'Released', state: 'CLOSED', stateReason: 'COMPLETED' }),
  ]);
  await f.sync([1, 2]);
  assert.equal(f.mutations.length, 0);
});
test('owner cancellation is never reopened or recast as delivery', async () => {
  const f = fixture([
    nativeIssue(1, { state: 'CLOSED', stateReason: 'NOT_PLANNED', prs: [nativePr()] }),
  ]);
  await f.sync();
  assert.equal(f.mutations.length, 0);
});
for (const [label, change] of [
  [
    'null node',
    (c) => {
      c.nodes = [null];
      c.totalCount = 1;
    },
  ],
  [
    'missing page info',
    (c) => {
      delete c.pageInfo;
    },
  ],
  [
    'count mismatch',
    (c) => {
      c.totalCount = 1;
    },
  ],
  [
    'missing cursor',
    (c) => {
      c.pageInfo.hasNextPage = true;
      c.nodes = [{ id: 'P1', repository }];
      c.totalCount = 2;
    },
  ],
  [
    'duplicate node',
    (c) => {
      c.nodes = [
        { id: 'P1', repository },
        { id: 'P1', repository },
      ];
      c.totalCount = 2;
    },
  ],
])
  test(`incomplete relationship fails closed: ${label}`, async () => {
    const f = fixture(undefined, {
      intercept: (r) => {
        if (!r.query?.includes('prs:')) return;
        const c = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
        change(c);
        return { node: { prs: c } };
      },
    });
    await assert.rejects(f.sync());
    assert.equal(f.mutations.length, 0);
  });
test('real paginated links preserve all mapped delivery PRs', async () => {
  const merged = nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' });
  const f = fixture(undefined, {
    intercept: (r) => {
      if (!r.query?.includes('prs:')) return;
      return {
        node: {
          prs: {
            nodes: [r.variables.cursor ? nativePr({ id: 'P2' }) : merged],
            totalCount: 2,
            pageInfo: {
              hasNextPage: !r.variables.cursor,
              endCursor: r.variables.cursor ? null : 'next',
            },
          },
        },
      };
    },
  });
  await f.sync();
  assert.equal(f.records[0].status, 'In progress');
  assert.equal(f.records[0].state, 'OPEN');
  assert.ok(f.calls.some((r) => r.variables?.cursor === 'next'));
});
for (const [label, options] of [
  ['failed status readback', { badStatusReadback: true }],
  ['failed closure readback', { badClosureReadback: true }],
  [
    'uncertain status mutation',
    {
      intercept: (r) => {
        if (r.query?.startsWith('mutation')) throw Error('uncertain');
      },
    },
  ],
])
  test(`mutation failure stops without retry: ${label}`, async () => {
    const f = fixture(
      [nativeIssue(1, { prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })] })],
      options,
    );
    await assert.rejects(f.sync());
    assert.ok(f.calls.filter((r) => r.query?.startsWith('mutation')).length === 1);
    assert.ok(f.calls.filter((r) => r.method === 'PATCH').length <= 1);
  });
test('API read failure never mutates', async () => {
  const f = fixture(undefined, {
    intercept: () => {
      throw Error('unavailable');
    },
  });
  await assert.rejects(f.sync());
  assert.equal(f.mutations.length, 0);
});
test('fresh native source change prevents a write', async () => {
  let reads = 0;
  const f = fixture([nativeIssue(1, { prs: [nativePr()] })], {
    intercept: (r, { records }) => {
      if (r.query?.startsWith('query Issue')) {
        reads++;
        records[0].body += ` ${reads}`;
      }
    },
  });
  await assert.rejects(f.sync(), /changed/);
  assert.equal(f.mutations.length, 0);
});
test('scope/cycle bounds fail closed', async () => {
  const f = fixture([nativeIssue(1, { children: [2] }), nativeIssue(2, { children: [1] })]);
  await assert.rejects(f.sync(), /cycle/);
  assert.equal(f.mutations.length, 0);
});
test('credential interface blocks explicitly and transport separates Project token', async () => {
  assert.throws(() => createApi({ repositoryToken: 'repo' }), /PROJECTS_TOKEN/);
  const seen = [];
  const api = createApi({
    repositoryToken: 'repo',
    projectsToken: 'projects',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, text: async () => '{"data":{}}' };
    },
  });
  await api({ query: 'query Repo { viewer { login } }' });
  await api({ credential: 'project', query: 'query Project { viewer { login } }' });
  assert.deepEqual(
    seen.map((r) => r.init.headers.authorization),
    ['Bearer repo', 'Bearer projects'],
  );
  assert.ok(
    seen.every((r) => r.url === 'https://api.github.com/graphql' && r.init.redirect === 'error'),
  );
  await assert.rejects(api({ path: '/repos/other/repo/issues/1' }), /destination/);
});
test('transport has no automatic retry and redacts failed response bodies', async () => {
  let calls = 0;
  const api = createApi({
    repositoryToken: 'repo',
    projectsToken: 'projects',
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 403, text: async () => 'sensitive-canary' };
    },
  });
  await assert.rejects(
    api({ query: 'mutation Fail { viewer { login } }' }),
    (e) => !e.message.includes('canary'),
  );
  assert.equal(calls, 1);
});

test('advancing develop invalidates head-only CI even when live association base advances', async () => {
  const advanced = 'c'.repeat(40);
  const f = fixture(
    [nativeIssue(1, { prs: [nativePr({ isDraft: false, baseRefOid: advanced })] })],
    {
      branchSha: advanced,
      runs: [runRecord({ pull_requests: [{ number: 8, head: { sha }, base: { sha: advanced } }] })],
      comparison: {
        status: 'diverged',
        base_commit: { sha: advanced },
        merge_base_commit: { sha: base },
        ahead_by: 1,
        behind_by: 1,
        total_commits: 1,
        commits: [{ sha }],
      },
    },
  );
  await f.sync();
  assert.equal(f.records[0].status, 'In progress');
  assert.ok(!f.calls.some((r) => r.path?.includes('/actions/workflows/')));
});
for (const [label, extra, complete] of [
  [
    'closed complete with merged delivery',
    {
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })],
    },
    true,
  ],
  [
    'open despite eligible evidence',
    { prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })] },
    false,
  ],
  ['cancelled', { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, false],
  ['closed count without evidence', { state: 'CLOSED', stateReason: 'COMPLETED' }, false],
])
  test(`native dependency gate: ${label}`, async () => {
    const f = fixture([
      nativeIssue(1, {
        prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })],
        dependencies: [2],
      }),
      nativeIssue(2, extra),
    ]);
    await f.sync();
    assert.equal(f.records[0].state === 'CLOSED', complete);
    assert.equal(f.records[1].status, 'Planned', 'dependency is not a mutation target');
  });
for (const [label, patch] of [
  [
    'archived item',
    (c) => {
      c.nodes[0].isArchived = true;
    },
  ],
  [
    'missing item',
    (c) => {
      c.nodes = [];
      c.totalCount = 0;
    },
  ],
  [
    'unknown Status',
    (c) => {
      c.nodes[0].fieldValueByName.name = 'Done';
    },
  ],
  [
    'foreign project',
    (c) => {
      c.nodes[0].project.id = 'OTHER';
    },
  ],
])
  test(`Project target rejected: ${label}`, async () => {
    const f = fixture(undefined, {
      intercept: (r) => {
        if (!r.query?.includes('items:')) return;
        const c = {
          nodes: [
            {
              id: 'ITEM1',
              isArchived: false,
              project: { id: 'PROJECT' },
              fieldValueByName: { name: 'Planned', optionId: 'Planned', field: { id: 'STATUS' } },
            },
          ],
          totalCount: 1,
          pageInfo: { hasNextPage: false },
        };
        patch(c);
        return { node: { items: c } };
      },
    });
    await assert.rejects(f.sync());
    assert.equal(f.mutations.length, 0);
  });
test('foreign relationship cannot import scope', async () => {
  const f = fixture([
    nativeIssue(1, {
      prs: [nativePr({ repository: { id: 'OTHER', nameWithOwner: 'other/repo' } })],
    }),
  ]);
  await assert.rejects(f.sync(), /outside/);
  assert.equal(f.mutations.length, 0);
});
test('bounded pagination rejects a never-ending relationship', async () => {
  let page = 0;
  const f = fixture(undefined, {
    intercept: (r) => {
      if (!r.query?.includes('prs:')) return;
      page++;
      return {
        node: {
          prs: {
            nodes: [{ ...nativePr(), id: `P${page}` }],
            totalCount: 1000,
            pageInfo: { hasNextPage: true, endCursor: `page${page}` },
          },
        },
      };
    },
  });
  await assert.rejects(f.sync(), /Pagination bound/);
  assert.equal(page, 10);
  assert.equal(f.mutations.length, 0);
});
test('ambiguous PR state cannot be used as completion evidence', async () => {
  const f = fixture([
    nativeIssue(1, { prs: [nativePr({ state: 'MERGED', merged: false, mergedAt: 'now' })] }),
  ]);
  await assert.rejects(f.sync(), /Incomplete PR/);
  assert.equal(f.mutations.length, 0);
});

function eventRunner(eventName, event, f, override = {}) {
  const env = {
    GITHUB_REPOSITORY: config.repository,
    GITHUB_TOKEN: 'repo',
    PROJECTS_TOKEN: 'projects',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: '/fake/event',
    ...override,
  };
  const fetchImpl = async (url, init) => {
    const input = init.body ? JSON.parse(init.body) : undefined;
    const request = input?.query
      ? {
          credential: init.headers.authorization === 'Bearer projects' ? 'project' : 'repository',
          ...input,
        }
      : {
          path: new URL(url).pathname + new URL(url).search,
          method: init.method,
          ...(input ? { body: input } : {}),
        };
    const data = await f.api(request);
    return { ok: true, text: async () => JSON.stringify(input?.query ? { data } : data) };
  };
  return run({
    env,
    fetchImpl,
    log: () => {},
    read: async (path) => JSON.stringify(path === '/fake/event' ? event : config),
  });
}
const eventRepo = { full_name: config.repository, node_id: 'R1' };
test('trusted issues event reaches real transport and preserves intake', async () => {
  const f = fixture();
  await eventRunner('issues', { repository: eventRepo, issue: { number: 1 } }, f);
  assert.equal(f.mutations.length, 0);
  assert.ok(f.calls.some((c) => c.credential === 'project'));
});
test('PR metadata event follows freshly paginated native Issue links', async () => {
  const f = fixture([nativeIssue(1, { prs: [nativePr()] })], {
    intercept: (r) => {
      if (r.path === `/repos/${config.repository}/pulls/8`)
        return {
          node_id: 'P1',
          base: { ref: 'develop', repo: { full_name: config.repository, node_id: 'R1' } },
        };
      if (r.query?.includes('issues:'))
        return {
          node: {
            issues: {
              nodes: [{ id: 'I1', number: 1, repository }],
              totalCount: 1,
              pageInfo: { hasNextPage: false },
            },
          },
        };
    },
  });
  await eventRunner(
    'pull_request_target',
    { repository: eventRepo, pull_request: { number: 8, node_id: 'P1' } },
    f,
  );
  assert.equal(f.records[0].status, 'In progress');
});
test('completed workflow event refreshes current state, including failed CI', async () => {
  const failed = runRecord({ conclusion: 'failure' });
  const f = fixture(
    [nativeIssue(1, { prs: [nativePr({ isDraft: false })], status: 'In review' })],
    {
      runs: [failed],
      intercept: (r) => {
        if (r.path === `/repos/${config.repository}/pulls/8`)
          return {
            node_id: 'P1',
            base: { ref: 'develop', repo: { full_name: config.repository, node_id: 'R1' } },
          };
        if (r.query?.includes('issues:'))
          return {
            node: {
              issues: {
                nodes: [{ id: 'I1', number: 1, repository }],
                totalCount: 1,
                pageInfo: { hasNextPage: false },
              },
            },
          };
      },
    },
  );
  await eventRunner(
    'workflow_run',
    { repository: eventRepo, action: 'completed', workflow_run: failed },
    f,
  );
  assert.equal(f.records[0].status, 'In progress');
});
for (const [label, eventName, event, override] of [
  [
    'missing credential',
    'issues',
    { repository: eventRepo, issue: { number: 1 } },
    { PROJECTS_TOKEN: '' },
  ],
  [
    'foreign event',
    'issues',
    { repository: { full_name: 'other/repo', node_id: 'R2' }, issue: { number: 1 } },
    {},
  ],
  ['unsupported event', 'push', { repository: eventRepo }, {}],
  [
    'foreign workflow',
    'workflow_run',
    { repository: eventRepo, action: 'completed', workflow_run: runRecord({ name: 'Other' }) },
    {},
  ],
])
  test(`event boundary fails before mutation: ${label}`, async () => {
    const f = fixture();
    await assert.rejects(eventRunner(eventName, event, f, override));
    assert.equal(f.mutations.length, 0);
  });
test('empty fork workflow association requires manual reconciliation', async () => {
  const currentRun = runRecord({ pull_requests: [] });
  const f = fixture(undefined, { currentRun });
  await assert.rejects(
    eventRunner(
      'workflow_run',
      { repository: eventRepo, action: 'completed', workflow_run: currentRun },
      f,
    ),
    /association/,
  );
  assert.equal(f.mutations.length, 0);
});

for (const body of [
  '## Acceptance\n- [x] Delivered A\n1. [ ] Requirement B',
  '## Acceptance\n- [x] Delivered A\n1) [ ] Requirement B',
  '## Acceptance\n- [x] Delivered A\n````\n```\n````\n- [ ] Requirement B',
  '## Acceptance\n- [x] Delivered A\n~~~~\n~~~\n~~~~\n- [ ] Requirement B',
])
  test(`R1 unchecked acceptance remains open: ${JSON.stringify(body)}`, async () => {
    const f = fixture([
      nativeIssue(1, { body, prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })] }),
    ]);
    await f.sync();
    assert.equal(f.records[0].state, 'OPEN');
    assert.ok(
      !f.mutations.some(
        (r) =>
          r.method === 'PATCH' || r.variables?.input?.value?.singleSelectOptionId === 'Integrated',
      ),
    );
  });
test('R2 current head containing advanced develop qualifies despite live association base changes', async () => {
  const advanced = 'c'.repeat(40);
  const f = fixture(
    [nativeIssue(1, { prs: [nativePr({ isDraft: false, baseRefOid: advanced })] })],
    { branchSha: advanced },
  );
  await f.sync();
  assert.equal(f.records[0].status, 'In review');
  assert.ok(f.calls.some((r) => r.path?.includes(`/compare/${advanced}...${sha}`)));
});
for (const [label, comparison] of [
  [
    'wrong base identity',
    {
      status: 'ahead',
      base_commit: { sha: 'c'.repeat(40) },
      merge_base_commit: { sha: base },
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commits: [{ sha }],
    },
  ],
  [
    'wrong tested head identity',
    {
      status: 'ahead',
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commits: [{ sha: 'c'.repeat(40) }],
    },
  ],
])
  test(`R2 comparison identity rejects ${label}`, async () => {
    const f = fixture([nativeIssue(1, { prs: [nativePr({ isDraft: false })] })], { comparison });
    await assert.rejects(f.sync(), /comparison/);
    assert.equal(f.mutations.length, 0);
  });

test('R1 checked ordered tasks and fenced examples can complete', async () => {
  const f = fixture([
    nativeIssue(1, {
      body: '## Acceptance\n1. [x] Delivered\n2) [X] Verified\n````\n```\n- [ ] Example only\n````',
      prs: [nativePr({ state: 'MERGED', merged: true, mergedAt: 'now' })],
    }),
  ]);
  await f.sync();
  assert.equal(f.records[0].state, 'CLOSED');
});
test('R2 identical exact commits qualify', async () => {
  const f = fixture([nativeIssue(1, { prs: [nativePr({ isDraft: false, headRefOid: base })] })], {
    runs: [runRecord({ head_sha: base })],
    comparison: {
      status: 'identical',
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      total_commits: 0,
      ahead_by: 0,
      behind_by: 0,
      commits: [],
    },
  });
  await f.sync();
  assert.equal(f.records[0].status, 'In review');
});
test('R2 comparison explicitly fetches final chronological commit identity', async () => {
  const f = fixture([nativeIssue(1, { prs: [nativePr({ isDraft: false })] })], {
    intercept: (r) => {
      if (!r.path?.includes('/compare/')) return;
      return {
        status: 'ahead',
        base_commit: { sha: base },
        merge_base_commit: { sha: base },
        total_commits: 5,
        ahead_by: 5,
        behind_by: 0,
        commits: [{ sha: r.path.endsWith('page=5') ? sha : 'c'.repeat(40) }],
      };
    },
  });
  await f.sync();
  assert.equal(f.records[0].status, 'In review');
  assert.ok(f.calls.some((r) => r.path?.includes('/compare/') && r.path.endsWith('page=5')));
});
