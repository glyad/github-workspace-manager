import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'glyad/github-workspace-manager';
const PAGE = 'totalCount pageInfo { hasNextPage endCursor }';
const REF = 'id number repository { id nameWithOwner }';
const PR = `${REF} state isDraft merged mergedAt baseRefName baseRefOid headRefOid updatedAt headRepository { id nameWithOwner }`;
const RELATIONS = {
  prs: `closedByPullRequestsReferences(includeClosedPrs:true, first:100, after:$cursor) { ${PAGE} nodes { ${PR} } }`,
  children: `subIssues(first:100, after:$cursor) { ${PAGE} nodes { ${REF} } }`,
  dependencies: `blockedBy(first:100, after:$cursor) { ${PAGE} nodes { ${REF} } }`,
  items: `projectItems(first:100, after:$cursor) { ${PAGE} nodes { id isArchived project { id } fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2SingleSelectField { id } } } } } }`,
};
function requireFact(value, message) {
  if (!value) throw Error(message);
}
function ownAcceptance(body) {
  // Ignore fenced examples; only explicit acceptance/approved-scope sections count.
  let fence = null,
    active = false,
    level = 0;
  const boxes = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const mark = marker?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && !marker[2].trim())
        fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (heading[1].length <= level) active = false;
      if (/^(acceptance(?: criteria)?|approved scope)$/i.test(heading[2])) {
        active = true;
        level = heading[1].length;
      }
    }
    const box = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s+\S/.exec(line);
    if (active && box) boxes.push(box[1].toLowerCase() === 'x');
  }
  return boxes.length > 0 && boxes.every(Boolean);
}

export function decideStatus(issue) {
  const { prs, children, dependencies } = issue;
  const started = prs.length > 0 || children.some((c) => c.started);
  const result = (status, complete, reason = null) => ({ status, complete, started, reason });
  if (issue.status === 'Released')
    return result(
      null,
      issue.state === 'CLOSED' &&
        issue.stateReason === 'COMPLETED' &&
        started &&
        prs.every((p) => p.state === 'MERGED' && p.baseRefName === 'develop') &&
        children.every((c) => c.complete) &&
        dependencies.every((d) => d.complete) &&
        ownAcceptance(issue.body),
    );
  if (issue.state === 'CLOSED' && issue.stateReason !== 'COMPLETED')
    return result(null, false, 'Owner-closed/cancelled Issue requires chat reconciliation');
  if (prs.some((p) => p.state === 'CLOSED' || p.baseRefName !== 'develop'))
    return result(
      null,
      false,
      'Closed-unmerged or differently targeted delivery PR requires chat reconciliation',
    );
  const complete =
    started &&
    prs.every((p) => p.state === 'MERGED') &&
    children.every((c) => c.complete) &&
    dependencies.every((d) => d.complete) &&
    ownAcceptance(issue.body);
  if (complete) return result('Integrated', true);
  if (issue.state === 'CLOSED')
    return result(
      null,
      false,
      'Closed Issue lacks complete native delivery/acceptance evidence; reconcile in chat',
    );
  const active = prs.filter((p) => p.state === 'OPEN');
  const review =
    active.length > 0 &&
    active.every((p) => !p.isDraft && p.ci) &&
    children.every((c) => c.complete || c.status === 'In review');
  return result(
    started ? (review ? 'In review' : 'In progress') : null,
    false,
    started && active.length === 0
      ? 'Own acceptance, children or dependencies incomplete; reconcile in chat'
      : (children.find((c) => c.reason)?.reason ?? null),
  );
}

