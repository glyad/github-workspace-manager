# Local Draft and parent synchronization

## Contents

- [Install and checkpoints](#install-and-checkpoints)
- [Local checks and evidence](#local-checks-and-evidence)
- [Recovery and limits](#recovery-and-limits)

## Install and checkpoints

Use the pinned Node/npm runtime and `npm ci`. In each checkout run `npm run governance:install-hooks`. Installation enables Git's worktree config and writes/reads back `core.hooksPath=.githooks` for that checkout. Linked worktrees need their own installation; keep their branches separate. These files do not claim installation on an existing checkout.

Create ordinary work with `npm run governance:new-work -- feature/ISSUE-description`. The command fetches the actual `develop` parent, creates the branch from that fetched commit and returns the starting SHA. It does not create a PR. Existing branches use the actual PR base and the explicit `branch.BRANCH.governance-parent` setting (default `develop`); a mismatch blocks work. The guard verifies the approved origin, repository identity, same-repository PR head and open state through existing `gh` authentication. Read failures stop work.

Before editing, run `npm run governance:pre-edit -- CHECKPOINT`. Checkpoints are `identify-parent`, `new-work`, `before-change`, `resume`, `parallel`, `interface-change`, `final-validation`, `review-fix`, `pre-integration`, `downstream-merge`, `preserve-work`, `literal-merge`, `push-sync`, and `invalidate-evidence`. They share the approved fetch/merge discipline at explicit work boundaries. A Ready or reviewed PR must first become remotely verified Draft, including before parent merges. A branch without a PR still requires verified PR absence, branch/parent checks and configured checks on commit/push. If a PR appears while checking, refresh context and retry.

Ordinary `feature/`, `chore/`, `doc/`, and `fix/` work targets `develop`. `hotfix/` integration requires the explicit `branch.BRANCH.governance-phase=hotfix-integration` setting and the same develop guards. This command does not execute `hotfix-shipping` or `normal-release` transactions. The later release orchestrator owns released-tag provenance, shipping without develop and the authorized direct develop-to-main release exception. That exception remains authorized; it is unsupported by these ordinary-work commands.

## Local checks and evidence

`governance/checks.json` runs the real governance tests, ESLint, Prettier checks and public-file policy checks. No product check is declared before product implementation exists. Every commit attempt and changed downstream merge runs checks, including Draft work. The pre-commit guard exports the actual index to an isolated temporary snapshot; dirty working files are retained. It rechecks the index tree after checks and remote Draft verification. Unmerged entries fail closed. Checks run without Git's hook environment, so test repositories cannot inherit the caller's index. Configured dependencies are shared through the existing ignored `node_modules` directory; no new dependencies are installed by a hook.

Pre-push reads every ref/SHA on stdin. The actual hook destination and every effective origin fetch/push URL must identify the approved repository; an unrelated extra push URL blocks the entire operation before the first push. Each same-name ordinary branch is independently observed, checked against its local SHA and destination old SHA, verified Draft (or verified PR absence), and tested from the exact proposed commit tree. Deletions, renamed refs, tags, unsupported main/develop transactions and non-fast-forward updates are blocked here. The guard has no general skip flag and never runs a nested commit/push, preventing recursive hook invocation.

Synchronization uses literal `git merge --no-ff --no-commit` of the fetched parent SHA. It runs local checks, rechecks the live parent, creates a signed commit with `-S`, verifies its signature and immediately pushes without force, then reads back the remote branch SHA. The producer uses a same-name branch refspec and pins its expected ref/SHA for the installed hook; the hook rejects a changed candidate and still rejects raw-SHA source refspecs. These scoped identity variables are removed from check subprocesses and grant no check bypass. If already an ancestor, it records that fact without manufacturing a merge commit. Returned evidence pins the observed parent and before/after head; it always leaves readiness false and invalidates previous review. Human merge approval and fresh CI/independent review are separate later gates. A parent-only change also invalidates earlier evidence.

## Recovery and limits

Dirty/untracked work blocks synchronization before a merge begins. Preserve it in its existing checkout or use an isolated checkout; the guard never stashes, resets or discards files. Conflicts leave `MERGE_HEAD` and conflict files available. Resolve without discarding unrelated work, obtain any needed product decision, run the configured checks, create a signed merge commit and immediately push while verified Draft. A failed check, signature, push or remote read-back blocks readiness/integration. A failed push can leave a valid local merge commit: retry a normal guarded push, read back its SHA and repeat current-parent validation and exact-candidate review. Do not amend/rebase/force-push the published identity to repair uncertainty.

Hooks and pre-edit commands are local cooperative enforcement. Git clients can omit hooks or use their own Git/config/runtime; editing cannot be intercepted by Git. Run the pre-edit command explicitly, verify hook installation in every checkout and retain the remote readiness safety net before enabling hosted automation. GitHub's Draft mutation has no compare-and-swap: the guard checks immediately before mutation and reads back the complete base/head identity afterward, blocking on drift. A concurrent remote change after the final observation remains possible; remote admission and final integration reconciliation must reject stale evidence. These local commands never mark Ready or authorize integration.
