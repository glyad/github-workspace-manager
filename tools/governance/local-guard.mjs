import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute, checkTree } from './checks.mjs';
import {
  createGitPort,
  validContext,
  synchronizeParent,
  createWorkBranch,
} from './parent-sync.mjs';
import { blocked, verified } from './contracts.mjs';

const oid = /^[a-f0-9]{40,64}$/;
function matches(pr, expected, id) {
  return (
    expected &&
    pr &&
    pr.id === id &&
    pr.state === 'OPEN' &&
    pr.repositoryId === expected.repositoryId &&
    pr.repository === expected.repository &&
    pr.headRepositoryId === expected.repositoryId &&
    pr.headBranch === expected.branch &&
    pr.baseBranch === expected.parent &&
    oid.test(pr.headSha) &&
    oid.test(pr.baseSha) &&
    (!expected.headSha || pr.headSha === expected.headSha)
  );
}
const candidateKey = (p) =>
  JSON.stringify([
    p.id,
    p.repositoryId,
    p.headRepositoryId,
    p.headBranch,
    p.baseBranch,
    p.headSha,
    p.baseSha,
    p.state,
  ]);
export async function ensureDraft(port, prId) {
  try {
    const first = await port.observePR(prId);
    if (first.kind !== 'verified' || !matches(first.value, port.expected, prId))
      return blocked('PR identity/state/candidate could not be verified');
    const candidate = first.value;
    if (!candidate.draft) {
      const changed = await port.setDraft(candidate);
      if (changed.kind !== 'verified') return blocked('Remote Draft transition failed');
    }
    const last = await port.observePR(prId);
    if (
      last.kind !== 'verified' ||
      !matches(last.value, port.expected, prId) ||
      !last.value.draft ||
      candidateKey(last.value) !== candidateKey(candidate)
    )
      return blocked('Draft read-back failed or base/head changed; retry from a fresh observation');
    return verified(last.value, last.evidence ?? []);
  } catch {
    return blocked('Remote Draft observation failed');
  }
}
export async function verifyWorkDraft(port, context) {
  if (context.prId) return ensureDraft(port, context.prId);
  try {
    const absent = await port.observeNoPR();
    return absent.kind === 'verified' && absent.value === true
      ? verified({ noPR: true })
      : blocked('PR absence is not verified; refresh the work context');
  } catch {
    return blocked('PR absence observation unavailable');
  }
}
export async function guardCommit(git, port, context, checks = () => checkTree(git.cwd)) {
  if (!validContext(context)) return blocked('Commit branch/parent/phase is not admitted');
  const before = await git.observe();
  if (before.branch !== context.branch || before.parent !== context.parent)
    return blocked('Commit checkout identity changed');
  {
    const r = await verifyWorkDraft(port, context);
    if (r.kind !== 'verified') return r;
  }
  const checked = await checks();
  if (checked.kind !== 'verified') return checked;
  const after = await git.observe();
  if (before.head !== after.head || before.branch !== after.branch)
    return blocked('Commit candidate changed during checks');
  {
    const r = await verifyWorkDraft(port, context);
    if (r.kind !== 'verified') return r;
  }
  // The final index comparison follows the remote call, closing that local race window.
  if (checked.value?.tree && git.indexTree && (await git.indexTree()) !== checked.value.tree)
    return blocked('Index changed after check evidence');
  return checked;
}
export async function guardPush(
  git,
  port,
  context,
  input,
  checks = ({ sha }) => checkTree(git.cwd, { sha }),
) {
  const lines = input.trim().split('\n').filter(Boolean);
  if (!lines.length) return blocked('No push refs supplied');
  if (context.expectedPush) {
    const [ref, sha] = lines[0].trim().split(/\s+/);
    if (lines.length !== 1 || ref !== context.expectedPush.ref || sha !== context.expectedPush.sha)
      return blocked('Synchronization push differs from its pinned branch/SHA');
  }
  const seen = new Set();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return blocked('Malformed pre-push ref record');
    const [localRef, sha, remoteRef, remoteSha] = fields;
    const branch = remoteRef.startsWith('refs/heads/') ? remoteRef.slice(11) : '';
    if (
      seen.has(remoteRef) ||
      localRef !== remoteRef ||
      !oid.test(sha) ||
      /^0+$/.test(sha) ||
      !oid.test(remoteSha)
    )
      return blocked('Deletion, duplicate, renamed or invalid ref push denied');
    seen.add(remoteRef);
    const selected = port.forBranch ? await port.forBranch(branch) : { port, context };
    if (!selected || selected.kind === 'blocked')
      return blocked('Cannot verify pushed branch identity');
    const target = { ...selected.context, branch };
    if (
      !validContext(target) ||
      selected.context.branch !== branch ||
      (await git.resolve(localRef)) !== sha
    )
      return blocked('Push branch/parent/SHA is not admitted');
    if (!/^0+$/.test(remoteSha) && (!git.isAncestor || !(await git.isAncestor(remoteSha, sha))))
      return blocked('Non-fast-forward push denied');
    if (!target.prId) {
      const r = await verifyWorkDraft(selected.port, target);
      if (r.kind !== 'verified') return r;
    }
    if (target.prId) {
      const r = await ensureDraft(selected.port, target.prId);
      if (r.kind !== 'verified') return r;
      if (r.value.headSha !== remoteSha)
        return blocked('Pushed destination head differs from current PR; retry');
    }
    const r = await checks({ ref: localRef, sha, remoteRef, remoteSha });
    if (r.kind !== 'verified') return r;
    if ((await git.resolve(localRef)) !== sha) return blocked('Push ref changed during checks');
    if (!target.prId) {
      const r = await verifyWorkDraft(selected.port, target);
      if (r.kind !== 'verified') return r;
    }
    if (target.prId) {
      const r = await ensureDraft(selected.port, target.prId);
      if (r.kind !== 'verified' || r.value.headSha !== remoteSha)
        return blocked('Remote Draft/candidate changed after push checks');
    }
  }
  return verified({ refs: lines.length, ready: false });
}
export async function installHooks(cwd) {
  const git = (...args) => execute('git', ['-C', cwd, ...args]);
  if (
    !git('config', '--local', 'extensions.worktreeConfig', 'true').ok ||
    !git('config', '--worktree', 'core.hooksPath', '.githooks').ok ||
    git('config', '--worktree', '--get', 'core.hooksPath').stdout !== '.githooks'
  )
    return blocked('Checkout-scoped hook installation/read-back failed');
  return verified({ hooksPath: '.githooks', scope: 'worktree' });
}

