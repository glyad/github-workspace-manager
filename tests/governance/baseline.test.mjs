import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as baseline from '../../tools/governance/baseline.mjs';
const actorId = 'MDQ6VXNlcjE=';
const evidence = (id) => [
  { source: 'trusted-test', actorId, resourceId: id, observedAt: new Date().toISOString() },
];
const verified = (value, id) => ({ kind: 'verified', value, evidence: evidence(id) });
async function temp() {
  return realpath(await mkdtemp(join(tmpdir(), 'baseline-test-')));
}
test('durable journal reads exact appended records across new writer instances', async () => {
  assert.equal(typeof baseline.createSetupJournal, 'function');
  const root = await temp();
  const journal = baseline.createSetupJournal({ root, actorId });
  const record = {
    operationId: 'op-1',
    phase: 'create-intent',
    fullName: 'glyad/github-workspace-manager',
  };
  assert.equal((await journal.appendJournal('op-1', record)).kind, 'verified');
  assert.deepEqual(
    (await baseline.createSetupJournal({ root, actorId }).readJournal('op-1')).value,
    [record],
  );
  assert.equal((await stat(join(root, '.governance-local/setup'))).mode & 0o777, 0o700);
});
test('journal rejects traversal, secrets, symlink escape and tampered records', async () => {
  assert.equal(typeof baseline.createSetupJournal, 'function');
  const root = await temp();
  const j = baseline.createSetupJournal({ root, actorId });
  assert.equal(
    (await j.appendJournal('../escape', { operationId: '../escape', phase: 'x' })).kind,
    'blocked',
  );
  assert.equal(
    (await j.appendJournal('op', { operationId: 'op', phase: 'x', token: 'private' })).kind,
    'blocked',
  );
  await j.appendJournal('op', { operationId: 'op', phase: 'intent' });
  await writeFile(join(root, '.governance-local/setup/op.jsonl'), '{}\n');
  assert.equal((await j.readJournal('op')).kind, 'blocked');
  const other = await temp();
  await symlink(root, join(other, '.governance-local'));
  assert.equal(
    (await baseline.createSetupJournal({ root: other, actorId }).readJournal('op')).kind,
    'blocked',
  );
});
test('lost creation response remains uncertain without attributable result and never creates twice', async () => {
  assert.equal(typeof baseline.ensureRepository, 'function');
  const root = await temp();
  const j = baseline.createSetupJournal({ root, actorId });
  let remote = null,
    calls = 0;
  const port = {
    ...j,
    observeActor: async () => verified({ id: actorId, login: 'glyad' }, actorId),
    observeRepository: async () => verified(remote, remote?.id ?? 'glyad/github-workspace-manager'),
    createRepository: async () => {
      assert.equal((await j.readJournal('op')).value[0].phase, 'create-intent');
      calls++;
      remote = {
        id: 'R_1',
        fullName: 'glyad/github-workspace-manager',
        ownerLogin: 'glyad',
        visibility: 'public',
      };
      throw Error('lost');
    },
  };
  const operation = { operationId: 'op', actorId, fullName: 'glyad/github-workspace-manager' };
  assert.equal((await baseline.ensureRepository(port, operation)).kind, 'uncertain');
  assert.equal((await baseline.ensureRepository(port, operation)).kind, 'uncertain');
  assert.equal(calls, 1);
});
test('unknown creation outcome is not automatically retried and missing journal blocks existing adoption', async () => {
  assert.equal(typeof baseline.ensureRepository, 'function');
  const j = baseline.createSetupJournal({ root: await temp(), actorId });
  let calls = 0;
  const port = {
    ...j,
    observeActor: async () => verified({ id: actorId, login: 'glyad' }, actorId),
    observeRepository: async () => verified(null, 'glyad/github-workspace-manager'),
    createRepository: async () => {
      calls++;
      throw Error('lost');
    },
  };
  const op = { operationId: 'op', actorId, fullName: 'glyad/github-workspace-manager' };
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'uncertain');
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'uncertain');
  assert.equal(calls, 1);
  port.observeRepository = async () =>
    verified(
      { id: 'R_1', fullName: op.fullName, ownerLogin: 'glyad', visibility: 'public' },
      'R_1',
    );
  assert.equal(
    (await baseline.ensureRepository(port, { ...op, operationId: 'other' })).kind,
    'conflict',
  );
});
test('baseline checks frozen file content and supplemental AGENTS scope before mutation', async () => {
  assert.equal(typeof baseline.applyBaseline, 'function');
  const root = await temp();
  await writeFile(join(root, 'README.md'), 'changed');
  let calls = 0;
  const session = {
    state: 'open',
    actor: { id: actorId, login: 'glyad' },
    operationId: 'op',
    repositoryId: 'R_1',
    fullName: 'glyad/github-workspace-manager',
    destination: root,
    approvedPaths: ['README.md'],
  };
  const port = {
    applySettings: async () => {
      calls++;
    },
  };
  assert.equal(
    (await baseline.applyBaseline(port, session, { 'README.md': '0'.repeat(64) })).kind,
    'blocked',
  );
  assert.equal(calls, 0);
  assert.equal(
    (await baseline.applyBaseline(port, session, { 'AGENTS.md': '0'.repeat(64) })).kind,
    'blocked',
  );
});
test('journal uses parseable JSONL and pins recorded repository identity on resume', async () => {
  const root = await temp();
  const j = baseline.createSetupJournal({ root, actorId });
  await j.appendJournal('op', {
    operationId: 'op',
    phase: 'create-intent',
    fullName: 'glyad/github-workspace-manager',
  });
  const raw = await readFile(join(root, '.governance-local/setup/op.jsonl'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(JSON.parse(raw.trim()).sequence, 1);
  await j.appendJournal('op', {
    operationId: 'op',
    phase: 'create-verified',
    repositoryId: 'R_old',
  });
  const port = {
    ...j,
    observeActor: async () => verified({ id: actorId, login: 'glyad' }, actorId),
    observeRepository: async () =>
      verified(
        {
          id: 'R_recreated',
          fullName: 'glyad/github-workspace-manager',
          ownerLogin: 'glyad',
          visibility: 'public',
        },
        'R_recreated',
      ),
  };
  assert.equal(
    (
      await baseline.ensureRepository(port, {
        operationId: 'op',
        actorId,
        fullName: 'glyad/github-workspace-manager',
      })
    ).kind,
    'conflict',
  );
});
test('production readback rejects unverified commits and mismatched settings rather than mutation acknowledgements', async () => {
  const port = baseline.createBaselineGitHubPort({
    root: await temp(),
    actorId,
    execute: () =>
      'HTTP/2.0 200 OK\r\n\r\n' +
      JSON.stringify({
        node_id: 'R_1',
        full_name: 'glyad/github-workspace-manager',
        private: false,
        has_issues: true,
        has_discussions: true,
        has_wiki: false,
        is_template: false,
        allow_merge_commit: true,
        allow_squash_merge: false,
        allow_rebase_merge: false,
        allow_auto_merge: false,
        delete_branch_on_merge: false,
        merge_commit_title: 'PR_TITLE',
        default_branch: 'main',
        has_pages: false,
      }),
  });
  assert.equal(typeof port.observeBaseline, 'function');
  assert.notEqual(
    (await port.observeBaseline({ repositoryId: 'R_1', destination: await temp() }, {})).kind,
    'verified',
  );
});
test('explicit existing local verification configuration reaches disposable signing probe', async () => {
  assert.equal(typeof baseline.probeBaselineSigning, 'function');
});
test('baseline requires fresh authenticated owner before applying settings', async () => {
  const root = await temp();
  await writeFile(join(root, 'README.md'), 'frozen');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update('frozen').digest('hex');
  let mutations = 0;
  const session = {
    state: 'open',
    actor: { id: actorId, login: 'glyad' },
    operationId: 'op',
    repositoryId: 'R_1',
    fullName: 'glyad/github-workspace-manager',
    destination: root,
    approvedPaths: ['README.md'],
  };
  const port = {
    observeActor: async () => verified({ id: 'wrong', login: 'other' }, 'wrong'),
    observeRepository: async () =>
      verified(
        { id: 'R_1', fullName: session.fullName, ownerLogin: 'glyad', visibility: 'public' },
        'R_1',
      ),
    appendJournal: async () => verified({ operationId: 'op' }, 'op'),
    applySettings: async () => {
      mutations++;
    },
    observeBaseline: async () => verified({ verified: true, repositoryId: 'R_1' }, 'R_1'),
  };
  assert.equal(
    (await baseline.applyBaseline(port, session, { 'README.md': digest })).kind,
    'blocked',
  );
  assert.equal(mutations, 0);
});
async function observedBaselineWith(extra = [], settingsOverride = {}) {
  const root = await temp();
  await writeFile(join(root, 'README.md'), 'frozen');
  const settings = {
    description: 'Portable AI-assisted GitHub provisioning and configuration management',
    merge_commit_message: 'PR_BODY',
    has_projects: true,
    ...settingsOverride,
    node_id: 'R_1',
    full_name: 'glyad/github-workspace-manager',
    visibility: 'public',
    default_branch: 'main',
    has_issues: true,
    has_discussions: true,
    has_wiki: false,
    has_pages: false,
    is_template: false,
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    merge_commit_title: 'PR_TITLE',
  };
  const responses = {
    'repos/glyad/github-workspace-manager': settings,
    'repos/glyad/github-workspace-manager/commits/main': {
      sha: 'C_1',
      commit: { verification: { verified: true, reason: 'valid' }, tree: { sha: 'T_1' } },
    },
    'repos/glyad/github-workspace-manager/git/ref/heads/develop': { object: { sha: 'C_1' } },
    'repos/glyad/github-workspace-manager/git/trees/T_1?recursive=1': {
      truncated: false,
      tree: [
        {
          path: 'README.md',
          type: 'blob',
          mode: '100644',
          sha: '53ead0e50af5c063fc3fd6cdd94dbd50840ea475',
        },
        ...extra,
      ],
    },
  };
  const port = baseline.createBaselineGitHubPort({
    root,
    actorId,
    execute: (binary, args) => {
      assert.equal(binary, 'gh');
      assert.equal(args[5], '--method');
      assert.equal(args[6], 'GET');
      assert.ok(responses[args[4]], `unexpected endpoint ${args[4]}`);
      return 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify(responses[args[4]]);
    },
  });
  return port.observeBaseline(
    { repositoryId: 'R_1', destination: root },
    { 'README.md': 'ffb304816a1090313e833215c08dae3d209cfad1ffd1f674f0909a2ae99e1394' },
  );
}
test('remote readback accepts exact signed baseline and equal develop', async () => {
  assert.equal((await observedBaselineWith()).kind, 'verified');
});
for (const [name, entry] of [
  ['gitlink', { path: 'unexpected-submodule', mode: '160000', type: 'commit', sha: 'deadbeef' }],
  [
    'empty unapproved directory',
    { path: 'unexpected-directory', mode: '040000', type: 'tree', sha: 'deadbeef' },
  ],
  ['symlink', { path: 'unexpected-link', mode: '120000', type: 'blob', sha: 'deadbeef' }],
])
  test(`remote readback rejects ${name} outside frozen manifest`, async () => {
    assert.equal((await observedBaselineWith([entry])).kind, 'blocked');
  });

test('a resource appearing before create cannot be adopted by resuming intent-only operation', async () => {
  const j = baseline.createSetupJournal({ root: await temp(), actorId });
  let observations = 0,
    creates = 0;
  const remote = {
    id: 'R_external',
    fullName: 'glyad/github-workspace-manager',
    ownerLogin: 'glyad',
    visibility: 'public',
  };
  const port = {
    ...j,
    observeActor: async () => verified({ id: actorId, login: 'glyad' }, actorId),
    observeRepository: async () => {
      observations++;
      return observations === 1 ? verified(null, remote.fullName) : verified(remote, remote.id);
    },
    createRepository: async () => {
      creates++;
    },
  };
  const op = { operationId: 'race', fullName: remote.fullName, actorId };
  assert.notEqual((await baseline.ensureRepository(port, op)).kind, 'verified');
  assert.notEqual((await baseline.ensureRepository(port, op)).kind, 'verified');
  assert.equal(creates, 0);
});
for (const patch of [{ description: 'different' }, { has_projects: false }])
  test(`remote readback rejects setting mismatch ${Object.keys(patch)[0]}`, async () => {
    assert.equal((await observedBaselineWith([], patch)).kind, 'blocked');
  });

test('attributable create result binds exact ID before independently verified resume', async () => {
  const j = baseline.createSetupJournal({ root: await temp(), actorId });
  let remote = null,
    calls = 0;
  const port = {
    ...j,
    observeActor: async () => verified({ id: actorId, login: 'glyad' }, actorId),
    observeRepository: async () => verified(remote, remote?.id ?? 'glyad/github-workspace-manager'),
    createRepository: async () => {
      calls++;
      remote = {
        id: 'R_owned',
        fullName: 'glyad/github-workspace-manager',
        ownerLogin: 'glyad',
        visibility: 'public',
      };
      assert.ok((await j.readJournal('bound')).value.some((r) => r.phase === 'create-attempt'));
      return verified(remote, 'R_owned');
    },
  };
  const op = { operationId: 'bound', actorId, fullName: 'glyad/github-workspace-manager' };
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'verified');
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'verified');
  assert.equal(calls, 1);
  assert.ok(
    (await j.readJournal('bound')).value.some(
      (r) => r.phase === 'create-result' && r.repositoryId === 'R_owned',
    ),
  );
});
test('successful creation receipt is durable before failed readback and reconciles only its exact ID', async () => {
  const root = await temp();
  let remote = null,
    failRead = true,
    postCount = 0;
  const port = baseline.createBaselineGitHubPort({
    root,
    actorId,
    execute: (binary, args) => {
      const endpoint = args[4],
        method = args[6];
      let value,
        status = 200;
      if (endpoint === 'user') value = { node_id: actorId, login: 'glyad' };
      else if (endpoint === 'user/repos' && method === 'POST') {
        postCount++;
        status = 201;
        value = {
          node_id: 'R_receipt',
          full_name: 'glyad/github-workspace-manager',
          owner: { login: 'glyad' },
          visibility: 'public',
        };
        remote = value;
      } else if (endpoint === 'repos/glyad/github-workspace-manager') {
        if (remote && failRead) throw Error('read unavailable');
        status = remote ? 200 : 404;
        value = remote ?? { message: 'Not Found' };
      } else throw Error('unexpected request');
      return `HTTP/2.0 ${status} Status\r\n\r\n${JSON.stringify(value)}`;
    },
  });
  const op = { operationId: 'receipt', actorId, fullName: 'glyad/github-workspace-manager' };
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'uncertain');
  assert.ok(
    (await port.readJournal('receipt')).value.some(
      (r) => r.phase === 'create-response' && r.repositoryId === 'R_receipt',
    ),
  );
  failRead = false;
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'verified');
  remote = { ...remote, node_id: 'R_other' };
  assert.equal((await baseline.ensureRepository(port, op)).kind, 'conflict');
  assert.equal(postCount, 1);
});
for (const [name, operation] of [
  ['missing operation', undefined],
  ['missing operation ID', { actorId, fullName: 'glyad/github-workspace-manager' }],
  [
    'invalid operation ID',
    { operationId: '../escape', actorId, fullName: 'glyad/github-workspace-manager' },
  ],
  [
    'wrong actor',
    { operationId: 'op', actorId: 'other', fullName: 'glyad/github-workspace-manager' },
  ],
  ['wrong repository', { operationId: 'op', actorId, fullName: 'glyad/other' }],
])
  test(`direct creation rejects ${name} before POST`, async () => {
    let posts = 0;
    const port = baseline.createBaselineGitHubPort({
      root: await temp(),
      actorId,
      execute: (binary, args) => {
        if (args[6] === 'POST') posts++;
        return (
          'HTTP/2.0 201 Created\r\n\r\n' +
          JSON.stringify({
            node_id: 'R_invalid',
            full_name: 'glyad/github-workspace-manager',
            owner: { login: 'glyad' },
            visibility: 'public',
          })
        );
      },
    });
    assert.equal((await port.createRepository(operation)).kind, 'blocked');
    assert.equal(posts, 0);
  });
