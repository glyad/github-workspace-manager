import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDraft,
  handleDraftEvent,
  createGitHubAdapter,
} from '../../tools/governance/native-pr-draft.mjs';

const sha = (c) => c.repeat(40);
const repo = { id: 1, full_name: 'glyad/github-workspace-manager', default_branch: 'main' };
function fixture(kind = 'push') {
  const pr = {
    number: 7,
    node_id: 'PR_7',
    state: 'open',
    draft: false,
    head: { sha: sha('b'), ref: 'chore/test', repo },
    base: { sha: sha('a'), ref: 'develop', repo },
    updated_at: '2026-10-25T12:02:00Z',
  };
  const workflow = { id: 10, name: 'Ready CI', path: '.github/workflows/ready-ci.yml' };
  const run = {
    id: 20,
    run_attempt: 1,
    name: 'Ready CI',
    path: workflow.path,
    workflow_id: 10,
    repository: structuredClone(repo),
    head_repository: structuredClone(repo),
    head_branch: pr.head.ref,
    head_sha: sha('c'),
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    created_at: '2026-10-25T12:01:00Z',
    pull_requests: [
      {
        id: 70,
        number: 7,
        head: { sha: sha('b'), ref: pr.head.ref },
        base: { sha: sha('a'), ref: 'develop' },
      },
    ],
  };
  pr.id = 70;
  const event =
    kind === 'push'
      ? {
          action: 'synchronize',
          repository: structuredClone(repo),
          number: 7,
          before: sha('d'),
          after: sha('b'),
          pull_request: structuredClone(pr),
        }
      : {
          action: 'completed',
          repository: structuredClone(repo),
          workflow_run: structuredClone(run),
        };
  return {
    eventName: kind === 'push' ? 'pull_request_target' : 'workflow_run',
    event,
    repo,
    pr,
    workflow,
    run,
    timeline: [{ id: 30, event: 'ready_for_review', created_at: '2026-10-25T12:00:00Z' }],
  };
}
test('matching Ready push and current failed Ready CI draft the current candidate', () => {
  for (const kind of ['push', 'failure']) assert.equal(decideDraft(fixture(kind)).action, 'draft');
});
for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
  test(`applicable ${conclusion} run drafts`, () => {
    const f = fixture('failure');
    f.event.workflow_run.conclusion = f.run.conclusion = conclusion;
    assert.equal(decideDraft(f).action, 'draft');
  });
}
for (const change of [
  (f) => {
    f.pr.draft = true;
  },
  (f) => {
    f.pr.state = 'closed';
  },
  (f) => {
    f.pr.head.sha = sha('e');
  },
  (f) => {
    f.pr.base.sha = sha('e');
  },
  (f) => {
    f.pr.base.ref = 'main';
  },
  (f) => {
    f.event.pull_request.draft = true;
  },
])
  test('stale, Draft, closed or mismatched push cannot mutate', () => {
    const f = fixture();
    change(f);
    assert.notEqual(decideDraft(f).action, 'draft');
  });
for (const kind of ['push', 'failure']) {
  test(`${kind}: later Ready, same-second Ready and missing history cannot mutate`, () => {
    for (const time of [
      '2026-10-25T12:03:00Z',
      ...(kind === 'push' ? ['2026-10-25T12:02:00Z'] : []),
    ]) {
      const f = fixture(kind);
      f.timeline.push({ id: 31, event: 'ready_for_review', created_at: time });
      assert.notEqual(decideDraft(f).action, 'draft');
    }
    const f = fixture(kind);
    f.timeline = [];
    assert.equal(decideDraft(f).action, 'manual');
  });
  test(`${kind}: intervening Draft/close/reopen history blocks automatic mutation`, () => {
    for (const event of ['converted_to_draft', 'closed', 'reopened']) {
      const f = fixture(kind);
      f.timeline.push({ id: 31, event, created_at: '2026-10-25T12:00:30Z' });
      assert.equal(decideDraft(f).action, 'manual');
    }
  });
}
for (const change of [
  (f) => {
    f.event.repository.id = 2;
  },
  (f) => {
    f.pr.node_id = null;
  },
  (f) => {
    f.pr.head.repo = null;
  },
  (f) => {
    f.timeline[0].created_at = 'bad';
  },
  (f) => {
    f.timeline.push({ ...f.timeline[0] });
  },
])
  test('missing or ambiguous native identity/history blocks', () => {
    const f = fixture();
    change(f);
    assert.equal(decideDraft(f).action, 'manual');
  });
