import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { blocked, verified } from './contracts.mjs';

export function execute(binary, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(binary, args, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4_000_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    };
  } catch {
    return { ok: false, stdout: '' };
  }
}
export async function runChecks(commands, cwd) {
  if (
    !Array.isArray(commands) ||
    !commands.length ||
    commands.some(
      (c) => !Array.isArray(c) || !c.length || c.some((v) => typeof v !== 'string' || !v),
    )
  )
    return blocked('Configured checks must be nonempty argument arrays');
  const completed = [];
  for (const [binary, ...args] of commands) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('GIT_') &&
          !['GOVERNANCE_EXPECTED_PUSH_REF', 'GOVERNANCE_EXPECTED_PUSH_SHA'].includes(key),
      ),
    );
    if (!execute(binary, args, { cwd, env }).ok)
      return blocked(`Local check failed: ${binary} ${args.join(' ')}`);
    completed.push([binary, ...args]);
  }
  return verified({
    commands: completed,
    passed: true,
    commandsDigest: createHash('sha256').update(JSON.stringify(commands)).digest('hex'),
  });
}

/** Export the index or exact commit through a private temporary index. Never stash/reset user work. */
export async function checkTree(cwd, { sha, commands } = {}) {
  const git = (...args) => execute('git', ['-C', cwd, ...args]);
  const tree = git('rev-parse', '--verify', sha ? `${sha}^{tree}` : ':');
  // write-tree also refuses unmerged entries.
  const initial = sha ? tree : git('write-tree');
  if (!initial.ok || !/^[a-f0-9]{40,64}$/.test(initial.stdout))
    return blocked('Cannot identify exact staged/commit tree');
  const temp = await mkdtemp(join(tmpdir(), 'governance-check-'));
  try {
    const snapshot = join(temp, 'snapshot');
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
    if (
      !execute('git', ['-C', cwd, 'read-tree', initial.stdout], { env }).ok ||
      !execute('git', ['-C', cwd, 'checkout-index', '--all', `--prefix=${snapshot}/`], { env }).ok
    )
      return blocked('Cannot materialize isolated check tree');
    try {
      const stat = await lstat(join(snapshot, 'node_modules'));
      if (stat) return blocked('Tracked node_modules is forbidden');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await lstat(join(cwd, 'node_modules'));
      await symlink(resolve(cwd, 'node_modules'), join(snapshot, 'node_modules'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const configured =
      commands ??
      JSON.parse(await readFile(join(snapshot, 'governance/checks.json'), 'utf8')).commands;
    const result = await runChecks(configured, snapshot);
    if (result.kind !== 'verified') return result;
    if (!sha && git('write-tree').stdout !== initial.stdout)
      return blocked('Index changed during checks; retry the commit');
    if (sha && git('rev-parse', '--verify', `${sha}^{tree}`).stdout !== initial.stdout)
      return blocked('Commit tree changed during checks');
    return verified({ ...result.value, tree: initial.stdout, ...(sha ? { sha } : {}) });
  } catch {
    return blocked('Local check configuration or snapshot unavailable');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
