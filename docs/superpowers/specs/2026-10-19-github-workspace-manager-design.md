# GitHub Workspace Manager — Design Specification

Date: 2026-10-19  
Status: Approved by the user on 2026-10-19 after critical design review  
Workflow: Specification and architecture approved; Superpowers implementation planning authorized

**User amendment 2026-10-19:** Added the explicit MVP delivery constraint and own-repository routing clarification below. Original approval history is preserved; the existing PDF represents the prior approved revision and awaits a refreshed approved export.

## Table of contents

- [1. Purpose and decision provenance](#1-purpose-and-decision-provenance)
- [2. MVP scope](#2-mvp-scope)
- [3. Deferred backlog](#3-deferred-backlog)
- [4. Portable hexagonal architecture](#4-portable-hexagonal-architecture)
- [5. GitHub providers and guided fallback](#5-github-providers-and-guided-fallback)
- [6. Declarative configuration and configurable governance](#6-declarative-configuration-and-configurable-governance)
  - [Modular components](#modular-components)
- [7. Mandatory financial preflight](#7-mandatory-financial-preflight)
- [8. Plan, approve, apply, verify](#8-plan-approve-apply-verify)
  - [Approval and execution invariants](#approval-and-execution-invariants)
- [9. Persistence and credential security](#9-persistence-and-credential-security)
- [10. Adaptive UI and harness interaction](#10-adaptive-ui-and-harness-interaction)
- [11. Failure handling and recovery](#11-failure-handling-and-recovery)
  - [Reversibility and pre-change backups](#reversibility-and-pre-change-backups)
  - [Complete operation logging](#complete-operation-logging)
  - [Repository rules for codebase changes](#repository-rules-for-codebase-changes)
- [12. Testing and acceptance criteria](#12-testing-and-acceptance-criteria)
- [13. Tradeoffs and architecture decision records](#13-tradeoffs-and-architecture-decision-records)
- [14. Project repository checkpoint and approval gates](#14-project-repository-checkpoint-and-approval-gates)
- [15. Design self-review](#15-design-self-review)
- [16. Approved workflow and recovery configuration features](#16-approved-workflow-and-recovery-configuration-features)

## 1. Purpose and decision provenance

GitHub Workspace Manager is a portable, AI-assisted GitHub provisioning and configuration manager. It helps users create repositories, configure selected capabilities, clone repositories locally, and maintain their desired configuration safely over time. Repository creation is one operation within a declarative lifecycle, rather than the whole product.

The first distribution is a Codex plugin. Business logic must remain independent of Codex, individual agent harnesses, UI frameworks, GitHub integration transports, and execution platforms. The MVP runs locally; remote execution is a future extension.

This specification consolidates the approved architecture in the conversation **Create GitHub Codex Plugin** (conversation ID `6ace6e7f-1904-83ed-8e28-3ac68da992e3`) and the current continuation request. Sections 2–5 and their approvals were retrieved in full. The reader exposes no older page: Section 1 is represented by the approved recap in Section 2 and the user's explicit provider clarification. No additional earlier decisions are inferred as approved. Details below that express invariants or acceptance conditions operationalize those decisions; they do not authorize implementation or external actions.

The current revision also incorporates the user’s requested reversibility, comprehensive operation logging, pre-change settings backups, and repository-aware codebase commits. The user has selected Conventional Commits as the default commit standard and Git Flow as the default branching strategy, with explicit selection of alternatives a must-have feature.

All five conversational architecture sections and this written specification have been approved. The user approved this written artifact on 2026-10-19 and authorized adding a linked table of contents and rendering a PDF. The architecture was subsequently approved on 2026-10-19, and the user authorized Superpowers implementation planning; implementation itself awaits written-plan approval and execution-method selection. This document contains neither implementation scaffolding nor an implementation plan.

## 2. MVP scope

**User amendment 2026-10-19 — MVP delivery:** Install/deploy the MVP locally and deliver a GitHub release artifact only. Marketplace submission/publication is excluded from the MVP; no marketplace publishing steps or credentials are required. This distribution constraint does not reduce the approved repository-management capabilities.

The MVP covers personal and organization-owned repository lifecycle workflows:

- Inspect account, environment, permissions, capabilities, and current repository state.
- Create a repository with selected owner, name, description, visibility, and configuration profile.
- Initialize Git coherently and clone into a user-selected local directory.
- Generate or update README, license, `.gitignore`, issue templates, and pull request templates.
- Configure branch and repository policies through the rulesets component, subject to provider support, permissions, account entitlements, governance, and cost checks.
- Update individual capabilities of an existing repository, preserve unmanaged settings, and detect drift within managed scope.
- Resolve and validate desired configuration, preview minimal changes, approve, apply, verify, and report results.
- Resume interrupted or partially completed operations without duplicating successful changes.
- Support reversal wherever feasible, disclose irreversible effects before approval, log all operations, and back up settings before mutations.
- Commit post-creation codebase changes through the repository’s configured branching, commit, and review rules.
- Let users select and persist the commit standard and branching strategy for new and existing repositories, defaulting to Conventional Commits and Git Flow where no higher-precedence selection or requirement applies.
- Configure branch names/prefixes, commit types/scopes, merge/review policies, signing/sign-offs, and change-delivery preferences through the workflow settings.
- Configure backup retention/storage limits and browse recovery snapshots and restoration limits before choosing a restore point.
- Provide schema-driven configuration forms, conversational interaction, local browser fallback, and embedded MCP Apps integration when supported.

The MVP execution engine is sequential. Dependency-aware planning leaves room for later concurrency without making concurrent multi-repository execution a release requirement. Read-only inspection needs no mutation approval. Destructive and sensitive operations define approval requirements for any supported operation; this does not make repository deletion or every possible GitHub administration action an MVP deliverable.

Success means the user can establish and maintain a repository with a clear preview, reliable verification, recoverable failures, and no unapproved paid capability or unauthorized mutation.

## 3. Deferred backlog

Preserve these items for a future `BACKLOG.md`; this design-only step records them here without creating additional artifacts:

- Full language/framework/application scaffolding.
- Advanced CI/CD, release automation, and versioning configuration.
- GitHub Projects v2 and associated automation.
- Organization creation through supervised browser workflows.
- Conditional governance and delegated policy management.
- Remote/cloud and distributed execution, sophisticated scheduling, and concurrent multi-repository operations.
- Automatic rollback policies and centralized audit storage.
- Enterprise configuration storage and database-backed persistence implementations.
- Third-party configuration components and an external extension registry.
- Organization-wide compliance dashboards and sophisticated configuration dashboards.
- Advanced cost estimation and spending policies.
- Advanced visual editors, collaborative configuration sessions, and organization-specific UI layouts.

Automated browser interaction is introduced incrementally after guided workflows; the MVP must not depend on comprehensive browser automation. GitHub Apps and OAuth authentication are extension targets beyond initial GitHub CLI credential reuse. Additional source-control platforms are an architectural possibility, not a committed feature.

## 4. Portable hexagonal architecture

Use Ports & Adapters: domain and application services define platform-independent interfaces; external integrations implement them. The core must not import Codex-specific APIs or depend on a particular MCP host, browser, filesystem implementation, credential mechanism, or GitHub SDK.

| Boundary | Responsibility | Dependencies |
|---|---|---|
| Domain/configuration model | Resource identity, desired state, profiles, policies, components, management scope | Platform-independent data and rules |
| Configuration resolver | Deterministic inheritance and explicit choice resolution | Configuration and policy ports |
| Validation service | Schemas, prerequisites, permissions, capabilities, policy, cost classification | Discovery and cost interfaces |
| Planning service | Minimal ordered operations, dependencies, expected outcomes | Resolved configuration and observed state |
| Approval service | Associate user decisions with a specific immutable plan | Host interaction and persistence ports |
| Execution service | Apply approved operations deterministically | Provider, Git, filesystem, and state ports |
| Verification service | Read back state and compare managed postconditions | Read interfaces and desired configuration |
| Audit/recovery services | Log all operations, capture pre-change settings, retain recovery evidence, and plan reversals | Persistence and state-inspection interfaces |
| Presentation/harness adapters | Collect choices, display previews, expose semantic operations | Application services |

The agent interprets natural language, recommends options, and explains results. It proposes configuration; it does not improvise unplanned mutations after approval. Presentation components submit configuration and approval decisions to application services rather than execute GitHub operations directly.

Thin integration surfaces include the Codex plugin, Claude Code skills/commands, generic MCP tools/resources, and a standalone CLI. These share semantic application operations. Commands such as `$github-create-repository` are entry points, not separate implementations. Codex is the first packaging target; portability must be demonstrable without requiring simultaneous feature parity across every host.

## 5. GitHub providers and guided fallback

Prefer the **official GitHub MCP** integration when available and capable. Reuse native harness capabilities where appropriate; use an Octokit adapter for GitHub operations unavailable through preferred integrations. Keep all three behind common platform-independent interfaces. Authentication is a separate concern from provider selection.

Discovery establishes actual tools, permissions, and supported operations rather than assuming that an installed provider supports every feature. Select providers per operation according to capability and context, preserving the preference above. Unsupported capabilities are explicit results, not silent omissions. The execution preview identifies the selected provider and any browser-required steps.

Capability includes the ability to honor approved identity, concurrency, commit/signing rules, backup coverage, and verification—not merely an available write endpoint. Resolve the GitHub host, authenticated principal, owner, and stable resource identity across all selected providers; a browser session or MCP connection using a different account must not silently substitute for the approved actor. If a preferred provider cannot meet these guarantees, select a suitable adapter before approval or report the operation as blocked. Do not weaken requirements to retain provider preference.

Browser interaction is an exceptional, supervised fallback for capabilities unavailable through suitable programmatic interfaces. The MVP supplies guided workflows: explain the required page and action, let the user control sensitive interaction, and verify the outcome where observable. Incremental automation must remain supervised and must not bypass GitHub permissions, approval, authentication, or cost gates. On failure, offer guided manual completion rather than attempting uncontrolled alternatives. A material provider or operation change after approval requires plan revalidation and renewed approval as applicable.

## 6. Declarative configuration and configurable governance

Each resource contains identity (type, owner, name), desired state, selected profile, applicable policies, optional components, execution context, and explicit management scope. Use versioned YAML for desired configuration. This is the plugin's schema, not a native GitHub configuration standard.

Resolve settings in descending precedence:

1. GitHub-enforced restrictions, which cannot be bypassed.
2. Plugin-enforced organization policies, mandatory within plugin workflows.
3. Explicit repository configuration, overriding recommendations.
4. Organization advisory policies, overriding profile defaults.
5. Selected configuration profile, supplying defaults.

Governance is configurable through enforced restrictions and advisory recommendations. Explicit repository choices cannot override an enforced policy. Financial authorization is independent of inheritance: a profile, policy, or override cannot implicitly approve a charge. Explain validation conflicts and require resolution before applying affected changes.

Only explicitly managed settings may be reconciled after approval. Preserve unmanaged values. Report conflicting and unsupported settings distinctly; do not interpret an omitted component as permission to delete existing configuration. Changes to management scope appear in the preview.

Distinguish an omitted/unmanaged field, an explicitly managed value, and an explicit reset/removal request in the schema. Validate document versions and reject unsupported versions or unknown mutation fields rather than silently dropping them. Resolve configuration from recorded source revisions and show per-field provenance. Organization-enforced plugin policy must come from a designated trusted source; repository content cannot promote itself to organization authority or approve its own policy relaxation.

Local filesystem paths and machine-specific preferences belong to execution configuration, separate from shared repository definitions.

### Modular components

| Component | Responsibility | Release boundary |
|---|---|---|
| `repository.basic` | Name, description, visibility | MVP |
| `repository.local` | Local clone and Git initialization | MVP |
| `repository.readme` | README generation/update | MVP |
| `repository.license` | License selection | MVP |
| `repository.gitignore` | Ignore rules | MVP |
| `repository.issue-templates` | Issue templates | MVP |
| `repository.pr-template` | Pull request template | MVP |
| `repository.rulesets` | Branch/repository policies | MVP |
| `repository.workflow` | Commit/branch conventions, workflow details, merge/review and signing/sign-off preferences, and compliant delivery behavior; coordinate remote enforcement with `repository.rulesets` | MVP |
| `repository.ci` | CI/CD workflows | Deferred |
| `repository.releases` | Release/versioning configuration | Deferred |
| `project.scaffolding` | Application/framework scaffolding | Deferred |
| `organization.projects` | GitHub Projects v2 | Deferred |

Each component declares its schema, prerequisites, required permissions, operations, possible financial implications, reversibility classification, backup requirements, and reversal method or limitations. Users can configure a component independently without recreating a repository. Initial modules are trusted and bundled. External configuration must not confer arbitrary code-execution privileges; third-party modules are deferred.

## 7. Mandatory financial preflight

Every mutation plan undergoes cost preflight, including component defaults, organization settings, and fallback workflows. Identify potential additional paid services or entitlements and explain known costs, prerequisites, and uncertainty before execution. No additional paid service may be enabled without explicit informed consent.

Include foreseeable billable effects of approved actions, such as existing automation triggered by a push or merge, rather than considering only newly enabled products. Distinguish no additional charge established, existing entitlement with possible usage charges, additional paid entitlement, and unresolved cost exposure. Record the evidence source and time, billing owner, action, and disclosed cost basis/limits or uncertainty with financial consent. An acknowledgment of unspecified risk alone is not informed authorization; if the exposure cannot be explained sufficiently for a bounded decision, keep that action blocked. This preflight is not a guarantee of a precise future bill or a spending-enforcement service.

Financial authorization is distinct from ordinary plan approval and sensitive-operation confirmation. A general request, accepted profile, or organization recommendation does not provide it. If price or entitlement information is insufficient, do not classify the operation as free by assumption: surface the uncertainty and block the cost-bearing action until the user can give informed authorization. Advanced numerical estimates and spending policies remain deferred; this does not weaken mandatory cost classification and consent.

A material change to cost-bearing actions or their disclosed implications invalidates the relevant prior authorization. Verification and reporting must distinguish a blocked paid step from a successfully applied configuration.

## 8. Plan, approve, apply, verify

The common lifecycle is:

**Inspect → Resolve → Validate → Plan → Preview → Approve → Apply → Verify → Report**

1. Discover environment, account, credentials availability, providers, permissions, and existing state.
2. Resolve inheritance and validate schemas, dependencies, governance, cost implications, and provider capabilities.
3. Generate a deterministic ordered plan with stable operation identities, dependencies, selected providers, expected outcomes, postconditions, reversibility classifications, backup requirements, and repository workflow obligations.
4. Preview the changes, managed scope, risks, costs, conflicts, browser steps, reversal methods, and any irreversible effects. Resolve blocking conflicts before execution.
5. Record approval against the final immutable plan. Material configuration, operation, state, or cost changes require revalidation and revised approval where applicable.
6. Persist the operation-start record and required pre-change settings snapshot before each mutation; block the mutation if either cannot be saved. Execute approved operations sequentially in the MVP, applying the repository workflow rules below to codebase changes. Avoid conflicting Git initialization paths or unrelated histories.
7. Read back remote/local state and compare managed postconditions to desired state.
8. Report successes, no-ops, skipped/blocked steps, failures, unresolved drift, and recovery choices.

| Action category | Approval requirement |
|---|---|
| Read-only inspection/audit | No mutation approval |
| Standard mutations, such as repository creation or templates | Specific execution plan approval |
| Sensitive mutations, such as deletion, reduced security, visibility changes | Explicit operation-specific confirmation |
| Paid capabilities | Separate informed financial authorization, in addition to applicable approvals |

Approvals are not transferable to materially revised plans. Where multiple repositories are represented in a preview, identify each sensitive operation individually; concurrent multi-repository orchestration remains deferred.

### Approval and execution invariants

An approved plan binds the resolved configuration and source revisions, GitHub host/account and resource identity, operation parameters, generated file content or its immutable digest, base revisions, provider, delivery stage, required evidence, and disclosed cost/reversal implications. Identical inputs produce the same semantic plan; run timestamps and audit IDs are execution metadata. Freeze generated content before approval rather than regenerating it during apply. Approvals record who approved and which plan and consent categories were accepted; configuration files and repository text cannot serve as approval evidence.

Before each mutation, recheck its relevant preconditions, permissions, and approval validity against current state. Compare against the state expected after earlier successful steps in the same plan; those planned changes do not invalidate their own approval. External changes to relevant fields, base revisions, actor, enforcement, or financial/recovery assumptions require replanning and renewed applicable approval. Unrelated changes outside managed scope need not invalidate the plan. Use conditional writes where supported; when a provider cannot prevent races, disclose the limitation and verify immediately after the write rather than claiming atomic protection.

Serialize conflicting local executions for the same repository/configuration resources, including separate plugin processes. Stop on a failed or uncertain step and leave dependent steps pending; resumption revalidates evidence before continuing. Cancellation stops scheduling new mutations, records any in-flight uncertainty, and preserves recovery state. Retries are bounded and honor rate-limit guidance. A guided browser step must have its approved intent and required backup recorded before the user is instructed to perform it; unobservable results remain pending verification rather than successful by user assertion alone.

## 9. Persistence and credential security

Use four distinct storage responsibilities behind replaceable persistence interfaces:

| Category | MVP representation |
|---|---|
| Desired configuration, profiles, policies | Version-controlled YAML |
| Drafts, execution state, progress, recovery | Local persistent filesystem storage with atomic writes |
| Approvals, all operations, warnings, outcomes | Local append-only audit journal |
| Pre-change settings snapshots and reversal references | Protected local filesystem storage with atomic writes, linked to plan and operation IDs |

Hybrid defaults are repository-local configuration for personal repositories and a central GitOps configuration repository for organization repositories. Users can explicitly choose either strategy. A configured central source is not permission to create a remote configuration repository automatically; missing configuration sources must be surfaced for explicit resolution.

Record which source and reference are authoritative for each resource, their revision, and the approved desired-state revision used by each run. Editing shared desired configuration is itself a repository code change and must follow that configuration repository's workflow. For central GitOps storage, preview both repositories' changes, dependencies, and delivery stages; sequential coordination does not imply a cross-repository transaction. A draft, local commit, or unmerged configuration PR does not update a configured remote authoritative reference. A deliberately selected local source may use its approved committed revision; show that distinction explicitly. Do not silently write a competing local source when a central source is unavailable.

Persistence interfaces allow later SQLite, PostgreSQL, or cloud implementations without changing domain rules. The MVP does not require a database service. Drafts must survive validation errors and transitions between UI modes.

Initially reuse secure GitHub CLI authentication for adapters that can use it. A host-managed official MCP or native integration may retain its own established authentication; CLI credentials must not be exported into that integration or the UI. Verify its actor and target independently and disclose mismatches before planning. Keep credential acquisition separate from GitHub providers and leave extension points for plugin-managed GitHub Apps and OAuth. Authentication does not imply authorization: verify actual permissions before each affected mutation and revalidate when execution context changes.

Credentials, tokens, browser sessions, and secrets must never enter version-controlled configuration, frontend payloads, plans, or audit logs. Use credential providers or OS-protected storage. Persist references and redacted outcomes rather than secrets. Apply the same secret-exclusion requirement to snapshots and backups; explicitly identify write-only or unreadable values that cannot be restored from a snapshot.

The MVP local browser UI binds only to loopback, uses short-lived session credentials, validates expected origins/hosts, and protects mutation endpoints against cross-site requests. The frontend never receives GitHub authentication tokens. Browser workflows remain user-controlled and supervised.

Treat repository documents, templates, provider responses, and browser content as untrusted data. They may describe contribution requirements but cannot grant privileges, change approval gates, or issue agent instructions. Validate local paths and resource identifiers, prevent traversal or unintended symlink writes, preserve existing destination contents, and avoid interpreting configuration values as shell commands. Discover repository hooks, signing tools, and check commands before execution; do not silently run arbitrary repository-supplied code merely to create a commit or inspect rules. Required executable checks need explicit coverage in the approved plan or an already authorized execution policy. Protect recovery files, journals, and temporary files with restrictive local access; local append-only logging is an accountability record, not a claim of tamper-proof storage against the machine owner.

## 10. Adaptive UI and harness interaction

Prefer embedded MCP Apps UI where the host actually supports it; otherwise use a local browser UI or universal conversational fallback. Detect capabilities at runtime. All modes share configuration drafts and application services.

Generate forms from component/configuration schemas. Present recommended values with explanations, custom values where permitted, required/optional status, dependencies, cost implications, validation feedback, profiles, and expandable advanced settings. Do not force a form for a simple single-setting conversational change.

The form lifecycle is **Request → Schema → Draft → Validate → Preview → Approve → Execute**, followed by shared verification/reporting. Approval covers final resolved configuration and its execution plan, rather than only the original natural-language request. Switching UI modes must preserve the draft. Clearly distinguish ordinary confirmation, sensitive-operation approval, and financial consent.

## 11. Failure handling and recovery

GitHub and local Git operations do not share an atomic transaction. Preserve accurate partial progress rather than claim all-or-nothing behavior.

| Failure/state | Required behavior |
|---|---|
| Network interruption | Retry only when safe; inspect uncertain outcomes before repeating mutations |
| Rate limiting | Respect provider retry/rate-limit guidance |
| Missing permission | Stop affected operations and explain the required permission |
| Existing resource | Verify identity and authorized intent; an unexpected creation collision requires explicit adoption/replanning, while an authorized update reconciles only managed scope |
| External configuration change | Revalidate the plan; do not overwrite conflicting changes blindly |
| Partial failure/interruption | Persist completed steps and expose resumable recovery |
| Unapproved paid action | Block it |
| Browser failure | Offer guided manual completion |
| Verification mismatch | Report actual state and drift; propose remediation through the approval lifecycle |

Each operation has a stable identity and observable postcondition, or an explicit pending-verification state for an outcome that cannot yet be observed. Already satisfied postconditions become no-ops. Persist stable remote resource IDs, commit IDs, branch/PR references, and request evidence when available; a matching name alone is insufficient evidence that an uncertain creation attempt succeeded. Use optimistic concurrency for updates where supported. On resume, inspect actual state and reconcile saved progress; do not blindly repeat writes or treat persisted completion as proof of current state. Do not duplicate commits or PRs whose approved delivery is already in progress merely because the target branch still differs from desired state.

Never automatically delete a newly created repository because a subsequent configuration step fails. Preserve it, report its actual state, and allow resume or separately authorized cleanup. Automatic rollback policy is deferred.

### Reversibility and pre-change backups

Every plugin mutation, whether performed through MCP, native tools, Octokit, local Git, or supervised browser interaction, must be reversible wherever technically possible. Classify each planned mutation as reversible, partially reversible, or irreversible, based on actual provider capabilities, saved state, permissions, and side effects. Include its reversal method and prerequisites. Restoring a setting does not imply that historical side effects, external notifications, exposure of information, or incurred costs can be undone.

Before approval and execution, explicitly message the user about any irreversible operation or irreversible portion of an operation, explain its consequences, and require acknowledgment tied to that plan. Do not discover an unavailable reversal method and proceed silently. Reassess and obtain revised approval if reversibility changes.

Before any repository mutation, durably capture the repository settings state visible to the provider, including the prior values of all affected settings, applicable rules, resource identity, observation time, and version/concurrency information where available. Link the snapshot to the plan and operation. For repository creation, record that the resource did not exist; capture its initial settings before subsequent configuration changes. Preserve Git base revisions and affected-file evidence for codebase changes; a settings snapshot alone cannot restore files. A reused snapshot must be revalidated as the current pre-change state and remain available for the operation's recovery needs. Internal audit/snapshot writes do not recursively require snapshots of themselves; backup and retention actions still receive audit records and applicable approvals.

Record snapshot coverage and unreadable or non-restorable fields explicitly. If an affected prior value cannot be captured, stop and disclose the restoration limitation; proceeding requires explicit approval of a revised plan that classifies that effect accordingly. A storage failure blocks mutation rather than silently disabling backups. Protect snapshots as local recovery data, outside shared desired configuration. Retention is governed by Section 16: retained audit history does not promise indefinite restoration, and an expired or pruned snapshot must no longer be advertised as restorable. Retain enough evidence to resume an unfinished operation; do not prune its required recovery artifacts while it is active or unresolved.

Provide user-invoked reversal through the same inspect, plan, preview, approve, apply, and verify lifecycle. Compare current state with the recorded post-change state first; preserve intervening user or third-party changes and surface conflicts for resolution. Reverse dependency order where required. A reversal has its own logging, pre-change backup, permissions, sensitive-action, and financial checks. Reversal availability does not authorize automatic rollback or deletion of a newly created repository. Automatic rollback policies remain deferred.

Restore only selected, captured, managed fields and file changes; never replay an entire snapshot over unrelated current settings. Preview whether restoration also changes authoritative desired configuration through its repository workflow or intentionally leaves reported drift. Do not silently let subsequent reconciliation undo the user's restore. Reversal readiness is rechecked at restore time because permissions, rules, retained Git objects, and provider capabilities may have changed.

### Complete operation logging

Log all plugin operations, including reads, planning, validation, previews, approvals, mutation attempts, no-ops, retries, guided/manual steps, verification, backups, and reversals. Records identify the plan/run, operation, resource, actor or execution context, provider, time, status, sanitized change summary, backup/reversal references, and failure or uncertainty where applicable. Do not log raw credentials or sensitive payloads merely to achieve completeness.

Write an intent/start record before mutations and append their outcomes afterward. If an outcome cannot be recorded, stop further mutations and reconcile the uncertain operation against actual state on recovery. Guided browser actions receive the same audit treatment, distinguishing user-reported completion from independently verified completion. Missing audit or required backup capability blocks mutation through that provider.

Journal events use ordered, durable records linked to execution state so restart can detect a missing outcome or incomplete write. Logging infrastructure does not recursively log each of its own record writes. If journaling is unavailable, report that failure directly and stop normal workflows; any read-only diagnostic needed to recover logging must be visibly identified as unjournaled. Do not claim a complete audit for that diagnostic interval. Snapshot retention does not silently delete audit history; audit-capacity exhaustion is surfaced and blocks mutation until resolved.

### Repository rules for codebase changes

After repository creation, every plugin addition, modification, or deletion of repository content—including README, license, ignore files, issue/PR templates, and version-controlled plugin configuration—must be represented by a commit that follows the repository’s effective workflow. This includes newly generated files, not only previously tracked files; local operational journals and recovery storage are not repository content. Discover documented contribution rules, applicable organization policy, branch protections/rulesets, branching strategy, and commit requirements before planning changes.

Respect the configured strategy, such as Git Flow, GitHub Flow, trunk-based development, or a repository-specific workflow. Resolve the correct base/target branch, working branch and naming convention, commit-message format, required sign-offs or signatures, review/PR requirements, and mandatory checks. Offer Conventional Commits as the default commit standard and Git Flow as the default branching strategy. These defaults apply when no explicit selection or existing/enforced repository rule supplies a different value; they must not silently migrate an existing workflow. If required rules are missing, conflicting, or cannot be met, surface the issue and resolve an explicit workflow before writing or committing changes.

Commit-standard and branching-strategy selection are must-have MVP capabilities, exposed through forms and conversation and persisted in declarative configuration by `repository.workflow`. Offer Conventional Commits or a custom commit convention, and Git Flow, GitHub Flow, trunk-based development, or a custom branching strategy. A custom choice must capture enough explicit rules to validate messages and resolve branch routing; naming a convention alone is insufficient. Validate standard/strategy combinations against applicable policies before planning.

Custom rules are declarative, bounded validation/routing data, not arbitrary executable scripts. Detect conflicting evidence instead of guessing a workflow from branch names alone. An existing repository with no discoverable convention may adopt an explicitly confirmed choice; absence of evidence does not authorize an unannounced migration.

Show the effective choices and their source (existing repository rules, enforced policy, explicit selection, profile, or default) in the configuration preview. Apply the precedence in Section 6. Existing repository rules constrain execution until an approved migration changes them; an explicit selection alone does not authorize replacing those rules. New repositories present the defaults for confirmation. Changing an existing repository’s convention is a separate previewed configuration change with affected branches/files, reversal limits, and required approvals. Selecting Git Flow does not bring advanced release automation into the MVP.

The preview identifies affected files and content, branch/base, author/committer identity, proposed commit message, and required PR/check path. Commit creation is part of the approved file-change plan; pushing, opening a PR, or merging must also fall within that plan’s authorized scope and repository requirements. Never bypass protections or fabricate signatures or passing checks. Preserve unrelated local work and commit only the approved changes. API-based file writes must satisfy the same branch and commit rules as local Git writes, and cannot implement a local-only delivery choice by writing remotely.

For a new empty repository, the plan explicitly chooses one initial-history path and the ordering of the first compliant commit, primary/development branches, default-branch selection, and enforceable protections. Git Flow setup includes the selected primary/development branch routing but no release automation. Do not combine independent remote auto-initialization and local root histories. Existing organization restrictions apply throughout bootstrap; if they make the first commit or required checks impossible, stop for resolution instead of creating a temporary protection bypass. Do not configure a nonexistent or unsatisfiable required check as though an executable workflow had been supplied; authoring advanced CI remains deferred.

Treat file writing and commit creation as a recoverable unit, with approved content staged away from unrelated work where feasible. If a hook, signing operation, or commit fails, do not report success or automatically discard files: retain/recover the approved patch, describe any uncommitted plugin changes, and offer safe resume or restoration. A successful file-change operation requires evidence of its compliant commit. A restart after a successful but unrecorded commit must locate and verify that commit before considering another attempt.

Report whether a change is committed locally, pushed, awaiting review/checks, or merged; a commit on a working branch is not proof that the target branch has been updated. Verify the postcondition appropriate to the approved delivery stage. Reversal of codebase changes normally uses a new revert commit through the same branching and review process, preserving shared history rather than rewriting it. Advanced CI/CD authoring remains deferred; complying with existing required checks is in scope.

Local-only, branch-push, and PR delivery choices are valid stopping points when compatible with effective rules. A local-only result may be complete for that approved stage while target-branch configuration remains unapplied. Plan remote settings changes separately and order any that depend on delivered file/configuration changes after the required stage; do not activate dependent settings merely because a local commit exists. Pending reviews/checks are resumable states, with no implied merge authorization. When merging is explicitly planned, recheck required reviews/checks and the exact approved head revision immediately before merge.

## 12. Testing and acceptance criteria

Testing must cover the behavioral boundaries, not only individual provider calls:

- Unit tests: inheritance, schemas, policy enforcement, management scope, cost and reversibility classification, backup coverage, workflow resolution, and deterministic planning.
- Contract tests: all provider adapters satisfy common capability, operation, and failure semantics, including unsupported operations.
- Integration tests: provisioning, updates, idempotency, and partial-failure recovery using dedicated disposable GitHub resources.
- End-to-end tests: natural-language configuration, forms, UI transitions, final-plan approval, and full lifecycle verification.

Automate without paid services wherever possible. Real GitHub API tests are opt-in and use dedicated test resources, never production repositories by default. Creating test resources is not authorized by this design-document task.

| Area | Release acceptance evidence |
|---|---|
| Creation | Personal and organization repositories can be created when authorized and supported |
| Configuration | Profiles and explicit overrides resolve according to precedence; enforced restrictions cannot be bypassed |
| Local operations | Repository initializes coherently and clones into the selected directory |
| Basic assets | README, license, ignore rules, issue templates, and PR templates can be generated/updated |
| Rulesets | Supported branch/repository policies apply; unavailable capability or entitlement is reported clearly |
| Ongoing lifecycle | Managed settings update while unrelated unmanaged settings remain intact |
| Planning/approval | Preview matches applied operations and frozen content; stale source/base/account/managed-state changes invalidate approval, while expected prior steps and unrelated changes do not |
| Idempotency | Applying an unchanged configuration twice produces no unnecessary mutations, commits, or PRs, including while an approved delivery is pending |
| Recovery | Interruption and uncertain outcomes resume safely without duplicate repositories or destructive cleanup |
| Reversal | Reversible changes restore approved prior state; partial/irreversible effects are disclosed and acknowledged before execution; intervening changes are preserved |
| Backups | Required snapshots exist before mutations; failed snapshot storage prevents mutation; creation records prior absence |
| Audit | All operation categories have sanitized records; failed intent logging blocks mutation and uncertain outcomes are reconciled |
| Workflow selection | Forms and conversation select/persist commit standards and branching strategies; absent higher-precedence rules, Conventional Commits and Git Flow are presented as defaults; custom rules are validated |
| Workflow preservation | Existing conventions are detected and preserved until an explicit migration is approved; effective choices and their sources are shown |
| Repository workflow | Template/file changes produce compliant commits on the correct branches and required PR/check path; direct-write bypasses are rejected |
| Codebase reversal | Revert commits follow repository rules and preserve unrelated work and shared history |
| Workflow controls | Branch names/prefixes, commit types/scopes, merge/review rules, signing/sign-offs, and delivery preferences are configurable and honored without bypassing policy |
| Recovery controls | Retention/storage limits and restore-point browsing expose coverage/expiry; active recovery evidence is preserved, capacity failures block mutation, and destructive pruning requires informed acknowledgment |
| Authorization | Missing permissions and unapproved sensitive operations prevent affected mutations |
| Financial safety | Paid entitlements and foreseeable usage-triggering actions require informed authorization with recorded evidence; unresolved exposure remains blocked |
| Verification | Read-back distinguishes success from blocked steps, failure, and remaining drift |
| UI | Schema forms, browser fallback, and conversation share drafts; embedded UI is capability-dependent |
| Security | Credentials remain outside configuration, frontend, plans, audit, and backups; untrusted input cannot grant approval, run commands, or escape approved local paths |
| Portability | Core behavior is testable through independent ports without Codex-specific APIs |
| Documentation | Installation, configuration, troubleshooting, and extension guidance are provided |

Cross-cutting failure evidence must also cover: provider/account mismatches; preferred providers unable to honor signing or concurrency; unexpected creation collisions; external edits between preview and apply; conflicting plugin processes; cancellation during a write; disk-full or incomplete journal/snapshot writes; interruption between file write and commit, commit and push, and push and PR; a required signing capability or required check that is unavailable; empty-repository bootstrap under enforced rules; and restore after external changes or snapshot expiry. These are design acceptance requirements, not permission to run live tests during this review.

## 13. Tradeoffs and architecture decision records

These ADRs are recorded within this specification; separate ADR files are not created at this stage.

| ADR | Decision | Benefit and accepted tradeoff |
|---|---|---|
| 001 | Portable hexagonal core; thin host/provider adapters | Reuse and independent tests; more explicit interfaces than a Codex-only script |
| 002 | Official GitHub MCP preferred, native harness tools and Octokit as appropriate | Reuses official/available integrations; capability differences require discovery and contracts |
| 003 | Guided supervised browser fallback first | Covers gaps while retaining user control; less automation and more user involvement initially |
| 004 | Declarative components with explicit management scope | Minimal reconciliation and independent updates; schemas and scope must be maintained |
| 005 | Enforced/advisory governance with defined precedence | Configurable organizational control; conflict resolution is explicit rather than permissive |
| 006 | Cost preflight and separate financial consent | Prevents implicit spending; uncertain paid actions may require user resolution |
| 007 | Deterministic immutable plans and explicit approvals | Reviewable execution; material changes require replanning |
| 008 | Local filesystem state, YAML configuration, append-only audit | Simple local-first operation; no distributed transactions or centralized audit in MVP |
| 009 | Hybrid repository-local/central GitOps configuration | Fits personal and organization use; needs clear source resolution and override rules |
| 010 | Adaptive schema-driven UI with shared drafts | Consistent behavior across hosts; embedded UI availability cannot be assumed |
| 011 | Sequential, idempotent, resumable execution; no automatic destructive rollback | Predictable recovery; partial resources can remain for explicit follow-up |
| 012 | Repository lifecycle first; broader platform capabilities deferred | Bounded MVP; CI/CD, Projects, organization creation, and application scaffolding arrive later |
| 013 | Reversal wherever feasible; explicit warning and acknowledgment for irreversible effects | Supports recovery without promising that all side effects can be undone |
| 014 | Comprehensive operation audit and mandatory pre-change settings snapshots | Enables accountable restoration; storage/capture failures can block execution |
| 015 | Repository-governed commits for all post-creation codebase changes | Honors existing collaboration rules; delivery can await required review/checks |
| 016 | Selectable workflow conventions; Conventional Commits and Git Flow defaults | Gives consistent starting choices without silently replacing existing or enforced repository rules |
| 017 | Workflow detail, merge/review, signing/sign-off, delivery, and recovery controls in MVP | Makes repository compliance and recovery configurable; requires validation of combinations and clear retention limits |

TypeScript and npm workspaces were proposed in approved Section 5 for the project implementation. They are the recorded project direction, while core interfaces and semantics remain independent of host and transport. Selecting that toolchain does not authorize scaffolding in this step.

## 14. Project repository checkpoint and approval gates

**User amendment 2026-10-19 — own-repository operation:** Only `develop` may merge into `main`; `feature/**`, `chore/*`, and `doc/*` merge only into `develop`, with semantic Issue-type prefixes. Append and commit the release changelog before tagging and derive release notes from that committed entry. These rules govern this project’s repository and supersede its earlier generic Git Flow routing preference; the product still supports configurable classic Git Flow and other strategies. Current setup selections and pending choices are recorded in `2026-10-19-repository-setup-decisions.md`; Issue-completion policy remains pending. The original checkpoint proposal and approval history below are retained as history, not a replacement for subsequent user selections.

The proposed project identity from Section 5 is:

| Property | Proposed value |
|---|---|
| Name | `github-workspace-manager` |
| Description | Portable AI-assisted GitHub provisioning and configuration management |
| Visibility | Private initially |
| Default branch | `main` |
| Primary language | TypeScript |
| Package management | npm workspaces |
| License | Selection required before public distribution; no license is selected by this document |

The checkpoint remains **after written-spec approval, the architecture-document stage, and written implementation-plan approval**, before implementation. Written-spec and architecture approval were granted on 2026-10-19; implementation planning is authorized and implementation-plan approval remains a future gate. At that checkpoint, explicitly signal that it is time to create the project's remote repository and commit the approved specification, ADRs, backlog, and implementation plan. Confirm the remaining creation inputs, such as owner, through that workflow; do not infer them here.

The sequence is:

1. Consolidate the conversational design into this document and self-review it (completed).
2. Obtain explicit approval of this written specification (granted by the user on 2026-10-19); add its linked table of contents and render the approved specification as a PDF.
3. Prepare and obtain approval of the separate architecture document (completed; user approval recorded on 2026-10-19).
4. Prepare the written implementation plan using Superpowers and GPT-6 Astra/Medium (authorized on 2026-10-19).
5. Obtain plan approval and the user's execution-method selection.
6. Signal and carry out the authorized remote repository creation checkpoint.
7. Begin implementation under the approved plan and execution method.

The initial specification workspace had no initialized local Git repository. This revision is saved in the current ChatGPT project’s editable `docs/` directory, outside read-only synced references. The user has approved both documents and authorized implementation planning under `docs/project-model-policy.md`. This planning stage does not authorize Git initialization/commits, product scaffolding, dependency installation, implementation, or remote resources. The previously delivered PDF remains the approved specification snapshot from before this planning-status update; product requirements are unchanged. The later approved repository checkpoint records the specification in Git under the selected repository rules.

## 15. Design self-review

Reviewed for scope omissions, contradictory requirements, ambiguous gates, and incomplete placeholders. The following resolutions are incorporated:

- Provider preference is capability-aware and does not bypass approval when fallback changes a plan materially.
- Browser guidance is in the MVP; comprehensive automated browser interaction is incremental.
- Sequential execution is the MVP despite future dependency-aware concurrency examples.
- Basic repository assets are in scope; full application scaffolding and advanced CI/CD are deferred.
- Configurable enforced/advisory governance is in scope; conditional/delegated governance is deferred.
- Mandatory financial preflight is in scope; advanced estimation is deferred.
- Embedded MCP Apps UI is preferred when supported, with browser/conversation fallbacks required.
- Hybrid configuration defaults do not authorize automatic creation of a central repository.
- No automatic repository deletion is used for recovery.
- User-invoked reversal and pre-change backups are MVP requirements; automatic rollback policy remains deferred.
- Settings backups and complete operation logging extend the original execution-history requirement without storing secrets.
- Repository branching/commit/review compliance applies to all post-creation file changes, including templates and their reversal.
- The user’s completed items 3–4 establish selectable conventions as must-have features, with Conventional Commits and Git Flow defaults; existing/enforced rules remain respected.
- The user approved all five additional feature proposals; Section 16 incorporates them as MVP requirements, including retention controls and restore-point browsing.
- Conversational section approvals and written-spec approval are recorded separately. Written-spec and architecture approval were granted on 2026-10-19; implementation planning is authorized and implementation-plan approval remains a future gate.

The critical review additionally clarifies the following existing requirements rather than adding a new product tier or deferring approved features:

- Provider capability includes actor identity, signing, concurrency, backups, and verification; authentication reuse must not assume every provider shares CLI credentials.
- Approval binds content, source revisions, delivery stage, and relevant preconditions; planned intermediate state and external conflicting state are distinguished.
- Creation collisions require explicit adoption, and resumed delivery does not duplicate commits or PRs while awaiting review.
- Versioned configuration distinguishes unmanaged fields from resets, trusts designated policy sources, and records central GitOps delivery separately from applied state.
- Empty-repository bootstrap, commit failure, local-only delivery, required checks, and downstream merge/signature limitations are explicit.
- Financial preflight includes foreseeable usage triggered by ordinary writes, with uncertainty bounded sufficiently for informed consent.
- Finite backup retention, active recovery evidence, append-only audit, and restore-induced configuration drift have consistent semantics.
- This approved-specification update and PDF rendering remain document-only. The separate architecture is now approved and implementation planning is authorized; implementation and repository creation remain gated by written-plan approval and execution-method selection.

No new major product decision is selected by these clarifications. Remote owner and license remain future checkpoint inputs. Per-repository workflow details, signing identity, delivery preference, and backup retention/storage values are choices the approved MVP must collect and validate; this specification does not invent numeric retention defaults or signing keys. The source-history boundary in Section 1 remains explicit for user review.


## 16. Approved workflow and recovery configuration features

The user approved all five refinements below for inclusion in the design. They are MVP requirements, available through schema-driven forms and conversational configuration. Store shared workflow rules in desired configuration and machine-specific delivery/storage preferences in execution configuration. Written-spec approval was granted by the user on 2026-10-19; this approval does not authorize implementation or external actions.

| Feature | User choice and purpose | Scope |
|---|---|---|
| Workflow detail editor | Configure primary/development branch names, feature/release/hotfix prefixes, and commit types/scopes; validate required fields for the chosen workflow | MVP refinement of approved workflow selection |
| Merge and review policy editor | Choose permitted merge methods, PR title convention, required approvals, and branch deletion after merge; ensure resulting commits comply with the selected standard | MVP configuration extension, subject to support/cost checks |
| Signing and sign-off preferences | Select commit signing and contributor sign-off requirements; preflight local capability without creating or replacing keys | MVP configuration extension; existing requirements already must be honored |
| Change-delivery preference | Choose local commit only, push a working branch, or open a PR; show the pending delivery stage and require separate authorization for merge unless already explicitly planned | MVP refinement of delivery previews |
| Backup retention and restore browser | Choose retention/storage limits and inspect available snapshots and reversal limitations before selecting a restore point | MVP recovery configuration and browsing |

No preference can override enforced policies, repository protections, cost consent, or immutable-plan approval. Validate required fields and discover existing rules before presenting effective choices. Required signing or sign-off capability must be available before committing; never fabricate a signature or contributor attestation. Do not create or replace signing keys implicitly.

The merge/review editor owns the user's desired behavior; `repository.rulesets` and provider adapters implement available remote enforcement without competing ownership of the same setting. Show whether a choice is enforced by GitHub, enforced only for plugin operations, or unsupported. A PR-title convention checked by the plugin is not represented as repository-wide enforcement when the provider cannot establish it. Coordinate allowed merge methods with the resulting commit messages, sign-offs, and signatures; do not claim that squash/rebase/merge preserves these properties without verification. Reject incompatible combinations or leave delivery awaiting a compliant merge path. Required sign-off records an authorized contributor identity and attestation, not a fabricated footer; required signing preflights the available trusted mechanism and verifies the resulting commit evidence.

Retention and storage limits must be visible alongside each snapshot’s coverage, restore availability, and expiry. Do not silently prune snapshots that are still advertised as restorable. Selecting a retention policy that will expire recovery options requires explicit acknowledgment of that future irreversible loss; subsequent pruning may follow that approved policy without repeated confirmation, but must log the event and update restore availability. A later retention reduction or exceptional deletion outside that policy requires renewed acknowledgment. Preserve active/unresolved recovery dependencies. Storage limits account for required backup artifacts and metadata; expose audit storage separately. If configured limits prevent saving a required backup, block the affected mutation and offer retention/storage resolution. Snapshot browsing is a basic recovery interface, not the deferred advanced dashboard.

Acceptance evidence must demonstrate that each setting can be selected, validated, persisted in the appropriate configuration, previewed, and honored by execution. Cover branch routing and message validation, merge/review compatibility, unavailable signing capability, each delivery stage, retention-limit failures, and restore-point selection with clear coverage and expiry. Changes to these preferences undergo the same backup, approval, audit, and verification lifecycle as other managed configuration changes.
