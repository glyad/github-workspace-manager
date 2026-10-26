import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  synchronizeParent,
  createGitPort,
  createWorkBranch,
} from '../../tools/governance/parent-sync.mjs';
const sha = 'a'.repeat(40),
  base = 'b'.repeat(40);
const checkpoints = [
  'identify-parent',
  'new-work',
  'before-change',
  'resume',
  'parallel',
  'interface-change',
  'final-validation',
  'review-fix',
  'pre-integration',
  'downstream-merge',
  'preserve-work',
  'literal-merge',
  'push-sync',
  'invalidate-evidence',
  'hotfix-shipping',
  'normal-release',
];
function fixture(reason = 'resume') {
  const events = [];
  let head = sha;
  const git = {
    observe: async () => ({ branch: 'feature/a', head, parent: 'develop', dirty: false }),
    fetchParent: async () => {
      events.push('fetch');
      return base;
    },
    isAncestor: async () => false,
    merge: async () => {
      events.push('merge');
      return true;
    },
    checks: async () => {
      events.push('checks');
      return { kind: 'verified' };
    },
    commit: async () => {
      events.push('commit');
      head = 'c'.repeat(40);
      return true;
    },
    push: async () => {
      events.push('push');
      return true;
    },
    parentHead: async () => base,
  };
  const port = {
    expected: {
      repositoryId: 'R',
      repository: 'glyad/github-workspace-manager',
      branch: 'feature/a',
      parent: 'develop',
      headSha: sha,
    },
    observePR: async () => ({
      kind: 'verified',
      value: {
        id: 'PR',
        number: 1,
        repositoryId: 'R',
        repository: 'glyad/github-workspace-manager',
        headRepositoryId: 'R',
        headBranch: 'feature/a',
        baseBranch: 'develop',
        headSha: head,
        baseSha: base,
        state: 'OPEN',
        draft: true,
      },
    }),
  };
  return {
    git,
    port,
    events,
    context: {
      branch: 'feature/a',
      parent: 'develop',
      prId: 'PR',
      phase: 'ordinary',
      checkpointReason: reason,
    },
  };
}
for (const checkpoint of checkpoints)
  test(`checkpoint ${checkpoint} cannot admit an unsafe parent or phase`, async () => {
    const f = fixture(checkpoint);
    f.context.parent = 'feature/sibling';
    assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
    assert.deepEqual(f.events, []);
  });
test('verified Draft precedes literal parent merge, checks, signed commit and immediate push', async () => {
  const f = fixture();
  const r = await synchronizeParent(f.git, f.port, f.context);
  assert.equal(r.kind, 'verified');
  assert.deepEqual(f.events, ['fetch', 'merge', 'checks', 'commit', 'push']);
  assert.equal(r.value.parentSha, base);
  assert.equal(r.value.reviewInvalidated, true);
  assert.equal(r.value.ready, false);
});
test('dirty work is preserved without starting a merge', async () => {
  const f = fixture();
  f.git.observe = async () => ({ branch: 'feature/a', head: sha, parent: 'develop', dirty: true });
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, []);
});
test('already-ancestor records evidence without fabricated commit or push', async () => {
  const f = fixture();
  f.git.isAncestor = async () => true;
  const r = await synchronizeParent(f.git, f.port, f.context);
  assert.equal(r.kind, 'verified');
  assert.equal(r.value.alreadyAncestor, true);
  assert.deepEqual(f.events, ['fetch']);
});
for (const [name, method, result] of [
  ['conflict', 'merge', false],
  ['failed local checks', 'checks', { kind: 'blocked' }],
  ['failed signature/commit', 'commit', false],
  ['failed push', 'push', false],
])
  test(`${name} blocks readiness and dependent integration`, async () => {
    const f = fixture();
    f.git[method] = async () => result;
    assert.notEqual((await synchronizeParent(f.git, f.port, f.context)).kind, 'verified');
  });