test('direct valid-shaped creation rejects changed authenticated account before POST', async () => {
  let posts = 0;
  const port = baseline.createBaselineGitHubPort({
    root: await temp(),
    actorId,
    execute: (binary, args) => {
      if (args[6] === 'POST') posts++;
      return 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify({ node_id: 'other', login: 'other' });
    },
  });
  assert.equal(
    (
      await port.createRepository({
        operationId: 'op',
        actorId,
        fullName: 'glyad/github-workspace-manager',
      })
    ).kind,
    'blocked',
  );
  assert.equal(posts, 0);
});
test('preflight authorizes Projects only after sending the accepted GraphQL request shape', async () => {
  const { createReadOnlyGitHubPort } = await import('../../tools/governance/github.mjs');
  const desired = JSON.parse(
    await readFile(new URL('../../governance/repository.json', import.meta.url), 'utf8'),
  );
  const acceptedQuery =
    'query { viewer { projectsV2(first:100) { nodes { id title public } pageInfo { hasNextPage } } } }';
  let queryAccepted = false;
  const port = createReadOnlyGitHubPort({
    signingProbe: async () => ({
      localVerified: true,
      githubAssociationVerified: true,
      fingerprint: 'SHA256:public-fixture',
    }),
    execute: (binary, args, options = {}) => {
      assert.equal(binary, 'gh');
      if (args[0] === 'config') return { ok: true, stdout: 'https\n' };
      if (args.includes('graphql')) {
        queryAccepted = JSON.parse(options.input).query === acceptedQuery;
        return queryAccepted
          ? {
              ok: true,
              stdout: JSON.stringify({
                data: {
                  viewer: {
                    projectsV2: {
                      nodes: [{ id: 'P_unrelated', title: 'Other project', public: true }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              }),
            }
          : {
              ok: false,
              stdout: JSON.stringify({ errors: [{ message: 'Invalid GraphQL document' }] }),
            };
      }
      if (args.includes('user')) {
        const body = JSON.stringify({ node_id: actorId, login: 'glyad' });
        return {
          ok: true,
          stdout: args.includes('--include')
            ? 'HTTP/2.0 200 OK\r\nx-oauth-scopes: repo, project\r\n\r\n' + body
            : body,
        };
      }
      if (args.includes('repos/glyad/github-workspace-manager'))
        return { ok: false, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{}' };
      throw Error('Unexpected preflight request');
    },
  });
  const result = await port.observeSetup(desired);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.project.authorized, true);
  assert.equal(result.value.project.scopeVerified, true);
  assert.deepEqual(result.value.project.matches, []);
  assert.equal(queryAccepted, true);
});
test('repository settings request supplies the backend-compatible PR title and body pair', async () => {
  let accepted = false;
  const port = baseline.createBaselineGitHubPort({
    root: await temp(),
    actorId,
    execute: (binary, args, options) => {
      assert.equal(args[6], 'PATCH');
      const body = JSON.parse(options.input);
      if (body.merge_commit_title !== 'PR_TITLE' || body.merge_commit_message !== 'PR_BODY') {
        const error = Error('GitHub rejected invalid_merge_commit_setting_combo');
        error.stdout =
          'HTTP/2.0 422 Unprocessable Entity\r\n\r\n' +
          JSON.stringify({
            message: 'Validation Failed',
            errors: [{ code: 'invalid', field: 'merge_commit_allowed' }],
          });
        throw error;
      }
      accepted = true;
      return 'HTTP/2.0 200 OK\r\n\r\n{}';
    },
  });
  await port.applySettings();
  assert.equal(accepted, true);
});
test('remote baseline rejects incompatible merge message even when title matches', async () => {
  assert.equal(
    (await observedBaselineWith([], { merge_commit_message: 'PR_TITLE' })).kind,
    'blocked',
  );
});