export function createApi({ repositoryToken, projectsToken, fetchImpl = fetch }) {
  requireFact(
    repositoryToken && projectsToken,
    'Blocked: GITHUB_TOKEN and PROJECTS_TOKEN are required',
  );
  let calls = 0;
  return async ({ credential = 'repository', query, variables, path, method = 'GET', body }) => {
    requireFact(++calls <= 3000, 'API request bound reached');
    requireFact(
      query || /^\/repos\/glyad\/github-workspace-manager\/[a-zA-Z0-9_?=&./%-]+$/.test(path),
      'Untrusted API destination',
    );
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${query ? '/graphql' : path}`, {
        method: query ? 'POST' : method,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          authorization: `Bearer ${credential === 'project' ? projectsToken : repositoryToken}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        ...(query || body ? { body: JSON.stringify(query ? { query, variables } : body) } : {}),
      });
    } catch {
      throw Error('API request uncertain; stop and reconcile manually (no automatic retry)');
    }
    requireFact(
      response.ok,
      `API request failed (${response.status}); stop and reconcile manually`,
    );
    const raw = await response.text();
    requireFact(raw.length <= 4000000, 'API response bound reached');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw Error('Invalid API JSON; reconcile manually');
    }
    requireFact(!data.errors, 'GraphQL incomplete/error response; reconcile manually');
    return query ? data.data : data;
  };
}

