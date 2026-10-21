import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planProjectBaseline,
  applyProjectBaseline,
  projectDigest,
} from '../../tools/governance/project-baseline.mjs';
const config = {
  owner: 'glyad',
  repositoryId: 'R_repo',
  title: 'GitHub Workspace Manager',
  public: true,
  milestone: 'v0.1.0',
  nativeIssueTypes: false,
  fields: {
    Status: ['Backlog', 'Planned', 'In progress', 'In review', 'Integrated', 'Released'],
    Priority: ['P0', 'P1', 'P2', 'P3'],
    Size: ['XS', 'S', 'M', 'L', 'XL'],
  },
  labels: [],
};
const scope = {
  entries: [
    {
      key: 'product-01',
      title: 'Task 1',
      body: 'Approved acceptance',
      milestone: 'v0.1.0',
      status: 'Planned',
      parentKey: 'version-0-1-0',
      dependencies: [],
      labels: ['type:feature'],
    },
    {
      key: 'version-0-1-0',
      title: 'v0.1.0',
      body: 'Version umbrella',
      milestone: 'v0.1.0',
      status: 'Planned',
      dependencies: [],
    },
  ],
};
const snapshot = () => ({ actor: 'glyad', repositoryId: 'R_repo', projects: [], bindings: {} });
function fake() {
  const values = new Map(),
    journal = [],
    calls = [];
  return {
    values,
    journal,
    calls,
    async readJournal() {
      return structuredClone(journal);
    },
    async appendJournal(row) {
      journal.push(structuredClone(row));
    },
    async observe(operation, id) {
      return values.get(id ?? operation.key) ?? null;
    },
    async apply(operation) {
      calls.push(operation.key);
      const value = {
        id: 'ID_' + operation.key,
        key: operation.key,
        fingerprint: operation.fingerprint,
      };
      values.set(value.id, value);
      values.set(operation.key, value);
      return value;
    },
    async observeIdentity() {
      return { actor: 'glyad', repositoryId: 'R_repo', sessionOpen: true };
    },
  };
}
test('duplicate target Project names block rather than choose first', () => {
  const s = snapshot();
  s.projects = [
    { id: 'a', title: config.title },
    { id: 'b', title: config.title },
  ];
  assert.throws(() => planProjectBaseline(s, config, scope), /ambiguous/i);
});
test('identity mismatch blocks plan', () => {
  assert.throws(
    () => planProjectBaseline({ ...snapshot(), actor: 'other' }, config, scope),
    /identity/i,
  );
});
test('duplicate stable Issue IDs block plan', () => {
  const bad = structuredClone(scope);
  bad.entries.push(bad.entries[0]);
  assert.throws(() => planProjectBaseline(snapshot(), config, bad), /duplicate/i);
});
test('unsupported native types use selected labels without type mutation', () => {
  const ops = planProjectBaseline(snapshot(), config, scope);
  const issue = ops.find((o) => o.key === 'issue:product-01');
  assert.equal(issue.desired.type, undefined);
  assert.deepEqual(issue.desired.labels, ['type:feature']);
});
test('product work stays Planned and missing Priority/Size are not invented', () => {
  const ops = planProjectBaseline(snapshot(), config, scope);
  const issue = ops.find((o) => o.key === 'membership:product-01');
  assert.equal(issue.desired.status, 'Planned');
  assert.equal(issue.desired.priority, undefined);
  assert.equal(issue.desired.size, undefined);
});
test('unknown parent or dependency blocks before publishing', () => {
  const bad = structuredClone(scope);
  bad.entries[0].dependencies = ['missing'];
  assert.throws(() => planProjectBaseline(snapshot(), config, bad), /unknown/i);
});
test('native link operation exists separately from body links', () => {
  const ops = planProjectBaseline(snapshot(), config, scope);
  assert.ok(ops.some((o) => o.kind === 'subissue' && o.desired.childKey === 'product-01'));
});
test('verified resume reuses receipt IDs and never duplicates', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  const a = await applyProjectBaseline(p, ops);
  assert.equal(a.kind, 'verified');
  const n = p.calls.length;
  const b = await applyProjectBaseline(p, ops);
  assert.equal(b.kind, 'verified');
  assert.equal(p.calls.length, n);
  assert.ok(b.value.bindings['issue:product-01']);
});
test('lost create response remains uncertain without automatic retry', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  p.apply = async (o) => {
    p.calls.push(o.key);
    throw Error('lost');
  };
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'uncertain');
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'uncertain');
  assert.equal(p.calls.length, 1);
});
test('partial creation resumes exact IDs after independent readback', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  const observe = p.observe;
  let once = true;
  p.observe = async (o, id) => {
    if (id && once) {
      once = false;
      throw Error('read failure');
    }
    return observe(o, id);
  };
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'uncertain');
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'verified');
  assert.equal(p.calls.filter((k) => k === 'project').length, 1);
});
test('visibility mismatch is not accepted from mutation response', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  p.observe = async () => ({ id: 'wrong', fingerprint: 'private' });
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'conflict');
  assert.equal(p.calls.length, 0);
});
test('relationship readback failure remains pending', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  const observe = p.observe;
  p.observe = async (o, id) => (o.kind === 'subissue' && id ? null : observe(o, id));
  const r = await applyProjectBaseline(p, ops);
  assert.equal(r.kind, 'uncertain');
  assert.equal(r.value, undefined);
});
test('fresh actor/session drift blocks before mutation', async () => {
  const p = fake();
  p.observeIdentity = async () => ({ actor: 'other', repositoryId: 'R_repo', sessionOpen: true });
  assert.equal(
    (await applyProjectBaseline(p, planProjectBaseline(snapshot(), config, scope))).kind,
    'blocked',
  );
  assert.equal(p.calls.length, 0);
});
test('journal failure stops before mutation', async () => {
  const p = fake();
  p.appendJournal = async () => {
    throw Error('disk');
  };
  assert.equal(
    (await applyProjectBaseline(p, planProjectBaseline(snapshot(), config, scope))).kind,
    'uncertain',
  );
  assert.equal(p.calls.length, 0);
});

