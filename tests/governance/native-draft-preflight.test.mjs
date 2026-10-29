import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflowPath = '.github/workflows/native-draft-preflight.yml';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const main = 'c'.repeat(40);
const request = 'request_12345678';
const runName = `draft-preflight|pr=72|base=${base}|head=${head}|request=${request}`;
const repo = { id: 1427426748, full_name: 'glyad/github-workspace-manager' };
function fixture() {
  return {
    '/repos/glyad/github-workspace-manager': repo,
    '/repos/glyad/github-workspace-manager/pulls/72': {
      id: 123,
      number: 72,
      state: 'open',
      draft: true,
      node_id: 'PR_123',
      created_at: '2026-10-29T12:00:00Z',
      base: { ref: 'develop', sha: base, repo },
      head: { ref: 'fix/72-native-workflow', sha: head, repo },
    },
    '/repos/glyad/github-workspace-manager/git/ref/heads/develop': { object: { sha: base } },
    '/repos/glyad/github-workspace-manager/git/ref/heads/main': { object: { sha: main } },
    [`/repos/glyad/github-workspace-manager/compare/${base}...${head}`]: {
      status: 'ahead',
      merge_base_commit: { sha: base },
    },
    '/repos/glyad/github-workspace-manager/actions/workflows/native-draft-preflight.yml': {
      id: 44,
      path: workflowPath,
      state: 'active',
    },
    '/repos/glyad/github-workspace-manager/actions/runs/1234': {
      id: 1234,
      run_attempt: 1,
      workflow_id: 44,
      path: workflowPath,
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: main,
      repository: repo,
      actor: { login: 'glyad' },
      triggering_actor: { login: 'glyad' },
      display_title: runName,
    },
    '/repos/glyad/github-workspace-manager/actions/workflows/44/runs?event=workflow_dispatch&per_page=100':
      {
        total_count: 1,
        workflow_runs: [{ id: 1234, display_title: runName }],
      },
    '/graphql': {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_123',
            number: 72,
            createdAt: '2026-10-29T12:00:00Z',
            isDraft: true,
            state: 'OPEN',
            baseRefName: 'develop',
            baseRefOid: base,
            headRefName: 'fix/72-native-workflow',
            headRefOid: head,
            timelineItems: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, hasPreviousPage: false },
              nodes: [{ id: 'DRAFT_1', __typename: 'ConvertToDraftEvent' }],
            },
          },
        },
      },
    },
  };
}
async function execute({ change = () => {}, env = {} } = {}) {
  const text = await readFile(workflowPath, 'utf8');
  const matches = [
    ...text.matchAll(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE\n/g),
  ];
  assert.equal(matches.length, 2, 'both complete hosted heredocs are present');
  assert.equal(matches[0][1], matches[1][1], 'same complete script for prepare and final');
  // Remove YAML block indentation only, exactly as the workflow runner does.
  const code = matches[0][1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: code,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const dir = await mkdtemp(join(tmpdir(), 'draft-preflight-'));
  try {
    const data = fixture();
    change(data);
    await writeFile(join(dir, 'responses.json'), JSON.stringify(data));
    await writeFile(
      join(dir, 'mock.mjs'),
      String.raw`
import { readFileSync } from 'node:fs';
const responses = JSON.parse(readFileSync(process.env.RESPONSES));
globalThis.fetch = async (url, options) => {
  if (new URL(url).origin !== 'https://api.github.com') throw Error('unexpected API origin');
  if (options.headers.authorization !== 'Bearer test-read-token') throw Error('missing read credential');
  let value = responses[new URL(url).pathname + new URL(url).search];
  if (new URL(url).pathname === '/graphql' && Array.isArray(value?.data?.repository?.pullRequest?.timelineItems?.nodes)) {
    const types = JSON.parse(options.body).query.match(/itemTypes:\[([^\]]+)\]/)?.[1].split(',');
    const names = { ConvertToDraftEvent: 'CONVERT_TO_DRAFT_EVENT', ReadyForReviewEvent: 'READY_FOR_REVIEW_EVENT', HeadRefForcePushedEvent: 'HEAD_REF_FORCE_PUSHED_EVENT', BaseRefChangedEvent: 'BASE_REF_CHANGED_EVENT', ClosedEvent: 'CLOSED_EVENT', ReopenedEvent: 'REOPENED_EVENT' };
    const timeline = value.data.repository.pullRequest.timelineItems;
    const filtered = timeline.nodes.filter((node) => types?.includes(names[node.__typename]));
    value = structuredClone(value);
    value.data.repository.pullRequest.timelineItems.nodes = filtered;
    value.data.repository.pullRequest.timelineItems.totalCount -= timeline.nodes.length - filtered.length;
  }
  if (!value) throw Error('unexpected endpoint: ' + url);
  return { ok: !value.denied, status: value.denied ? 403 : 200, json: async () => value };
};
`,
    );
    await writeFile(join(dir, 'validator.mjs'), code);
    const result = spawnSync(
      process.execPath,
      ['--import', join(dir, 'mock.mjs'), join(dir, 'validator.mjs')],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          RESPONSES: join(dir, 'responses.json'),
          GITHUB_OUTPUT: join(dir, 'output'),
          GH_TOKEN: 'test-read-token',
          INPUTS: JSON.stringify({
            pr_number: '72',
            expected_base: base,
            expected_head: head,
            request_id: request,
          }),
          GITHUB_REPOSITORY: repo.full_name,
          GITHUB_REPOSITORY_ID: String(repo.id),
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: main,
          WORKFLOW_SHA: main,
          WORKFLOW_REF: `${repo.full_name}/${workflowPath}@refs/heads/main`,
          GITHUB_ACTOR: 'glyad',
          GITHUB_TRIGGERING_ACTOR: 'glyad',
          GITHUB_RUN_ID: '1234',
          GITHUB_RUN_ATTEMPT: '1',
          PHASE: 'prepare',
          ...env,
        },
      },
    );
    let output = '';
    try {
      output = await readFile(join(dir, 'output'), 'utf8');
    } catch {
      /* rejected requests emit none */
    }
    return { ...result, output };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('actual trusted validator captures the exact Draft tuple', async () => {
  const result = await execute();
  assert.equal(result.status, 0, result.stderr);
  const tuple = JSON.parse(result.output.match(/^tuple=(.+)$/m)[1]);
  assert.equal(tuple.head, head);
  assert.equal(tuple.base, base);
  assert.equal(tuple.source, main);
  assert.equal(tuple.prId, 123);
  assert.deepEqual(tuple.lifecycle.events, [{ id: 'DRAFT_1', type: 'ConvertToDraftEvent' }]);
});
for (const [name, path, mutate] of [
  [
    'stale head',
    '/pulls/72',
    (x) => {
      x.head.sha = main;
    },
  ],
  [
    'stale parent',
    '/git/ref/heads/develop',
    (x) => {
      x.object.sha = main;
    },
  ],
  [
    'fork',
    '/pulls/72',
    (x) => {
      x.head.repo = { ...repo, id: 42 };
    },
  ],
  [
    'Ready',
    '/pulls/72',
    (x) => {
      x.draft = false;
    },
  ],
  [
    'closed',
    '/pulls/72',
    (x) => {
      x.state = 'closed';
    },
  ],
  [
    'wrong run source',
    '/actions/runs/1234',
    (x) => {
      x.head_sha = head;
    },
  ],
  [
    'forged run binding',
    '/actions/runs/1234',
    (x) => {
      x.display_title += '|extra';
    },
  ],
  [
    'permission denied',
    '/pulls/72',
    (x) => {
      x.denied = true;
    },
  ],
])
  test(`rejects ${name}`, async () => {
    const result = await execute({
      change: (data) => mutate(data[`/repos/${repo.full_name}${path}`]),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  });
for (const inputs of [
  { pr_number: '72/../../actions' },
  { expected_head: '$(touch bad)' },
  { request_id: 'bad\nrequest' },
  { expected_base: head },
])
  test(`rejects malformed or mismatched assertions ${JSON.stringify(inputs)}`, async () => {
    const result = await execute({
      env: {
        INPUTS: JSON.stringify({
          pr_number: '72',
          expected_base: base,
          expected_head: head,
          request_id: request,
          ...inputs,
        }),
      },
    });
    assert.notEqual(result.status, 0);
  });
test('rejects repeated attempts and unauthorized actors', async () => {
  for (const env of [
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_ACTOR: 'other' },
    { GITHUB_TRIGGERING_ACTOR: 'other' },
  ]) {
    assert.notEqual((await execute({ env })).status, 0);
  }
});
test('rejects duplicate requests or newer candidate cycles', async () => {
  for (const display_title of [runName, runName.replace(request, 'new_request_123')]) {
    const result = await execute({
      change: (data) => {
        const runs =
          data[
            `/repos/${repo.full_name}/actions/workflows/44/runs?event=workflow_dispatch&per_page=100`
          ];
        runs.total_count = 2;
        runs.workflow_runs.unshift({ id: 1235, display_title });
      },
    });
    assert.notEqual(result.status, 0);
  }
});
test('final validation requires actual successful jobs and unchanged tuple/lifecycle', async () => {
  const prepared = await execute();
  const captured = prepared.output.match(/^tuple=(.+)$/m)[1];
  assert.equal(
    (
      await execute({
        env: {
          PHASE: 'current',
          CAPTURED: captured,
          PREPARE_RESULT: 'success',
          CHECKS_RESULT: 'success',
        },
      })
    ).status,
    0,
  );
  for (const failure of ['failure', 'skipped', 'cancelled', '', 'neutral']) {
    assert.notEqual(
      (
        await execute({
          env: {
            PHASE: 'current',
            CAPTURED: captured,
            PREPARE_RESULT: 'success',
            CHECKS_RESULT: failure,
          },
        })
      ).status,
      0,
    );
  }
  assert.notEqual(
    (
      await execute({
        env: {
          PHASE: 'current',
          CAPTURED: captured,
          PREPARE_RESULT: 'success',
          CHECKS_RESULT: 'success',
        },
        change: (data) => {
          data['/graphql'].data.repository.pullRequest.timelineItems.nodes[0].id = 'DRAFT_2';
        },
      })
    ).status,
    0,
  );
});
test('workflow keeps candidate execution isolated and explicit', async () => {
  const yaml = await readFile(workflowPath, 'utf8');
  assert.match(yaml, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(yaml, /(?:pull_request|workflow_run|schedule|push):|: write|secrets\./);
  const checks = yaml.split('\n  checks:\n')[1].split('\n  current:\n')[0];
  assert.doesNotMatch(checks, /GH_TOKEN|github.token|INPUTS|CAPTURED|curl|gh api/);
  assert.match(checks, /repository: glyad\/github-workspace-manager/);
  assert.match(checks, /ref: \$\{\{ needs.prepare.outputs.head \}\}/);
  assert.match(checks, /persist-credentials: false/);
  assert.match(checks, /npm ci --ignore-scripts\n          npm run check:local/);
  assert.match(yaml, /needs: \[prepare, checks\]\n    if: \$\{\{ always\(\) \}\}/);
  assert.equal((yaml.match(/actions\/checkout@/g) || []).length, 1);
  assert.doesNotMatch(yaml, /upload-artifact|download-artifact|continue-on-error/);
});

test('newly created Draft with complete empty lifecycle history can run its first checks', async () => {
  const initial = (data) => {
    const timeline = data['/graphql'].data.repository.pullRequest.timelineItems;
    timeline.nodes = [];
    timeline.totalCount = 0;
  };
  const prepared = await execute({ change: initial });
  assert.equal(prepared.status, 0, prepared.stderr);
  const captured = prepared.output.match(/^tuple=(.+)$/m)[1];
  assert.deepEqual(JSON.parse(captured).lifecycle.events, []);
  assert.equal(JSON.parse(captured).lifecycle.createdAt, '2026-10-29T12:00:00Z');
  assert.equal(
    (
      await execute({
        change: initial,
        env: {
          PHASE: 'current',
          CAPTURED: captured,
          PREPARE_RESULT: 'success',
          CHECKS_RESULT: 'success',
        },
      })
    ).status,
    0,
  );
  assert.notEqual(
    (
      await execute({
        env: {
          PHASE: 'current',
          CAPTURED: captured,
          PREPARE_RESULT: 'success',
          CHECKS_RESULT: 'success',
        },
      })
    ).status,
    0,
  );
});
test('same open Draft pair after close and reopen invalidates the captured cycle', async () => {
  const prepared = await execute();
  assert.equal(prepared.status, 0, prepared.stderr);
  const captured = prepared.output.match(/^tuple=(.+)$/m)[1];
  const result = await execute({
    env: {
      PHASE: 'current',
      CAPTURED: captured,
      PREPARE_RESULT: 'success',
      CHECKS_RESULT: 'success',
    },
    change: (data) => {
      const timeline = data['/graphql'].data.repository.pullRequest.timelineItems;
      timeline.nodes.push(
        { id: 'CLOSED_1', __typename: 'ClosedEvent' },
        { id: 'REOPENED_1', __typename: 'ReopenedEvent' },
      );
      timeline.totalCount = 3;
    },
  });
  assert.notEqual(
    result.status,
    0,
    'an intervening close/reopen must invalidate the same-pair proof',
  );
});
test('missing malformed or incomplete lifecycle data never passes as an initial Draft', async () => {
  for (const mutate of [
    (pr) => {
      delete pr.timelineItems;
    },
    (pr) => {
      pr.timelineItems.nodes = null;
    },
    (pr) => {
      pr.timelineItems.pageInfo.hasNextPage = true;
    },
    (pr) => {
      pr.timelineItems.pageInfo.hasPreviousPage = true;
    },
    (pr) => {
      pr.timelineItems.totalCount = -1;
    },
    (pr) => {
      pr.createdAt = undefined;
    },
  ])
    assert.notEqual(
      (await execute({ change: (data) => mutate(data['/graphql'].data.repository.pullRequest) }))
        .status,
      0,
    );
});

test('real GitHub filtered timeline count semantics preserve complete observations', async () => {
  // Observed read-only on PR71: totalCount=8, two filtered nodes, both pageInfo flags false.
  const result = await execute({
    change: (data) => {
      data['/graphql'].data.repository.pullRequest.timelineItems.totalCount = 8;
    },
  });
  assert.equal(result.status, 0, result.stderr);
});