export function createReader(api, config) {
  const repo = (r) =>
    requireFact(
      r?.nameWithOwner === REPOSITORY && r.id === config.repositoryId,
      'Relationship outside configured repository; reconcile in chat',
    );
  async function connection(id, type, key) {
    const nodes = [],
      seen = new Set();
    let cursor = null,
      total;
    for (let page = 0; page < 10; page++) {
      const field =
        type === 'PullRequest'
          ? `closingIssuesReferences(first:100, after:$cursor) { ${PAGE} nodes { ${REF} } }`
          : RELATIONS[key];
      const data = await api({
        credential: key === 'items' ? 'project' : 'repository',
        query: `query Relation($id:ID!, $cursor:String) { node(id:$id) { ... on ${type} { ${key}: ${field} } } }`,
        variables: { id, cursor },
      });
      const list = data?.node?.[key];
      requireFact(
        list &&
          Array.isArray(list.nodes) &&
          Number.isSafeInteger(list.totalCount) &&
          list.totalCount >= 0 &&
          typeof list.pageInfo?.hasNextPage === 'boolean',
        'Incomplete native relationship',
      );
      total ??= list.totalCount;
      requireFact(
        total === list.totalCount && total <= 1000,
        'Relationship changed or exceeds bound',
      );
      for (const node of list.nodes) {
        requireFact(node?.id && !seen.has(node.id), 'Null/duplicate native relationship');
        if (key !== 'items') repo(node.repository);
        seen.add(node.id);
        nodes.push(node);
      }
      if (!list.pageInfo.hasNextPage) {
        requireFact(nodes.length === total, 'Incomplete relationship count');
        return nodes;
      }
      requireFact(
        list.nodes.length > 0 &&
          typeof list.pageInfo.endCursor === 'string' &&
          list.pageInfo.endCursor !== cursor,
        'Incomplete pagination cursor',
      );
      cursor = list.pageInfo.endCursor;
    }
    throw Error('Pagination bound reached; reconcile in chat');
  }
  async function issue(number) {
    requireFact(Number.isSafeInteger(number) && number > 0, 'Invalid Issue number');
    const data = await api({
      query: `query Issue($number:Int!) { repository(owner:"glyad", name:"github-workspace-manager") { issue(number:$number) { ${REF} body state stateReason updatedAt milestone { id } parent { ${REF} } } } }`,
      variables: { number },
    });
    const value = data?.repository?.issue;
    requireFact(
      value?.id &&
        value.number === number &&
        typeof value.body === 'string' &&
        ['OPEN', 'CLOSED'].includes(value.state) &&
        typeof value.updatedAt === 'string' &&
        Object.hasOwn(value, 'parent') &&
        Object.hasOwn(value, 'milestone'),
      'Incomplete Issue metadata',
    );
    repo(value.repository);
    if (value.parent) repo(value.parent.repository);
    const prs = await connection(value.id, 'Issue', 'prs');
    for (const p of prs) {
      requireFact(
        ['OPEN', 'CLOSED', 'MERGED'].includes(p.state) &&
          typeof p.isDraft === 'boolean' &&
          typeof p.merged === 'boolean' &&
          (p.state === 'MERGED') === p.merged &&
          typeof p.baseRefName === 'string' &&
          /^[a-f0-9]{40}$/.test(p.baseRefOid) &&
          /^[a-f0-9]{40}$/.test(p.headRefOid) &&
          p.updatedAt &&
          (p.state !== 'MERGED' || p.mergedAt),
        'Incomplete PR evidence',
      );
      p.ci = p.state === 'OPEN' && !p.isDraft ? await readyCI(p) : false;
    }
    const children = await connection(value.id, 'Issue', 'children');
    const dependencies = await connection(value.id, 'Issue', 'dependencies');
    const items = (await connection(value.id, 'Issue', 'items')).filter(
      (i) => i.project?.id === config.native.projectId,
    );
    requireFact(
      items.length === 1 && !items[0].isArchived,
      'Expected one active native Project item; intake or chat reconciliation required',
    );
    const item = items[0],
      status = item.fieldValueByName;
    requireFact(
      status?.field?.id === config.native.fields.Status.id &&
        config.native.fields.Status.options.some(
          (o) => o.id === status.optionId && o.name === status.name,
        ),
      'Unknown/missing native Status',
    );
    return { ...value, prs, children, dependencies, itemId: item.id, status: status.name };
  }
  async function readyCI(p) {
    const branch = await api({ path: `/repos/${REPOSITORY}/branches/develop` });
    requireFact(/^[a-f0-9]{40}$/.test(branch.commit?.sha), 'Missing current develop SHA');
    // Run PR association base/head objects are live metadata, not run-time evidence.
    // Compare exact current develop and tested-head commits to establish inclusion.
    const comparePath = `/repos/${REPOSITORY}/compare/${branch.commit.sha}...${p.headRefOid}?per_page=1`;
    let comparison = await api({ path: `${comparePath}&page=1` });
    requireFact(
      comparison.base_commit?.sha === branch.commit.sha,
      'Native comparison base identity mismatch',
    );
    if (!['ahead', 'identical'].includes(comparison.status)) return false;
    const count = comparison.total_commits;
    requireFact(
      Number.isSafeInteger(count) &&
        count >= 0 &&
        count <= 1000 &&
        comparison.ahead_by === count &&
        comparison.behind_by === 0 &&
        comparison.merge_base_commit?.sha === branch.commit.sha,
      'Incomplete native comparison',
    );
    if (comparison.status === 'identical') {
      requireFact(
        count === 0 && p.headRefOid === branch.commit.sha,
        'Native comparison identical identity mismatch',
      );
    } else {
      requireFact(count > 0, 'Incomplete native comparison ahead count');
      if (count > 1) comparison = await api({ path: `${comparePath}&page=${count}` });
      requireFact(
        comparison.status === 'ahead' &&
          comparison.total_commits === count &&
          comparison.ahead_by === count &&
          comparison.behind_by === 0 &&
          comparison.base_commit?.sha === branch.commit.sha &&
          comparison.merge_base_commit?.sha === branch.commit.sha &&
          comparison.commits?.length === 1 &&
          comparison.commits[0].sha === p.headRefOid,
        'Native comparison tested-head identity mismatch',
      );
    }
    const runs = [];
    let total;
    const seen = new Set();
    for (let page = 1; page <= 10; page++) {
      const data = await api({
        path: `/repos/${REPOSITORY}/actions/workflows/ready-ci.yml/runs?event=pull_request&head_sha=${p.headRefOid}&per_page=100&page=${page}`,
      });
      requireFact(
        Array.isArray(data.workflow_runs) &&
          Number.isSafeInteger(data.total_count) &&
          data.total_count <= 1000,
        'Incomplete Ready CI listing',
      );
      total ??= data.total_count;
      requireFact(total === data.total_count, 'Ready CI listing changed');
      for (const run of data.workflow_runs) {
        requireFact(
          Number.isSafeInteger(run.id) && run.id > 0 && !seen.has(run.id),
          'Duplicate/invalid Ready CI run',
        );
        seen.add(run.id);
        runs.push(run);
      }
      if (runs.length === data.total_count) break;
      requireFact(
        data.workflow_runs.length === 100 && page < 10 && runs.length < data.total_count,
        'Incomplete Ready CI pagination',
      );
    }
    // Prefer the newest run; an older successful attempt cannot override newer failure.
    const matches = runs.filter(
      (r) =>
        r.repository?.full_name === REPOSITORY &&
        r.name === 'Ready CI' &&
        r.path === '.github/workflows/ready-ci.yml' &&
        r.event === 'pull_request' &&
        r.head_sha === p.headRefOid &&
        r.pull_requests?.some((x) => x.number === p.number),
    );
    matches.sort((a, b) => b.id - a.id);
    const latest = matches[0];
    if (!latest) return false;
    const current = await api({ path: `/repos/${REPOSITORY}/actions/runs/${latest.id}` });
    return (
      current.id === latest.id &&
      current.run_attempt === latest.run_attempt &&
      current.repository?.full_name === REPOSITORY &&
      current.path === latest.path &&
      current.name === 'Ready CI' &&
      current.event === 'pull_request' &&
      current.head_sha === p.headRefOid &&
      current.status === 'completed' &&
      current.conclusion === 'success' &&
      current.pull_requests?.some((x) => x.number === p.number)
    );
  }
  async function snapshot(number) {
    const records = new Map(),
      visiting = new Set();
    async function visit(n, depth = 0) {
      requireFact(
        depth < 20 && !visiting.has(n),
        'Native hierarchy/dependency cycle or depth bound',
      );
      if (records.has(n)) return;
      requireFact(records.size + visiting.size < 100, 'Native traversal bound');
      visiting.add(n);
      const value = await issue(n);
      for (const r of [...value.children, ...value.dependencies]) {
        await visit(r.number, depth + 1);
        requireFact(records.get(r.number).id === r.id, 'Relationship identity changed');
      }
      for (const child of value.children)
        requireFact(
          records.get(child.number).parent?.id === value.id,
          'Inconsistent native parent relationship',
        );
      records.set(n, value);
      visiting.delete(n);
    }
    await visit(number);
    const decisions = new Map();
    for (const [n, value] of records) {
      decisions.set(
        n,
        decideStatus({
          ...value,
          children: value.children.map((c) => {
            const d = decisions.get(c.number),
              r = records.get(c.number);
            return {
              ...d,
              complete: d.complete && r.state === 'CLOSED' && r.stateReason === 'COMPLETED',
            };
          }),
          dependencies: value.dependencies.map((c) => {
            const d = decisions.get(c.number),
              r = records.get(c.number);
            return {
              ...d,
              complete: d.complete && r.state === 'CLOSED' && r.stateReason === 'COMPLETED',
            };
          }),
        }),
      );
    }
    return { records, decision: decisions.get(number) };
  }
  return { issue, snapshot, linkedIssues: (id) => connection(id, 'PullRequest', 'issues') };
}

