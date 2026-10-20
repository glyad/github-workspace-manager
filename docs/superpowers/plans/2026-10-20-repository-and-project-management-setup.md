# Repository and Project Management Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and verify the approved public repository and Project baseline, then implement and safely activate its local checks, review, planning and release automation in gated stages.

**Architecture:** Repository-owned governance tools are separate from the portable plugin packages. Pure transition functions consume freshly observed GitHub state; trusted adapters serialize mutations, retain attributable evidence and verify results. Initial setup has a bounded main exception; ordinary development and later activation retain the approved authority, review and restoration gates.

**Tech Stack:** Git, GitHub CLI/REST/GraphQL, GitHub Projects v2, GitHub Actions on Linux, Node.js 24 LTS, npm workspaces, TypeScript for product packages; dependency-light Node ESM and `node:test` for repository governance. Resolve and pin maintained compatible patch/tool/Action versions during execution; this document does not claim current version verification.

**Spec:** `docs/superpowers/specs/2026-10-20-repository-and-project-management-design.md` (approved 2026-10-20).

**Related approved plan:** `docs/superpowers/plans/2026-10-19-github-workspace-manager.md`; this addendum supplies its repository checkpoint and own-repository governance, without expanding the product MVP.

**Status:** Approved by the user on 2026-10-20; subagent-driven execution started with read-only preflight and local staging. Subagent-driven execution is already selected. Authoring: Astra/Medium; bounded elevated Astra/High review completed 2026-10-20; corrections and verification are recorded below. No setup, remote mutation or paid execution is asserted by this plan.

