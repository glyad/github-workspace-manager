import { execute, checkTree } from './checks.mjs';
import { verifyWorkDraft } from './local-guard.mjs';
import { blocked, verified } from './contracts.mjs';

const checkpoints = new Set([
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
]);
export function validContext(context) {
  return (
    context &&
    /^(feature\/.+|chore\/.+|doc\/.+|fix\/.+|hotfix\/.+)$/.test(context.branch) &&
    !context.branch.includes('..') &&
    context.parent === 'develop' &&
    ((context.phase === 'ordinary' && !context.branch.startsWith('hotfix/')) ||
      (context.phase === 'hotfix-integration' && context.branch.startsWith('hotfix/')))
  );
}
export async function createWorkBranch(git, context) {
  if (!validContext(context))
    return blocked('New work requires an identified develop parent and ordinary/integration phase');
  const before = await git.observe();
  if (before.dirty) return blocked('Preserve dirty work before creating a branch');
  const parentSha = await git.fetchParent(context.parent);
  if (!parentSha || !(await git.createBranch(context.branch, parentSha)))
    return blocked('Fetched-parent branch creation failed');
  const after = await git.observe();
  return after.branch === context.branch && after.head === parentSha
    ? verified({ branch: context.branch, parent: context.parent, parentSha })
    : blocked('New branch read-back differs');
}
export async function synchronizeParent(git, port, context) {
  if (!validContext(context) || !checkpoints.has(context.checkpointReason))
    return blocked(
      'Unsafe parent, phase or unknown checkpoint; release shipping requires its separate provenance transaction',
    );
  const before = await git.observe();
  if (before.branch !== context.branch || before.parent !== context.parent || before.dirty)
    return blocked('Branch/parent mismatch or dirty tree; preserve work in an isolated checkout');
  {
    const draft = await verifyWorkDraft(port, context);
    if (draft.kind !== 'verified') return draft;
  }
  const parentSha = await git.fetchParent(context.parent);
  if (!parentSha) return blocked('Current remote parent fetch failed');
  const current = await git.observe();
  if (current.head !== before.head || current.branch !== before.branch || current.dirty)
    return blocked('Working candidate changed before merge');
  const evidence = {
    branch: context.branch,
    parent: context.parent,
    parentSha,
    beforeHead: before.head,
    checkpointReason: context.checkpointReason,
    reviewInvalidated: true,
    ready: false,
  };
  if (await git.isAncestor(parentSha, before.head))
    return verified({ ...evidence, headSha: before.head, alreadyAncestor: true });
  // Draft is freshly revalidated immediately before the destructive operation.
  {
    const draft = await verifyWorkDraft(port, context);
    if (draft.kind !== 'verified') return draft;
  }
  if (!(await git.merge(parentSha)))
    return {
      kind: 'conflict',
      reason:
        'Merge unresolved; preserve MERGE_HEAD and resolve explicitly, then validate/sign/push',
      evidence: [],
    };
  const checks = await git.checks();
  if (checks.kind !== 'verified') return checks;
  if ((await git.parentHead(context.parent)) !== parentSha)
    return blocked('Parent advanced during validation; reconcile before committing');
  const beforeCommit = await git.observe();
  if (beforeCommit.head !== before.head || beforeCommit.branch !== before.branch)
    return blocked('Working head changed during downstream validation');
  {
    const draft = await verifyWorkDraft(port, context);
    if (draft.kind !== 'verified') return draft;
  }
  if (checks.value?.tree && git.indexTree && (await git.indexTree()) !== checks.value.tree)
    return blocked('Merge index changed after validation');
  if (!(await git.commit(`chore(sync): merge ${context.parent} into ${context.branch}`)))
    return blocked('Signed merge commit failed; leave changes for recovery');
  const merged = await git.observe();
  if (!(await git.push(context.branch, merged.head)))
    return blocked(
      'Synchronization push failed; readiness/integration blocked until verified retry',
    );
  if ((await git.parentHead(context.parent)) !== parentSha)
    return blocked('Parent advanced after push; repeat synchronization and validation');
  return verified({
    ...evidence,
    headSha: merged.head,
    alreadyAncestor: false,
    pushed: true,
    checks: checks.value,
  });
}
export function createGitPort(cwd) {
  const git = (...args) => execute('git', ['-C', cwd, ...args]);
  const value = (...args) => {
    const r = git(...args);
    return r.ok ? r.stdout : '';
  };
  return {
    cwd,
    indexTree: async () => value('write-tree'),
    resolve: async (ref) => value('rev-parse', '--verify', `${ref}^{commit}`),
    observe: async () => ({
      branch: value('branch', '--show-current'),
      head: value('rev-parse', '--verify', 'HEAD'),
      parent:
        value('config', '--get', `branch.${value('branch', '--show-current')}.governance-parent`) ||
        'develop',
      dirty:
        !git('status', '--porcelain=v1', '--untracked-files=all').ok ||
        !!value('status', '--porcelain=v1', '--untracked-files=all'),
    }),
    fetchParent: async (parent) => {
      if (parent !== 'develop') return '';
      const r = git('fetch', '--no-tags', 'origin', `refs/heads/${parent}`);
      return r.ok ? value('rev-parse', '--verify', 'FETCH_HEAD^{commit}') : '';
    },
    parentHead: async (parent) => {
      const r = git('ls-remote', '--exit-code', 'origin', `refs/heads/${parent}`);
      return r.ok ? r.stdout.split(/\s+/)[0] : '';
    },
    isAncestor: async (ancestor, head) => git('merge-base', '--is-ancestor', ancestor, head).ok,
    merge: async (parentSha) =>
      /^[a-f0-9]{40,64}$/.test(parentSha) && git('merge', '--no-ff', '--no-commit', parentSha).ok,
    checks: async () => checkTree(cwd),
    commit: async (message) =>
      git('commit', '-S', '-m', message).ok && git('verify-commit', 'HEAD').ok,
    push: async (branch, sha) =>
      value('rev-parse', '--verify', `refs/heads/${branch}`) === sha &&
      execute('git', ['-C', cwd, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
        env: {
          ...process.env,
          GOVERNANCE_EXPECTED_PUSH_REF: `refs/heads/${branch}`,
          GOVERNANCE_EXPECTED_PUSH_SHA: sha,
        },
      }).ok &&
      value('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`).split(/\s+/)[0] === sha,
    createBranch: async (branch, parentSha) =>
      git('check-ref-format', '--branch', branch).ok &&
      git('switch', '--create', branch, parentSha).ok &&
      git('config', `branch.${branch}.governance-parent`, 'develop').ok,
  };
}
