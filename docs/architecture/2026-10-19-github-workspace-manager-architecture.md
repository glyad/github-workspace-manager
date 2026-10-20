# GitHub Workspace Manager — System Architecture

Date: 2026-10-19  
Status: Approved by the user on 2026-10-19  
Source: [Approved design specification](/Users/davidkossoglyad/.codex/.chatgpt-projects/g-p-6ad52ba8c62c8191941d5745aa10d19a/docs/superpowers/specs/2026-10-19-github-workspace-manager-design.md), approved 2026-10-19  
Stage: Architecture approved; implementation planning authorized; implementation awaits plan approval

**User amendment 2026-10-19:** Added the explicit MVP delivery constraint and own-repository routing clarification below. Original approval history is preserved; the existing PDF represents the prior approved revision and awaits a refreshed approved export.

## Table of contents

- [1. Authority, scope, and architectural decisions](#1-authority-scope-and-architectural-decisions)
- [2. System context and dependency boundaries](#2-system-context-and-dependency-boundaries)
- [3. Domain records and state transitions](#3-domain-records-and-state-transitions)
- [4. Application services and port contracts](#4-application-services-and-port-contracts)
- [5. Configuration ownership and resolution](#5-configuration-ownership-and-resolution)
- [6. Provider discovery, identity, and fallback](#6-provider-discovery-identity-and-fallback)
- [7. Immutable plans and authorization](#7-immutable-plans-and-authorization)
- [8. Sequential execution, locking, and durability](#8-sequential-execution-locking-and-durability)
- [9. Git bootstrap, workflow, and delivery](#9-git-bootstrap-workflow-and-delivery)
- [10. Financial preflight](#10-financial-preflight)
- [11. Backup, retention, reversal, and recovery](#11-backup-retention-reversal-and-recovery)
- [12. Security and trust boundaries](#12-security-and-trust-boundaries)
- [13. UI and harness adapters](#13-ui-and-harness-adapters)
- [14. Logical packaging and deployment](#14-logical-packaging-and-deployment)
- [15. Verification and acceptance traceability](#15-verification-and-acceptance-traceability)
- [16. ADR alignment and unresolved inputs](#16-adr-alignment-and-unresolved-inputs)
- [17. Architecture review record and next gate](#17-architecture-review-record-and-next-gate)

## 1. Authority, scope, and architectural decisions

The approved specification is the product contract. This document translates that contract into component responsibilities, data relationships, execution semantics, and failure boundaries. It does not supersede its requirements. References to specification sections below refer to that source document.

**Approved constraints** include a portable hexagonal core, local-first sequential execution, capability-aware preference for official GitHub MCP, YAML desired configuration, explicit management scope, immutable approved plans, separate financial consent, durable audit and pre-change backups, repository-compliant commits, and adaptable schema-driven interaction. Conventional Commits and Git Flow remain the defaults subject to existing rules and higher-precedence choices. All five refinements in specification §16 remain MVP requirements.

**Approved architecture mechanisms**, accepted with this document on 2026-10-19, are the record model, service/port boundaries, semantic plan fingerprinting, operation checkpoints, process-independent resource locks, audit-linked recovery protocol, and logical package divisions described here. They are ways to meet the approved contract, not additional approved product features. No concrete host API, provider SDK method, filesystem durability primitive, or signing mechanism is assumed available merely because it appears as a required port capability.

The MVP includes personal and organization repository creation, coherent initialization and cloning, README/license/ignore/issue-template/PR-template management, rulesets, workflow configuration, managed updates/drift detection, recovery and reversal, and shared conversational/form drafts. Release automation, advanced CI/CD authoring, Projects v2, organization creation, full application scaffolding, external components, distributed execution, automatic rollback policy, centralized audit, databases, advanced dashboards/cost estimation, and collaborative editing remain deferred. Git Flow routing does not imply release automation. Initial credential reuse does not imply implementation of GitHub Apps or OAuth.

## 2. System context and dependency boundaries

The local application owns planning and execution authority. An agent can propose desired state and explain a result, but cannot turn retrieved text or a generated recommendation into approval. Every presentation surface reaches the same application services.

```text
User / agent host
  | configuration proposals, explicit user decisions
  v
Codex / conversational / embedded / local-browser / CLI adapters
  | semantic application requests; no direct provider mutations
  v
Application services
  Inspect -> Resolve -> Validate -> Plan -> Approve -> Execute -> Verify
  |                  audit, backups, recovery, workflow, cost
  v
Domain rules and port contracts
  | adapters implement contracts; core imports no host/transport SDK
  +-- GitHub: official MCP / native harness / Octokit / guided browser
  +-- Local: Git / filesystem / locks / state / journal / snapshots
  +-- Trust: credentials / trusted policy / consent / cost evidence
```

Dependency direction is inward: adapters depend on application contracts; application services depend on domain rules and ports. Domain rules consume typed facts and return decisions without invoking transport or UI code. The composition boundary connects supported adapters at startup. Credentials remain inside credential/provider adapter boundaries.

The executor is the sole application path that dispatches approved mutations. The recovery service produces plans for that executor; it has no privileged bypass. Remote setting changes, Git operations, configuration-repository changes, and guided manual steps all enter the same dependency graph. There is no transaction spanning GitHub, Git, and local persistence.

## 3. Domain records and state transitions

The following are logical records, not a committed storage schema or public SDK. Persistent records carry a format version; unsupported versions are rejected safely rather than guessed or silently migrated.

| Record | Identity and essential contents | Role |
|---|---|---|
| Resource binding | GitHub host, owner/name, stable remote ID when known; before creation, intended identity plus recorded absence | Separates an intended new repository from an observed existing one; names alone never prove creation success |
| Configuration source | Authority designation, repository/local location, reference, immutable revision, trust designation, source kind | Distinguishes desired configuration from draft and applied state |
| Draft | Draft ID, revision, values, field intent, source selections, validation results | Shared between all UI modes and retained through errors |
| Resolved configuration | Managed fields, effective values, per-field source/provenance, policy evidence, workflow rules | Deterministic input to planning |
| Observation | Resource binding, readable managed/current settings, Git refs, permissions, enforcement, coverage, concurrency evidence, time | Supplies preconditions; absence and unreadability are different facts |
| Capability/identity evidence | Provider instance, host/principal, operations and semantic guarantees, constraints, observation time | Determines whether an adapter can execute a particular operation |
| Plan | Semantic fingerprint, frozen input revisions/content, resource bindings, ordered operations, dependencies, preconditions, delivery goals, disclosures | Immutable review and execution contract |
| Operation | Stable ID within the plan, action, target, provider binding, parameters/content references, expected predecessor state, postcondition, backup and consent requirements | Smallest independently observable mutation/checkpoint unit |
| Authorization | Plan fingerprint, user/host decision evidence, consent category and operation scope, disclosures accepted, time | Records ordinary approval, sensitive confirmation, financial consent, and irreversible-effect acknowledgment distinctly |
| Run and checkpoint | Run ID, plan reference, operation attempts, observed outcomes, pending work, cancellation state | Mutable progress only; cannot alter approved semantics |
| Snapshot | Snapshot ID, plan/operation references, protected captured state, coverage/omissions, Git evidence, expiry and recovery dependencies | Supports a bounded restoration claim |
| Delivery record | Approved patch/content identity, base/commit IDs, branch and PR references, target, authorized stopping stage | Prevents duplicate commits/PRs during pending delivery |
| Audit event | Ordered event ID, run/operation/resource, actor/provider, sanitized action, outcome, evidence links | Append-only accountability and restart correlation |

Resource binding becomes stable after verified creation; this is an expected plan transition rather than a new target selection. Unexpected name collisions remain blocked until explicitly adopted in a revised plan.

A draft moves through `editing -> validated -> planned`. Editing a planned draft yields a new draft revision and a new plan; it never edits an approved plan. A plan moves through `awaiting approval -> executable`, or remains blocked by validation/consent. A changed relevant assumption makes it stale and requires revalidation and applicable renewed approval.

A run moves through `ready -> running -> verifying -> completed`, with explicit `blocked`, `failed`, `cancelled`, or `pending` outcomes. These outcomes include per-operation detail; “completed” cannot imply that every remote target is configured when the approved endpoint was a local commit.

An operation moves through `pending -> prepared -> dispatched -> verified`. Preparation means intent and required backup are durably stored. A timeout after dispatch yields `uncertain`, not an automatic failure safe to retry. Read-back reconciliation resolves uncertainty to verified, not applied, conflicting, or pending verification. No-op is a separate verified outcome. A failed or uncertain step stops new mutation scheduling; dependent steps remain pending.

Delivery progresses through `approved content -> written/staged -> committed locally -> pushed -> PR open -> awaiting checks/reviews -> merged`, as applicable. Approved local-only, branch-push, or PR endpoints can complete without reaching merge. Check/review waiting is resumable, not an error and not merge permission.

## 4. Application services and port contracts

Contracts exchange semantic inputs, structured evidence, and typed failures. They do not expose raw transport responses to the domain. Every mutation adapter must distinguish a definitely undispatched request from an uncertain outcome. Common result classes include success with evidence, unsupported capability, permission denied, conflict/stale precondition, rate limited with retry guidance, unavailable dependency, and uncertain outcome.

| Service / port | Contract responsibility | Important guarantee |
|---|---|---|
| Inspection / provider discovery | Observe resources, permissions, entitlements, provider identity and capabilities | Reports unknown and unreadable explicitly; no permission inferred from authentication |
| Configuration / trusted policy sources | Read versioned sources and return immutable revisions plus trust provenance | Repository text cannot designate itself as enforced organization policy |
| Resolver and validator | Resolve field precedence, schema, managed scope, prerequisites, workflow/cost/recovery feasibility | Pure decisions from recorded inputs; no mutation during validation |
| Component registry | Supply bundled schemas, dependencies, semantic operations, cost/reversal/backup requirements | Declarative configuration never loads arbitrary executable components |
| Planner | Compute minimal deterministic operation graph and stable sequential ordering | Freezes generated content and includes delivery/configuration dependencies |
| Approval port/service | Render final plan and collect authenticated host/user decisions | Approval evidence comes from a trusted interaction channel, never configuration text |
| GitHub provider port | Read and apply semantic resource actions with preconditions and evidence | Declares conditional-write, identity, backup, signing, and verification limitations |
| Git/workspace port | Inspect refs/worktree, prepare approved patch, create compliant commits, push/PR/merge as separately planned | Preserves unrelated work; reports actual commit and delivery evidence |
| Credential port | Resolve protected credentials or established provider session references | No secret returned to the frontend, plan, audit, or shared configuration |
| Financial evidence port | Classify entitlements and foreseeable usage effects with sources/time/uncertainty | Unknown costs cannot become “free” through fallback or defaulting |
| State and artifact ports | Persist drafts, plan bodies, frozen content and checkpoints atomically | Failed or incomplete writes cannot be treated as durable preparation |
| Lock port | Exclusively claim conflicting resource/source/workspace keys across local processes | Inability to establish exclusion blocks conflicting execution |
| Audit port | Append durable ordered sanitized intent and outcome events; detect incomplete tail | No mutation without durable intent; missing outcome triggers reconciliation |
| Snapshot/recovery port | Capture coverage, pin dependencies, browse expiry, construct selective reversal evidence | Storage limits cannot silently drop required coverage |
| Harness/UI port | Discover supported interaction modes and carry semantic requests/results | UI switches preserve draft identity and revision |

Read, plan, preview, validation, retries, no-op, backup, manual guidance, verification, and recovery actions are audited as application operations. Logging its own writes is not recursive. If logging fails, normal workflows stop; narrowly necessary read-only diagnostics are visibly identified as unjournaled.

## 5. Configuration ownership and resolution

Shared version-controlled YAML owns resource definitions, explicit field management, selected profile/policies, and shared workflow rules. Local execution configuration owns selected directories, machine-specific delivery/storage preferences, and protected state locations. Persistent operational state owns attempts, snapshots, approvals, delivery progress, and observed applied revisions. These records are neither desired configuration nor authoritative approvals when copied into repository text.

Each mutation field distinguishes **unmanaged/omitted**, **managed value**, and **explicit reset/removal**. A removal requires an explicit supported operation and review; omission never implies deletion. Unknown mutation fields and unsupported document versions are errors. A component cannot broaden management scope as an incidental prerequisite; required scope changes appear in the plan.

Resolution follows the approved precedence: GitHub restrictions, plugin-enforced organization policy from a designated trusted source, explicit repository configuration, organization advisory policy, then selected profile defaults. Product defaults fill remaining eligible choices. Existing repository conventions constrain execution until an explicit migration is approved; the precedence algorithm must not erase discovered requirements simply because a user selected a new strategy. Conflicting evidence requires resolution instead of guessing from branch names.

Each resolved field retains its winning source and revision, overridden recommendation where useful, and constraining policies. The UI can therefore explain both the requested value and why an effective value or validation conflict exists.

Personal repositories default to repository-local configuration; organization repositories default to a configured central GitOps repository. Either can be explicitly selected. The binding identifies the exact authoritative reference. A missing central source blocks its dependent workflow and prompts source resolution; it does not authorize creation of a central repository or a competing local source.

Changing shared configuration is itself governed code delivery. When central configuration and target resources both change, the plan contains separate resource bindings and workflow obligations for each repository. Target execution depends on the approved revision reaching its authoritative reference. An unmerged PR/local commit is only pending delivery when authority is remote. An explicitly selected committed local source can be authoritative, with that distinction displayed. Partial success in one repository remains visible; coordination is sequential, not transactional.

Bundled MVP components are `repository.basic`, `repository.local`, `repository.readme`, `repository.license`, `repository.gitignore`, `repository.issue-templates`, `repository.pr-template`, `repository.rulesets`, and `repository.workflow`. Workflow owns desired conventions and merge/review behavior; rulesets owns applicable remote enforcement translation. A single semantic setting has one owner, with mapped enforcement operations, so two components cannot issue competing writes. The preview labels each rule as GitHub-enforced, plugin-only, or unsupported.

## 6. Provider discovery, identity, and fallback

Discovery is scoped to the host, actor, owner/resource, operation, and its required guarantees. A provider inventory is evidence, not a static list of brand names. Installed tools and successful authentication do not establish all required capabilities.

Selection first tests the official GitHub MCP integration. Native harness facilities are reused where appropriate; an Octokit adapter covers suitable programmatic gaps. An operation is eligible only if it can satisfy the approved identity, permissions, required concurrency guarantees or disclosed limitations, backup coverage, signing/workflow rules, cost gates, and observable postconditions. Preference never overrides eligibility. The architecture does not claim that any current transport exposes a particular tool.

The selected provider instance and host/principal binding are frozen into each operation. All providers participating in a resource's plan must resolve to the approved actor and stable target. CLI credential reuse applies only to compatible adapters. Host-managed MCP/native sessions keep their own authentication and are independently checked. A principal mismatch is surfaced before approval, not repaired by silently copying credentials or switching accounts.

Immediately before dispatch, revalidate relevant identity and capability facts. A material provider/account change creates a revised plan; the executor cannot improvise fallback after approval. Credential refresh that preserves the approved identity and semantics need not itself change the plan, but evidence must establish that preservation.

Guided browser fallback is an explicit manual operation with an approved target page/action, pre-change snapshot, cost/reversal disclosures, and verification method. The user controls sensitive interaction. Guidance begins only after durable intent and required backup. Session identity must be established sufficiently to bind the action; inability to establish it blocks the step. User-reported completion is stored separately from independent verification. Unobservable results remain pending verification. Failed guidance offers manual completion/replanning; comprehensive browser automation is not an MVP dependency.

## 7. Immutable plans and authorization

The planner builds a dependency graph and produces one stable sequential order. The semantic fingerprint covers resolved configuration and source revisions, managed scope, resource/actor/provider bindings, frozen file contents or verified immutable content digests, base revisions, operations and parameters, intended stopping stages, relevant state/enforcement preconditions, executable checks, backup coverage, and cost/reversal disclosures. Canonical representation is proposed so equivalent semantic inputs yield equivalent fingerprints; timestamps and run IDs remain execution metadata.

An approval references this fingerprint. Content-addressed references are useful only if their bytes remain available and match before dispatch; a missing artifact blocks execution, and regenerated content requires a new plan. Approval is not inferred from a natural-language task, profile selection, configuration file, or previous similar plan.

The authorization ledger keeps separate decisions for ordinary execution, operation-specific sensitive effects, paid/usage-bearing actions with informed consent, and irreversible portions/retention loss. The preview collects all applicable decisions without collapsing them into a generic confirmation. Repository deletion is not added to MVP merely because destructive-operation semantics are defined.

Each operation has relevant read dependencies and an expected state after earlier approved steps. Revalidation compares against that expected state, so the plan's own repository creation or preceding settings change does not invalidate its remaining work. External changes to relevant managed state, Git bases, sources, actor, enforcement, financial implications, or recovery assumptions invalidate affected execution. Unrelated unmanaged changes do not automatically invalidate approval.

Where supported, conditional writes carry the checked revision/precondition into dispatch. Where unavailable, the preview discloses the race window and immediate verification is mandatory. This does not claim atomic safety against other GitHub actors. A provider that cannot meet a required guarantee is ineligible; disclosure cannot waive enforced policy.

## 8. Sequential execution, locking, and durability

Execution acquires local process-independent locks for the conflicting resource identities, authoritative configuration sources, and affected workspace destinations. Before creation, host/owner/name provides the provisional resource key; after creation, the stable ID is bound without releasing protection over that identity transition. For multi-resource plans, a stable lock ordering prevents local deadlocks. Waiting for review, user guidance, or external checks releases execution locks after checkpointing; resume reacquires them and revalidates. Locks do not serialize external GitHub users.

Lock ownership includes process/run evidence. An apparently stale lock cannot be reclaimed solely because time elapsed; recovery verifies that its owner is no longer active and reconciles any in-flight intent before mutation. The exact OS-backed primitive is an implementation choice, but it must prevent two local processes from concurrently owning the same execution boundary. Unsupported filesystem/locking environments are reported rather than silently weakening this property.

The proposed durable mutation protocol is:

1. Acquire the relevant locks; load and validate plan, authorizations, state, identity, permissions, and current preconditions.
2. Capture and durably persist required settings/file evidence, coverage metadata, and active recovery references. Revalidate a reused snapshot against the current pre-change state.
3. Durably append the operation intent with plan fingerprint, attempt identity, snapshot references, and dispatch preconditions. Only after both backup and intent succeed may dispatch begin.
4. Dispatch once. Persist returned evidence and read back the operation's postcondition; append outcome and update the checkpoint.
5. Proceed only after the outcome is durably recorded and its required evidence is satisfactory. Stop on failure or uncertainty.

Snapshots, frozen artifacts, and checkpoints use atomic replacement and platform-appropriate durability guarantees. The audit journal uses ordered durable appends, detectable record boundaries, and recovery that preserves incomplete-tail evidence. Correlation IDs connect journal and state. A crash between stores cannot create a false success: the journal and external observations reconcile checkpoints, rather than trusting whichever file was written last.

A snapshot saved without an intent is harmless unused recovery evidence. An intent without an outcome is uncertain, whether a checkpoint says dispatched or not. An outcome saved without a checkpoint can reconstruct progress. If post-dispatch outcome logging fails, no further mutations run. Audit-capacity failure and snapshot-capacity failure are separate surfaced conditions.

Retries are bounded and honor rate-limit instructions. A retry is eligible only when the action was definitely not applied, or reconciliation and the action's idempotency contract make repetition safe. Repository creation does not gain idempotency from a matching name. Saved remote IDs, request evidence, commit IDs, and PR references identify already completed work.

Cancellation stops scheduling new mutations. A dispatched request may still finish; interruption records uncertainty and preserves backups and intent. Resume inspects actual state before continuing, including verifying whether an unrecorded commit/push/PR already exists. No cancellation or downstream failure triggers automatic repository deletion or rollback.

## 9. Git bootstrap, workflow, and delivery

Workflow resolution discovers repository contribution rules, protections, organization constraints, existing conventions, signing/sign-off requirements, checks, and local execution capabilities. Existing rules are data to validate, not permission to execute repository-supplied commands.

The workflow schema exposes all approved choices:

| Setting family | Configurable behavior |
|---|---|
| Commit convention | Conventional Commits default or bounded custom validation; allowed types/scopes |
| Branch strategy | Git Flow default, GitHub Flow, trunk-based, or custom routing with sufficient explicit rules |
| Branch detail | Primary/development branch names and feature/release/hotfix prefixes |
| Merge/review | Permitted merge methods, PR-title convention, required approvals, post-merge branch deletion |
| Signing/sign-off | Requirements, authorized contributor identity/attestation, available trusted signing mechanism |
| Delivery | Local commit only, push working branch, or open PR; explicit merge authorization if planned |

Shared conventions persist in desired configuration; machine-specific delivery preferences persist in execution configuration. Effective rules can constrain those preferences. Defaults are presented for confirmation on new repositories. Existing rules are preserved until a separately previewed migration describes affected files/branches and reversal limits. Custom data cannot contain arbitrary executable validation scripts.

An empty repository plan chooses exactly one initial-history path: remote initialization followed by clone, or an empty remote with one compliant local root history. It orders the initial commit, primary/development branches where applicable, default branch, and protections around actual prerequisites. Organization restrictions remain active throughout. An impossible first commit, unsatisfiable check, or missing signing capability blocks bootstrap; temporary protection bypasses are not a recovery strategy. No required check is represented as supplied merely by naming it.

Post-creation content changes, including newly generated assets and plugin configuration, require compliant commits. The plan freezes affected files/patches, base/target/working branch, author/committer, proposed messages, executable checks and hooks, sign-off/signing evidence, and review path. It isolates approved changes from unrelated work where feasible and never stages unrelated local content. Hooks/checks/signing tools need explicit planned authorization or existing execution policy before invocation. Required checks must be honored; advanced CI authoring stays deferred.

File writing and commit creation form a recoverable operation with sub-checkpoints. A failure preserves approved patch evidence and identifies uncommitted plugin changes. Successful completion requires locating and verifying the compliant commit, including on restart after an unrecorded success. An API file write must meet the same rules; remote writes cannot satisfy a local-only plan.

Delivery verification is stage-specific: a local commit proves local delivery; a push proves the selected branch update; a PR proves submission with the correct head/base; merge proves the target update. Pending delivery records suppress duplicate commits and PRs when target-branch drift is expected. Settings that depend on delivered configuration/files wait for their required stage, not merely local commit existence.

A planned merge rechecks exact approved head, required reviews/checks, permitted method, resulting commit-message/sign-off/signature requirements, and cost before dispatch. Squash/rebase/merge cannot be assumed to preserve those properties. Incompatible methods leave delivery pending or require a revised compliant plan. Branch deletion after merge is a planned operation subject to approvals, backup/recovery limits, and rules. Codebase reversal normally creates a revert commit through the same workflow; it does not rewrite shared history.

## 10. Financial preflight

Cost classification runs for every mutation plan and every fallback, including ordinary pushes or merges that can trigger existing automation. It evaluates both newly enabled entitlements and foreseeable usage effects. Classification is one of: no additional charge established; existing entitlement with possible usage charges; additional paid entitlement; or unresolved exposure.

Each cost-bearing action links to evidence source/time, billing owner, action/trigger, disclosed cost basis or limits, and remaining uncertainty. The financial authorization is tied to that disclosure and the plan. A profile, organization policy, standard plan approval, or vague acceptance of unspecified risk cannot supply it.

When evidence does not permit a bounded informed decision, the action is blocked. Independent unaffected steps may only execute if they remain valid parts of the approved plan and dependencies; a blocked paid step is never reported as applied. A material change in actions or disclosed implications invalidates financial authorization. The system neither promises an exact future bill nor enforces spending caps; advanced estimates/policies remain deferred.

## 11. Backup, retention, reversal, and recovery

Before each repository mutation, snapshots capture visible settings, all readable affected prior values, applicable rules, identity, observation time, concurrency evidence, and explicit coverage limitations. Creation captures prior absence; subsequent configuration captures the new repository's initial settings. Git base revisions and affected-file evidence supplement settings backups. Git object retention must be sufficient for the advertised recovery option, rather than assuming an object ID guarantees future availability.

Write-only, unreadable, secret, or otherwise non-restorable values are not silently represented as saved. An affected uncapturable value stops execution until a revised plan discloses the limitation and obtains required approval. Secret exclusion still applies; backup requirements never authorize copying credentials. Internal audit/snapshot writes do not recursively require backups, while backup and retention actions are audited.

Retention policies and storage limits are configurable; this architecture invents no numeric default. The restore browser presents snapshot coverage, expiry, retained file/Git evidence, current dependencies, availability, and partial/irreversible limitations. Capacity calculations include backup metadata and required artifacts; audit capacity is exposed separately. Active/unresolved recovery dependencies pin their evidence even if a general age rule would expire it. If limits cannot accommodate required evidence, mutation blocks for storage/retention resolution.

Choosing a policy that expires recovery options requires informed acknowledgment of future irreversible loss. Pruning within that approved policy may proceed without repeated confirmation, but records the event and immediately removes the restoration claim. Later reductions or exceptional deletion require renewed acknowledgment. Pruning snapshots cannot silently prune the append-only audit. Retained audit records may point to explicitly expired artifacts and do not promise indefinite restoration.

Recovery offers reconciliation, resume, or user-invoked reversal. A restore request reads the chosen snapshot and compares current state with recorded post-change state. It constructs a new selective plan for captured managed fields and file changes, preserving intervening edits and surfacing conflicts. It may order reversals opposite original dependencies. The restore plan has its own permissions, cost checks, backup, consent, audit, and verification.

A restore also previews whether authoritative desired configuration will change through its workflow or whether explicit reported drift remains. The plugin must not silently reconcile back over the user's restore. Restore readiness is checked at selection and dispatch because permissions, rules, providers, and retained evidence can change. Partially reversible effects—such as notifications, prior information exposure, usage charges, or published history—remain disclosed even if current settings can be restored.

## 12. Security and trust boundaries

| Boundary / threat | Architectural control | Residual limit |
|---|---|---|
| Repository/provider/browser text attempts to instruct the agent | Treat as untrusted data; bounded parsing, schema validation, trusted approval channel | User may still explicitly choose new actions through a new plan |
| Repository config claims organization authority | Designated trusted policy source and recorded revisions | Authority provisioning must be explicitly configured |
| Credential/session leakage | Credential adapter isolation; sanitized structured events; no secrets in UI, plans, config, snapshots, or temporary artifacts | Secret exclusion limits restoration coverage for some fields |
| Cross-account provider substitution | Host/principal/resource binding checked per provider and before dispatch | Unverifiable identity blocks the affected operation |
| Local traversal, symlinks, or existing-content overwrite | Canonical approved path boundaries, symlink-safe mutation checks, collision detection, preserved destination contents | Concurrent external filesystem edits require revalidation/conflict handling |
| Command/configuration injection | Structured arguments and bounded declarative rules; no arbitrary command strings from configuration | Hooks/checks/tools are separate authorized execution boundaries |
| Browser cross-origin mutation | Loopback binding, short-lived session credentials, expected host/origin validation, cross-site request protection | Local browser UI is not a remote administration service |
| Two local executors or external edits | Resource locks plus relevant precondition checks and conditional writes where available | Local locks cannot prevent external actors; unsupported atomic writes are disclosed |
| Local state tampering or disk exhaustion | Restrictive access, durable records, validation of artifacts, capacity checks, fail-closed mutation gates | Append-only journal is not tamper-proof against machine owner |

Required signing uses a discovered trusted mechanism and verifies commit evidence; the product does not implicitly create/replace keys. Sign-off requires authorized identity and contributor attestation, not an invented footer. A lack of capability blocks the affected commit or merge. Logging and backups contain sanitized summaries/evidence references, not raw transport payloads.

## 13. UI and harness adapters

Embedded MCP Apps is preferred only when supported at runtime. Local browser and universal conversation use the same draft, validation, plan, approval, execution, and report APIs. A simple conversational single-field change need not open a form. Codex is the first distribution; other thin adapters demonstrate portability without implying simultaneous host feature parity.

Schemas drive recommended/custom values, dependencies, required/optional fields, cost context, validation, profiles, and advanced settings. Separate presentation metadata can explain values without changing semantic validation. The application owns validation regardless of frontend checks. Draft revisions prevent stale form submissions from overwriting newer conversational edits; a conflict preserves both user inputs for resolution instead of losing the draft. This is local mode consistency, not deferred collaborative editing.

A semantic interaction follows `request -> schema -> draft -> validate -> preview -> approve -> execute -> verify/report`. Final preview includes source provenance, managed scope, provider/actor, files and workflow, costs, backups, reversal limits, and stage-specific outcomes. Ordinary approval, sensitive confirmation, financial consent, and irreversible-loss acknowledgment remain visibly distinct.

Reports distinguish no-op, verified success, local delivery, pending review/checks, blocked cost/permission/capability, uncertain outcome, remaining drift, and available recovery actions. Recovery browsing is the basic MVP restore interface, not an advanced dashboard. Host adapters may render differently but cannot hide required disclosures or bypass gates.

## 14. Logical packaging and deployment

**User amendment 2026-10-19 — MVP delivery:** The MVP is installed/deployed locally and distributed as a GitHub release artifact only. Marketplace submission/publication and its credentials are excluded. This project’s own source merges through `develop` into `main` only; `feature/**`, `chore/*`, and `doc/*` target `develop`. Release notes derive from the appended, committed version changelog. These operating constraints do not alter the core’s configurable Git Flow/custom strategy support.

TypeScript and npm workspaces remain the recorded implementation direction. The following are proposed logical boundaries, not created packages, dependencies, or scaffolding:

| Logical unit | Contents | Dependency rule |
|---|---|---|
| Domain/contracts | Resource/configuration/workflow models, invariants, semantic ports | No host, filesystem, provider SDK, or UI imports |
| Application | Resolution, validation, planning, approvals, execution, verification, recovery | Depends on domain/contracts and injected ports |
| Bundled components | MVP schemas and semantic component definitions | Trusted distribution; no runtime third-party loading |
| Provider adapters | Official MCP, native tools, Octokit, guided-browser mediation | Translate capabilities/results without changing domain policy |
| Local adapters | Git, protected persistence, audit, locks, credentials, loopback UI backend | Enforce local security/durability contracts |
| Presentation/harness adapters | Codex plugin, shared forms, conversation, future thin CLI/MCP/other-host surfaces | Invoke application operations; no independent mutation engine |
| Composition/runtime | Version-compatible adapter wiring and runtime capability inventory | Owns platform-specific startup and shutdown |

A local process hosts the core and adapters; embedded or local-browser frontends communicate through the harness/application boundary. Operational storage remains local and protected, separate from versioned shared YAML. This is a logical deployment view, not a selection of a particular process protocol or frontend library. Version checks protect schemas and stored state before execution; compatibility migrations must preserve evidence and cannot silently reinterpret approvals.

Remote execution, distributed locking, database-backed persistence, centralized audit, GitHub Apps/OAuth, additional source-control platforms, and external module distribution are extension seams only. Installation, configuration, troubleshooting, and extension documentation remain release deliverables; this architecture is not a claim that they or the software already exist.

## 15. Verification and acceptance traceability

The table maps every acceptance area in specification §12 to architectural responsibility and meaningful release evidence. These are verification obligations, not a sequenced implementation plan or authorization to run live tests.

| Source acceptance area | Architecture coverage | Required evidence |
|---|---|---|
| Creation | §§3, 6, 8–9 | Authorized personal/org creation; stable identity; unexpected collision blocks adoption |
| Configuration | §§4–5, 7 | Deterministic precedence, provenance, trusted policy, unknown-field rejection |
| Local operations | §§8–9, 12 | Chosen destination preserved; coherent single history; valid clone/bootstrap |
| Basic assets | §§5, 7, 9 | All five asset types frozen in preview and delivered in compliant commits |
| Rulesets | §§5–6, 9–10 | Applicable policies applied; unsupported permissions/entitlements explicit |
| Ongoing lifecycle | §§5, 7–8 | Managed updates preserve unmanaged fields and distinguish explicit reset |
| Planning/approval | §§3, 7–8 | Applied bytes/actions match plan; relevant stale facts invalidate; expected predecessor changes do not |
| Idempotency | §§3, 8–9 | Second unchanged run produces no redundant settings writes, commits, or PRs, including pending delivery |
| Recovery | §§8, 11 | Reconcile interrupted/uncertain writes without duplication or destructive cleanup |
| Reversal | §§7, 11 | Selective restore preserves intervening edits and acknowledges irreversible portions |
| Backups | §§8, 11 | Durable pre-change evidence; prior absence on creation; storage failure blocks dispatch |
| Audit | §§4, 8, 11–12 | Sanitized records for every operation category; intent failure blocks; missing outcome reconciles |
| Workflow selection | §§5, 9, 13 | Defaults and alternatives selectable/persisted; custom rules bounded and sufficient |
| Workflow preservation | §§5, 9 | Existing conventions constrain execution; migration separately previewed |
| Repository workflow | §§6, 9 | Correct branches/messages/checks/signatures; no API/direct-write bypass |
| Codebase reversal | §§9, 11 | Compliant revert commit preserves unrelated work/shared history |
| Workflow controls | §§5, 9, 13 | Branch names/prefixes, types/scopes, merges/reviews, signing/sign-offs, and delivery honored |
| Recovery controls | §§8, 11, 13 | Retention choices, expiry/coverage browser, pinned dependencies, capacity blocking, prune acknowledgment |
| Authorization | §§6–8, 12 | Actor mismatch, missing permission, sensitive confirmation failure block affected mutations |
| Financial safety | §§7, 10 | Explicit evidence/consent for entitlements and usage triggers; unresolved exposure blocked |
| Verification | §§3–4, 8–9, 13 | Stage-specific read-back distinguishes success, pending, blocked, and drift |
| UI | §§3, 13 | Draft survives validation/mode changes; embedded capability fallback; distinct consent categories |
| Security | §§6–8, 12 | No secrets in persisted/UI data; path escape and untrusted instructions cannot gain execution authority |
| Portability | §§2, 4, 14 | Domain/application tested through substitute ports without Codex APIs |
| Documentation | §§14, 17 | Release documentation covers install/configuration/troubleshooting/extension contracts |

Unit evidence covers deterministic rules and planning; shared contract suites exercise every adapter's capability, identity, result, and failure semantics. Local fault-injection integration evidence covers disk-full, incomplete journal/snapshot writes, simultaneous local processes, cancellation during dispatch, and crashes between file write/commit, commit/push, and push/PR. Provider contract cases include inability to honor signing/concurrency, unavailable checks, and observable versus unobservable manual results.

Workflow integration evidence includes empty-repository bootstrap under enforced rules, central-source delivery lag, local-only completion with dependent remote settings pending, all three delivery choices, exact-head merge revalidation, and squash/rebase/signature compatibility. Recovery evidence includes external changes after snapshot, expired snapshots, active-evidence retention, restore-induced drift, and insufficient capacity. End-to-end evidence exercises natural-language and form selection, final-plan approval, mode transitions, and complete reporting.

Real GitHub integration tests are opt-in and use dedicated disposable resources, never production repositories by default. Automate without paid services where possible. This architecture task creates no test resources and reports no software tests as passed.

## 16. ADR alignment and unresolved inputs

The source ADRs remain authoritative; this architecture elaborates them without replacing them.

| Source ADR | Architectural realization |
|---|---|
| 001 — Portable hexagonal core | §§2, 4, 14: inward dependencies and semantic ports |
| 002 — Provider preference | §6: capability/identity eligibility before preference |
| 003 — Guided fallback | §§6, 8, 13: supervised planned steps with durable evidence |
| 004 — Declarative components/scope | §5: explicit field intent and single setting ownership |
| 005 — Governance | §§5, 12: trusted policy provenance and enforced precedence |
| 006 — Cost and separate consent | §§7, 10: evidence-linked authorization and blocking uncertainty |
| 007 — Immutable plans | §§3, 7: frozen semantics, fingerprint, relevant-state validation |
| 008 — Local persistence/audit | §§8, 11–12: durable correlated records and local limits |
| 009 — Hybrid GitOps | §5: explicit authority/revision and separate repository delivery |
| 010 — Adaptive UI | §13: shared drafts, runtime capabilities, common services |
| 011 — Sequential resumable execution | §§3, 8: checkpoints, reconciliation, no automatic destructive rollback |
| 012 — Bounded lifecycle MVP | §§1, 5, 14: approved components and deferred extension seams |
| 013 — Reversal and disclosure | §§7, 11: selective reversal with distinct acknowledgment |
| 014 — Audit/backups | §§4, 8, 11: all-operation events and mandatory preparation |
| 015 — Repository-governed commits | §9: compliant content delivery and reversal |
| 016 — Selectable conventions/defaults | §§5, 9: preserved existing rules and confirmed defaults |
| 017 — Workflow/recovery controls | §§9, 11, 13: all five refinements remain MVP |

No new major product choice is required to read this architecture. The user approved the mechanisms in §1 with this architecture on 2026-10-19. Exact storage encoding, lock primitive, package names, frontend technology, and adapter-specific mappings remain implementation design choices constrained by these contracts; no unsupported concrete SDK capability is assumed.

The project's owner and license remain future repository-checkpoint inputs. The proposed project identity remains `github-workspace-manager`, initially private, default branch `main`, with TypeScript/npm workspaces. Per-repository workflow details, signing identities/mechanisms, delivery preference, configuration-source authority, and retention/storage values must be collected and validated in actual workflows. This document does not invent keys, numeric retention defaults, an owner, a license, or a default merge authorization.

## 17. Architecture review record and next gate

This document was checked against specification §§2–12 and §16 for MVP coverage, against all 25 acceptance areas and the cross-cutting failure cases in §12, and against ADRs 001–017. Particular consistency checks cover expected versus external state changes, source-authority versus pending GitOps delivery, local delivery versus target application, finite snapshot retention versus persistent audit, and restoration versus subsequent reconciliation.

The user approved both this architecture and the specification on 2026-10-19 and authorized Superpowers implementation planning. Planning follows the project model policy in `docs/project-model-policy.md`: GPT-6 Astra/Medium. Implementation remains gated by written-plan approval and execution-method selection. This approval does not itself authorize code scaffolding, dependency installation, Git initialization/commits, repository creation, or other external resources.

The next authorized stage is a written implementation plan. The remote repository checkpoint still follows architecture and written implementation-plan approval, with execution-method selection and remaining creation inputs resolved before implementation. No implementation plan is embedded here.