## Table of contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [Execution stages and file map](#execution-stages-and-file-map)
- [Shared interfaces and persistence](#shared-interfaces-and-persistence)
- [Task 1: Freeze preflight and bounded setup authority](#task-1-freeze-preflight-and-bounded-setup-authority)
- [Task 2: Create the signed repository and contributor baseline](#task-2-create-the-signed-repository-and-contributor-baseline)
- [Task 3: Establish the public Project and initial scope](#task-3-establish-the-public-project-and-initial-scope)
- [Task 4: Restore protections and verify baseline handoff](#task-4-restore-protections-and-verify-baseline-handoff)
- [Task 5: Enforce local Draft and parent synchronization](#task-5-enforce-local-draft-and-parent-synchronization)
- [Task 6: Implement serialized remote readiness admission](#task-6-implement-serialized-remote-readiness-admission)
- [Task 7: Connect isolated CI and gated independent review](#task-7-connect-isolated-ci-and-gated-independent-review)
- [Task 8: Reconcile Project scope and delivery evidence](#task-8-reconcile-project-scope-and-delivery-evidence)
- [Task 9: Prepare reproducible release candidates and assets](#task-9-prepare-reproducible-release-candidates-and-assets)
- [Task 10: Coordinate publication, hotfixes and develop renewal](#task-10-coordinate-publication-hotfixes-and-develop-renewal)
- [Task 11: Prove activation and deliver the operational handoff](#task-11-prove-activation-and-deliver-the-operational-handoff)
- [Acceptance and dependency map](#acceptance-and-dependency-map)
- [Self-review and approval handoff](#self-review-and-approval-handoff)

## Global Constraints

- Public `glyad/github-workspace-manager`; description “Portable AI-assisted GitHub provisioning and configuration management”; default `main`; checkout `/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager`.
- MIT license, `Copyright (c) 2026 David Kossoglyad`; CODEOWNERS `* @glyad`; explicitly public enforcement contact `david@logoui.co.il`.
- “Only develop merges main.” Normal releases use the approved direct merge/push, without a main PR, Issue or additional main review; `glyad` retains sole merge authority.
- “Merge commits only; no squash, rebase or force-push substitution.” Signed commits are required; DCO trailers are optional; no linear-history rule, auto-merge or automatic branch deletion.
- Setup-only main bypass covers identifiable repository/Project setup, including root and `.github` commits/pushes; revoke and verify safeguards before normal SDLC. It never grants release-agent main bypass, secrets or unrelated product development.
- Draft skips hosted CI/review; local configured checks run after every downstream merge and every commit attempt. Only deliberate readiness admits CI; only current passing CI and Ready admit fresh Astra/High independent review.
- Implementer Sol/Medium, implementation self-review Sol/High, fresh independent task/fix/whole-branch code review Astra/High; no Copilot and no unavailable second-human approval requirement.
- “No paid feature purchases are implied.” No paid reviewer calls/secrets/activation before specific funding, credentials and enforceable limits are approved. Included Codex usage/resets do not pay for Action API calls.
- Public Project `GitHub Workspace Manager`; milestone is authoritative version membership. Status: `Backlog`, `Planned`, `In progress`, `In review`, `Integrated`, `Released`; Priority `P0`–`P3`; Size `XS`, `S`, `M`, `L`, `XL`.
- Stable Issue IDs, native sub-issues/dependencies where supported, human-only scope reduction, explicit mixed-version mapping, and independent release/integration evidence are mandatory.
- Initial version `v0.1.0`; RCs such as `v0.1.0-rc.1` do not advance main/renew develop. Archive, SBOM and SHA-256 checksums use native GitHub Release assets; local installation only, no marketplace.
- Read-only `sources/` and synced `AGENTS.md` stay untouched. Execute in the selected checkout; never convert this project mirror into the implementation repository.
- GitHub native fonts/formatting only. Meaning must survive removal of color/icons; stable identifiers and Conventional Commit prefixes must remain intact.

## Review Focus

1. Lost creation responses and partial setup restoration must reconcile the exact resource and leave ordinary work blocked until safeguards are verified (Tasks 1–4).
2. A delayed synchronize/failure event must neither admit paid work nor draft a later intentional readiness attempt (Tasks 6–7).
3. A valid-looking artifact or ledger comment written by an untrusted actor must never become approval or release evidence (Tasks 6–10).
4. Reparenting mixed-version children, including already integrated deferred code, must preserve IDs/history and require owner disposition (Task 8).
5. Publication succeeds while a subsequent ref mutation is uncertain: preserve published identity and recover through observation rather than retagging or retrying blindly (Task 10).

---

## Execution stages and file map

Tasks 1–4 deliver the baseline. Tasks 5–8 deliver workflow automation; Tasks 9–10 deliver release automation; Task 11 verifies whichever stages are actually enabled. Unresolved funding/identity gates may leave later stages blocked while a verified baseline is delivered. Do not leave a setup bypass open while waiting for them. Later bounded setup-only sessions may reuse the approved exception with Task 1/4 controls; ordinary product work always uses normal branches and review.

Before execution, preserve existing/dirty files, obtain required filesystem authorization for the destination, and inspect any repository already present. Never overwrite a different repository or delete a created resource to compensate for later failure. Baseline changes use signed setup commits with local checks and independent review; later code uses isolated branches/worktrees and atomic PRs linked to Issues. A blocked required automated check means no ordinary integration; do not silently substitute app reviews for the selected hosted review mechanism.

| Paths | Responsibility |
| --- | --- |
| `governance/{repository,project,labels,activation}.json` | Nonsecret desired settings, visual language and explicitly inactive/active capability flags |
| `governance/{scope,checks,release-policy}.json` | Approved requirement mapping, real check commands, release metadata allowlist |
| `tools/governance/*.mjs` | Repository-only CLI, adapters and pure transitions; no imports from product runtime |
| `tests/governance/*.test.mjs`, `tests/governance/fixtures/` | Fakes, local Git scenarios and sanitized event fixtures |
| `.github/{ISSUE_TEMPLATE/,workflows/,CODEOWNERS,PULL_REQUEST_TEMPLATE.md}` | Native contributor UI and least-privilege workflows |
| `.githooks/{pre-commit,pre-push}`, `.github/workflows/*.yml` | Explicitly installed local hooks and verified hosted entry points |
| `docs/governance/{setup,workflow,project,release,security}-runbook.md` | Concrete operations, recovery, limitations and native UI steps |
| `.governance-local/` (ignored, mode 0700) | Local setup journal, IDs, snapshots, check evidence; no secrets |
| `docs/adr/README.md`, `BACKLOG.md`, approved `docs/` | Existing approved product decisions and implementation history |

Every new/revised Markdown file gets a linked ToC. Task commits stage only their files and necessary lockfile changes; run meaningful checks first. Command examples below assume the selected checkout and installed/pinned runtime. Each task gets the selected self-review and fresh independent review before acceptance; tests must fail for the intended reason before implementing behavior, not merely because dependencies are missing.

## Shared interfaces and persistence

Use exported JSDoc typedefs in `tools/governance/contracts.mjs`, with runtime validation in `tools/governance/validate.mjs`. Every adapter returns `Result<T> = {kind:'verified',value:T,evidence:Evidence[]} | {kind:'blocked'|'conflict'|'uncertain',reason:string,evidence:Evidence[]}`; no success from mutation acknowledgement alone.

`Evidence = {source:string,actorId:string,observedAt:string,resourceId:string,revision?:string,digest?:string}`. `Candidate = {repositoryId:string,prId:string,baseRef:string,baseSha:string,headSha:string,readyEventId:string,attemptId:string}`. An attempt ID is SHA-256 of canonical candidate identity plus controller version; use native latest readiness event identity, not event arrival order or a timestamp alone.

`Transition = {operationId:string,observedState:string,eventId:string,actorId:string,expectedRevision:string,evidence:Evidence[],nextState:string}`. `Decision = {kind:'apply',transition:Transition} | {kind:'blocked'|'noop',reason:string}`. `OwnerDecision = {actorLogin:'glyad',sourceUrl:string,requirementIds:string[],disposition:string,observedAt:string}` requires trusted user authorization plus a persisted reference; an Issue body claiming authorization is insufficient.

`GitHubPort` exposes `observeRepository(id)`, `observePullRequest(id)`, `observeLatestReadyEvent(id)`, `observeProject(id)`, `readJournal(key)`, `appendJournal(key,record)`, and `apply(operation,preconditions)` returning `Promise<Result<...>>`. Add typed operation variants with each owning task; use `gh api` JSON stdin for REST/GraphQL, never shell interpolation of user text. Tokens remain in the existing secure credential mechanism, never tool output, fixtures or files.

The remaining named records have these minimum fields; owning tasks may add evidence, never weaken required checks:

| Record | Required fields |
| --- | --- |
| `SetupSnapshot` / `SetupSession` | Repository identity/existence, actor, destination, signing/project capability, effective rules / operation ID, snapshot, approved paths/operations, open/closed state |
| `ProtectionEvidence` / `BaselineEvidence` / `ProjectEvidence` | Expected and observed settings/IDs/SHAs, verified booleans, evidence references, unresolved items |
| `BaselineReport` / `ActivationReport` | Component status (`verified`, `blocked`, `unsupported`), observed identity, evidence, blocker, next gate |
| `Operation` / `RulePlan` | Stable operation ID, explicit action enum and resource ID, JSON arguments, observed preconditions / ordered operations and capability blocks |
| `SyncEvidence` / `CheckEvidence` | Parent/head before/after, merge and push outcome, check results / command argv, exit code, checked SHA and digest |
| `Reservation` | Attempt ID, limits, consumed calls, reservation ID and reserved/consumed/uncertain state |
| `ProjectState` / `ScopeChange` / `Admission` | Status plus integration/publication facts / owner decision and old/new requirement/link mapping / admitted requirements and evidence or explicit blocks |
| `ReleaseCandidate` / `AssetManifest` | Kind (`normal`, `rc`, `hotfix`), version, exact shipping C/main SHAs, applicable development or same-line hotfix baseline, changelog digest, kind-specific scope/validation/approval references / candidate identity and filename/hash/size entries |
| `ReleaseRecord` / `HotfixPlan` / `RenewalEvidence` | Candidate, phase, tag/release IDs, asset manifest, main merge SHA, pending obligations / main and latest same-line tag SHAs, branch and phase / old/new develop SHAs, resolved PR IDs and restored protections |

Local setup uses an append-only JSONL journal under `.governance-local/setup/` with operation intents/results and sanitized effective-setting snapshots. Remote controllers use machine-marked comments on a dedicated governance ledger Issue, keyed by repository/PR or release/version, recording candidate and operation IDs. Accept only records attributable to the configured controller identity and verified workflow run; public editable Issue descriptions/comments from other actors are untrusted. Evidence missing, tampered, deleted or contradictory blocks mutation and requires reconciliation. Keep content compact, public-safe and secret-free; retain published release provenance within the selected archive/SBOM and authenticated journal, without adding an unselected standalone release asset.

Serialize trusted mutation jobs with shared Actions concurrency groups per PR and a repository release group (stricter than per-line serialization), `cancel-in-progress: false`. GitHub may replace pending jobs: reconcile current remote state on every run, never depend on delivery of every event. Workers cannot write the journal or grant approval. Read remote state again immediately before mutation and after completion; uncertain outcomes are read/reconciled before retry. Native APIs lack a universal transaction/CAS, so races after the last read remain a documented fail-closed revalidation boundary, never an atomicity claim.

## Task 1: Freeze preflight and bounded setup authority

**Files:** Create `governance/repository.json`, `governance/activation.json`, `tools/governance/{contracts,validate,github,setup}.mjs`, `tests/governance/setup.test.mjs`, `docs/governance/setup-runbook.md`.

**Interfaces:** `preflightSetup(port, desired) -> Promise<Result<SetupSnapshot>>`; `openSetupSession(snapshot, approvedPaths, existingActor) -> Result<SetupSession>`; `closeSetupSession(port, session) -> Promise<Result<ProtectionEvidence>>`. Sessions record exact repo ID, actor, before/desired rules, eligible paths/operations, start/end and outstanding work.

- [ ] Write tests for wrong account/repository, an existing nonempty destination, missing signing/project capability, lost create response, out-of-scope file and restoration failure. Assert no blind create retry, no key provisioning, no ordinary-work admission after failed closure.
- [ ] Run `node --test tests/governance/setup.test.mjs`; confirm assertions fail before implementing adapters/session checks.
- [ ] Implement read-only preflight for `github.com`, `glyad`, HTTPS access, current repo/Project existence, scopes and signing using a disposable local signed commit with the existing configured identity. Verify signature locally and confirm the existing identity has the necessary trusted GitHub signing association before required signed pushes; verify resulting commits remotely. Missing trust/association is a blocker, not permission to create/upload keys. Never print credentials. Missing `project` authorization uses the secure GitHub authorization flow at execution time.
- [ ] Define setup scope as Tasks 2–4 files/settings/Project operations and approved inactive automation seeds, excluding product feature packages. Use only the already authenticated eligible maintainer identity; inspect supported temporary main ruleset control, record exact change, and limit it to the identified setup session. No new bot/secret or blanket all-repository grant; unsupported safe control blocks that mutation.
- [ ] Run focused tests; persist sanitized preflight/session evidence. Commit `chore(setup): define bounded setup and verification controls` once the signed repository exists in Task 2; this dependency permits local preparation before first commit.

## Task 2: Create the signed repository and contributor baseline

**Files:** Create `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.node-version`, `.npmrc`, `package.json`, `package-lock.json`, `eslint.config.mjs`, `.prettierrc.json`, `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/{feature,bug,chore,documentation,hotfix,version}.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `tools/governance/{baseline,check-files}.mjs`, `tests/governance/baseline.test.mjs`; copy approved editable `docs/`, materialize `docs/adr/README.md` and `BACKLOG.md`.

**Interfaces:** `applyBaseline(port, session, fileManifest) -> Promise<Result<BaselineEvidence>>`; manifest maps paths to frozen SHA-256 content digests. Product Task 1 subsequently extends the root npm scripts/workspaces without replacing these governance checks.

- [ ] Add tests asserting exact identity/license/contact, required template fields, no credentials/placeholders masquerading as runnable instructions, and safe resume after remote creation but before initial push. Run `node --test tests/governance/baseline.test.mjs` and observe intended failure.
- [ ] Freeze approved source copies and ADRs 001–017/deferred backlog, preserve approval history, and document addendum precedence over the older bootstrap prohibition. Include owner workflow instructions in the new repository's editable instructions; do not edit this mirror's synced `AGENTS.md`. Public-seed inspection excludes private session data, temporary artifacts and credentials.
- [ ] Create/reconcile the public repository and destination checkout, initialize signed `main`, then create `develop`. Enable Issues/Discussions; disable Wiki/Pages/template, squash/rebase/auto-merge/automatic branch deletion; set merge title to PR title. Read back each supported setting and record unsupported capabilities honestly.
- [ ] Pin verified Node 24 patch and compatible npm release; lock ESLint/Prettier for actual governance files. Define `test:governance`, `lint`, `format:check`, `check:files` and `check:local` (composition of real checks); no fake product tests/build/typecheck. Add each product check when implemented by the existing plan. Avoid an unnecessary `.env.example` until an actual nonsecret setting needs one.
- [ ] Populate templates with acceptance/dependencies/version/linked-work prompts; native milestone/relationship assignment follows Task 3. Run `npm ci` and `npm run check:local`; commit/push signed `chore(setup): establish repository contributor baseline` within the open setup session. Verify remote SHA/signature and exact baseline files.

## Task 3: Establish the public Project and initial scope

**Files:** Create `governance/{project,labels,scope}.json`, `tools/governance/project-baseline.mjs`, `tests/governance/project-baseline.test.mjs`, `docs/governance/project-runbook.md`.

**Interfaces:** `planProjectBaseline(snapshot, config, scope) -> Operation[]`; `applyProjectBaseline(port, operations) -> Promise<Result<ProjectEvidence>>`. Scope entries carry stable requirement ID, approved source section/task, milestone, Issue node ID, parent ID, dependency IDs and acceptance criteria; persist returned IDs, never derive them from titles.

- [ ] Test duplicate display names, unsupported native Issue types, partial Issue creation, absent field values and relationship failure. Assert retry reuses recorded IDs, visibility is verified, and body links do not count as native dependency/sub-issue evidence. Run focused tests and confirm failure.
- [ ] Implement exact fields/statuses and views: Status board; planning table grouped by milestone; Current release (`v0.1.0`); Future releases; Triage showing any missing milestone/Priority/Size. Discover supported API operations; use native UI for view configuration when API support is absent, then read back/visually verify. Do not guess unsupported filter syntax or claim inaccessible views configured.
- [ ] Create milestone `v0.1.0`, one version umbrella, 24 linked work Issues corresponding to the approved product plan, and bounded governance/setup Issues for this addendum. Copy approved acceptance/dependencies, not just task titles; map deferred product backlog separately without silently assigning a version. Review this generated mapping against approved scope before publishing it. Default intake Backlog; approved current-version mapped work Planned; leave unselected Priority/Size empty and visible in Triage.
- [ ] Apply the palette below and concise descriptions; create native sub-issue/dependency links where supported and verify them. Native type capability failure falls back only to selected labels, with limitations recorded. A failed native link remains pending rather than replaced by an unverified claim.

| Stable labels | Color hex | Text/icon presentation |
| --- | --- | --- |
| `type:feature`, `type:fix`, `type:chore`, `type:docs`, `type:hotfix` | `0969DA`, `CF222E`, `57606A`, `8250DF`, `9A6700` respectively | Feature ✨, Fix 🐛, Chore 🔧, Documentation 📚, Hotfix 🚑 in Issue presentation |
| `area:core`, `area:github`, `area:ui`, `area:security`, `area:release` | `DDF4FF`, `EAEFF2`, `FBEFFF`, `FFF1E5`, `DAFBE1` respectively | Explicit area names; no reliance on color |
| `blocked`, `needs-decision`, `good first issue`, `help wanted` | `B62324`, `9A6700`, `7057FF`, `008672` respectively | Concise descriptions of blockage, owner decision, beginner suitability and contribution help |

- [ ] Verify label contrast in native light/dark rendering and adjust shades if needed without changing identifiers. Keep icons optional and sparse: Issue `✨ Feature: configuration preview`; PR `feat(ui): ✨ add configuration preview` preserves the parser prefix. Use native Project field colors only; no status labels/custom fonts. Test Conventional Commit parsing with decorated/plain subjects.
- [ ] Run `node --test tests/governance/project-baseline.test.mjs` and local checks; commit/push `chore(project): establish version scope and planning views`. Verify Project public visibility, repository association, field options, every initial Issue membership/milestone and native links.

## Task 4: Restore protections and verify baseline handoff

**Files:** Create `tools/governance/{protections,verify-baseline}.mjs`, `tests/governance/protections.test.mjs`, `docs/governance/security-runbook.md`; modify `governance/{repository,activation}.json` and setup runbook.

**Interfaces:** `desiredProtections(capabilities, activation) -> RulePlan`; `verifyBaseline(port, expected) -> Promise<Result<BaselineReport>>`. Report each selected capability as verified, blocked or unsupported, with observed evidence and next gate.

- [ ] Test temporary bypass leakage, a missing selected main rule, unverified check name, inherited conflicting rule and restoration denial. Assert normal SDLC stays blocked; no fallback enabling unrestricted integration. Run focused test to fail.
- [ ] After the last setup commit/push and before closing setup, ensure develop contains the entire final main setup baseline, including Tasks 3–4 and later main setup commits, using the authorized setup path and signed literal merges where needed. Fetch both refs, run local checks and verify ancestry; do not begin product work from the early Task 2 develop snapshot. Preserve any preexisting work and stop on unexpected divergence.
- [ ] Configure selected main signed-commit/force-push/deletion safeguards without main PR/linear-history requirements. Configure develop PR/conversation/force-push/signature controls and verified check enforcement as available; zero unavailable second-human approvals. Keep release bypass/renewal authority inactive. Where required checks are not yet real, explicitly block integration with a supported deny-update control or equivalent verified restriction; do not invent passing checks. If unavailable, report enforcement blocked and do not admit integration.
- [ ] Enable free available vulnerability alerts, secret scanning/push protection, private vulnerability reporting and supported code-scanning configuration. Record code-scanning completion pending a meaningful real run. Keep dependency-update automation deferred. Set read-only workflow tokens and an allowlist of verified pinned required Actions; fork execution remains disabled/unadmitted until its trusted path is proven.
- [ ] Close the setup session: remove its temporary bypass, restore/read back effective protections, verify the controlled ordinary develop-only release path and absence of active release main bypass. Native main protections alone do not prove every allowed direct push originates from develop: record the maintainer-authorized release adapter/ancestry checks and this enforcement boundary, without claiming an unavailable native source-branch restriction. Run `npm run check:local` and `node --test tests/governance/protections.test.mjs`; commit/push required setup records, complete the final develop-baseline synchronization above, then close and retain final closure evidence locally/remotely without reopening main just to log it.
- [ ] Deliver verified repo/Project URLs, SHAs and capability report. Declare baseline complete only if its selected checks/restoration pass; distinguish blocked reviewer/release automation. Ordinary development may start on Draft branches after verified restoration, but integration stays blocked until required gates exist.

## Task 5: Enforce local Draft and parent synchronization

**Files:** Create `governance/checks.json`, `.githooks/{pre-commit,pre-push}`, `tools/governance/{local-guard,parent-sync,checks}.mjs`, `tests/governance/{local-guard,parent-sync}.test.mjs`, `docs/governance/workflow-runbook.md`; modify `package.json`.

**Interfaces:** `ensureDraft(port, prId) -> Promise<Result<Candidate>>`; `synchronizeParent(git, port, WorkContext) -> Promise<Result<SyncEvidence>>`; `runChecks(commands, cwd) -> Promise<Result<CheckEvidence>>`. WorkContext includes branch, actual parent, PR ID, phase (`ordinary`, `hotfix-shipping`, `hotfix-integration`) and checkpoint reason.

- [ ] Test all 16 approved checkpoints using table-driven cases plus temporary local repositories: dirty tree, already-ancestor, conflict, failed push, base-only advancement, ready PR and hotfix phase. Assert literal merge, no fabricated merge, Draft verification before edits, every commit/merge local checks, staged-versus-worktree mismatch rejection, multi-ref push validation, and no develop during hotfix shipping. Run `node --test tests/governance/local-guard.test.mjs tests/governance/parent-sync.test.mjs` to fail.
- [ ] Implement pre-edit CLI plus pre-commit/pre-push hooks with explicit `core.hooksPath` installation/read-back per checkout. New work branches use fetched parent and recorded SHA; resumed/parallel/interface-change/final-validation/review-fix/pre-integration checkpoints use the approved flow. No PR yet still requires branch/parent checks; ready PR must become verified Draft before further change.
- [ ] Resolve conflicts without losing unrelated work, validate, sign and immediately push merge changes; a failed push blocks readiness/integration. After conflict-free changed merges use the same discipline. Preserve isolated worktrees and stop for genuine product choices. Human approval is checked separately at integration.
- [ ] Run real configured checks on every commit attempt and downstream merge; bind commit checks to the actual staged tree in an isolated snapshot when the worktree differs, and recheck the index digest before commit. Pre-push validation binds evidence to every ref/SHA being pushed rather than only the checked-out branch. Prevent recursive hook invocation without a general skip flag. Add product checks only when real scripts exist. Demonstrate failed test/lint/format blocks commit and a remote Draft verification failure blocks push.
- [ ] Run focused/local checks, document manual-client limitations and recovery, then commit `feat(governance): enforce draft and parent synchronization` through the currently authorized delivery path.

## Task 6: Implement serialized remote readiness admission

**Files:** Create `tools/governance/{journal,controller,admission}.mjs`, `.github/workflows/governance-controller.yml`, `tests/governance/{controller,journal}.test.mjs`, sanitized fixtures; modify activation/workflow runbooks.

**Interfaces:** `decideReadiness(observed, event, journal) -> Decision`; `reconcileTransition(port, decision) -> Promise<Result<Transition>>`; `admitCandidate(port, event) -> Promise<Result<Candidate>>`. These functions own the shared admission gate for every expensive worker.

- [ ] Add tests for duplicate/reordered ready/synchronize/Draft/close events, rapid Draft→Ready, base-only drift, replaced pending jobs, missing ledger and forged actor/run evidence. Assert no automatic synchronize→CI path, no stale downgrade and no acceptance of another candidate's result. Run focused tests to fail.
- [ ] Implement journal authenticity and bounded parsing, stable operation keys, intent/result read-back, latest native readiness-event verification and current base/head observation. On unexpected Ready head change invalidate evidence and return only the still-matching current attempt to Draft. Changed base invalidates admission/review; no ordinary push/schedule trigger is added.
- [ ] Configure trusted default-branch controller on relevant PR metadata events and verified worker completion, never checkout/run PR code with mutation credentials. Use shared per-PR serialization, minimal metadata/issues/check permissions and read-only defaults. Every worker start and consequential completion rechecks admission; cancellation is efficiency only. Post-mutation reads detect any remaining status race: quarantine the affected attempt and report reconciliation rather than automatically restoring Ready or accepting stale results. Do not claim the API supports atomic readiness comparison when it does not.
- [ ] Create the controller-owned public-safe ledger Issue and verify configured actor/run provenance. Scope any Projects credential separately; no normal workflow token claim for personal Projects. Leave workflow inactive if required identity/permission/trust capability is unresolved.
- [ ] Run `node --test tests/governance/controller.test.mjs tests/governance/journal.test.mjs` and local checks; commit `feat(governance): serialize readiness and reject stale evidence`. Validate using fixtures/disposable resources; do not induce failures in production by default.

## Task 7: Connect isolated CI and gated independent review

**Files:** Create `.github/workflows/{candidate-ci,candidate-review}.yml`, `tools/governance/{worker-results,review-budget}.mjs`, `tests/governance/{workers,review-budget}.test.mjs`; modify activation/security/workflow runbooks.

**Interfaces:** `acceptWorkerResult(candidate, runIdentity, result, observed) -> Decision`; `reserveReviewBudget(attempt, limits, ledger) -> Result<Reservation>`; `ReviewLimits = {callsPerAttempt:number,maxOutputTokens:number,maxInputBytes:number,maxRunSeconds:number,maxConcurrentCalls:number}` with explicit approved positive values before activation.

- [ ] Test Draft/no-admission, CI failure on current versus stale attempt, forged result, oversized diff, duplicate API reservation, exhausted limit and key exposure to untrusted checkout. Assert zero paid calls before current CI success + Ready + activated funding/credentials; stale failure never drafts a later attempt. Run focused tests to fail.
- [ ] CI uses a workflow definition from a trusted pinned/default-branch revision, checks out exact admitted base/head, runs actual local/product checks and code scanning where available in an unprivileged job, and emits candidate-bound results. Shipping hotfix validation uses its pinned shipping head and same-line release baseline; never use a synthetic develop merge ref or merge develop before hotfix publication. Develop-integration validation is a later separate candidate. Pin Actions by verified SHA, disable persisted checkout credentials, use Linux runners, no secret-bearing cache, and modest artifacts (14-day diagnostic retention; durable release evidence separately retained). Do not cache initially.
- [ ] Implement custom Codex Action review with fresh `gpt-6-astra`/High, trusted runner code and PR material treated as data. Keep privileged posting separate. Before activation demonstrate the selected Action's sandbox/credential boundary against malicious PR instructions; public forks remain blocked until this succeeds. No tool-capable untrusted code path gets the API key.
- [ ] At enablement only, obtain explicit API spending/credential/limit decisions through the secure key flow. Enforce reservations, input/output/run ceilings, bounded retries and concurrency; ambiguous billing outcome consumes the reservation until reconciled. Explain that these bound calls/resources, not a guaranteed currency cap; unresolved required hard spending guarantees block activation.
- [ ] With consent and proven trust, run one real admitted candidate, verify checks `governance/ci`, `governance/review`, `governance/admission` from the expected issuer, then enforce them on develop. Fresh review findings return the workflow through Draft and a new readiness attempt. Without gates, retain disabled status and integration block.
- [ ] Run focused/local tests and commit `feat(governance): gate isolated validation and independent review`; record real versus mocked evidence explicitly.

## Task 8: Reconcile Project scope and delivery evidence

**Files:** Create `tools/governance/{project-state,scope-decisions}.mjs`, `tests/governance/project-state.test.mjs`; modify `governance/scope.json`, controller and Project runbook.

**Interfaces:** `deriveProjectState(requirements, integration, publication, candidate) -> ProjectState`; `planScopeChange(scope, ownerDecision, observedLinks) -> Result<ScopeChange>`; `releaseAdmission(scope, evidence) -> Result<Admission>`.

- [ ] Test closed-unmerged PR, mixed-version parent, unchanged child IDs after split, missing owner decision, integrated deferred code without disposition and hotfix Released before integration. Assert no false completion/closure, release remains visible after integration and deferred requirements remain explicit. Run focused tests to fail.
- [ ] Implement Backlog intake; Planned requires owner-accepted version mapping; In progress covers active/Draft revisions; In review requires current passing CI + Ready; Integrated requires all mapped required work integrated; Released requires publication inclusion. Store integration/publication facts independently and derive status with Released preserved. Closure is a separate decision.
- [ ] Reconcile milestone authority and Project fields from verified native evidence. Reparent existing child IDs, then verify PR/dependency/Project/history links. For scope reduction require trusted `glyad` decision and exact affected requirements; integrated deferrals additionally require reviewed/tested code disposition. Never silently reopen, drop or count closed-unmerged work.
- [ ] Require all current-version requirements complete with evidence or owner-deferred before release; aggregate parents from requirement mapping, not counts. Test partially applied Project writes resume without duplicating Issues or hiding missing fields.
- [ ] Run `node --test tests/governance/project-state.test.mjs` and local checks; commit `feat(project): reconcile scope and delivery evidence`. Activate personal Project mutation only with verified least-privilege authorization.

## Task 9: Prepare reproducible release candidates and assets

**Files:** Create `governance/release-policy.json`, `tools/governance/{release-candidate,release-assets}.mjs`, `tests/governance/{release-candidate,release-assets}.test.mjs`, `docs/governance/release-runbook.md`, `.github/workflows/release-candidate.yml`.

**Interfaces:** `freezeCandidate(kind, refs, scopeAdmission, validation, ownerEvidence, version) -> Result<ReleaseCandidate>`; `buildReleaseAssets(candidate, sourceTree) -> Promise<Result<AssetManifest>>`. Candidate records its kind, exact shipping `C`, main ancestor SHA, relevant same-line hotfix baseline or develop snapshot, version, changelog digest and approvals; manifest binds each filename/hash/size to `C`.

- [ ] Test dirty/uncommitted changelog, reused tags, incomplete applicable scope/validation, moved normal/RC develop, nonancestor main, outstanding hotfix inclusion and a valid shipping hotfix whose head intentionally differs from develop. Normal/RC admission uses version-scope/E2E evidence; hotfix admission uses its approved fix scope and shipping-candidate validation, not completion of unreleased develop features. Assert no candidate freeze/build/publication with missing evidence. Run focused tests to fail.
- [ ] Implement signed version/changelog preparation with explicit metadata allowlist (`CHANGELOG.md`, selected package version fields and mechanically corresponding lockfile fields); reject application/security/workflow edits. Release actor/model, signed identity, bypass and protected-tag permission stay disabled until specifically verified/approved. Never translate an actor-wide bypass into a claim of intent restriction.
- [ ] Build from frozen `C` in a clean isolated checkout after the product plan supplies an installable artifact and full E2E. Produce the selected three asset kinds: `github-workspace-manager-v<VERSION>.zip`, `github-workspace-manager-v<VERSION>.sbom.cdx.json`, and `SHA256SUMS`; checksums cover archive/SBOM, not themselves. Embed candidate provenance in archive metadata and/or supported SBOM fields and retain it in the authenticated journal; do not add a separate unselected provenance asset. Verify a maintained pinned CycloneDX generator during execution. Exclude secrets/dev state and test local installation of the exact archive.
- [ ] Extract deterministic notes from the committed version changelog plus verified installation instructions; upload only to a draft native GitHub Release after actual tag permissions are available. Download/recompute hashes and check the complete expected asset set. No marketplace/external registry, no rebuild after publication under the same identity.
- [ ] Run `node --test tests/governance/release-candidate.test.mjs tests/governance/release-assets.test.mjs` and local checks; commit `feat(release): bind candidate and artifacts to approved source`. Record live publication as blocked until remaining activation gates pass.

## Task 10: Coordinate publication, hotfixes and develop renewal

**Files:** Create `tools/governance/{release-controller,hotfix,renew-develop}.mjs`, `tests/governance/{release-controller,hotfix,renew-develop}.test.mjs`, `.github/workflows/release-controller.yml`; modify release runbook and controller journal variants.

**Interfaces:** `advanceRelease(port, releaseRecord, event, ownerDecision) -> Promise<Result<ReleaseRecord>>`; `planHotfix(main, latestPublishedSameLine) -> Result<HotfixPlan>`; `renewDevelop(port, deliveredMain, resolvedOldCycle) -> Promise<Result<RenewalEvidence>>`.

- [ ] Test publish failure, publication-success/main-push failure, ambiguous response after push, divergent refs, stale owner approval, RC publication, successive hotfixes, normal/hotfix race and protected renewal failure. Assert published tags/assets never change, no new cycle starts prematurely and main does not advance for RC/hotfix. Run focused tests to fail.
- [ ] Serialize release mutations; immediately before normal/RC publication verify scope, approvals, asset hashes, `develop === C`, unchanged ancestor main and no outstanding hotfix inclusion. For hotfix publication instead verify the shipping head equals `C`, unchanged main/same-line released baseline, fix-scope approval and shipping validation; do not require develop to equal `C` or merge its unreleased features. Publish then re-read tag/release/assets. Only after publication and `glyad` approval prepare signed two-parent `M` from observed main and `C`, require `tree(M) === tree(C)`, recheck refs and push normally. Read back main and verify exact `M`, its signature, both parents and tree equality before recording delivery or allowing renewal; a write acknowledgement is insufficient. This main-merge step applies only to normal final releases. No force push or additional main review; uncertain drift pauses chat recovery.
- [ ] For RC, stop after verified prerelease without main merge/renewal. For hotfix, branch from main and merge latest same-line published hotfix tag, validate/review/publish with develop excluded; record Released plus pending develop inclusion. Then synchronize to develop, validate/fresh-review and obtain `glyad` integration approval; never rewrite the published hotfix tag. Block normal release until all obligations are verified included.
- [ ] After normal publication/main delivery, resolve old-cycle PRs and complete umbrella, preserve published history, then renew develop only with verified separately authorized protected-deletion mechanism. Snapshot/restore rules and prohibit broad bypass; recreate exactly from delivered main, verify safeguards, then open next-version umbrella. Failure pauses the next cycle and preserves recoverable state.
- [ ] Run focused tests plus local Git graph/tree assertions and local checks; commit `feat(release): reconcile publication and version-cycle recovery`. Live release/renewal stays inactive while actor/tag/deletion gates are unresolved.

## Task 11: Prove activation and deliver the operational handoff

**Files:** Create `tests/governance/acceptance.test.mjs`, `tools/governance/verify-activation.mjs`; modify activation flags and all five runbooks with observed results/limitations.

**Interfaces:** `verifyActivation(port, configuration, evidence) -> Promise<Result<ActivationReport>>`; report contains independent baseline/local/controller/CI/reviewer/Project/release/renewal statuses, evidence URLs and unresolved gates.

- [ ] Write acceptance fixtures spanning setup restoration → Draft edits → parent merge/checks → Ready → CI → review → owner integration → scope admission → publication → main delivery → renewal, including the five Review Focus failures. Assert disabled components cannot be marked complete. Run `node --test tests/governance/acceptance.test.mjs` to fail.
- [ ] Implement final verifier using fresh remote reads, not cached mutation responses. Verify exact settings/files/signatures, Project views/options/Issue membership, effective protections/expected check issuers, zero leftover setup bypass, actual checks and current evidence. Use explicitly opt-in disposable resources for destructive/error injection; no production test cleanup/deletion by default.
- [ ] Run `npm run check:local` plus `node --test tests/governance/*.test.mjs`; perform selected whole-branch independent Astra/High review and recheck fixes. Run only authorized funded live checks; otherwise show the exact blocked activation gate and preserve integration restrictions.
- [ ] Commit `docs(governance): record verified setup and activation evidence` through the authorized path. Deliver URLs, baseline/check status, recovery instructions and pending decisions; do not claim completed automatic review from local agent reviews. Render final approved documentation PDFs with Sol/Medium and required Sol/High/layout verification, preserving earlier approved history.

## Acceptance and dependency map

Tasks 1→2→3→4 form the baseline; missing Project access may allow repository progress but prevents claiming the Project baseline complete. Task 5 follows restored safeguards. Tasks 6→7 require trust/credential/funding gates before activation; Task 8 depends on Tasks 3/6. Tasks 9→10 depend on working product build/E2E from the approved 24-task plan and activated review/scope evidence. Task 11 reports verified stages without masking blocked ones. If review activation blocks ordinary integration of the automation itself, a bounded approved setup session can deliver reviewed governance setup files, then must close/verify protections again; it cannot deliver unrelated product work.

| Approved design coverage | Owning tasks / decisive evidence |
| --- | --- |
| Identity, public seed, contributor files and native presentation | 1–3: remote SHA/signature, content manifest, readable labels/templates and verified views |
| Full setup exception and restoration | 1/4/11: operation scope, effective before/after rules and closed session |
| Six statuses, stable hierarchy and owner scope decisions | 3/8: native ID/link read-back and requirement-based acceptance tests |
| All 16 synchronization rules and local checks | 5: checkpoint matrix, local Git fixtures and failing-hook demonstrations |
| Draft/Ready CI/review lifecycle and trust/cost boundary | 6/7: adversarial event fixtures, authenticated issuer and consent-bound real run |
| Frozen provenance, assets, RCs, hotfixes and renewal | 9/10: artifact hashes, exact Git graph/tree, failure recovery and gate checks |
| Honest staged delivery, permissions and independent review | 4/11: separate verified/blocked/unsupported statuses and review evidence |

## Self-review and approval handoff

The author completed a bounded Astra/Medium inline check. A separate bounded elevated Astra/High self-review completed on 2026-10-20 against the approved design and latest user amendments. Corrected the final setup-baseline synchronization into develop; made native main-routing enforcement limits explicit; strengthened existing signing-identity checks without authorizing keys; bound local validation to staged/pushed content; separated normal/RC versus hotfix release admission and shipping validation; required remote main-merge read-back before renewal; and kept provenance inside the selected asset bundle. Clarified trusted workflow definitions and residual readiness-race reconciliation without asserting atomic API guarantees.

After corrections, checked all 11 tasks, authority/funding/restoration gates, approved candidate C/tree-identical M provenance and exact source/output consistency. No remaining blocking contradiction was found in this bounded planning review. This is review of the plan, not proof of executable implementation or successful live checks. No code, hooks, repository, Project, secret, bypass or paid reviewer has been created; no recursive review escalation was performed.

After review fixes, keep `outputs/github-workspace-manager-repository-and-project-management-setup-plan.md` identical to this source. Ask the user to review and approve this written plan; preserve their selected subagent-driven method. Approval starts the authorized staged execution, not unresolved API spending, signing-key creation or release-identity grants. Do not ask again for approval of the already approved design.
