import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryName = 'glyad/github-workspace-manager';
const workflowPath = '.github/workflows/ready-ci.yml';
const workflowName = 'Ready CI';
const failures = new Set(['failure', 'timed_out', 'cancelled']);
const lifecycle = new Set(['ready_for_review', 'converted_to_draft', 'closed', 'reopened']);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
const time = (value) =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    ? Date.parse(value)
    : NaN;
const result = (action, reason) => ({ action, reason });
const sameRepo = (a, b) => id(a?.id) && a.id === b?.id && a.full_name === b?.full_name;
function pair(pr) {
  return {
    node: pr.node_id,
    number: pr.number,
    head: pr.head.sha,
    headRef: pr.head.ref,
    headRepo: pr.head.repo.id,
    base: pr.base.sha,
    baseRef: pr.base.ref,
    baseRepo: pr.base.repo.id,
  };
}
function samePair(a, b) {
  return JSON.stringify(pair(a)) === JSON.stringify(pair(b));
}
function validPR(pr, repo) {
  return (
    id(pr?.id) &&
    id(pr.number) &&
    typeof pr.node_id === 'string' &&
    pr.node_id.length > 0 &&
    typeof pr.draft === 'boolean' &&
    ['open', 'closed'].includes(pr.state) &&
    sha(pr.head?.sha) &&
    typeof pr.head.ref === 'string' &&
    pr.head.ref.length > 0 &&
    id(pr.head.repo?.id) &&
    typeof pr.head.repo.full_name === 'string' &&
    sha(pr.base?.sha) &&
    sameRepo(pr.base.repo, repo)
  );
}
/** Native observations only. No candidate declarations, artifacts or checkpoints. */
export function decideDraft({ eventName, event, repo, pr, timeline, workflow, run }) {
  if (!id(repo?.id) || repo.full_name !== repositoryName || !sameRepo(repo, event?.repository))
    return result('manual', 'Repository identity is missing or mismatched');
  if (!validPR(pr, repo)) return result('manual', 'PR identity is missing or mismatched');
  if (pr.state !== 'open' || pr.draft) return result('noop', 'PR is closed or already Draft');
  if (pr.base.ref !== 'develop') return result('noop', 'PR no longer targets develop');
  let cutoff;
  if (eventName === 'pull_request_target' && event.action === 'synchronize') {
    const snapshot = event.pull_request;
    if (
      !validPR(snapshot, repo) ||
      event.number !== pr.number ||
      snapshot.number !== pr.number ||
      snapshot.id !== pr.id
    )
      return result('manual', 'Push PR identity is missing or mismatched');
    if (snapshot.draft || snapshot.state !== 'open')
      return result('noop', 'Push occurred outside Ready');
    if (
      !sha(event.before) ||
      !sha(event.after) ||
      event.before === event.after ||
      event.after !== snapshot.head.sha
    )
      return result('manual', 'Push before/after identity is missing or mismatched');
    if (!samePair(snapshot, pr)) return result('noop', 'Push candidate is stale');
    // The native PR snapshot update time is a conservative push cutoff, not a lock.
    cutoff = time(snapshot.updated_at);
  } else if (eventName === 'workflow_run' && event.action === 'completed') {
    const sent = event.workflow_run;
    if (
      !id(workflow?.id) ||
      workflow.name !== workflowName ||
      workflow.path !== workflowPath ||
      !id(run?.id) ||
      run.id !== sent?.id ||
      run.run_attempt !== sent.run_attempt ||
      !id(run.run_attempt) ||
      run.workflow_id !== workflow.id ||
      sent.workflow_id !== workflow.id ||
      run.name !== workflowName ||
      run.path !== workflowPath ||
      sent.path !== workflowPath ||
      !sameRepo(run.repository, repo) ||
      !sameRepo(sent.repository, repo) ||
      run.event !== 'pull_request' ||
      sent.event !== 'pull_request' ||
      run.status !== 'completed' ||
      sent.status !== 'completed' ||
      run.conclusion !== sent.conclusion ||
      run.created_at !== sent.created_at
    )
      return result('manual', 'Ready CI workflow/run identity is missing or mismatched');
    if (!failures.has(run.conclusion))
      return result('noop', 'CI conclusion does not require Draft');
    if (
      !Array.isArray(run.pull_requests) ||
      run.pull_requests.length !== 1 ||
      !Array.isArray(sent.pull_requests) ||
      sent.pull_requests.length !== 1
    )
      return result('manual', 'CI PR association is missing or ambiguous');
    const associated = run.pull_requests[0];
    if (
      associated.id !== pr.id ||
      associated.number !== pr.number ||
      ['id', 'number'].some((key) => associated[key] !== sent.pull_requests[0][key]) ||
      ['head', 'base'].some((side) =>
        ['sha', 'ref'].some(
          (key) => associated[side]?.[key] !== sent.pull_requests[0][side]?.[key],
        ),
      )
    )
      return result('manual', 'CI PR association does not match the event');
    if (
      !sameRepo(run.head_repository, pr.head.repo) ||
      run.head_branch !== pr.head.ref ||
      !sha(run.head_sha) ||
      run.head_sha !== sent.head_sha ||
      associated.head?.sha !== pr.head.sha ||
      associated.head?.ref !== pr.head.ref ||
      associated.base?.sha !== pr.base.sha ||
      associated.base?.ref !== pr.base.ref
    )
      return result('noop', 'CI candidate is stale');
    // created_at remains the original run creation time on reruns; do not use run_started_at.
    cutoff = time(run.created_at);
  } else return result('noop', 'Unsupported event');
  if (!Number.isFinite(cutoff)) return result('manual', 'Native event time is missing');
  if (!Array.isArray(timeline)) return result('manual', 'Native lifecycle history is missing');
  const history = timeline.filter((item) => lifecycle.has(item.event));
  const seen = new Set();
  for (const item of history) {
    if (!id(item.id) || !Number.isFinite(time(item.created_at)) || seen.has(item.id))
      return result('manual', 'Native lifecycle history is ambiguous');
    seen.add(item.id);
  }
  const ready = history
    .filter((item) => item.event === 'ready_for_review')
    .sort((a, b) => time(b.created_at) - time(a.created_at));
  if (!ready.length) return result('manual', 'No native Ready witness; reconcile manually');
  const latest = ready[0];
  const readyTime = time(latest.created_at);
  if (
    ready[1]?.created_at === latest.created_at ||
    history.some(
      (item) =>
        item.id !== latest.id &&
        item.event !== 'ready_for_review' &&
        time(item.created_at) >= readyTime,
    )
  )
    return result('manual', 'Lifecycle history conflicts with current Ready');
  if (readyTime > cutoff)
    return result('noop', 'A newer intentional Ready cycle superseded this event');
  if (eventName === 'pull_request_target' && readyTime === cutoff)
    return result('manual', 'Push and Ready share a timestamp; reconcile manually');
  return {
    action: 'draft',
    reason: eventName === 'workflow_run' ? 'Current Ready CI failed' : 'Unexpected Ready head push',
    witness: JSON.stringify({
      ...pair(pr),
      ready: latest.id,
      readyAt: latest.created_at,
      run:
        eventName === 'workflow_run'
          ? [run.id, run.run_attempt, run.created_at, run.conclusion]
          : null,
    }),
  };
}