test('ready verification failure blocks edits and merge', async () => {
  const f = fixture();
  f.port.observePR = async () => ({ kind: 'uncertain' });
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, []);
});
test('hotfix shipping never merges develop and requires released-tag provenance', async () => {
  const f = fixture();
  f.context.phase = 'hotfix-shipping';
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, []);
});
test('parent advancement after validation blocks committing stale candidate', async () => {
  const f = fixture();
  f.git.parentHead = async () => sha;
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, ['fetch', 'merge', 'checks']);
});
async function repositories(t) {
  const root = await mkdtemp(join(tmpdir(), 'task5-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'),
    cwd = join(root, 'work');
  const run = (dir, ...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  execFileSync('git', ['init', '--bare', '-q', origin]);
  execFileSync('git', ['clone', '-q', origin, cwd]);
  run(cwd, 'config', 'user.name', 'Fixture');
  run(cwd, 'config', 'user.email', 'fixture@example.test');
  run(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'root'), 'root');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'root');
  run(cwd, 'branch', '-M', 'develop');
  run(cwd, 'push', '-q', 'origin', 'develop');
  return { cwd, run };
}
test('real Git port merges fetched parent with two parents and preserves dirty files', async (t) => {
  const { cwd, run } = await repositories(t);
  run(cwd, 'checkout', '-qb', 'feature/a');
  await writeFile(join(cwd, 'feature'), 'feature');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feature');
  run(cwd, 'checkout', 'develop');
  await writeFile(join(cwd, 'parent'), 'parent');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'parent');
  run(cwd, 'push', '-q', 'origin', 'develop');
  run(cwd, 'checkout', 'feature/a');
  const git = createGitPort(cwd);
  const parent = await git.fetchParent('develop');
  assert.equal(await git.merge(parent), true);
  assert.equal(run(cwd, 'rev-parse', 'MERGE_HEAD'), parent);
  assert.equal(await readFile(join(cwd, 'feature'), 'utf8'), 'feature');
  assert.equal(await readFile(join(cwd, 'parent'), 'utf8'), 'parent');
});
test('new branch starts at fetched parent and records exact commit', async (t) => {
  const { cwd, run } = await repositories(t);
  const r = await createWorkBranch(createGitPort(cwd), {
    branch: 'feature/new',
    parent: 'develop',
    phase: 'ordinary',
  });
  assert.equal(r.kind, 'verified');
  assert.equal(run(cwd, 'rev-parse', 'HEAD'), r.value.parentSha);
  assert.equal(run(cwd, 'branch', '--show-current'), 'feature/new');
});
for (const reason of [
  'identify-parent',
  'new-work',
  'before-change',
  'resume',
  'parallel',
  'interface-change',
  'final-validation',
  'review-fix',
  'pre-integration',
  'downstream-merge',
  'preserve-work',
  'literal-merge',
  'push-sync',
  'invalidate-evidence',
])
  test(`${reason} uses the current fetched parent and leaves readiness false`, async () => {
    const f = fixture(reason);
    const r = await synchronizeParent(f.git, f.port, f.context);
    assert.equal(r.kind, 'verified');
    assert.equal(r.value.parentSha, base);
    assert.equal(r.value.ready, false);
  });