for (const change of [
  (f) => {
    f.run.workflow_id = 11;
  },
  (f) => {
    f.workflow.path = '.github/workflows/other.yml';
  },
  (f) => {
    f.run.repository.id = 2;
  },
  (f) => {
    f.run.head_repository.id = 2;
  },
  (f) => {
    f.run.event = 'push';
  },
  (f) => {
    f.run.run_attempt = 2;
  },
  (f) => {
    f.run.pull_requests = [];
  },
  (f) => {
    f.run.pull_requests[0].head.sha = sha('e');
  },
  (f) => {
    f.run.pull_requests[0].base.sha = sha('e');
  },
  (f) => {
    f.run.pull_requests[0].number = 8;
  },
  (f) => {
    f.run.conclusion = 'success';
  },
])
  test('wrong or stale workflow/run/PR cannot mutate', () => {
    const f = fixture('failure');
    change(f);
    assert.notEqual(decideDraft(f).action, 'draft');
  });
function fake(f = fixture()) {
  let writes = 0,
    reads = 0;
  return {
    get writes() {
      return writes;
    },
    async observe() {
      reads++;
      return structuredClone(f);
    },
    async draft(id) {
      assert.equal(id, 'PR_7');
      writes++;
      f.pr.draft = true;
    },
    async readPR() {
      assert.ok(reads >= 2);
      return structuredClone(f.pr);
    },
  };
}
test('adapter orchestration rechecks and independently verifies Draft', async () => {
  const api = fake();
  const result = await handleDraftEvent(api);
  assert.equal(result.action, 'drafted');
  assert.equal(api.writes, 1);
});
test('new Ready during recheck invalidates the mutation', async () => {
  const f = fixture();
  const api = fake(f);
  let reads = 0;
  const observe = api.observe;
  api.observe = async () => {
    if (++reads === 2)
      f.timeline.push({ id: 31, event: 'ready_for_review', created_at: '2026-10-25T12:03:00Z' });
    return observe();
  };
  assert.notEqual((await handleDraftEvent(api)).action, 'drafted');
  assert.equal(api.writes, 0);
});
test('uncertain mutation and failed readback never retry', async () => {
  for (const failure of ['write', 'readback', 'ready']) {
    const api = fake();
    let writes = 0;
    api.draft = async () => {
      writes++;
      if (failure === 'write') throw Error('network');
    };
    api.readPR = async () => {
      if (failure === 'readback') throw Error('network');
      return fixture().pr;
    };
    assert.equal((await handleDraftEvent(api)).action, 'manual');
    assert.equal(writes, 1);
  }
});
test('API observation failure stops before writing', async () => {
  const api = fake();
  api.observe = async () => {
    throw Error('403');
  };
  assert.equal((await handleDraftEvent(api)).action, 'manual');
  assert.equal(api.writes, 0);
});
function transport(f, { pages = [f.timeline], failMutation = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    let body;
    const path = new URL(url).pathname;
    if (path === '/graphql') {
      if (failMutation)
        return new Response(JSON.stringify({ errors: [{ message: 'denied' }] }), { status: 200 });
      f.pr.draft = true;
      body = { data: { convertPullRequestToDraft: { pullRequest: { id: f.pr.node_id } } } };
    } else if (path.endsWith('/timeline'))
      body = pages[Number(new URL(url).searchParams.get('page')) - 1] ?? [];
    else if (path.endsWith('/pulls/7')) body = f.pr;
    else if (path.endsWith('/actions/runs/20')) body = f.run;
    else if (path.endsWith('/actions/workflows/ready-ci.yml')) body = f.workflow;
    else if (path === '/repos/glyad/github-workspace-manager') body = f.repo;
    else throw Error(`unexpected URL ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetchImpl };
}
test('real API adapter observes native data and sends one variable-bound mutation', async () => {
  const f = fixture('failure');
  const t = transport(f);
  const api = createGitHubAdapter({
    eventName: f.eventName,
    event: f.event,
    token: 'test',
    fetchImpl: t.fetchImpl,
  });
  assert.equal((await handleDraftEvent(api)).action, 'drafted');
  const writes = t.calls.filter((c) => c.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body).variables, { id: 'PR_7' });
  assert.equal(t.calls.filter((c) => c.url.includes('/pulls/7')).length, 3);
});
test('API adapter paginates history rather than treating a partial page as complete', async () => {
  const f = fixture();
  const comments = Array.from({ length: 100 }, () => ({ event: 'commented' }));
  const t = transport(f, { pages: [comments, f.timeline] });
  const api = createGitHubAdapter({
    eventName: f.eventName,
    event: f.event,
    token: 'test',
    fetchImpl: t.fetchImpl,
  });
  assert.equal((await handleDraftEvent(api)).action, 'drafted');
  assert.ok(t.calls.some((c) => c.url.includes('page=2')));
});
test('API adapter GraphQL errors stop with no second mutation', async () => {
  const f = fixture();
  const t = transport(f, { failMutation: true });
  const api = createGitHubAdapter({
    eventName: f.eventName,
    event: f.event,
    token: 'test',
    fetchImpl: t.fetchImpl,
  });
  assert.equal((await handleDraftEvent(api)).action, 'manual');
  assert.equal(t.calls.filter((c) => c.method === 'POST').length, 1);
});

test('Ready and CI creation in the same second is accepted for ordinary CI delivery', () => {
  const f = fixture('failure');
  f.timeline[0].created_at = f.run.created_at;
  assert.equal(decideDraft(f).action, 'draft');
});

test('fork PR identity is supported without executing candidate data', async () => {
  const f = fixture();
  f.pr.head.repo = { id: 90, full_name: 'contributor/fork' };
  f.pr.head.ref = 'chore/$(untrusted)';
  f.event.pull_request = structuredClone(f.pr);
  const t = transport(f);
  const api = createGitHubAdapter({
    eventName: f.eventName,
    event: f.event,
    token: 'test',
    fetchImpl: t.fetchImpl,
  });
  assert.equal((await handleDraftEvent(api)).action, 'drafted');
  assert.ok(t.calls.every((call) => new URL(call.url).origin === 'https://api.github.com'));
  assert.ok(t.calls.every((call) => !call.url.includes('untrusted')));
});
test('fork run matches the explicit current PR head repository', () => {
  const f = fixture('failure');
  f.pr.head.repo = { id: 90, full_name: 'contributor/fork' };
  f.run.head_repository = structuredClone(f.pr.head.repo);
  f.event.workflow_run.head_repository = structuredClone(f.pr.head.repo);
  assert.equal(decideDraft(f).action, 'draft');
});
test('a rerun after a newer Ready does not renew the original creation time', () => {
  const f = fixture('failure');
  f.timeline[0].created_at = '2026-10-25T12:03:00Z';
  f.run.run_attempt = f.event.workflow_run.run_attempt = 2;
  f.run.run_started_at = '2026-10-25T12:04:00Z';
  assert.equal(decideDraft(f).action, 'noop');
});
test('a changed Ready witness that still precedes the event invalidates the recheck', async () => {
  const f = fixture();
  const api = fake(f);
  let count = 0;
  const original = api.observe;
  api.observe = async () => {
    if (++count === 2)
      f.timeline.push({ id: 31, event: 'ready_for_review', created_at: '2026-10-25T12:01:30Z' });
    return original();
  };
  assert.equal((await handleDraftEvent(api)).action, 'manual');
  assert.equal(api.writes, 0);
});
test('Draft readback on a changed head is not reported as success', async () => {
  const api = fake();
  api.readPR = async () => {
    const pr = fixture().pr;
    pr.draft = true;
    pr.head.sha = sha('f');
    return pr;
  };
  assert.equal((await handleDraftEvent(api)).action, 'manual');
  assert.equal(api.writes, 1);
});
test('missing API identity, forbidden responses and unbounded history cannot write', async () => {
  const f = fixture();
  const t = transport(f);
  for (const mode of ['identity', '403', 'history']) {
    let writes = 0;
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') writes++;
      if (mode === '403') return new Response('{}', { status: 403 });
      if (mode === 'identity' && new URL(url).pathname.endsWith('/pulls/7'))
        return new Response('{}');
      if (mode === 'history' && url.includes('/timeline'))
        return new Response(
          JSON.stringify(Array.from({ length: 100 }, () => ({ event: 'commented' }))),
        );
      return t.fetchImpl(url, options);
    };
    const api = createGitHubAdapter({
      eventName: f.eventName,
      event: f.event,
      token: 'test',
      fetchImpl,
    });
    assert.equal((await handleDraftEvent(api)).action, 'manual');
    assert.equal(writes, 0);
  }
});
