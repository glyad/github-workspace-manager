import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureDraft,
  guardCommit,
  guardPush,
  installHooks,
} from '../../tools/governance/local-guard.mjs';
import { runChecks, checkTree } from '../../tools/governance/checks.mjs';

const sha = 'a'.repeat(40),
  base = 'b'.repeat(40);
function remote(overrides = {}) {
  let pr = {
    id: 'PR_1',
    number: 1,
    repositoryId: 'R_1',
    repository: 'glyad/github-workspace-manager',
    headRepositoryId: 'R_1',
    headBranch: 'feature/a',
    baseBranch: 'develop',
    headSha: sha,
    baseSha: base,
    state: 'OPEN',
    draft: false,
    ...overrides,
  };
  return {
    expected: {
      repositoryId: 'R_1',
      repository: 'glyad/github-workspace-manager',
      branch: 'feature/a',
      parent: 'develop',
      headSha: sha,
    },
    observePR: async () => ({ kind: 'verified', value: { ...pr } }),
    setDraft: async () => {
      pr.draft = true;
      return { kind: 'verified' };
    },
  };
}
async function repo(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'task5-check-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'value'), 'staged');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return { cwd, git };
}
test('ready PR becomes remotely verified Draft before admission', async () => {
  const r = await ensureDraft(remote(), 'PR_1');
  assert.equal(r.kind, 'verified');
  assert.equal(r.value.draft, true);
  assert.equal(r.value.baseSha, base);
});
for (const [name, fields] of [
  ['foreign repository', { repositoryId: 'R_other' }],
  ['fork', { headRepositoryId: 'R_fork' }],
  ['wrong branch', { headBranch: 'feature/b' }],
  ['closed', { state: 'CLOSED' }],
  ['stale head', { headSha: base }],
  ['wrong base', { baseBranch: 'main' }],
])
  test(`Draft guard blocks ${name}`, async () =>
    assert.equal((await ensureDraft(remote(fields), 'PR_1')).kind, 'blocked'));