export async function synchronize({ api, config, numbers, log = console.log }) {
  requireFact(
    config.repository === REPOSITORY && config.repositoryId === config.native.repositoryId,
    'Invalid configured repository',
  );
  const reader = createReader(api, config),
    targets = new Set();
  for (let n of numbers) {
    const path = new Set();
    while (n) {
      requireFact(
        !path.has(n) && path.size < 20 && targets.size < 100,
        'Affected hierarchy bound/cycle',
      );
      path.add(n);
      targets.add(n);
      n = (await reader.issue(n)).parent?.number;
    }
  }
  // Child-first order is obtained from each fresh native subtree, not closed counts.
  const ordered = new Set();
  for (const n of targets)
    for (const key of (await reader.snapshot(n)).records.keys())
      if (targets.has(key)) ordered.add(key);
  const results = [];
  for (const number of ordered) {
    let before = await reader.snapshot(number);
    const fresh = await reader.snapshot(number);
    requireFact(
      JSON.stringify([...before.records]) === JSON.stringify([...fresh.records]),
      'Native source changed during observation; reconcile manually',
    );
    before = fresh;
    let value = before.records.get(number),
      decision = before.decision;
    if (decision.reason) log(`#${number}: ${decision.reason}`);
    if (decision.status && decision.status !== value.status) {
      const option = config.native.fields.Status.options.find((o) => o.name === decision.status);
      requireFact(option, 'Missing configured Status option');
      await api({
        credential: 'project',
        query:
          'mutation Status($input:UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input:$input) { projectV2Item { id } } }',
        variables: {
          input: {
            projectId: config.native.projectId,
            itemId: value.itemId,
            fieldId: config.native.fields.Status.id,
            value: { singleSelectOptionId: option.id },
          },
        },
      });
      const readback = await reader.issue(number);
      requireFact(
        readback.id === value.id &&
          readback.itemId === value.itemId &&
          readback.status === decision.status,
        'Status mutation readback uncertain; reconcile manually; no retry',
      );
    }
    if (decision.complete && value.state === 'OPEN') {
      const a = await reader.snapshot(number),
        b = await reader.snapshot(number);
      requireFact(
        JSON.stringify([...a.records]) === JSON.stringify([...b.records]),
        'Native source changed before closure; reconcile manually',
      );
      value = b.records.get(number);
      decision = b.decision;
      requireFact(
        decision.complete && value.status === 'Integrated' && value.state === 'OPEN',
        'Completion changed before closure; reconcile manually',
      );
      await api({
        path: `/repos/${REPOSITORY}/issues/${number}`,
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      });
      const closed = await reader.issue(number);
      requireFact(
        closed.id === value.id &&
          closed.state === 'CLOSED' &&
          closed.stateReason === 'COMPLETED' &&
          closed.status === 'Integrated',
        'Issue closure readback uncertain; reconcile manually; no retry',
      );
    }
    results.push({ number, ...decision });
  }
  return results;
}