test('latest lost mutable response remains sticky despite an older receipt', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope).slice(0, 2);
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'verified');
  const value = p.values.get('project-settings');
  value.fingerprint = 'drift';
  const apply = p.apply;
  p.apply = async (o) => {
    p.calls.push(o.key);
    throw Error('lost second mutation');
  };
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'uncertain');
  const n = p.calls.length;
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'uncertain');
  assert.equal(p.calls.length, n);
  p.apply = apply;
});
test('changed operation bytes conflict before mutation', async () => {
  const p = fake(),
    ops = planProjectBaseline(snapshot(), config, scope);
  ops[0].desired.title = 'changed';
  assert.equal((await applyProjectBaseline(p, ops)).kind, 'conflict');
  assert.equal(p.calls.length, 0);
});
test('reviewed scope retains complete approved task sections and dependency ranges', async () => {
  const { readFile } = await import('node:fs/promises');
  const desired = JSON.parse(
    await readFile(new URL('../../governance/scope.json', import.meta.url)),
  );
  const product = await readFile(
    new URL('../../docs/superpowers/plans/2026-10-19-github-workspace-manager.md', import.meta.url),
    'utf8',
  );
  const tasks = desired.entries.filter((e) => e.kind === 'product');
  assert.equal(tasks.length, 24);
  for (const e of tasks) {
    const heading = '## Task ' + e.sourceTask + ': ';
    const start = product.indexOf(heading);
    const end = product.indexOf('\n## ', start + heading.length);
    const section = product.slice(product.indexOf('\n', start) + 1, end).trim();
    assert.equal(e.acceptance, section);
    assert.ok(e.body.includes(section));
    assert.equal(e.status, 'Planned');
    assert.equal(e.milestone, 'v0.1.0');
    assert.equal(e.parentKey, 'version-0-1-0');
    const line = /\*\*Depends on:\*\* (.+)/.exec(section)[1];
    const expected = [];
    for (const [, a, b] of line.matchAll(/(\d+)(?:[–-](\d+))?/g))
      for (let n = +a; n <= +(b ?? a); n++) expected.push('product-' + String(n).padStart(2, '0'));
    assert.deepEqual(e.dependencies, expected);
  }
  assert.equal(desired.entries.filter((e) => e.kind === 'deferred').length, 12);
  assert.ok(
    desired.entries
      .filter((e) => e.kind === 'deferred')
      .every((e) => e.milestone === null && e.status === 'Backlog'),
  );
  assert.equal(projectDigest({ a: 1, b: 2 }), projectDigest({ b: 2, a: 1 }));
});

for (const [name, change] of [
  ['valid identity', () => {}],
  [
    'actor ID',
    (s) => {
      s.actor.id = 'DIFFERENT_OWNER';
    },
  ],
  [
    'repository ID',
    (s) => {
      s.repositoryId = 'R_other';
    },
  ],
  [
    'destination',
    (s) => {
      s.destination += '/other';
    },
  ],
  [
    'full name',
    (s) => {
      s.fullName = 'glyad/other';
    },
  ],
  [
    'operation ID',
    (s) => {
      s.operationId = 'other-session';
    },
  ],
]) {
  test('production port verifies constructor ' + name + ' before mutation', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createProjectGitHubPort } = await import('../../tools/governance/project-baseline.mjs');
    const root = await mkdtemp(join(tmpdir(), 'project-session-'));
    try {
      const fresh = {
        operationId: 'approved-session',
        state: 'open',
        actor: { login: 'glyad', id: 'U_owner' },
        repositoryId: 'R_repo',
        fullName: 'glyad/github-workspace-manager',
        destination: root,
      };
      await mkdir(join(root, '.governance-local/setup'), { recursive: true, mode: 0o700 });
      await writeFile(join(root, '.governance-local/setup/session.json'), JSON.stringify(fresh), {
        mode: 0o600,
      });
      const passed = structuredClone(fresh);
      change(passed);
      let mutations = 0;
      const execute = (_binary, args, options) => {
        const endpoint = args[args.indexOf('--hostname') + 2];
        if (endpoint === 'user') return JSON.stringify({ login: 'glyad', node_id: 'U_owner' });
        if (endpoint === 'repos/glyad/github-workspace-manager')
          return JSON.stringify({
            node_id: 'R_repo',
            full_name: 'glyad/github-workspace-manager',
            owner: { login: 'glyad' },
          });
        mutations++;
        assert.ok(options.input);
        return JSON.stringify({ data: { createProjectV2: { projectV2: { id: 'P_test' } } } });
      };
      const port = createProjectGitHubPort({ root, session: passed, execute });
      const valid = name === 'valid identity';
      assert.equal((await port.observeIdentity()).sessionOpen, valid);
      const operation = planProjectBaseline(snapshot(), config, scope)[0];
      if (valid) {
        assert.deepEqual(await port.apply(operation, undefined, {}), { id: 'P_test' });
        assert.equal(mutations, 1);
      } else {
        await assert.rejects(() => port.apply(operation, undefined, {}), /session|identity/i);
        assert.equal(mutations, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
