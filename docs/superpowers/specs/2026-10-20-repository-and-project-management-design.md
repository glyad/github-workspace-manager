# Repository and project management design

Date: 2026-10-20. Authoring and bounded self-review: GPT-6 Astra/High.  
Status: approved by the user on 2026-10-20 with the setup-only main-protection exception and presentation-language amendment recorded below. Release provenance/prerelease handling and staged activation are approved. Implementation plan approval and listed activation gates remain pending; no remote resource or permission is claimed configured.

## Contents

- [Purpose and approval boundary](#purpose-and-approval-boundary)
- [Repository and contributor baseline](#repository-and-contributor-baseline)
- [Project and scope model](#project-and-scope-model)
- [Branch and synchronization rules](#branch-and-synchronization-rules)
- [Local checks and remote review](#local-checks-and-remote-review)
- [Automation architecture](#automation-architecture)
- [Normal releases and develop renewal](#normal-releases-and-develop-renewal)
- [Hotfix releases](#hotfix-releases)
- [Permissions and security](#permissions-and-security)
- [Staged setup and unresolved gates](#staged-setup-and-unresolved-gates)
- [Catalog coverage and implementation choices](#catalog-coverage-and-implementation-choices)
- [Verification and handoff](#verification-and-handoff)

## Purpose and approval boundary

Create the public `glyad/github-workspace-manager` repository and public personal GitHub Project, with explicit, auditable rules suitable for agent-driven development under one human product owner. Make scope, parent synchronization, review and release evidence deterministic without granting agents scope-reduction or merge authority.

This is governance for this repository. It does not add Projects management, release automation or CI generation to the plugin MVP. The approved product specification, architecture and 24-task implementation plan remain approved; the plugin still supports configurable strategies for other repositories. This repository/automation addendum has its own user approval dated 2026-10-20.

The [decision log](2026-10-19-repository-setup-decisions.md) retains chronological evidence. This consolidation resolves superseded entries: Project visibility is public; review follows passing CI; milestone membership, release archive/SBOM/checksums and draft-release preparation are selected. Historical pending entries do not reopen those choices. All 16 comprehensive parent-synchronization rules are approved; the later temporary setup exception below takes precedence only for setup operations. The user approved this written design with the amendments below; technical enforcement details belong in its implementation plan and activation checks.

The user approved the written design with amendments and requested actual setup. Proceed to the addendum implementation plan, its applicable review/approval, and execution using the already selected subagent-driven method. Do not repeat design approval or reopen the product design. Keep explicit credential, spending and permission activation gates separate from the approved design. [Brainstorming stage requirements](/Users/davidkossoglyad/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/skills/brainstorming/SKILL.md).

## Repository and contributor baseline

Selected identity: GitHub.com personal owner `glyad`; public repository `github-workspace-manager`; default `main`; description “Portable AI-assisted GitHub provisioning and configuration management”; local checkout `/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager`. TypeScript and npm workspaces. MIT license, `Copyright (c) 2026 David Kossoglyad`.

Seed the approved editable specification, architecture, plan, model/workflow instructions, ADRs and backlog per the existing repository checkpoint. Preserve sources and approval history; do not copy credentials. README must contain verified installation/use/development commands. Include CONTRIBUTING, CHANGELOG, `.gitignore`, `.gitattributes`, `.editorconfig`, lint/format configuration, runtime/npm declarations and committed npm lockfile. No fabricated runnable commands before implementation exists.

Include CODEOWNERS `* @glyad`, Code of Conduct with the explicitly public enforcement contact `david@logoui.co.il`, SECURITY with private vulnerability reporting, and SUPPORT routing questions/design to Discussions and bugs/work to Issues. No support SLA is selected. Enable Issues and Discussions; disable Wiki, MVP Pages and template status. Dev containers/Codespaces are declined; automatic dependency-update PRs are deferred.

Issue templates: Feature, Bug, Chore, Documentation, Hotfix and Version umbrella. Capture acceptance criteria, dependencies, milestone and linked work as applicable. PR template covers linked Issue, bounded scope, validation, parent synchronization and readiness. Verify native relationships; body text alone does not configure them.

Selected labels: `type:feature`, `type:fix`, `type:chore`, `type:docs`, `type:hotfix`; `area:core`, `area:github`, `area:ui`, `area:security`, `area:release`; `blocked`, `needs-decision`, `good first issue`, `help wanted`. Do not duplicate Status, Priority, Size or version as labels. Colors and descriptions are implementation choices for review in the plan.

User implementation amendment 2026-10-20: use a consistent visual language across repository and Project surfaces, including appropriate label colors and useful icons in Issue/PR presentation. Use native GitHub typography and formatting; GitHub controls its own fonts, so do not promise custom font styling. Text must carry meaning independently of color, with accessible contrast and readable names. Optional decorative icons must not alter stable label names/API identifiers, duplicate status semantics or break Conventional Commit parsing: preserve the type/scope prefix and place any decoration only where compatible. Exact palette and display examples belong in implementation; no unsupported native styling is implied.

## Project and scope model

Selected: public personal Projects v2 integration, one repository milestone per version as authoritative Issue release membership, a develop/version umbrella, native sub-issues/dependencies where supported, and stable Issue identities. Use suitable Markdown checkbox subtasks; do not use retired tasklist blocks. Native Issue types must be capability-checked for this personal account; use the selected type labels rather than assume organization-managed types exist.

Fields: Status; Priority `P0`, `P1`, `P2`, `P3`; Size `XS`, `S`, `M`, `L`, `XL`. Views: Status board; planning table grouped by milestone; upcoming/current and future release views; triage for missing milestone, priority or size. **Approved design:** Project title `GitHub Workspace Manager`; field descriptions and filters are implementation details, with missing values remaining visible rather than silently inferred.

| Selected Status | Meaning and evidence |
| --- | --- |
| Backlog | Tracked, not yet scheduled for active work; precise intake assignment is proposed implementation policy. |
| Planned | Work assigned to a version and accepted into its plan; precise transition checks remain in the implementation plan. |
| In progress | Work is underway, including revisions after returning Draft. |
| In review | Current-candidate CI passed and the PR remains Ready for independent review. |
| Integrated | Required work merged into develop. |
| Released | Work is demonstrably included in a published version. |

Native Issue closure is distinct from board Status and delivery. Work Issues normally close after their required child PRs complete the accepted merge/integration flow. Closed-unmerged children pause affected automatic completion and release readiness for manual chat resolution. Do not silently count, discard, reopen or accept them.

A reliable agent may propose splitting, movement or deferral. Only the human product owner decides full or partial deferral/reduction. Record the decision and affected requirements before moving the milestone. Split parents by reparenting the same child IDs, preserving/verifying PR, dependency, Project and history links. Mixed-version parents must retain explicit current and deferred requirement mappings; parent closure cannot imply deferred work shipped. Already integrated deferred code needs an explicit owner-approved code disposition with review/tests, not a metadata-only move.

Release admission requires every current-version requirement completed with integration/validation evidence or explicitly owner-deferred. **Approved design:** calculate parent progress from its mapped requirements, never only closed-child counts; retain release-inclusion and integration evidence independently so the hotfix order does not erase published status. A hotfix may become Released before Integrated; preserve Released after later integration and record integration separately. Exact storage is an implementation detail, not a new seventh Status.

## Branch and synchronization rules

Selected: semantic `feature/**`, `chore/*`, `doc/*`, `fix/*` work branches target develop only. Only develop merges main. Main's normal release path is a direct merge/push with no main-targeting PR, own Issue or separate main review. It remains subject to `glyad`'s sole merge authority and upstream release evidence. Merge commits only; no squash, rebase or force-push substitution. Conventional Commits for individual commits and merge titles; PR titles supply merge titles where PRs exist. Require signed commits; DCO trailers optional. Disable auto-merge and automatic branch deletion.

Selected parent checkpoints: before resumed/interrupted or continuing parallel work, and again before integration. Fetch the actual current integration base, use literal merges, preserve dirty/unrelated work and use separate worktrees for concurrent workers. Changed base or head invalidates review evidence. Local checks run after downstream merges and every commit attempt. Commit and immediately push validated changes. Parent synchronization does not itself authorize Ready or merge.

**Approved comprehensive synchronization rules (2026-10-20):**

1. Identify and fetch the actual integration parent; normally develop for feature/chore/doc/fix work. Never substitute a sibling branch.
2. Create new ordinary work branches from the fetched current parent and record its commit.
3. Before synchronizing a ready/reviewed PR, change it to Draft and verify remotely; stop dependent operations if verification fails.
4. Fetch and merge the parent before resuming interrupted work or an agent handoff.
5. Fetch and merge before continuing parallel-agent work; use separate branches/worktrees.
6. Synchronize when known parent changes affect interfaces, dependencies, schemas, configuration or implementation assumptions.
7. Synchronize before final local validation/readiness; commit and immediately push validated changes while Draft, then deliberately request readiness, hosted CI and independent review.
8. Before addressing review findings, return to Draft and synchronize the current parent before implementing corrections.
9. Recheck the parent immediately before integration. Advancement invalidates earlier evidence: repeat Draft, parent merge, local checks, commit/push, Ready, CI and independent review; glyad retains merge authority.
10. Run configured local checks after every downstream merge and on every commit attempt, including Draft work. Failures block commit/readiness.
11. Preserve dirty/unrelated work. Resolve conflicts explicitly, validate combined behavior and obtain a human product decision when needed.
12. Use literal merges, never silent rebase/force push. If the parent is already an ancestor, record up-to-date without manufacturing a commit.
13. Commit and immediately push successful synchronization; failed push leaves remote synchronization incomplete and blocks dependent readiness/integration.
14. Changed head/base invalidates candidate checks/review. Stale workflow results must not approve, downgrade or merge a newer candidate.
15. Keep hotfix shipping separate: main-origin plus latest released same-line hotfix tag, no develop merge before publication. After publication synchronize for develop integration while preserving tag/artifacts. Concurrent release/base changes require explicit reconciliation.
16. Preserve the direct develop→main normal-release exception: no main PR or additional review, and no automatic main→develop synchronization invented by these ordinary-work rules.

Apply checkpoints at explicit work boundaries, without continuous polling. Hotfix status exception: publication can make a hotfix Released before its integration into develop; retain both release and integration evidence rather than enforcing a universally linear status sequence.

## Local checks and remote review

Selected local behavior: run tests, lint, formatting and other configured local CI checks on every commit attempt and after every downstream parent merge, including Draft. Failures block completing the affected operation. Exact scripts must match real code; the existing product plan supplies its meaningful task/type/boundary tests. No hooks are claimed installed.

Selected remote behavior: Draft skips hosted CI and independent review. A deliberate `ready_for_review` attempt admits CI. Failure for the verified current attempt returns Draft. Passing CI for the current base/head while still Ready admits a fresh Astra/High independent review. Fixes return Draft before commits/pushes and repeat the readiness cycle. Do not rerun expensive CI/review merely because an already-ready PR head changes.

The local agent/commit/push guards verify Draft before changes. GitHub cannot intercept a local commit: the remote head-push safety net handles unexpected ready-head changes after the event, invalidates old evidence and returns the current attempt Draft. A shared admission gate must prevent expensive CI/review from racing ahead of that handling. Revalidate identity/base/head/readiness/attempt before every consequential transition or accepted result; stale failures cannot draft a later valid attempt. [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

Implementation is Sol/Medium, self-review Sol/High; independent code review and fix rechecks use fresh Astra/High. Main gets no additional review gate. No Copilot. `glyad` alone may approve merges; an automated check is not another person's approval. The selected custom Codex Action uses exact model/effort control; funding, credentials and actual account access are separate activation gates.

**Approved trigger scope:** ready admission, pushed-head safety handling, return-to-Draft/closure invalidation and final base/head reconciliation. No ordinary develop/main push-CI or schedule is added by default. Explicit release validation remains required. Base drift is checked at readiness, review completion and human integration; results are never accepted against a changed base. Cancel superseded expensive work where supported, but correctness relies on stale-result rejection, not cancellation success. Public-fork analysis remains blocked until its trusted execution path is verified; no privileged credential enters untrusted code.

## Automation architecture

**Approved design:** keep five narrow components, outside the portable product runtime:

| Component | Responsibility | Authority boundary |
| --- | --- | --- |
| Local guard/check runner | Draft verification, parent observations, configured checks and push readiness | Developer credentials; no implicit merge or scope decision |
| Trusted event controller | Reconcile PR/Issue/Project state; admit a specific readiness attempt; reject stale events | Minimal metadata/check permissions; no untrusted checkout |
| Isolated CI and reviewer workers | Validate admitted exact commits and produce attributable results | Untrusted code isolated from privileged posting credentials; reviewer API key only within the selected trusted analysis path |
| Project reconciler | Milestone/status/relationship updates from verified evidence and owner decisions | Scoped repository/Project access; no independent scope reduction |
| Release coordinator | Frozen candidate, artifacts, publication and human merge handoff | Release-preparation allowlist; no main bypass or agent merge authority |

The controller records an operation/attempt identity, PR/base/head, observed state, initiating event, decision authority, evidence and intended next state. Serialize operations per PR or release/version; reread GitHub before applying changes. Retries reconcile actual state before repeating mutations. Unknown outcomes remain pending, not success. Data locations, APIs and exact idempotency mechanics belong in the plan; implementation must prove these contracts.

## Normal releases and develop renewal

Selected initial delivery: `v0.1.0`, with release candidates such as `v0.1.0-rc.1` allowed when needed. SemVer, never reuse a published version; consult published tags/releases. Append and commit the version changelog before tagging; derive deterministic change notes from it. Release notes also include installation instructions.

Selected artifacts: installable plugin archive, SBOM file(s) and SHA-256 checksum file covering the archive/SBOM, not itself. Use native GitHub Release assets only; no external artifact store/registry. Prepare a draft release, upload all selected assets, validate the complete set, then publish. MVP installation/deployment is local; no marketplace.

Selected ordering: complete scoped work, full integrated E2E, all applicable validation and exact-commit approval; publish verified tag/artifacts first; then `glyad` approves the direct develop→main merge/push once per normal version cycle. Publication failure leaves main unchanged. Publication success followed by merge failure preserves the release, pauses the next cycle and requires chat recovery. No claim of an atomic cross-operation transaction.

**Approved provenance resolution:** freeze the approved develop commit `C`; tag and build from exactly `C`; bind artifact hashes and validation evidence to it. Before publication require current main to be an ancestor of `C`, and require develop still at `C`. After publication, create the signed merge commit `M` from that unchanged main with `C` as the other parent. Verify `M` has the same Git tree as `C`; the tag stays at `C`, not `M`. Recheck refs before pushing. Drift, divergent history, mismatch or uncertain outcome pauses for chat; do not retag/rebuild the published identity or silently merge newer develop. This avoids automatically merging main into the already-reviewed candidate. Archive format, SBOM tooling and whether to enable GitHub immutable-release enforcement remain implementation/activation choices; preservation of published identity is already required.

**Approved prerelease resolution:** candidates may publish as prereleases without advancing main or renewing develop. A final version uses a fresh verified candidate and distinct version tag; no retagging an RC as final. This interpretation is approved; publication still requires the selected validation and activation gates.

After successful normal publication and main merge, close the completed umbrella preserving tag/history, resolve old-cycle PRs, delete/recreate develop from delivered main, verify protections and open the next-version umbrella. Preserve hotfix ancestry and all published identities. Actual branch renewal needs the separately designed protected-deletion mechanism; no broad deletion bypass is implied.

## Hotfix releases

Create each hotfix branch from main only, then incorporate the latest released hotfix tag in the same version line before new fixes. Keep develop out before publication. Test/review and publish the hotfix tag/assets without advancing main. Immediately afterward synchronize/integrate into current develop with checks, fresh review and `glyad` approval. Preserve the published identity throughout; release-preparation bypass does not authorize hotfix code integration.

Block the next normal release until it includes released fixes. Pause an underway normal publication until hotfix integration and version/candidate revalidation. Concurrent main advancement or conflicting release work requires reconciliation, not silent retargeting. **Approved design:** the release coordinator serializes publication per version line and records a pending hotfix integration obligation, cleared only by verified develop inclusion. No automated main merge authority follows.

## Permissions and security

Selected develop policy: PRs, passing checks, fresh independent agent review, resolved conversations and blocked force pushes, with only scoped release preparation and controlled renewal exceptions. Main blocks force pushes/deletion while allowing authorized direct develop release merges. No impossible second-human approval requirement; CODEOWNERS documents ownership without creating one.

Release-agent bypass is limited to develop release preparation, such as version/changelog changes and related flow operations. Identity/model, credentials and protected-tag permission remain unassigned. Native actor bypass is not an intent allowlist: the trusted workflow must constrain files/operations independently. Do not enable an unrestricted actor and call it scoped. No main bypass, arbitrary code/security change or blanket administration is authorized. [GitHub bypass configuration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

Selected security: vulnerability alerts, secret scanning/push protection and code scanning where available; private vulnerability reporting. Verify capability and effective settings. Dependency-update automation remains deferred. No paid feature purchases are implied.

**Approved controls:** repository rulesets where supported; read-only workflow token default; elevate only trusted mutation jobs; pin trusted Actions to verified immutable commits; restrict execution to the required action set; require explicit trusted admission for fork work; no credentials in artifacts/logs. Detailed fork policy and allowed-action list require review before activation. Signing identity/key capability must be verified before the first required signed commit; never manufacture a key or weaken the selected requirement.

Included Codex usage/resets apply to local app work, subject to authoritative limits and per-use reset confirmation. The custom Action uses separately billed API usage. Its API funding question remains deferred until activation; no paid calls/secrets now. Enforced call/run limits must be designed; budget alerts are not hard caps. Existing local agent reviews are not configured GitHub automation.

## Staged setup and unresolved gates

**Approved staged delivery:** this design is approved; write/review its implementation plan, then execute in the existing subagent-driven mode. Separate verified baseline setup from later automation activation; report pending features honestly.

| Stage | Scope | Gate |
| --- | --- | --- |
| Initial baseline | Repository/checkout, selected seed/files/settings, signed history | Written implementation-plan approval; verify signing and setup controls below |
| Project baseline | Public Project, approved fields/views/milestones/labels/templates and initial Issue hierarchy | Projects authorization; initial Issue mapping reviewed against approved scope |
| Local/remote review automation | Guards, actual checks, controller, Project reconciliation, custom reviewer | Real successful checks, reviewed trust design, required credentials and reviewer funding/limits |
| Release automation | Candidate/artifact pipeline, scoped release identity and controlled renewal | Approved provenance; identity/permissions/tag/deletion mechanics verified; tested recovery |

**Approved setup-only main-protection exception (2026-10-20):** the user replaces the documentation-only bootstrap proposal with permission to bypass main branch protection throughout repository and Project setup, including setup commits/pushes in the repository root and `.github`. This permits the initial baseline and subsequent setup changes on main; it is not limited to a single seed commit. Keep the exception tied to identifiable repository/Project setup operations and evidence. It does not authorize indefinite product development on main, an ongoing release-agent main bypass, new secret/actor grants, or unrelated changes.

The implementation plan must specify the temporary controls, eligible existing execution identity, setup-change boundaries and restoration checks. Before normal SDLC begins, finish or explicitly report pending setup work, remove the temporary bypass, restore and read back the selected main safeguards (including blocked force pushes/deletion), and verify ordinary develop-only normal-release routing. If restoration cannot be verified, do not begin normal SDLC or claim setup complete; report the blocker. Later deferred automation setup may use this exception only for its bounded setup operations with the same restoration discipline, not as a standing grant. Signed-commit and local-validation requirements remain selected; no actual bypass has been configured by this document.

Access/activation gates are not reasons to reopen settled product policy:

- Parent preflight reported working `gh` HTTPS auth with repository/workflow scopes, but missing `project` scope. Recheck current access before setup; obtain the needed Projects authorization securely. The normal workflow repository token cannot access user Projects. [Projects authentication](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions).
- Verify signing capability before bootstrap. Do not leave unsigned seed commits under a claimed signed-commit policy.
- API reviewer spending/key/call ceilings remain deferred until enablement. Until resolved, no automated reviewer is active; keep affected Ready/merge gates blocked rather than claim completion or substitute a different mechanism.
- Release actor/model, its constrained bypass and protected-tag/deletion paths remain disabled until explicitly resolved. They do not block creating a baseline repository/Project after prerequisite approvals.
- Initial required checks can be enforced only after real runs exist. Do not weaken required policy to pretend an empty repository has passed; keep integration blocked while its checks/automation are incomplete.

## Catalog coverage and implementation choices

All seven setup catalog categories are covered by the recorded decisions and this gap audit; not every optional item has been chosen. This design proposes ending the item-by-item questionnaire and handling routine details in the reviewed plan. No unselected optional feature becomes silently declined or enabled.

| Category | Settled policy | Remaining handling |
| --- | --- | --- |
| Identity/source | Public personal repository, exact path/name/license/seed | Topics/homepage/additional migration unselected; omit from initial phase pending later request |
| Files/environment | Contributor bundle, templates, runtime pin/lockfile/local checks; no devcontainer | Concrete compatible tools/versions, verified scripts, form schemas, safe environment example contents in plan |
| Features/merging | Discussions/Issues/Project, disabled Wiki/Pages/template, merge commits/manual cleanup | Fork settings need trusted execution review; unrelated archive/download settings retain observed defaults |
| Governance | Solo authority, signed commits, branch routing/protection and exceptions | Exact ruleset configuration, signing, temporary setup bypass controls and release bypass identity; no merge queue or extra environments selected |
| Automation | Selected CI/review/Project/release behavior, Linux hosted checks | Approved trigger/admission design implementation, failure tests, caching/retention and actual check names in plan; triage/stale/scheduled automation unselected and outside initial phase |
| Security/Actions | Alerts/scanning/private reports; dependency updater deferred | Capability/read-back checks, allowed actions/fork controls, trusted permissions; no paid security purchase or OIDC/environment provision selected |
| Optional integrations | Public Project and custom reviewer; native release assets | Other webhooks/apps/notifications/external trackers, custom properties/autolinks/social preview, registries/custom domains remain unselected outside initial phase; organization-only controls are capability-gated |

Routine exact tool versions, label colors, artifact naming and field descriptions can be resolved using current supported options in the implementation plan; they do not justify another broad requirements questionnaire. Choices changing cost, authority, release semantics or scope remain explicit gates.

## Verification and handoff

Before claiming completion, read back remote identity/visibility/default branch/features, files and commit SHAs, signatures, Project visibility/fields/views/membership, labels/templates, effective rules and successful current-commit checks. Successful mutation responses alone are insufficient. No repository/Project has been verified created by this design pass; preflight absence and access observations must be refreshed.

Meaningful automation acceptance tests must cover Draft commit/push admission, local check failure, unexpected ready-head change, duplicate/out-of-order events, stale base/head/attempt results, CI failure downgrade, no paid review before admitted CI success, owner-only scope reduction, stable child reparenting and mixed-version progress, publication failure, publication-success/main-merge failure, hotfix-before-integration and controlled renewal. Keep untrusted execution isolated from privileged mutation. Use fixtures/disposable resources, not the intended production repository by default.

Bounded Astra/High self-review completed after the user’s 2026-10-20 approval amendments: checked the full setup-only main exception, restoration-before-normal-SDLC gate, approved provenance/prerelease/staged activation, native presentation constraints, billing/identity gates and all 16 synchronization rules. Local ToC anchors and matching output were checked. No implementation, external mutation, secret provisioning or PDF rendering occurred.

The written design is approved. Next: prepare its implementation plan under the existing model/workflow policy and render this approved revision using the assigned Sol/Medium document role with required verification. Preserve prior product approval/PDF history. Do not ask for this design’s approval again; unresolved API spending, signing-key creation and release-identity grants remain separate activation gates.