test('hotfix integration uses develop only after explicit integration phase', async () => {
  const f = fixture();
  f.context.branch = 'hotfix/0.1.1';
  f.context.phase = 'hotfix-integration';
  f.git.observe = async () => ({
    branch: f.context.branch,
    head: sha,
    parent: 'develop',
    dirty: false,
  });
  f.port.expected.branch = f.context.branch;
  const observe = f.port.observePR;
  f.port.observePR = async () => {
    const r = await observe();
    r.value.headBranch = f.context.branch;
    return r;
  };
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'verified');
});
test('real merge conflict preserves both histories and unrelated files for recovery', async (t) => {
  const { cwd, run } = await repositories(t);
  run(cwd, 'checkout', '-qb', 'feature/a');
  await writeFile(join(cwd, 'root'), 'feature');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feature');
  const head = run(cwd, 'rev-parse', 'HEAD');
  run(cwd, 'checkout', 'develop');
  await writeFile(join(cwd, 'root'), 'parent');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'parent');
  run(cwd, 'push', '-q', 'origin', 'develop');
  run(cwd, 'checkout', 'feature/a');
  await writeFile(join(cwd, 'unrelated'), 'preserve');
  const git = createGitPort(cwd),
    parent = await git.fetchParent('develop');
  assert.equal(await git.merge(parent), false);
  assert.equal(run(cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(run(cwd, 'rev-parse', 'MERGE_HEAD'), parent);
  assert.equal(await readFile(join(cwd, 'unrelated'), 'utf8'), 'preserve');
  assert.match(await readFile(join(cwd, 'root'), 'utf8'), /<<<<<<< HEAD/);
});
test('hotfix branch cannot inherit ordinary phase and merge develop before shipping', async () => {
  const f = fixture();
  f.context.branch = 'hotfix/0.1.1';
  f.git.observe = async () => ({
    branch: f.context.branch,
    head: sha,
    parent: 'develop',
    dirty: false,
  });
  f.port.expected.branch = f.context.branch;
  const observe = f.port.observePR;
  f.port.observePR = async () => {
    const r = await observe();
    r.value.headBranch = f.context.branch;
    return r;
  };
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, []);
});
test('head movement during downstream checks blocks signed commit and push', async () => {
  const f = fixture();
  let observations = 0;
  const observe = f.git.observe;
  f.git.observe = async () => {
    const state = await observe();
    if (++observations > 2) state.head = base;
    return state;
  };
  assert.equal((await synchronizeParent(f.git, f.port, f.context)).kind, 'blocked');
  assert.deepEqual(f.events, ['fetch', 'merge', 'checks']);
});
test('synchronization producer pushes through the installed guard using Git-produced branch records', async (t) => {
  const { cwd, run } = await repositories(t);
  const { mkdir, copyFile, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const origin = join(dirname(cwd), 'origin.git');
  for (const dir of ['tools/governance', 'governance', '.githooks', 'offline-bin'])
    await mkdir(join(cwd, dir), { recursive: true });
  for (const name of ['local-guard', 'parent-sync', 'checks', 'contracts'])
    await copyFile(
      new URL(`../../tools/governance/${name}.mjs`, import.meta.url),
      join(cwd, `tools/governance/${name}.mjs`),
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
      owner: 'glyad',
      fullName: 'glyad/github-workspace-manager',
    }),
  );
  await writeFile(
    join(cwd, 'governance/checks.json'),
    JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }),
  );
  await writeFile(
    join(cwd, 'offline-bin/gh'),
    `#!/bin/sh\ncase "$*" in *pulls*) echo '[]';; *) echo '{"full_name":"glyad/github-workspace-manager","node_id":"R_1"}';; esac\n`,
  );
  await chmod(join(cwd, 'offline-bin/gh'), 0o755);
  // A real Git remote helper supplies local transport while Git sees the exact approved HTTPS destination.
  await writeFile(
    join(cwd, 'offline-bin/git-remote-https'),
    `#!/bin/sh
while IFS= read -r request; do
case "$request" in
capabilities) printf 'connect\\n\\n';;
'connect git-receive-pack') printf '\\n'; exec git receive-pack '${origin}';;
'connect git-upload-pack') printf '\\n'; exec git upload-pack '${origin}';;
*) exit 1;;
esac
done
`,
  );
  await chmod(join(cwd, 'offline-bin/git-remote-https'), 0o755);
  run(cwd, 'checkout', '-qb', 'feature/a');
  run(cwd, 'add', '.');
  run(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feature');
  const head = run(cwd, 'rev-parse', 'HEAD');
  run(cwd, 'config', 'core.hooksPath', '.githooks');
  run(cwd, 'remote', 'set-url', 'origin', 'https://github.com/glyad/github-workspace-manager.git');
  const oldPath = process.env.PATH,
    oldExec = process.env.GIT_EXEC_PATH;
  process.env.PATH = `${join(cwd, 'offline-bin')}:${dirname(process.execPath)}:${oldPath}`;
  process.env.GIT_EXEC_PATH = join(cwd, 'offline-bin');
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldExec === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = oldExec;
  });
  assert.equal(await createGitPort(cwd).push('feature/a', head), true);
  assert.equal(run(origin, 'rev-parse', 'refs/heads/feature/a'), head);
  assert.equal(await createGitPort(cwd).push('feature/a', base), false);
});