/** Existing gh authentication only. No paid APIs, credentials or Actions are provisioned. */
export async function createLocalPort(cwd, branch, options = {}) {
  const policy = JSON.parse(await readFile(resolve(cwd, 'governance/repository.json'), 'utf8'));
  if (policy.host !== 'github.com' || policy.fullName !== 'glyad/github-workspace-manager')
    throw Error('Repository policy mismatch');
  const git = (...args) => execute('git', ['-C', cwd, ...args]);
  const approvedUrls = [
    `https://github.com/${policy.fullName}.git`,
    `https://github.com/${policy.fullName}`,
    `git@github.com:${policy.fullName}.git`,
  ];
  const fetchUrls = git('remote', 'get-url', '--all', 'origin');
  const pushUrls = git('remote', 'get-url', '--push', '--all', 'origin');
  const urls = (r) => r.stdout.split('\n').filter(Boolean);
  if (
    !fetchUrls.ok ||
    !pushUrls.ok ||
    !urls(fetchUrls).length ||
    !urls(pushUrls).length ||
    [...urls(fetchUrls), ...urls(pushUrls)].some((url) => !approvedUrls.includes(url))
  )
    throw Error('Wrong repository origin destination configuration');
  if (
    'pushDestination' in options &&
    (!approvedUrls.includes(options.pushDestination) ||
      !urls(pushUrls).includes(options.pushDestination))
  )
    throw Error('Actual push destination is not an approved effective origin URL');
  const gh = (endpoint, query) => {
    const r = execute(
      'gh',
      [
        'api',
        '--hostname',
        policy.host,
        ...(query ? ['graphql', '--input', '-'] : ['--method', 'GET', endpoint]),
      ],
      { cwd, ...(query ? { input: JSON.stringify(query) } : {}) },
    );
    if (!r.ok) throw Error('Remote observation failed');
    const value = JSON.parse(r.stdout);
    if (value.errors) throw Error('GraphQL mutation failed');
    return value;
  };
  const repository = gh(`repos/${policy.fullName}`);
  if (repository.full_name !== policy.fullName || !repository.node_id)
    throw Error('Repository identity unavailable');
  const parent = git('config', '--get', `branch.${branch}.governance-parent`).stdout || 'develop';
  const phase = git('config', '--get', `branch.${branch}.governance-phase`).stdout || 'ordinary';
  const prs = gh(
    `repos/${policy.fullName}/pulls?state=open&head=${encodeURIComponent(`${policy.owner}:${branch}`)}&per_page=100`,
  );
  if (!Array.isArray(prs) || prs.length > 1) throw Error('Ambiguous PR identity');
  const initial = prs[0];
  const normalize = (p) => ({
    id: p.node_id,
    number: p.number,
    repositoryId: p.base?.repo?.node_id,
    repository: p.base?.repo?.full_name,
    headRepositoryId: p.head?.repo?.node_id,
    headBranch: p.head?.ref,
    baseBranch: p.base?.ref,
    headSha: p.head?.sha,
    baseSha: p.base?.sha,
    state: p.state?.toUpperCase(),
    draft: p.draft,
  });
  const expected = {
    repositoryId: repository.node_id,
    repository: policy.fullName,
    branch,
    parent,
    ...(initial ? { headSha: initial.head.sha } : {}),
  };
  const port = {
    expected,
    observeNoPR: async () => {
      const current = gh(
        `repos/${policy.fullName}/pulls?state=open&head=${encodeURIComponent(`${policy.owner}:${branch}`)}&per_page=100`,
      );
      return Array.isArray(current) && current.length === 0
        ? verified(true)
        : blocked('An open PR now exists; reload context');
    },
    observePR: async (id) => {
      if (!initial || id !== initial.node_id) return blocked('Unknown PR');
      return verified(normalize(gh(`repos/${policy.fullName}/pulls/${initial.number}`)));
    },
    setDraft: async (candidate) => {
      // Re-read exact candidate immediately before mutation. GitHub has no conditional Draft mutation.
      const current = normalize(gh(`repos/${policy.fullName}/pulls/${initial.number}`));
      if (candidateKey(current) !== candidateKey(candidate))
        return blocked('PR changed before Draft transition');
      const response = gh(null, {
        query:
          'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
        variables: { id: candidate.id },
      });
      return response.data?.convertPullRequestToDraft?.pullRequest?.id === candidate.id &&
        response.data.convertPullRequestToDraft.pullRequest.isDraft
        ? verified(true)
        : blocked('Draft transition unverified');
    },
    forBranch: async (refBranch) => createLocalPort(cwd, refBranch, options),
  };
  return { port, context: { branch, parent, phase, prId: initial?.node_id } };
}
async function main() {
  const cwd = process.cwd(),
    git = createGitPort(cwd),
    [command, argument, destination] = process.argv.slice(2);
  let result;
  if (command === 'install-hooks') result = await installHooks(cwd);
  else {
    const observation = await git.observe();
    const { port, context } = await createLocalPort(
      cwd,
      observation.branch,
      command === 'pre-push' ? { pushDestination: destination } : {},
    );
    if (command === 'pre-commit') result = await guardCommit(git, port, context);
    else if (command === 'pre-push') {
      if (argument !== 'origin') result = blocked('Only verified origin pushes are admitted');
      else {
        const expectedRef = process.env.GOVERNANCE_EXPECTED_PUSH_REF;
        const expectedSha = process.env.GOVERNANCE_EXPECTED_PUSH_SHA;
        if (expectedRef || expectedSha) {
          if (!expectedRef || !oid.test(expectedSha ?? ''))
            throw Error('Incomplete synchronization push identity');
          context.expectedPush = { ref: expectedRef, sha: expectedSha };
        }
        result = await guardPush(
          git,
          port,
          context,
          await (async () => {
            let input = '';
            for await (const chunk of process.stdin) input += chunk;
            return input;
          })(),
        );
      }
    } else if (command === 'pre-edit')
      result = await synchronizeParent(git, port, {
        ...context,
        checkpointReason: argument || 'before-change',
      });
    else if (command === 'new-work')
      result = await createWorkBranch(git, {
        branch: argument,
        parent: 'develop',
        phase: 'ordinary',
      });
    else
      result = blocked(
        'Use install-hooks, new-work BRANCH, pre-edit CHECKPOINT, pre-commit or pre-push',
      );
  }
  console.log(JSON.stringify(result));
  if (result.kind !== 'verified') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'Local governance guard failed; preserve work and resolve the blocked checkpoint',
    );
    process.exitCode = 1;
  });
