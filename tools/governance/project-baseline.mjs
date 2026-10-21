import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createSetupJournal } from './baseline.mjs';
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const projectDigest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const result = (kind, reason) => ({ kind, reason, evidence: [] });
/** Stable approved keys identify scope; display titles never provide creation ownership. */
export function planProjectBaseline(snapshot, config, scope) {
  if (
    snapshot?.actor !== config.owner ||
    config.owner !== 'glyad' ||
    snapshot.repositoryId !== config.repositoryId ||
    config.public !== true
  )
    throw Error('Project identity mismatch');
  if (snapshot.projects.filter((p) => p.title === config.title).length > 1)
    throw Error('Ambiguous Project display names');
  const keys = new Set();
  for (const e of scope.entries) {
    if (!/^[a-z0-9-]+$/.test(e.key) || keys.has(e.key))
      throw Error('Duplicate or invalid stable Issue key');
    keys.add(e.key);
    if (!e.body || !e.title || !['Planned', 'Backlog'].includes(e.status))
      throw Error('Invalid initial Issue scope');
  }
  for (const e of scope.entries)
    for (const key of [...(e.dependencies ?? []), ...(e.parentKey ? [e.parentKey] : [])])
      if (!keys.has(key) || key === e.key) throw Error('Unknown or self Issue relationship');
  const done = new Set();
  const visit = (key, path = new Set()) => {
    if (path.has(key)) throw Error('Cyclic Issue dependencies');
    if (done.has(key)) return;
    const next = new Set([...path, key]);
    for (const dep of scope.entries.find((e) => e.key === key).dependencies ?? []) visit(dep, next);
    done.add(key);
  };
  for (const e of scope.entries) visit(e.key);
  const operations = [];
  const add = (key, kind, desired, mutable = false) =>
    operations.push({
      key,
      kind,
      desired,
      mutable,
      repositoryId: config.repositoryId,
      actor: config.owner,
      fingerprint: projectDigest(desired),
    });
  add('project', 'project', { title: config.title });
  add(
    'project-settings',
    'project-settings',
    { title: config.title, public: true, repositoryId: config.repositoryId },
    true,
  );
  for (const [name, options] of Object.entries(config.fields))
    add(
      'field:' + name,
      'field',
      {
        name,
        options: options.map((option, i) => ({
          name: option,
          color: config.colors?.[name]?.[i] ?? 'GRAY',
          description: option,
        })),
      },
      true,
    );
  for (const label of config.labels ?? [])
    add('label:' + label.name, 'label', { ...label, color: label.color.toUpperCase() }, true);
  add('milestone', 'milestone', { title: config.milestone }, true);
  for (const e of scope.entries)
    add('issue:' + e.key, 'issue', {
      title: e.title,
      body: e.body + '\n\n<!-- gwm-requirement:' + e.key + ' -->\n',
      milestone: e.milestone ?? null,
      labels: [...(e.labels ?? [])].sort(),
    });
  for (const e of scope.entries)
    add('membership:' + e.key, 'membership', { issueKey: e.key, status: e.status }, true);
  for (const e of scope.entries) {
    if (e.parentKey)
      add('parent:' + e.key, 'subissue', { parentKey: e.parentKey, childKey: e.key });
    for (const dep of e.dependencies ?? [])
      add('dependency:' + e.key + ':' + dep, 'dependency', { issueKey: e.key, blockingKey: dep });
  }
  for (const view of config.views ?? [])
    add(
      'view:' + view.name,
      'view',
      { name: view.name, layout: view.layout, filter: view.filter ?? '' },
      true,
    );
  return operations;
}
/** Durable exact-ID receipts precede readback. Unresolved intents never authorize duplicate creation. */
export async function applyProjectBaseline(port, operations) {
  const bindings = {};
  const evidence = [];
  try {
    const rows = await port.readJournal();
    for (const op of operations) {
      const identity = await port.observeIdentity();
      if (
        identity.actor !== op.actor ||
        identity.repositoryId !== op.repositoryId ||
        identity.sessionOpen !== true
      )
        return result('blocked', 'Fresh owner, repository and open setup session required');
      const previous = rows.filter((r) => r.key === op.key);
      if (previous.some((r) => r.fingerprint !== op.fingerprint))
        return result('conflict', 'Reviewed operation changed; reconcile journal');
      if (projectDigest(op.desired) !== op.fingerprint)
        return result('conflict', 'Operation fingerprint changed');
      const receipt = previous.findLast((r) => r.phase === 'receipt' || r.phase === 'verified');
      if (
        previous.findLastIndex((r) => r.phase === 'intent') >
        previous.findLastIndex((r) => r.phase === 'receipt' || r.phase === 'verified')
      )
        return result(
          'uncertain',
          'Unresolved prior intent; explicit reconciliation required, no automatic retry',
        );
      if (receipt) bindings[op.key] = receipt.id;
      let current = await port.observe(op, receipt?.id, bindings);
      if (current && receipt && current.id !== receipt.id)
        return result('conflict', 'Observed resource differs from exact receipt ID');
      if (current?.fingerprint === op.fingerprint) {
        if (!receipt && !op.mutable)
          return result('conflict', 'Preexisting unbound creation requires explicit adoption');
        bindings[op.key] = current.id;
      } else {
        if (current && !op.mutable)
          return result('conflict', 'Existing resource differs from reviewed creation');
        if (receipt && !op.mutable)
          return result('uncertain', 'Recorded creation not independently verified');
        const intent = { key: op.key, phase: 'intent', fingerprint: op.fingerprint };
        await port.appendJournal(intent);
        rows.push(intent);
        const response = await port.apply(op, current?.id ?? receipt?.id, bindings);
        if (!response?.id)
          return result('uncertain', 'Mutation lacks exact attributable result ID');
        const record = {
          key: op.key,
          phase: 'receipt',
          fingerprint: op.fingerprint,
          id: response.id,
        };
        await port.appendJournal(record);
        rows.push(record);
        bindings[op.key] = response.id;
        current = await port.observe(op, response.id, bindings);
        if (current?.id !== response.id || current?.fingerprint !== op.fingerprint)
          return result('uncertain', 'Mutation postcondition or native relationship unverified');
      }
      const record = {
        key: op.key,
        phase: 'verified',
        fingerprint: op.fingerprint,
        id: current.id,
      };
      await port.appendJournal(record);
      rows.push(record);
      evidence.push({ key: op.key, id: current.id, observedAt: new Date().toISOString() });
    }
    return {
      kind: 'verified',
      value: { bindings, operationsVerified: operations.length },
      evidence,
    };
  } catch {
    return result(
      'uncertain',
      'Project operation or durable journal unavailable; reconcile before retry',
    );
  }
}
/** Authenticated CLI transport; structured JSON stdin, bounded output and no credential/error logging. */
export function createProjectGitHubPort({ root, session, execute = execFileSync }) {
  session = structuredClone(session);
  const journal = createSetupJournal({ root, actorId: session.actor.id });
  const journalKey = session.operationId + '-project';
  const request = (endpoint, method = 'GET', body) => {
    const args = ['api', '--hostname', 'github.com', endpoint, '--method', method];
    if (body) args.push('--input', '-');
    return JSON.parse(
      execute('gh', args, {
        cwd: root,
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
        maxBuffer: 4000000,
      }),
    );
  };
  const graph = (query, variables = {}) => {
    const r = request('graphql', 'POST', { query, variables });
    if (r.errors) throw Error('GraphQL request failed');
    return r.data;
  };
  const node = (id, selection) =>
    graph('query($id:ID!){node(id:$id){' + selection + '}}', { id }).node;
  const ref = (b, key) => {
    if (!b[key]) throw Error('Unresolved stable reference');
    return b[key];
  };
  const project = (b) => ref(b, 'project');
  const issue = (b, key) => node(ref(b, 'issue:' + key), '... on Issue {id number}');
  const selectField = (b, name) => {
    const fs = node(
      project(b),
      '... on ProjectV2 {fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name color description}} ... on ProjectV2Field{id name}}pageInfo{hasNextPage}}}',
    ).fields;
    if (fs.pageInfo.hasNextPage) throw Error('Field pagination required');
    const matches = fs.nodes.filter((f) => f.name === name);
    if (matches.length > 1) throw Error('Ambiguous native field');
    return matches[0];
  };
  const normalized = (id, desired) => ({ id, fingerprint: projectDigest(desired) });
  const repository = 'repos/glyad/github-workspace-manager';
  async function observeIdentity() {
    const fresh = JSON.parse(
      await readFile(join(root, '.governance-local/setup/session.json'), 'utf8'),
    );
    const actor = request('user'),
      repo = request(repository);
    let destinationMatches = false;
    try {
      destinationMatches =
        fresh.destination === session.destination &&
        realpathSync(fresh.destination) === realpathSync(root);
    } catch {
      /* invalid destination cannot authorize operations */
    }
    return {
      actor: actor.login,
      actorId: actor.node_id,
      repositoryId: repo.node_id,
      sessionOpen:
        fresh.state === 'open' &&
        session.state === 'open' &&
        /^[A-Za-z0-9_-]{1,70}$/.test(fresh.operationId) &&
        fresh.operationId === session.operationId &&
        fresh.actor?.login === 'glyad' &&
        fresh.actor.login === session.actor?.login &&
        fresh.actor.login === actor.login &&
        fresh.actor.id === session.actor?.id &&
        fresh.actor.id === actor.node_id &&
        fresh.repositoryId === session.repositoryId &&
        fresh.repositoryId === repo.node_id &&
        fresh.fullName === 'glyad/github-workspace-manager' &&
        fresh.fullName === session.fullName &&
        fresh.fullName === repo.full_name &&
        repo.owner?.login === 'glyad' &&
        destinationMatches,
    };
  }
  async function requireIdentity(op) {
    const identity = await observeIdentity();
    if (
      !identity.sessionOpen ||
      (op && (op.actor !== identity.actor || op.repositoryId !== identity.repositoryId))
    )
      throw Error('Authorized session identity mismatch');
    return identity;
  }
  return {
    async readJournal() {
      await requireIdentity();
      const r = await journal.readJournal(journalKey);
      if (r.kind !== 'verified') throw Error('Journal unavailable');
      return r.value.map((row) => row.settings);
    },
    async appendJournal(settings) {
      const identity = await requireIdentity();
      const r = await journal.appendJournal(journalKey, {
        operationId: journalKey,
        phase: 'project-' + settings.phase,
        repositoryId: identity.repositoryId,
        settings,
      });
      if (r.kind !== 'verified') throw Error('Journal not durable');
    },
    observeIdentity: observeIdentity,
    async observe(op, id, b = {}) {
      await requireIdentity(op);
      const d = op.desired;
      if (op.kind === 'project') {
        if (id) {
          const p = node(id, '... on ProjectV2 {id title}');
          return p?.id ? normalized(p.id, { title: p.title }) : null;
        }
        const ps = graph(
          'query{viewer{projectsV2(first:100){nodes{id title}pageInfo{hasNextPage}}}}',
        ).viewer.projectsV2;
        if (ps.pageInfo.hasNextPage) throw Error('Project pagination required');
        const matches = ps.nodes.filter((p) => p.title === d.title);
        if (matches.length > 1) throw Error('Ambiguous Project');
        return matches[0] ? normalized(matches[0].id, { title: matches[0].title }) : null;
      }
      if (op.kind === 'project-settings') {
        const p = node(
          project(b),
          '... on ProjectV2{id title public repositories(first:100){nodes{id}pageInfo{hasNextPage}}}',
        );
        if (p.repositories.pageInfo.hasNextPage) throw Error('Repository pagination required');
        return normalized(p.id, {
          title: p.title,
          public: p.public,
          repositoryId: p.repositories.nodes.some((r) => r.id === op.repositoryId)
            ? op.repositoryId
            : null,
        });
      }
      if (op.kind === 'field') {
        const f = selectField(b, d.name);
        return f
          ? normalized(f.id, {
              name: f.name,
              options: f.options?.map(({ name, color, description }) => ({
                name,
                color,
                description,
              })),
            })
          : null;
      }
      if (op.kind === 'label') {
        const labels = request(repository + '/labels?per_page=100');
        if (labels.length === 100) throw Error('Label pagination required');
        const label = labels.find((l) => l.name === d.name);
        return label
          ? normalized(label.node_id, {
              name: label.name,
              color: label.color.toUpperCase(),
              description: label.description,
            })
          : null;
      }
      if (op.kind === 'milestone') {
        const ms = request(repository + '/milestones?state=all&per_page=100');
        if (ms.length === 100) throw Error('Milestone pagination required');
        const matches = ms.filter((m) => m.title === d.title);
        if (matches.length > 1) throw Error('Ambiguous milestone');
        return matches[0] ? normalized(matches[0].node_id, { title: matches[0].title }) : null;
      }
      if (op.kind === 'issue') {
        if (!id) {
          const issues = request(repository + '/issues?state=all&per_page=100');
          if (issues.length === 100) throw Error('Issue pagination required');
          const matches = issues.filter((i) =>
            i.body?.includes('<!-- gwm-requirement:' + op.key.slice(6) + ' -->'),
          );
          if (matches.length > 1) throw Error('Duplicate requirement marker');
          id = matches[0]?.node_id;
        }
        if (!id) return null;
        const i = node(
          id,
          '... on Issue{id title body milestone{title}labels(first:100){nodes{name}pageInfo{hasNextPage}}}',
        );
        if (!i?.id || i.labels.pageInfo.hasNextPage) throw Error('Issue unavailable');
        return normalized(i.id, {
          title: i.title,
          body: i.body,
          milestone: i.milestone?.title ?? null,
          labels: i.labels.nodes.map((l) => l.name).sort(),
        });
      }
      if (op.kind === 'membership') {
        const p = node(
          ref(b, 'issue:' + d.issueKey),
          '... on Issue{projectItems(first:100){nodes{id project{id}fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}pageInfo{hasNextPage}}}',
        ).projectItems;
        if (p.pageInfo.hasNextPage) throw Error('Membership pagination required');
        const matches = p.nodes.filter((i) => i.project.id === project(b));
        if (matches.length > 1) throw Error('Duplicate membership');
        const item = matches[0];
        return item
          ? normalized(item.id, {
              issueKey: d.issueKey,
              status: item.fieldValueByName?.name ?? null,
            })
          : null;
      }
      if (op.kind === 'subissue') {
        const child = issue(b, d.childKey),
          parent = node(child.id, '... on Issue{parent{id}}').parent;
        return parent
          ? normalized(child.id, {
              parentKey: parent.id === ref(b, 'issue:' + d.parentKey) ? d.parentKey : null,
              childKey: d.childKey,
            })
          : null;
      }
      if (op.kind === 'dependency') {
        const dependent = issue(b, d.issueKey),
          blocking = issue(b, d.blockingKey),
          list = request(
            repository + '/issues/' + dependent.number + '/dependencies/blocked_by?per_page=100',
          );
        if (list.length === 100) throw Error('Dependency pagination required');
        return list.some((i) => i.node_id === blocking.id)
          ? normalized(dependent.id + ':' + blocking.id, d)
          : null;
      }
      if (op.kind === 'view') {
        const p = node(
          project(b),
          '... on ProjectV2{views(first:100){nodes{id name layout filter}pageInfo{hasNextPage}}}',
        ).views;
        if (p.pageInfo.hasNextPage) throw Error('View pagination required');
        const matches = p.nodes.filter((v) => v.name === d.name);
        if (matches.length > 1) throw Error('Ambiguous view');
        const v = matches[0];
        return v
          ? normalized(v.id, { name: v.name, layout: v.layout, filter: v.filter ?? '' })
          : null;
      }
      throw Error('Unsupported baseline observation');
    },
    async apply(op, id, b) {
      const identity = await requireIdentity(op);
      const d = op.desired;
      if (op.kind === 'project')
        return graph(
          'mutation($owner:ID!,$title:String!){createProjectV2(input:{ownerId:$owner,title:$title}){projectV2{id}}}',
          { owner: identity.actorId, title: d.title },
        ).createProjectV2.projectV2;
      if (op.kind === 'project-settings') {
        graph(
          'mutation($id:ID!){updateProjectV2(input:{projectId:$id,public:true}){projectV2{id}}}',
          { id: project(b) },
        );
        graph(
          'mutation($id:ID!,$repo:ID!){linkProjectV2ToRepository(input:{projectId:$id,repositoryId:$repo}){repository{id}}}',
          { id: project(b), repo: op.repositoryId },
        );
        return { id: project(b) };
      }
      if (op.kind === 'field') {
        const old = selectField(b, d.name),
          options = d.options.map((o) => ({
            ...o,
            ...(old?.options?.find((v) => v.name === o.name)
              ? { id: old.options.find((v) => v.name === o.name).id }
              : {}),
          }));
        if (old)
          return graph(
            'mutation($id:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]){updateProjectV2Field(input:{fieldId:$id,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
            { id: old.id, options },
          ).updateProjectV2Field.projectV2Field;
        return graph(
          'mutation($project:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]){createProjectV2Field(input:{projectId:$project,name:$name,dataType:SINGLE_SELECT,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
          { project: project(b), name: d.name, options },
        ).createProjectV2Field.projectV2Field;
      }
      if (op.kind === 'label') {
        const label = request(
          repository + '/labels' + (id ? '/' + encodeURIComponent(d.name) : ''),
          id ? 'PATCH' : 'POST',
          d,
        );
        return { id: label.node_id };
      }
      if (op.kind === 'milestone') {
        const m = request(repository + '/milestones', 'POST', { title: d.title });
        return { id: m.node_id };
      }
      if (op.kind === 'issue') {
        const ms = d.milestone
          ? request(repository + '/milestones?state=all&per_page=100').find(
              (m) => m.node_id === ref(b, 'milestone'),
            )
          : null;
        if (d.milestone && !ms) throw Error('Milestone identity missing');
        const i = request(repository + '/issues', 'POST', {
          title: d.title,
          body: d.body,
          labels: d.labels,
          ...(ms ? { milestone: ms.number } : {}),
        });
        return { id: i.node_id };
      }
      if (op.kind === 'membership') {
        const item = id
          ? { id }
          : graph(
              'mutation($p:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$issue}){item{id}}}',
              { p: project(b), issue: ref(b, 'issue:' + d.issueKey) },
            ).addProjectV2ItemById.item;
        const status = selectField(b, 'Status'),
          option = status.options.find((o) => o.name === d.status);
        if (!option) throw Error('Unknown native Status');
        graph(
          'mutation($p:ID!,$item:ID!,$field:ID!,$value:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$value}}){projectV2Item{id}}}',
          { p: project(b), item: item.id, field: status.id, value: option.id },
        );
        return item;
      }
      if (op.kind === 'subissue') {
        graph(
          'mutation($parent:ID!,$child:ID!){addSubIssue(input:{issueId:$parent,subIssueId:$child}){issue{id}}}',
          { parent: ref(b, 'issue:' + d.parentKey), child: ref(b, 'issue:' + d.childKey) },
        );
        return { id: ref(b, 'issue:' + d.childKey) };
      }
      if (op.kind === 'dependency') {
        graph(
          'mutation($issue:ID!,$blocking:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocking}){issue{id}}}',
          { issue: ref(b, 'issue:' + d.issueKey), blocking: ref(b, 'issue:' + d.blockingKey) },
        );
        return { id: ref(b, 'issue:' + d.issueKey) + ':' + ref(b, 'issue:' + d.blockingKey) };
      }
      if (op.kind === 'view') {
        const view = id
          ? { id }
          : graph(
              'mutation($p:ID!,$name:String!,$layout:ProjectV2ViewLayout!){createProjectV2View(input:{projectId:$p,name:$name,layout:$layout}){projectV2View{id}}}',
              { p: project(b), name: d.name, layout: d.layout },
            ).createProjectV2View.projectV2View;
        graph(
          'mutation($id:ID!,$filter:String!,$layout:ProjectV2ViewLayout!){updateProjectV2View(input:{viewId:$id,filter:$filter,layout:$layout}){projectV2View{id}}}',
          { id: view.id, filter: d.filter, layout: d.layout },
        );
        return view;
      }
      throw Error('Unsupported baseline mutation');
    },
  };
}
/** Whole-run exclusion. An unknown stale lock requires operator reconciliation. */
export async function withProjectBaselineLock(root, run) {
  const path = join(root, '.governance-local/setup/project-baseline.lock');
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.sync();
    return await run();
  } finally {
    if (handle) {
      await handle.close();
      await unlink(path);
    }
  }
}