test('Draft mutation must read back true and preserve exact candidate', async () => {
  const p = remote();
  p.setDraft = async () => ({ kind: 'verified' });
  assert.equal((await ensureDraft(p, 'PR_1')).kind, 'blocked');
});
test('base-only advancement during Draft transition blocks admission', async () => {
  const p = remote();
  let reads = 0;
  const observe = p.observePR;
  p.observePR = async () => {
    const r = await observe();
    if (++reads > 1) r.value.baseSha = sha;
    return r;
  };
  assert.equal((await ensureDraft(p, 'PR_1')).kind, 'blocked');
});
test('configured commands fail closed and retain failed command identity', async (t) => {
  const { cwd } = await repo(t);
  const r = await runChecks([[process.execPath, '-e', 'process.exit(7)']], cwd);
  assert.equal(r.kind, 'blocked');
  assert.equal(r.value, undefined);
  assert.equal((await runChecks([], cwd)).kind, 'blocked');
});
test('checks run on actual staged tree while preserving dirty worktree', async (t) => {
  const { cwd } = await repo(t);
  await writeFile(join(cwd, 'value'), 'dirty');
  const r = await checkTree(cwd, {
    commands: [
      [
        process.execPath,
        '-e',
        "if(require('fs').readFileSync('value','utf8')!=='staged')process.exit(1)",
      ],
    ],
  });
  assert.equal(r.kind, 'verified');
  assert.equal(await readFile(join(cwd, 'value'), 'utf8'), 'dirty');
  assert.match(r.value.tree, /^[a-f0-9]{40}$/);
});
test('staged tree mutation during checks rejects commit evidence', async (t) => {
  const { cwd, git } = await repo(t);
  const r = await checkTree(cwd, {
    commands: [
      [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(join(cwd, 'value'))},'raced'); require('child_process').execFileSync('git',['-C',${JSON.stringify(cwd)},'add','value'])`,
      ],
    ],
  });
  assert.equal(r.kind, 'blocked');
  assert.equal(git('show', ':value'), 'raced');
});
test('commit runs checks even while Draft and rejects remote verification failure', async () => {
  let checks = 0;
  const git = { observe: async () => ({ branch: 'feature/a', head: sha, parent: 'develop' }) };
  const context = { branch: 'feature/a', parent: 'develop', phase: 'ordinary', prId: 'PR_1' };
  assert.equal(
    (
      await guardCommit(git, remote({ draft: true }), context, async () => {
        checks++;
        return { kind: 'blocked', reason: 'lint' };
      })
    ).kind,
    'blocked',
  );
  assert.equal(checks, 1);
  const p = remote();
  p.observePR = async () => ({ kind: 'uncertain' });
  assert.equal(
    (
      await guardCommit(git, p, context, async () => {
        throw Error('must not run');
      })
    ).kind,
    'blocked',
  );
});
test('pre-push validates every local ref and SHA and denies deletions/main', async () => {
  const context = { branch: 'feature/a', parent: 'develop', phase: 'ordinary', prId: 'PR_1' };
  const git = {
    observe: async () => ({ branch: 'feature/a', head: sha, parent: 'develop' }),
    resolve: async () => sha,
    isAncestor: async () => true,
  };
  let checked = [];
  const validate = async (ref) => {
    checked.push(ref.sha);
    return { kind: 'verified' };
  };
  const p = remote({ draft: true });
  const lines = `refs/heads/feature/a ${sha} refs/heads/feature/a ${sha}\nrefs/heads/main ${base} refs/heads/main ${sha}`;
  assert.equal((await guardPush(git, p, context, lines, validate)).kind, 'blocked');
  assert.equal(checked.length, 1);
  assert.equal(
    (
      await guardPush(
        git,
        p,
        context,
        `refs/heads/feature/a ${'0'.repeat(40)} refs/heads/feature/a ${sha}`,
        validate,
      )
    ).kind,
    'blocked',
  );
});
test('hook installation reads back checkout-scoped hooks path', async (t) => {
  const { cwd, git } = await repo(t);
  const r = await installHooks(cwd);
  assert.equal(r.kind, 'verified');
  assert.equal(git('config', '--worktree', '--get', 'core.hooksPath'), '.githooks');
});
test('no-PR commit must revalidate absence before and after checks', async () => {
  let reads = 0;
  const p = {
    observeNoPR: async () =>
      ++reads === 1 ? { kind: 'verified', value: true } : { kind: 'blocked' },
  };
  const git = { observe: async () => ({ branch: 'feature/new', head: sha, parent: 'develop' }) };
  const r = await guardCommit(
    git,
    p,
    { branch: 'feature/new', parent: 'develop', phase: 'ordinary' },
    async () => ({ kind: 'verified', value: { passed: true } }),
  );
  assert.equal(r.kind, 'blocked');
  assert.equal(reads, 2);
});
test('all pushed branches get independent remote and exact-SHA validation', async () => {
  const branches = ['feature/a', 'feature/b'];
  const checked = [];
  const p = {
    forBranch: async (branch) => {
      const pr = remote({ draft: true, headBranch: branch });
      pr.expected.branch = branch;
      return { port: pr, context: { branch, parent: 'develop', phase: 'ordinary', prId: 'PR_1' } };
    },
  };
  const git = { resolve: async () => sha, isAncestor: async () => true };
  const records = branches.map((b) => `refs/heads/${b} ${sha} refs/heads/${b} ${sha}`).join('\n');
  assert.equal(
    (
      await guardPush(git, p, {}, records, async (r) => {
        checked.push(r.ref);
        return { kind: 'verified' };
      })
    ).kind,
    'verified',
  );
  assert.deepEqual(checked, ['refs/heads/feature/a', 'refs/heads/feature/b']);
});
for (const name of ['test', 'lint', 'format'])
  test(`failed ${name} command blocks the check sequence`, async (t) => {
    const { cwd } = await repo(t);
    const r = await runChecks(
      [
        [process.execPath, '-e', 'process.exit(1)'],
        [process.execPath, '-e', "require('fs').writeFileSync('should-not-run','bad')"],
      ],
      cwd,
    );
    assert.equal(r.kind, 'blocked');
    await assert.rejects(readFile(join(cwd, 'should-not-run')));
  });
test('pre-push rejects non-fast-forward updates even while Draft', async () => {
  const git = { resolve: async () => sha, isAncestor: async () => false };
  const p = remote({ draft: true, headSha: base });
  p.expected.headSha = base;
  assert.equal(
    (
      await guardPush(
        git,
        p,
        { branch: 'feature/a', parent: 'develop', phase: 'ordinary', prId: 'PR_1' },
        `refs/heads/feature/a ${sha} refs/heads/feature/a ${base}`,
        async () => ({ kind: 'verified' }),
      )
    ).kind,
    'blocked',
  );
});
test('installed pre-commit executes the actual staged checks and blocks a failed lint/format/test', async (t) => {
  const { cwd, git } = await repo(t);
  const { mkdir, copyFile, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const dir of ['tools/governance', 'governance', '.githooks', 'fake-bin'])
    await mkdir(join(cwd, dir), { recursive: true });
  for (const file of ['local-guard', 'parent-sync', 'checks', 'contracts'])
    await copyFile(
      new URL(`../../tools/governance/${file}.mjs`, import.meta.url),
      join(cwd, `tools/governance/${file}.mjs`),
    );
  await copyFile(
    new URL('../../.githooks/pre-commit', import.meta.url),
    join(cwd, '.githooks/pre-commit'),
  );
  await chmod(join(cwd, '.githooks/pre-commit'), 0o755);
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(cwd, 'governance/repository.json'),
    JSON.stringify({
      host: 'github.com',
      fullName: 'glyad/github-workspace-manager',
      owner: 'glyad',
    }),
  );
  await writeFile(
    join(cwd, 'fake-bin/gh'),
    `#!/bin/sh\ncase "$*" in *pulls*) echo '[]';; *) echo '{"full_name":"glyad/github-workspace-manager","node_id":"R_1"}';; esac\n`,
  );
  await chmod(join(cwd, 'fake-bin/gh'), 0o755);
  git('remote', 'add', 'origin', 'https://github.com/glyad/github-workspace-manager.git');
  git('checkout', '-qb', 'feature/a');
  await writeFile(
    join(cwd, 'governance/checks.json'),
    JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(1)']] }),
  );
  git('add', '.');
  assert.equal((await installHooks(cwd)).kind, 'verified');
  const env = {
    ...process.env,
    PATH: `${join(cwd, 'fake-bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
  };
  assert.throws(() =>
    execFileSync('git', ['-C', cwd, 'commit', '-qm', 'should fail'], { env, stdio: 'pipe' }),
  );
  assert.equal(git('log', '-1', '--format=%s'), 'fixture');
  await writeFile(
    join(cwd, 'governance/checks.json'),
    JSON.stringify({
      commands: [
        [
          process.execPath,
          '-e',
          "if(Object.keys(process.env).some(k=>k.startsWith('GIT_')))process.exit(1)",
        ],
      ],
    }),
  );
  git('add', 'governance/checks.json');
  // A staged snapshot is sufficient; a dirty worktree does not replace the staged check command.
  await writeFile(join(cwd, 'governance/checks.json'), 'dirty invalid JSON');
  execFileSync('git', ['-C', cwd, 'commit', '-qm', 'checked staged'], { env, stdio: 'pipe' });
  assert.equal(git('log', '-1', '--format=%s'), 'checked staged');
});
test('real pre-push hook reads all stdin refs and blocks failed remote Draft verification', async (t) => {
  const { cwd, git } = await repo(t);
  const { mkdir, copyFile, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const dir of ['tools/governance', 'governance', '.githooks', 'fake-bin'])
    await mkdir(join(cwd, dir), { recursive: true });
  for (const file of ['local-guard', 'parent-sync', 'checks', 'contracts'])
    await copyFile(
      new URL(`../../tools/governance/${file}.mjs`, import.meta.url),
      join(cwd, `tools/governance/${file}.mjs`),
    );
  await copyFile(
    new URL('../../.githooks/pre-push', import.meta.url),
    join(cwd, '.githooks/pre-push'),
  );
  await chmod(join(cwd, '.githooks/pre-push'), 0o755);
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(cwd, 'governance/repository.json'),
    JSON.stringify({
      host: 'github.com',
      fullName: 'glyad/github-workspace-manager',
      owner: 'glyad',
    }),
  );
  await writeFile(
    join(cwd, 'governance/checks.json'),
    JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }),
  );
  git('checkout', '-qb', 'feature/a');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'hook fixture');
  git('remote', 'add', 'origin', 'https://github.com/glyad/github-workspace-manager.git');
  const head = git('rev-parse', 'HEAD');
  const env = {
    ...process.env,
    PATH: `${join(cwd, 'fake-bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
  };
  const input = `refs/heads/feature/a ${head} refs/heads/feature/a ${head}\n`;
  await writeFile(
    join(cwd, 'fake-bin/gh'),
    `#!/bin/sh\ncase "$*" in *pulls*) echo '[]';; *) echo '{"full_name":"glyad/github-workspace-manager","node_id":"R_1"}';; esac\n`,
  );
  await chmod(join(cwd, 'fake-bin/gh'), 0o755);
  const output = execFileSync(
    join(cwd, '.githooks/pre-push'),
    ['origin', 'https://github.com/glyad/github-workspace-manager.git'],
    {
      cwd,
      env,
      input,
      encoding: 'utf8',
    },
  );
  assert.equal(JSON.parse(output).kind, 'verified');
  await writeFile(join(cwd, 'fake-bin/gh'), '#!/bin/sh\nexit 1\n');
  assert.throws(() =>
    execFileSync(
      join(cwd, '.githooks/pre-push'),
      ['origin', 'https://github.com/glyad/github-workspace-manager.git'],
      { cwd, env, input, stdio: 'pipe' },
    ),
  );
});
test('installed pre-push rejects foreign actual destinations and any unrelated effective push URL', async (t) => {
  const { cwd, git } = await repo(t);
  const { mkdir, copyFile, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const dir of ['tools/governance', 'governance', '.githooks', 'fake-bin'])
    await mkdir(join(cwd, dir), { recursive: true });
  for (const file of ['local-guard', 'parent-sync', 'checks', 'contracts'])
    await copyFile(
      new URL(`../../tools/governance/${file}.mjs`, import.meta.url),
      join(cwd, `tools/governance/${file}.mjs`),
    );
  await copyFile(
    new URL('../../.githooks/pre-push', import.meta.url),
    join(cwd, '.githooks/pre-push'),
  );
  await chmod(join(cwd, '.githooks/pre-push'), 0o755);
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(cwd, 'governance/repository.json'),
    JSON.stringify({
      host: 'github.com',
      fullName: 'glyad/github-workspace-manager',
      owner: 'glyad',
    }),
  );
  await writeFile(
    join(cwd, 'governance/checks.json'),
    JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }),
  );
  await writeFile(
    join(cwd, 'fake-bin/gh'),
    `#!/bin/sh\ncase "$*" in *pulls*) echo '[]';; *) echo '{"full_name":"glyad/github-workspace-manager","node_id":"R_1"}';; esac\n`,
  );
  await chmod(join(cwd, 'fake-bin/gh'), 0o755);
  git('checkout', '-qb', 'feature/a');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'hook fixture');
  const approved = 'https://github.com/glyad/github-workspace-manager.git',
    foreign = 'https://github.com/unrelated/repo.git';
  git('remote', 'add', 'origin', approved);
  const head = git('rev-parse', 'HEAD'),
    input = `refs/heads/feature/a ${head} refs/heads/feature/a ${head}\n`,
    env = {
      ...process.env,
      PATH: `${join(cwd, 'fake-bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
    };
  const invoke = (destination) =>
    execFileSync(join(cwd, '.githooks/pre-push'), ['origin', destination], {
      cwd,
      env,
      input,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.equal(JSON.parse(invoke(approved)).kind, 'verified');
  assert.throws(() => invoke(foreign));
  git('config', '--add', 'remote.origin.pushurl', approved);
  git('config', '--add', 'remote.origin.pushurl', foreign);
  assert.throws(() => invoke(approved));
  assert.throws(() => invoke(foreign));
});
test('synchronization SHA pin narrows push admission without admitting raw-SHA source refs', async () => {
  const context = {
    branch: 'feature/a',
    parent: 'develop',
    phase: 'ordinary',
    prId: 'PR_1',
    expectedPush: { ref: 'refs/heads/feature/a', sha: base },
  };
  const git = { resolve: async () => sha, isAncestor: async () => true },
    p = remote({ draft: true });
  assert.equal(
    (
      await guardPush(
        git,
        p,
        context,
        `refs/heads/feature/a ${sha} refs/heads/feature/a ${sha}`,
        async () => ({ kind: 'verified' }),
      )
    ).kind,
    'blocked',
  );
  context.expectedPush.sha = sha;
  assert.equal(
    (
      await guardPush(git, p, context, `${sha} ${sha} refs/heads/feature/a ${sha}`, async () => ({
        kind: 'verified',
      }))
    ).kind,
    'blocked',
  );
});
test('snapshot check commands cannot inherit synchronization producer identity', async (t) => {
  const { cwd } = await repo(t),
    oldRef = process.env.GOVERNANCE_EXPECTED_PUSH_REF,
    oldSha = process.env.GOVERNANCE_EXPECTED_PUSH_SHA;
  process.env.GOVERNANCE_EXPECTED_PUSH_REF = 'refs/heads/feature/source';
  process.env.GOVERNANCE_EXPECTED_PUSH_SHA = sha;
  try {
    assert.equal(
      (
        await runChecks(
          [
            [
              process.execPath,
              '-e',
              'if(process.env.GOVERNANCE_EXPECTED_PUSH_REF||process.env.GOVERNANCE_EXPECTED_PUSH_SHA)process.exit(1)',
            ],
          ],
          cwd,
        )
      ).kind,
      'verified',
    );
  } finally {
    if (oldRef === undefined) delete process.env.GOVERNANCE_EXPECTED_PUSH_REF;
    else process.env.GOVERNANCE_EXPECTED_PUSH_REF = oldRef;
    if (oldSha === undefined) delete process.env.GOVERNANCE_EXPECTED_PUSH_SHA;
    else process.env.GOVERNANCE_EXPECTED_PUSH_SHA = oldSha;
  }
});