export async function run({
  env = process.env,
  read = readFile,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  requireFact(env.GITHUB_REPOSITORY === REPOSITORY, 'Wrong workflow repository');
  const api = createApi({
    repositoryToken: env.GITHUB_TOKEN,
    projectsToken: env.PROJECTS_TOKEN,
    fetchImpl,
  });
  const config = JSON.parse(
    await read(new URL('../../governance/project.json', import.meta.url), 'utf8'),
  );
  const event = JSON.parse(await read(env.GITHUB_EVENT_PATH, 'utf8'));
  requireFact(
    event.repository?.full_name === REPOSITORY && event.repository.node_id === config.repositoryId,
    'Wrong event repository',
  );
  let numbers;
  if (env.GITHUB_EVENT_NAME === 'issues') numbers = [event.issue?.number];
  else {
    let pulls;
    if (env.GITHUB_EVENT_NAME === 'pull_request_target')
      pulls = [{ number: event.pull_request?.number, node_id: event.pull_request?.node_id }];
    else {
      requireFact(
        env.GITHUB_EVENT_NAME === 'workflow_run' &&
          event.action === 'completed' &&
          event.workflow_run?.name === 'Ready CI' &&
          event.workflow_run.event === 'pull_request',
        'Unsupported workflow event',
      );
      const run = await api({ path: `/repos/${REPOSITORY}/actions/runs/${event.workflow_run.id}` });
      requireFact(
        run.id === event.workflow_run.id &&
          run.repository?.full_name === REPOSITORY &&
          run.name === 'Ready CI' &&
          run.path === '.github/workflows/ready-ci.yml' &&
          run.event === 'pull_request' &&
          run.status === 'completed',
        'Wrong Ready CI run',
      );
      pulls = run.pull_requests;
    }
    requireFact(
      Array.isArray(pulls) && pulls.length > 0 && pulls.length <= 100,
      'Missing/ambiguous event PR association; reconcile manually',
    );
    numbers = [];
    const reader = createReader(api, config);
    for (const p of pulls) {
      requireFact(Number.isSafeInteger(p.number) && p.number > 0, 'Invalid event PR');
      const current = await api({ path: `/repos/${REPOSITORY}/pulls/${p.number}` });
      requireFact(
        current.base?.repo?.full_name === REPOSITORY &&
          current.base.repo.node_id === config.repositoryId &&
          current.base.ref === 'develop' &&
          current.node_id &&
          (!p.node_id || current.node_id === p.node_id),
        'Wrong current PR identity/base',
      );
      numbers.push(...(await reader.linkedIssues(current.node_id)).map((i) => i.number));
    }
    requireFact(
      numbers.length > 0,
      'No current native linked Issues; reconcile removed/missing links manually',
    );
  }
  return synchronize({ api, config, numbers: [...new Set(numbers)], log });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(
      `Project sync stopped: ${error.message}. Manual reconciliation required; do not blindly rerun uncertain writes.`,
    );
    process.exitCode = 1;
  });
}
