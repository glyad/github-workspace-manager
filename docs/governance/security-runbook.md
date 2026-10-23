# Baseline protection and security runbook

## Table of contents

- [Scope and pending gates](#scope-and-pending-gates)
- [Bounded live adapter](#bounded-live-adapter)
- [Final baseline synchronization](#final-baseline-synchronization)
- [Restoration and closure](#restoration-and-closure)
- [Capability evidence](#capability-evidence)
- [Recovery and enforcement boundary](#recovery-and-enforcement-boundary)
- [Verification](#verification)

- [Dormant review composition amendment](#dormant-review-composition-amendment)

## Scope and pending gates

Task 4 restores the approved baseline for `glyad/github-workspace-manager`.
Preparation and passing fixture tests do not verify any live GitHub setting.
`governance/repository.json` contains desired policy; activation flags remain
blocked/inactive until actual restoration and closure evidence exists.

Main requires signed commits and blocks force pushes/deletion. It has no PR,
second review or linear-history rule. Develop requires signed commits, a PR,
resolved conversations, no force pushes/deletion and zero second-human approvals.
An active develop `update` rule with **no bypass actors** denies integration
while the selected CI and independent reviewer gates are unavailable. No fake
check name or local app review substitutes for those hosted gates. Ordinary
Draft branches can start after verified closure; integration and release remain
blocked. Release and renewal grants stay inactive.

## Bounded live adapter

`createProtectionGitHubPort({repositoryId, actorId})` in
`tools/governance/protections.mjs` uses existing secure `gh` authentication,
argument arrays and JSON stdin. Its production executor never returns stderr.
No secrets, paid calls, credentials, workflows, ref changes or deletion are
created. It provides:

1. `observeControls()`: authenticated account/repository; all repository and
   inherited ruleset summaries/details; effective main/develop rules (all pages, bounded fail-closed at 20 pages); classic
   protections; free security and Actions settings. Incomplete pagination,
   unreadable inherited detail or unknown capability blocks verification.
2. `restoreBaselineControls(observedRevision)`: check current identity and exact
   snapshot digest against persisted setup intent; create/update only the two
   named `governance-baseline-main`/`governance-baseline-develop` rulesets with no
   bypass; enable selected security settings; set Actions read-only defaults,
   no PR approval permission and repository Actions disabled. Selected allowlist
   and SHA pinning remain explicit pending activation gates if unconfigured;
   baseline restoration sends only `{enabled:false}` to repository permissions
   and never writes the selected list or temporarily enables execution.
3. `observeRefs()`: actual main/develop SHAs plus GitHub signature verification
   from the exact commit endpoint.

Never pass a revision derived from an untrusted Issue or mutation response.
Persist an authenticated, sanitized observation and intent first. Existing
classic protections, inherited rules or any existing bypass require explicit
reconciliation; the adapter preserves them and blocks rather than deleting or
loosening unknown policy. The two managed names must be unique. Partial or lost
responses remain uncertain, and final readback, rather than acknowledgement,
determines whether selected controls are established. Managed conditions and
rules are compared by recognized semantics: order and explicit safe defaults
do not cause false failures, while unknown or weakened parameters are rejected.

The adapter uses the documented [repository rules API](https://docs.github.com/en/rest/repos/rules)
and [Actions permissions API](https://docs.github.com/en/rest/actions/permissions).
The desired activation policy starts with an empty selected allowlist because
baseline installs no hosted worker. Actual GitHub readback while Actions are
disabled may omit `allowed_actions` and report SHA pinning false; the combined
disable/selected/pinning PUT returned HTTP 409 in the actual repository. Record
that absent policy as null/unconfigured and pinning as observed, never as pass.
A disabled baseline can close with this explicit pending policy gate after all
other controls and closure are verified. Task 7 must configure and verify the
selected allowlist, required Actions pinned to reviewed immutable commits, and
SHA pinning **before ANY execution enablement**. If the API cannot establish
that policy without enabling first, activation remains blocked pending a safe,
separately reviewed supported path. Never temporarily enable Actions for setup.
No owner wildcard, marketplace-wide approval or mutable tag is selected.
The actual disabled Actions readback is the execution/fork gate, including raw
`run:` jobs and local actions. Workflow count or the external-action allowlist
alone cannot establish that gate.

## Final baseline synchronization

Complete Task 3, Task 4 source review, configured checks and all signed main
setup commits/pushes **before** installing develop update denial. Fetch actual
main and develop, preserve dirty work, and inspect ancestry. Stop on unexpected
divergence. Merge final main literally into develop using the authorized setup
path, signing the resulting merge when needed; do not manufacture a merge if
already current. Run local checks and push the synchronization immediately.
Record actual final main/develop SHAs, verified signatures and equal trees.

Recheck GitHub refs and local `git merge-base --is-ancestor` after the push.
Develop must contain the entire final main baseline, including Tasks 3–4; its
early Task 2 snapshot is insufficient. Any subsequent main setup commit repeats
this synchronization before closure. No product development starts during the
bounded setup session. Once deny-update is active, a further develop change
requires a new explicitly bounded restoration session; never retain a standing
bypass to simplify later setup.

## Restoration and closure

Use a reviewed driver with frozen IDs and final SHAs, never hardcoded earlier
commit identities:

```js
const controls = createProtectionGitHubPort({ repositoryId, actorId });
const before = await controls.observeControls();
// Require verified before; persist its exact revision and bounded intent first.
const restored = await controls.restoreBaselineControls(before.value.revision);
// Require verified readback before continuing.
```

Compose `createBaselineGitHubPort({expected, observeProjectBaseline,
observeClosure})` from `tools/governance/verify-baseline.mjs`. `expected` contains
repository/actor/Project IDs, final main/develop SHAs, setup operation ID and the
actual bound remote closure ledger Issue node ID. Do not invent that Issue.
The Task 3 callback must freshly read back the complete selected Project
baseline, return `Result` with `{id, public:true, verified:true}` and evidence
for the exact actor/Project. The closure callback must read actual local journal
and bound remote ledger evidence, not a public editable Issue body asserting
success. Final verification requires evidence for **both** operation and Issue.

Use `phase:'restoration'` for `verifyBaseline` before closure. It verifies all
safeguards, final signatures/ancestry/tree and local checks but does not admit
ordinary work. Feed that verified result through the trusted Task 1 closure
adapter: its `observeProtections` must report main signatures/force/deletion,
no temporary bypass and the routing boundary only after this full restoration
verification. Persist closure intent/result using Task 1's verified journal
contract, and retain final sanitized closure remotely in the authenticated,
exact bound setup ledger. Do not reopen main merely to log final closure.

Then verify again without a phase override, requiring the closed session and
verified local/remote closure records. The actual composed observer runs
`npm run check:local` in the selected checkout only when HEAD and final
main/develop trees agree and the full index/worktree (including untracked
validation inputs) is clean. It requires clean state and unchanged HEAD/tree
again after validation, verifies local signatures and ancestry, checks GitHub
signatures and rereads refs/settings after validation. A changing ref or setting
invalidates the result. The result explicitly distinguishes baseline closure,
ordinary Draft work and blocked integration/release. A `verified` restoration
result is not a final baseline-completion result.

## Capability evidence

Read back vulnerability alerts, secret scanning, secret push protection and
private vulnerability reporting after enabling supported free settings. Unknown
or denied API state is blocked, not unsupported. Genuine unsupported capability
requires observed evidence and a reason; no paid feature purchase is authorized.
The production adapter fails closed for unknown/unavailable security responses
rather than manufacturing unsupported classification.

Code scanning remains explicitly pending the trusted worker/admission path and
a meaningful real product scan. Default setup's ordinary push-trigger behavior
has not been selected by the approved readiness-only trigger design. Do not
activate it silently or count configuration as a successful scan. Report the
observed configuration/trust blocker and later meaningful-run gate. Dependency
update automation remains deferred. No product runtime is implemented here.

The baseline report has `verified`, `blocked` or `unsupported` component status,
observed repository identity, fresh source evidence, blockers and next gates.
Code-scanning completion and unconfigured Actions allowlist/pinning can remain
explicitly pending in an otherwise verified disabled baseline. The report
separates verified `actions` execution/default permissions from `actionsPolicy`
(`verified` or `pending-activation`) and always denies activation authority. Both
pending gates must appear in the handoff. Required hosted CI/review,
release identity, funding/limits and renewal authority remain later gates.

## Recovery and enforcement boundary

A denied restoration or lost write response never enables unrestricted develop
integration. Read actual remote state first, preserve successful partial effects
and journal unresolved operations. Reconcile duplicate names, inherited policy,
classic protection and bypass grants explicitly. Refresh the snapshot/revision
before a deliberate retry. Never delete created resources as compensation.

GitHub lacks universal transactional compare-and-swap across settings. The
adapter checks account/repository before each write and reobserves after the
batch; a race after the last read remains a fail-closed revalidation boundary.
Operators must serialize the setup session and reread before consequential
operations. Never claim these REST changes form an atomic transaction.

Native main safeguards cannot prove every direct push originated from develop.
The normal-release path remains a future maintainer-authorized adapter checking
exact develop candidate, ancestry, published identity and equal merge tree.
`glyad` alone authorizes it; there is no main PR or additional main review.
Until that adapter's gates pass, release automation is inactive. Administrative
ability to edit rules is not a configured workflow bypass or agent authority.

## Verification

Run `npm run check:local` and
`node --test tests/governance/protections.test.mjs` with pinned Node/npm.
Also format-check the Task 4 sources/config/runbooks explicitly; Task 3 owns the
current package format manifest and must not be edited concurrently.
Fixture tests exercise the real planner/verifier/REST adapter contract without
using production resources. Only actual production readback can close setup.
Deliver repository/Project URLs, actual SHAs/signatures, closure references,
capability report and the pending gates. Do not claim live verification from
this local staging directory.

## Dormant review composition amendment

The [offline review composition](runtime-bridge.md#dormant-review-composition-amendment) preserves the privileged boundary: parent-only opaque guard and fake proxy key, fixed credential-free child, and separate result-only posting fixture. Callback verification uses constructor-captured public key material and the consumed claim's immutable original full execution. A payload cannot supply either. V2 review cannot fall back to a static worker map or start callback. Funding precedes the single PR lock; accounting reconciliation cannot draft a later attempt.

Local process-group and synthetic archive evidence does not establish hostile same-user isolation, GitHub-native provenance or production spending guarantees. Public forks, production backend/issuer/key/funding/limits, hosted source bootstrap, both disabled review jobs, failing activation preflights and integration retain their existing blocks. No security grant or production capability is created by this amendment.