/** Re-read all decision facts before a single write; never retry an uncertain mutation. */
export async function handleDraftEvent(api) {
  try {
    const first = decideDraft(await api.observe());
    if (first.action !== 'draft') return first;
    const observation = await api.observe();
    const fresh = decideDraft(observation);
    if (fresh.action !== 'draft') return fresh;
    if (fresh.witness !== first.witness)
      return result('manual', 'Native candidate/Ready witness changed during recheck');
    try {
      await api.draft(observation.pr.node_id);
    } catch {
      return result(
        'manual',
        'Draft write outcome is uncertain; inspect native state before any retry',
      );
    }
    const after = await api.readPR(observation.pr.number);
    if (
      !validPR(after, observation.repo) ||
      !samePair(after, observation.pr) ||
      after.state !== 'open' ||
      !after.draft
    )
      return result('manual', 'Independent Draft readback did not match; reconcile manually');
    return result('drafted', fresh.reason);
  } catch {
    return result('manual', 'Native API observation/readback failed; reconcile manually');
  }
}

/** Fixed GitHub.com API destination; candidate text is JSON data, never shell or URL authority. */
export function createGitHubAdapter({ eventName, event, token, fetchImpl = fetch }) {
  if (!token) throw Error('GITHUB_TOKEN required');
  const root = `/repos/${repositoryName}`;
  async function request(path, body) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(`GitHub HTTP ${response.status}`);
    const data = await response.json();
    if (data.errors) throw Error('GitHub GraphQL errors');
    return data;
  }
  const number =
    eventName === 'pull_request_target'
      ? event.number
      : event.workflow_run?.pull_requests?.length === 1
        ? event.workflow_run.pull_requests[0].number
        : undefined;
  const readPR = async (prNumber = number) => {
    if (!id(prNumber)) throw Error('Unresolved PR');
    return request(`${root}/pulls/${prNumber}`);
  };
  return {
    readPR,
    async observe() {
      if (!id(number)) throw Error('Missing or ambiguous PR association');
      const repo = await request(root);
      const timeline = [];
      for (let page = 1; ; page++) {
        if (page > 20)
          throw Error('Lifecycle history exceeds bounded pagination; reconcile manually');
        const items = await request(`${root}/issues/${number}/timeline?per_page=100&page=${page}`);
        if (!Array.isArray(items)) throw Error('Malformed timeline');
        timeline.push(...items);
        if (items.length < 100) break;
      }
      let workflow, run;
      if (eventName === 'workflow_run') {
        if (!id(event.workflow_run?.id)) throw Error('Missing workflow run identity');
        workflow = await request(`${root}/actions/workflows/ready-ci.yml`);
        run = await request(`${root}/actions/runs/${event.workflow_run.id}`);
      }
      return { eventName, event, repo, pr: await readPR(), timeline, workflow, run };
    },
    async draft(prNode) {
      await request('/graphql', {
        query:
          'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id}}}',
        variables: { id: prNode },
      });
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const outcome = await handleDraftEvent(
      createGitHubAdapter({
        eventName: process.env.GITHUB_EVENT_NAME,
        event,
        token: process.env.GITHUB_TOKEN,
      }),
    );
    console.log(JSON.stringify(outcome));
    if (outcome.action === 'manual') process.exitCode = 1;
  } catch {
    console.error('Manual reconciliation required: cannot initialize native PR Draft control');
    process.exitCode = 1;
  }
}
