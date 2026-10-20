import { execFileSync } from 'node:child_process';
import { lstat, readdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { blocked, verified } from './contracts.mjs';
import { validateDesired } from './validate.mjs';

// Never return subprocess stderr: authentication tools may include sensitive material.
function run(binary, args, options = {}) {
  try { return { ok: true, stdout: execFileSync(binary, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000, stdio: ['pipe', 'pipe', 'pipe'], ...options }) }; }
  catch (error) { return { ok: false, stdout: typeof error.stdout === 'string' ? error.stdout : '' }; }
}

export async function inspectDestination(path) {
  let cursor = resolve(path), state = 'absent', safeAncestors = true;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) safeAncestors = false;
      if (cursor === resolve(path)) state = stat.isDirectory() ? ((await readdir(cursor)).length ? 'nonempty' : 'empty') : 'non-directory';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return { path, state, safeAncestors };
}

/** Uses only existing git identity/configured key. Temp commit is never pushed. */
export async function probeExistingSigning({ actor, gh, execute = run }) {
  const config = (key) => { const r = execute('git', ['config', '--get', key]); return r.ok ? r.stdout.trim() : ''; };
  const name = config('user.name'), email = config('user.email'), key = config('user.signingkey');
  const format = config('gpg.format') || 'openpgp';
  if (!name || !email || !key) return { localVerified: false, githubAssociationVerified: false, reason: 'Existing configured signing identity/key unavailable' };
  if (!['ssh', 'openpgp'].includes(format)) return { localVerified: false, githubAssociationVerified: false, reason: 'Unsupported existing signing format' };
  const temp = await mkdtemp(join(tmpdir(), 'governance-signing-'));
  try {
    const git = (...args) => execute('git', ['-C', temp, ...args]);
    if (!git('init', '--quiet').ok) return { localVerified: false, githubAssociationVerified: false };
    for (const [k, v] of [['user.name', name], ['user.email', email], ['user.signingkey', key], ['gpg.format', format]]) {
      if (!git('config', k, v).ok) return { localVerified: false, githubAssociationVerified: false };
    }
    // Global signing programs/allowed-signers remain inherited; no key configuration is changed.
    if (!git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-S', '-m', 'chore(setup): verify existing signing identity').ok || !git('verify-commit', 'HEAD').ok) return { localVerified: false, githubAssociationVerified: false };
    const signed = git('log', '-1', '--format=%GF%n%GK');
    const [fingerprint, keyId] = signed.stdout.trim().split('\n');
    if (!signed.ok || !fingerprint) return { localVerified: false, githubAssociationVerified: false };
    let associated = false;
    if (format === 'openpgp') {
      const response = await gh(`users/${actor.login}/gpg_keys?per_page=100`);
      const match = (k) => typeof k.key_id === 'string' && (fingerprint.toUpperCase().endsWith(k.key_id.toUpperCase()) || keyId?.toUpperCase() === k.key_id.toUpperCase());
      associated = response.kind === 'verified' && Array.isArray(response.value) && response.value.some((k) => match(k) || k.subkeys?.some(match));
    } else {
      const response = await gh(`users/${actor.login}/ssh_signing_keys?per_page=100`);
      // Public material only. Inline SSH keys are supported; never read a private key.
      let publicKey = key.startsWith('key::') ? key.slice(5) : key.startsWith('ssh-') ? key : '';
      if (!publicKey && !key.startsWith('-')) { try { publicKey = await readFile(key.endsWith('.pub') ? key : `${key}.pub`, 'utf8'); } catch { /* missing public companion blocks */ } }
      const normalize = (s) => s.trim().split(/\s+/).slice(0, 2).join(' ');
      associated = !!publicKey && response.kind === 'verified' && Array.isArray(response.value) && response.value.some((k) => typeof k.key === 'string' && normalize(k.key) === normalize(publicKey));
    }
    return { localVerified: true, githubAssociationVerified: associated, fingerprint, format };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function createReadOnlyGitHubPort({ execute = run, signingProbe = probeExistingSigning } = {}) {
  let actorId = 'unresolved';
  const evidence = (resourceId, revision) => [{ source: 'gh-read-only', actorId, resourceId, observedAt: new Date().toISOString(), ...(revision ? { revision } : {}) }];
  async function gh(endpoint, { graphQL, include = false } = {}) {
    const args = ['api', '--hostname', 'github.com'];
    if (include) args.push('--include');
    args.push(graphQL ? 'graphql' : endpoint);
    if (graphQL) args.push('--input', '-');
    else args.push('--method', 'GET');
    const r = execute('gh', args, graphQL ? { input: JSON.stringify({ query: graphQL }) } : {});
    if (!r.ok) return { kind: 'uncertain', reason: 'GitHub observation failed; no mutation attempted', evidence: evidence(endpoint) };
    try { return verified(include ? r.stdout : JSON.parse(r.stdout), evidence(endpoint)); }
    catch { return { kind: 'uncertain', reason: 'Invalid GitHub observation', evidence: evidence(endpoint) }; }
  }
  async function observeRepository(fullName) {
    if (fullName !== 'glyad/github-workspace-manager') return blocked('Wrong repository');
    const r = execute('gh', ['api', '--hostname', 'github.com', '--include', '--method', 'GET', `repos/${fullName}`]);
    const status = /^HTTP\/\S+\s+(\d{3})/m.exec(r.stdout)?.[1];
    if (status === '404') return verified(null, evidence(fullName));
    if (!r.ok || status !== '200') return { kind: 'uncertain', reason: 'Repository existence unresolved', evidence: evidence(fullName) };
    try {
      const raw = JSON.parse(r.stdout.split(/\r?\n\r?\n/).slice(1).join('\n\n'));
      return verified({ id: raw.node_id, fullName: raw.full_name, ownerLogin: raw.owner?.login, visibility: raw.visibility, defaultBranch: raw.default_branch }, evidence(raw.node_id));
    } catch { return { kind: 'uncertain', reason: 'Repository response invalid', evidence: evidence(fullName) }; }
  }
  return {
    observeRepository,
    async observeSetup(desired) {
      const problem = validateDesired(desired); if (problem) return blocked(problem);
      const user = await gh('user'); if (user.kind !== 'verified') return user;
      actorId = user.value.node_id;
      const actor = { login: user.value.login, id: actorId };
      if (actor.login !== desired.owner) return blocked('Wrong authenticated account', user.evidence);
      const protocol = execute('gh', ['config', 'get', 'git_protocol', '--host', 'github.com']);
      const repo = await observeRepository(desired.fullName); if (repo.kind !== 'verified') return repo;
      const auth = await gh('user', { include: true });
      const scopes = auth.kind === 'verified' ? /^x-oauth-scopes:\s*(.*)$/im.exec(auth.value)?.[1]?.split(',').map((s) => s.trim()) ?? [] : [];
      const project = { authorized: false, scopeVerified: scopes.includes('project'), matches: [] };
      if (project.scopeVerified) {
        const projects = await gh('graphql', { graphQL: 'query { viewer { projectsV2(first:100) { nodes { id title public } pageInfo { hasNextPage } } } }' });
        const list = projects.value?.data?.viewer?.projectsV2;
        if (projects.kind === 'verified' && !projects.value.errors && list && !list.pageInfo.hasNextPage) {
          project.authorized = true; project.matches = list.nodes.filter((p) => p.title === desired.projectTitle);
        }
      }
      let rules = { supported: true, revision: 'repository-absent', effective: [] };
      if (repo.value) {
        const result = await gh(`repos/${desired.fullName}/rules/branches/main`);
        if (result.kind !== 'verified' || !Array.isArray(result.value)) rules = { supported: false, revision: '', effective: [] };
        else rules = { supported: true, revision: createHash('sha256').update(JSON.stringify(result.value)).digest('hex'), effective: result.value };
      }
      const signing = await signingProbe({ actor, gh, execute });
      const allEvidence = evidence(repo.value?.id ?? desired.fullName, rules.revision);
      return verified({ host: desired.host, actor, protocol: protocol.ok ? protocol.stdout.trim() : '',
        repository: { exists: !!repo.value, fullName: repo.value?.fullName ?? desired.fullName, id: repo.value?.id ?? null },
        destination: await inspectDestination(desired.destination), signing, project, rules, evidence: allEvidence }, allEvidence);
    },
  };
}
