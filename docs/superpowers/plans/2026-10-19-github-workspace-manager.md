# GitHub Workspace Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete approved local-first MVP for safely creating, configuring, delivering, verifying, and recovering GitHub repository changes.

**Architecture:** A portable TypeScript domain and application layer owns configuration, planning, consent, sequential execution, and recovery. Injected provider, Git, persistence, and host adapters supply evidence and execute only approved semantic operations. Conversation, schema forms, browser fallback, and capability-dependent MCP Apps share drafts and application services.

**Tech Stack:** TypeScript, npm workspaces; proposed implementation choices are Node.js 24 LTS, Vitest, YAML parsing with `yaml`, JSON Schema validation with Ajv, Octokit for fallback GitHub transport, React with Vite for forms, and Playwright for browser tests. These libraries are implementation choices, not new product requirements; verify maintained compatible releases and lock exact versions during Task 1 or the first task using an optional adapter. Choose the released MCP TypeScript SDK and MCP Apps SDK bindings only after verifying their supported versions; do not infer stability or package names from v2 documentation.

**Spec:** `docs/superpowers/specs/2026-10-19-github-workspace-manager-design.md` (approved 2026-10-19).

**Architecture reference:** `docs/architecture/2026-10-19-github-workspace-manager-architecture.md` (approved 2026-10-19).

**Status:** Approved by the user on 2026-10-19; subagent-driven execution selected. The repository-creation checkpoint is active. Additional repository governance, Projects, release and review automation are being designed under the user-invoked brainstorming/setup workflow before their execution.

**User amendment 2026-10-19:** Added the explicit MVP delivery constraint and own-repository routing clarification below. Original approval history is preserved; the existing PDF represents the prior approved revision and awaits a refreshed approved export.

## Table of contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [Approval, repository checkpoint, and execution rules](#approval-repository-checkpoint-and-execution-rules)
- [File map and dependency direction](#file-map-and-dependency-direction)
- [Shared contract ledger](#shared-contract-ledger)
- [Task 1: Establish portable records through a deterministic identity slice](#task-1-establish-portable-records-through-a-deterministic-identity-slice)
- [Task 2: Parse versioned configuration and resolve trusted precedence](#task-2-parse-versioned-configuration-and-resolve-trusted-precedence)
- [Task 3: Register all bundled components and freeze basic asset content](#task-3-register-all-bundled-components-and-freeze-basic-asset-content)
- [Task 4: Resolve selectable workflow rules and explicit migrations](#task-4-resolve-selectable-workflow-rules-and-explicit-migrations)
- [Task 5: Persist protected artifacts, state and a recoverable audit journal](#task-5-persist-protected-artifacts-state-and-a-recoverable-audit-journal)
- [Task 6: Serialize conflicting executions across processes](#task-6-serialize-conflicting-executions-across-processes)
- [Task 7: Guard workspace paths, credentials and executable boundaries](#task-7-guard-workspace-paths-credentials-and-executable-boundaries)
- [Task 8: Capture snapshots and enforce acknowledged retention](#task-8-capture-snapshots-and-enforce-acknowledged-retention)
- [Task 9: Discover eligible providers and run reusable adapter contracts](#task-9-discover-eligible-providers-and-run-reusable-adapter-contracts)
- [Task 10: Implement Octokit repository and ruleset mappings](#task-10-implement-octokit-repository-and-ruleset-mappings)
- [Task 11: Classify financial exposure and enforce distinct consent](#task-11-classify-financial-exposure-and-enforce-distinct-consent)
- [Task 12: Build immutable minimal plans with relevant-state preconditions](#task-12-build-immutable-minimal-plans-with-relevant-state-preconditions)
- [Task 13: Execute one prepared mutation with durable verification](#task-13-execute-one-prepared-mutation-with-durable-verification)
- [Task 14: Reconcile uncertain runs, cancellation and bounded retries](#task-14-reconcile-uncertain-runs-cancellation-and-bounded-retries)
- [Task 15: Bootstrap and clone a coherent protected Git history](#task-15-bootstrap-and-clone-a-coherent-protected-git-history)
- [Task 16: Deliver frozen file changes as compliant recoverable commits](#task-16-deliver-frozen-file-changes-as-compliant-recoverable-commits)
- [Task 17: Honor delivery endpoints, required reviews and explicit merge](#task-17-honor-delivery-endpoints-required-reviews-and-explicit-merge)
- [Task 18: Coordinate authoritative GitOps configuration and managed updates](#task-18-coordinate-authoritative-gitops-configuration-and-managed-updates)
- [Task 19: Build selective restoration and compliant codebase reversal](#task-19-build-selective-restoration-and-compliant-codebase-reversal)
- [Task 20: Execute supervised guidance with observable completion](#task-20-execute-supervised-guidance-with-observable-completion)
- [Task 21: Expose shared revisioned drafts and semantic application commands](#task-21-expose-shared-revisioned-drafts-and-semantic-application-commands)
- [Task 22: Build schema forms, preview and protected loopback fallback](#task-22-build-schema-forms-preview-and-protected-loopback-fallback)
- [Task 23: Wire real runtime capabilities, MCP Apps and Codex packaging](#task-23-wire-real-runtime-capabilities-mcp-apps-and-codex-packaging)
- [Task 24: Prove full MVP acceptance and publish operational documentation](#task-24-prove-full-mvp-acceptance-and-publish-operational-documentation)
- [Acceptance and ADR traceability](#acceptance-and-adr-traceability)
- [Primary technical references and execution-time verification](#primary-technical-references-and-execution-time-verification)
- [Self-review and handoff](#self-review-and-handoff)

## Global Constraints

- User amendment 2026-10-19: the MVP is installed/deployed locally and delivered as a GitHub release artifact only. Do not submit or publish to a marketplace or provision marketplace credentials.
- “The MVP runs locally; remote execution is a future extension.”
- “The MVP execution engine is sequential.”
- “The core must not import Codex-specific APIs or depend on a particular MCP host, browser, filesystem implementation, credential mechanism, or GitHub SDK.”
- “Use versioned YAML for desired configuration.”
- “Only explicitly managed settings may be reconciled after approval. Preserve unmanaged values.”
- “No additional paid service may be enabled without explicit informed consent.”
- “Financial authorization is distinct from ordinary plan approval and sensitive-operation confirmation.”
- “Freeze generated content before approval rather than regenerating it during apply.”
- “Credentials, tokens, browser sessions, and secrets must never enter version-controlled configuration, frontend payloads, plans, or audit logs.” Secret exclusion also applies to snapshots and temporary artifacts.
- “Never automatically delete a newly created repository because a subsequent configuration step fails.”
- “Offer Conventional Commits as the default commit standard and Git Flow as the default branching strategy.” Existing/enforced rules remain constraints until an approved migration.
- “A successful file-change operation requires evidence of its compliant commit.”
- “Real GitHub API tests are opt-in and use dedicated test resources, never production repositories by default.”
- “Do not silently prune snapshots that are still advertised as restorable.”
- All nine MVP components and all five refinements in spec §16 are required; the backlog in spec §3 stays deferred, not silently mixed into these tasks.
- No owner, license, retention number, signing key, default merge authorization, provider tool name, or Codex manifest shape is invented by this plan.
- `sources/` and synced `AGENTS.md` are read-only. Work proceeds in the eventual approved repository/worktree, not by turning the synced project mirror into an implementation checkout.

## Review Focus

These additional input/failure classes receive explicit tests in the owning tasks below; this section identifies likely gaps beyond the acceptance table rather than leaving them untested.

1. YAML aliases, duplicate keys, non-finite numbers, and prototype-shaped keys must not expand resource usage or alter field authority (Task 2).
2. Unicode/case variants in host/resource/path identity must not create inconsistent lock keys or overwrite a different destination (Tasks 1, 7).
3. Provider success responses with incomplete or contradictory identity evidence must remain uncertain instead of being accepted as creation success (Tasks 9, 13).
4. Clock changes and crashed process identifier reuse must not expire active snapshots or steal locks based on elapsed time alone (Tasks 6, 8).
5. An expired browser session or stale draft revision during a consent screen must preserve edits and require a fresh trusted decision, never reuse an obsolete approval (Tasks 21, 22).

---

## Approval, repository checkpoint, and execution rules

**User amendment 2026-10-19 — own-repository routing:** Only `develop` may merge into `main`; `feature/**`, `chore/*`, and `doc/*` target only `develop`, with prefixes based on Issue type. The current parent-merge, exact-commit review, and sole-human-merge rules in `docs/project-instructions.md` apply. Release preparation/fixes reach `develop` first; no direct release/hotfix-to-`main` route is permitted. Append and commit the version changelog before tagging; derive deterministic GitHub release notes from it. A `chore/release-*` preparation branch is proposed, not selected. These own-repository rules do not change Task 4’s configurable product strategies.

The execution method is already selected: **Subagent-driven**. The remaining order is mandatory: **approve this written plan → repository creation checkpoint → implementation**; preserve the selected method without asking the user to choose it again. The checkpoint must explicitly tell the user it is time to create the project repository and commit the approved specification, ADR record, backlog, architecture, model policy, custom instructions, and plan. The expected identity is `github-workspace-manager`, description “Portable AI-assisted GitHub provisioning and configuration management”, public per the user’s repository-creation instructions, default branch `main`, TypeScript/npm workspaces. Confirm owner/account/host, destination, license choice or explicitly pending selection before public distribution, and actual repository branch/commit/signing/review rules. Creating the remote still requires the checkpoint's authorization; approval of this plan alone is insufficient.

At that checkpoint, use the repository setup workflow, copy editable approved documents into the selected checkout, materialize ADRs 001–017 from the approved table in `docs/adr/README.md`, and preserve the exact deferred scope in `BACKLOG.md`. Do not silently create a central configuration repository. Establish the selected strategy's implementation branch/worktree before Task 1. If protections make bootstrap impossible, resolve them with the user; never temporarily bypass them. These checkpoint operations precede the tasks and are not hidden scaffolding in this planning turn.

Read `docs/project-instructions.md` and `docs/project-model-policy.md`: planning uses Astra/Medium; implementation uses GPT-6.1 Sol/Medium; architecture review uses Astra/High. Approved architecture is not reopened to retroactively change its drafting model. Self-review uses the same model one effort level higher (Astra/High for planning; Sol/High for implementation), in addition to required independent reviews. Every authored/revised Markdown document needs a linked ToC, and final approved documents need a rendered, visually verified PDF. Task and whole-branch reviewer assignments follow the selected Superpowers workflow; architecture-review policy is not automatically their model policy.

Each task below ends in a focused Conventional Commit **subject to the actual selected repository policy**. Before each commit inspect the approved diff, stage only that task's named files and necessary lockfile changes, honor required signing/sign-off and hooks/check authorization, and use the selected working branch. Example commit messages are defaults, not permission to commit directly to `main`, fabricate attestations, push, or merge. If the eventual policy changes a message or delivery path, record the compliant equivalent. Run the task's focused tests, `npm run typecheck`, and `npm run boundaries` before its review/commit; later broad release tests run in Task 24. Tests default to fakes and temporary local Git repositories, with no network or production credentials.

## File map and dependency direction

All paths below are relative to the approved repository root. Each task lists exact production/test files it owns; create barrel `src/index.ts` exports only as those public contracts become available.

| Workspace / location | Responsibility |
|---|---|
| `packages/domain/src/` | Versioned semantic records, field intent, workflow rules, canonical plan data; no I/O imports |
| `packages/application/src/` | Injected-port services; all normal workflows audited; executor is sole mutation dispatcher |
| `packages/components/src/` | Nine trusted bundled component schemas, dependencies, asset recipes, and ownership mapping |
| `packages/adapters-local/src/` | Protected storage, journal, locks, paths, Git, CLI credential boundary, loopback service |
| `packages/adapters-github/src/` | Official MCP/native bridges, Octokit mapping, guided operations; common provider contract |
| `packages/ui/src/` | Shared schema forms, preview, distinct consent controls, progress and recovery views |
| `packages/runtime/src/` | Composition, CLI/MCP application bindings, supported host discovery |
| `plugins/codex/` | Verified Codex packaging and thin conversational entry points; actual manifest generated only from current verified format |
| `tests/support/`, `tests/contracts/`, `tests/integration/`, `tests/e2e/`, `tests/live/` | Owned typed fixtures, reusable adapter contracts, fault injection, interaction and explicitly opt-in live evidence |
| `docs/`, `scripts/` | Install/configuration/recovery/extension guidance, dependency-boundary checks, release evidence |

Dependency order: domain ← application ← adapters/runtime; components depend on domain and expose declarative definitions to application; UI imports public DTOs only, never provider/credential/Git implementations. Runtime is the composition root. Test support may depend on every contract but production must not import it.

## Shared contract ledger

Task 1 owns `packages/domain/src/records.ts`, `packages/domain/src/ports.ts`, and `tests/support/fixtures.ts`. Later tasks extend only their explicitly named types in focused files and re-export them; they must not invent competing definitions. The following names and signatures are the common seam, not complete implementation bodies. All persisted envelopes use `formatVersion: 1`; reject unsupported versions before use. Use runtime schemas and explicit typed-record↔JSON encoders for data crossing a boundary rather than TypeScript casts. Canonical hashing consumes encoded semantic JSON; record interfaces are not cast unsafely to `Json`. Application schemas validate `StateStore.read<T>` values before trusting them; the generic store is storage, not validation.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Id = string; type Digest = string; type Revision = string; type FieldPath = string;
type FieldIntent = { kind: 'unmanaged' } | { kind: 'value'; value: Json } | { kind: 'reset' };
type Resource = { host: string; owner: string; name: string; remoteId?: Id };
type Actor = { host: string; principalId: Id; login: string };
type Source = { id: Id; kind: 'repository' | 'central' | 'local'; resource?: Resource;
  location: string; ref: string; revision: Revision; authority: 'remote-ref' | 'local-commit';
  trust: 'repository' | 'organization-enforced' | 'organization-advisory' | 'profile' };
type Issue = { code: string; path?: FieldPath; message: string; blocking: boolean };
type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
type Artifact = { digest: Digest; size: number; mediaType: string };
type Coverage = { captured: FieldPath[]; omitted: { path: FieldPath; reason: string }[] };
type Observation = { resource: Resource; actor: Actor; exists: boolean;
  fields: Record<FieldPath, Json>; refs: Record<string, Revision>; permissions: string[];
  enforcement: Json; coverage: Coverage; concurrency: Json; observedAt: string };
type Evidence = { resource: Resource; actor: Actor; requestId?: string;
  commit?: Revision; branch?: string; prId?: Id; head?: Revision;
  observed: Json; artifactRefs: Artifact[] };
type ProviderResult<T> = { kind: 'success'; value: T } | {
  kind: 'unsupported' | 'denied' | 'conflict' | 'rate-limited' | 'unavailable' | 'uncertain';
  dispatched: 'no' | 'yes' | 'unknown'; retryAfterMs?: number; issues: Issue[] };
type Capability = { providerId: Id; family: 'official-mcp' | 'native' | 'octokit' | 'guided';
  actor: Actor; actions: string[]; guarantees: string[]; limitations: string[]; observedAt: string };
type Precondition = { resource: Resource; paths: FieldPath[]; expected: Json;
  afterOperations: Id[]; conditionalToken?: string };
type Cost = { id: Id; classification: 'no-additional-charge-established' | 'existing-usage' |
  'additional-entitlement' | 'unresolved'; billingOwner: string; action: string;
  source: string; observedAt: string; basis: string; limits?: string;
  uncertainty: string; bounded: boolean };
type ConsentCategory = 'plan' | 'sensitive' | 'financial' | 'irreversible';
type DeliveryStage = 'local-commit' | 'branch-push' | 'pull-request' | 'merged';
type ExecutionConfig = {formatVersion:1; destination:string; delivery:DeliveryStage;
  stateDirectory:string; retention:{maxAgeDays:number; maxBytes:number}; auditMaxBytes:number};
type Operation = { id: Id; action: string; resource: Resource; providerId: Id;
  actor: Actor; parameters: Json; artifacts: Artifact[]; dependsOn: Id[];
  preconditions: Precondition[]; postcondition: Json; deliveryStage?: DeliveryStage;
  backupFields: FieldPath[]; reversal: { kind: 'reversible' | 'partial' | 'irreversible';
    method: string; limitations: string[] }; costIds: Id[]; consents: ConsentCategory[] };
type Plan = { formatVersion: 1; fingerprint: Digest; draftId: Id; draftRevision: number;
  sources: Source[]; resolved: Json; execution: ExecutionConfig; operations: Operation[]; costs: Cost[];
  disclosures: Json; issues: Issue[] };
type Decision = { plan: Digest; category: ConsentCategory; operationIds: Id[];
  disclosureDigest: Digest; actor: string; channel: string; decidedAt: string };
type Authorization = Decision & { receiptId: Id };
type Snapshot = { formatVersion: 1; id: Id; plan: Digest; operationId: Id;
  before: Observation; coverage: Coverage; artifacts: Artifact[]; expiresAt?: string;
  pinnedBy: Id[]; after?: Evidence; availability: 'available' | 'expired' | 'missing' };
type Event = { formatVersion: 1; id: Id; sequence: number; at: string;
  category: string; status: string; plan?: Digest; runId?: Id; operationId?: Id;
  resource?: Resource; actor?: Actor; providerId?: Id; summary: Json; refs: Id[] };
type Checkpoint = { operationId: Id; state: 'pending' | 'prepared' | 'dispatched' |
  'verified' | 'no-op' | 'uncertain' | 'blocked' | 'failed'; attemptId: Id;
  snapshotIds: Id[]; evidence?: Evidence; lastEventId?: Id };
type Run = { formatVersion: 1; id: Id; plan: Digest; state: 'ready' | 'running' |
  'verifying' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'pending';
  checkpoints: Checkpoint[]; cancelled: boolean };
type Delivery = { formatVersion: 1; id: Id; plan: Digest; operationId: Id;
  contentDigest: Digest; base: Revision; target: string; workingBranch: string;
  goal: DeliveryStage; stage: 'approved' | 'written' | 'committed' | 'pushed' |
  'pr-open' | 'awaiting-checks-reviews' | 'merged'; evidence?: Evidence };
interface StateStore { read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>; }
interface ArtifactStore { put(bytes: Uint8Array, mediaType: string): Promise<Artifact>;
  get(ref: Artifact): Promise<Uint8Array>; }
interface Audit { append(event: Omit<Event, 'sequence'>): Promise<Event>;
  read(): Promise<readonly Event[]>; }
interface Lease { release(): Promise<void>; }
interface Locks { acquire(keys: readonly string[], runId: Id): Promise<Lease>; }
interface Provider { readonly id: Id; discover(resource: Resource): Promise<Capability>;
  observe(resource: Resource): Promise<ProviderResult<Observation>>;
  dispatch(operation: Operation, signal: AbortSignal): Promise<ProviderResult<Evidence>>; }
interface ConsentChannel { accept(decision: Decision): Promise<Result<Authorization>>; }
interface Clock { now(): string; sleep(ms: number, signal: AbortSignal): Promise<void>; }
```

Task 1 also owns `Fixtures` and exports `createFixtures(): Fixtures`; every test using `f` begins with `const f = createFixtures()`. Factory methods `resource`, `actor`, `observation`, `operation`, `plan`, `snapshot`, `event`, `run`, `delivery` each accept `Partial<T> = {}` and return a valid corresponding record; reference IDs/digests in composites must be recomputed by an explicit `freezeFixturePlan(plan): Plan`, not forged by shallow edits. `FakeProvider` implements `Provider` with `calls: Operation[]`, queued typed responses, controlled observed state, and dispatch barriers. `MemoryState`, `MemoryArtifacts`, `MemoryAudit`, `FakeClock`, and `FakeConsentChannel` implement their ports and support one-shot failure injection. Task 1 implements only the fixture behavior its tests need; the task consuming a failure/barrier extends the same owned fake instead of building a large unused simulation up front. Later tasks extend fixture builders alongside new types. Tests use local fixtures, not undefined global helpers. All test names/assertions below are requirements for executable tests, not claims that tests currently exist or pass. Assertion excerpts use locally arranged results from the immediately described test scenario; implement their arrange/act in the owning test using the listed interfaces and typed fixture builders, not undeclared shared helpers.

## Task 1: Establish portable records through a deterministic identity slice

**Depends on:** approved repository checkpoint.

**Files:** Create root `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/check-boundaries.mjs`, `docs/dependencies.md`; `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/{records,ports,identity,index}.ts`; `tests/support/fixtures.ts`; Test `tests/unit/identity.test.ts`.

**Interfaces:** Produces the ledger above and `resourceKey(resource: Resource): string`, `canonicalDigest(value: Json): Digest`. Canonical hashing is pure deterministic canonical JSON plus a portable SHA-256 implementation isolated behind this function; no Node imports in domain. Numeric JSON excludes non-finite values. Normalize DNS host case and GitHub owner/name case for identity keys while preserving display values; do not normalize arbitrary local filesystem paths as if they were GitHub names.

- [ ] **Step 1:** Write `identity.test.ts`: `expect(resourceKey(f.resource({host:'GITHUB.COM',name:'Repo'}))).toBe(resourceKey(f.resource({host:'github.com',name:'repo'})))`; assert reordered object keys give the same digest, changed values a different digest, unsupported envelope versions and `NaN` fail, and a domain import of a provider SDK is rejected by the boundary checker. Include non-ASCII identity validation without converting visually similar characters into another resource.
- [ ] **Step 2:** Run `npm run test -- tests/unit/identity.test.ts`; expect failure for missing identity functions after installing only the verified root/domain/test dependencies. Establish root scripts `test` = `vitest run`, `typecheck` = `tsc --noEmit`, `boundaries` = `node scripts/check-boundaries.mjs` as part of this useful slice. Inspect actual supported releases/engines and lock them; record findings in `docs/dependencies.md`.
- [ ] **Step 3:** Implement ledger validation, factories and identity functions; workspace/path aliases and strict compiler settings exist only to support these tests. Boundary checker prohibits production test imports and outward domain/application imports.
- [ ] **Step 4:** Run the focused command, typecheck, and boundaries; expect passing identity tests and zero forbidden imports.
- [ ] **Step 5:** Stage the named files plus `docs/dependencies.md`; commit `feat: establish portable resource identity contracts` under the selected repository rules.

## Task 2: Parse versioned configuration and resolve trusted precedence

**Depends on:** 1.

**Files:** Create `packages/domain/src/configuration.ts`, `packages/application/package.json`, `packages/application/tsconfig.json`, `packages/application/src/{configuration,configuration-sources}.ts`, `packages/adapters-local/package.json`, `packages/adapters-local/tsconfig.json`, `packages/adapters-local/src/yaml-source.ts`; Test `tests/unit/configuration.test.ts`.

**Interfaces:** Own `Configuration = {formatVersion:1; resource:Resource; fields:Record<FieldPath,FieldIntent>; components:string[]; source:Source}`, `Resolved = {resource:Resource; fields:Record<FieldPath,{intent:FieldIntent; source:Source; constraints:Json[]}>; sources:Source[]; issues:Issue[]}`. Produce `parseConfiguration(yaml:string, source:Source):Result<Configuration>`, `resolveConfiguration(layers:readonly Configuration[], githubRestrictions:Record<FieldPath,Json>, trustedPolicySourceIds:readonly Id[]):Result<Resolved>` and `selectSource(ownerKind:'personal'|'organization', explicit:Source|undefined, central:Source|undefined):Result<Source>`. Own `ConfigurationSourceReader.read(source:Source):Promise<Result<{source:Source;configuration:Configuration}>>`; implement `yamlSourceReader(readCommitted:(source:Source)=>Promise<{bytes:Uint8Array;revision:Revision}>):ConfigurationSourceReader`. Runtime binds `readCommitted` to exact local Git revision reads or supported provider repository-content reads; verify ref→revision mapping and reject unavailable authority. Source reading returns committed immutable revisions; no config writes here. Validate and encode the ledger-owned `ExecutionConfig` separately from shared configuration; it is frozen in `Plan.execution` by Task 12.

- [ ] **Step 1:** Write tests asserting enforced conflict returns `POLICY_CONFLICT`, repository text claiming organization authority returns `UNTRUSTED_POLICY`, explicit repository > advisory > profile wins with winning revision, omission remains unmanaged, explicit reset remains reset, unknown mutation/version fails, missing central returns `SOURCE_REQUIRED` without a write. Add bounded alias expansion, duplicate keys, prototype-shaped keys, non-finite values and shared-config local-path rejection tests.
Assertion excerpt for the arranged scenario:

```ts
expect(result).toMatchObject({ok:false,issues:[expect.objectContaining({code:'UNTRUSTED_POLICY'})]});
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/configuration.test.ts`; expect missing parser/resolver failures.
- [ ] **Step 3:** Implement strict YAML-to-JSON parsing limits and schema validation, then pure precedence and source choice. Retention/storage values must be positive explicit choices, not invented numeric defaults; machine preferences use `ExecutionConfig` separately.
- [ ] **Step 4:** Repeat focused tests plus common checks; expect no authority escalation, deterministic provenance, and unchanged input layers.
- [ ] **Step 5:** Commit `feat: resolve versioned configuration with trusted provenance`.

## Task 3: Register all bundled components and freeze basic asset content

**Depends on:** 1–2.

**Files:** Create `packages/components/package.json`, `packages/components/tsconfig.json`, `packages/components/src/{registry,schemas,assets,index}.ts`, `packages/components/assets/{licenses.json,gitignore.json}`, `packages/domain/src/components.ts`; Test `tests/unit/components.test.ts`.

**Interfaces:** Own `Component = {id:string; schema:Json; prerequisites:string[]; permissions:string[]; ownedFields:FieldPath[]; actions:string[]; backupFields:FieldPath[]; costTriggers:string[]; reversalLimits:string[]}`, `FileChange = {path:string; beforeDigest?:Digest; after?:Artifact}`. Produce `bundledComponents():readonly Component[]`, `validateComponents(config:Configuration):Issue[]`, `renderAssets(config:Resolved, suppliedText:Record<string,string>, artifacts:ArtifactStore):Promise<Result<FileChange[]>>`. Supplied/generated text is input data; `after` absent means an explicit deletion only.

- [ ] **Step 1:** Assert registry IDs exactly equal the nine spec §6 components; each has prerequisites/permissions/cost/reversal/backup metadata. Assert README, selected license, ignore rules, issue templates and PR template bytes match artifact digests; unmanaged files produce no change; unknown component and traversal filename fail. Assert workflow owns desired merge behavior while rulesets owns enforcement mappings without duplicate semantic ownership.
Assertion excerpt for the arranged scenario:

```ts
expect(bundledComponents().map(c => c.id).sort()).toEqual(['repository.basic','repository.gitignore','repository.issue-templates','repository.license','repository.local','repository.pr-template','repository.readme','repository.rulesets','repository.workflow']);
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/components.test.ts`; expect missing registry/rendering failures.
- [ ] **Step 3:** Implement trusted registry and schema metadata, deterministic basic templates with explicitly selected license/ignore sources and their attribution. Freeze supplied AI prose as exact bytes; core does not call an AI service. Do not add framework scaffolding or CI generation.
- [ ] **Step 4:** Run focused tests/common checks; expect exact-byte evidence for every asset and no incidental management expansion.
- [ ] **Step 5:** Commit `feat: add scoped repository components and frozen assets`.

## Task 4: Resolve selectable workflow rules and explicit migrations

**Depends on:** 2–3.

**Files:** Create `packages/domain/src/workflow.ts`, `packages/application/src/workflow.ts`; Extend `packages/components/src/schemas.ts`, `tests/support/fixtures.ts`; Test `tests/unit/workflow.test.ts`.

**Interfaces:** Own `Workflow = {standard:'conventional'|'custom'; strategy:'git-flow'|'github-flow'|'trunk'|'custom'; primary:string; development?:string; prefixes:{feature:string; release?:string; hotfix?:string}; types:string[]; scopes:string[]; customMessage?:{prefix:string; minLength:number; maxLength:number}; customRoutes?:Record<string,{base:string;target:string;prefix:string}>; mergeMethods:('merge'|'squash'|'rebase')[]; prTitle:'commit-message'|'custom'; customPrTitle?:{prefix:string;maxLength:number}; requiredApprovals:number; requiredChecks:string[]; deleteBranchAfterMerge:boolean; signingRequired:boolean; signOffRequired:boolean}`, `WorkflowEvidence = {existing?:Workflow; enforced:Partial<Workflow>; source:Source; conflicts:Issue[]; availableChecks:string[]; signingAvailable:boolean}`, `EffectiveWorkflow = {rules:Workflow; provenance:Record<string,string>; migrationRequired:boolean; issues:Issue[]}`. Produce `resolveWorkflow(requested:Partial<Workflow>, evidence:WorkflowEvidence, isNew:boolean):Result<EffectiveWorkflow>`, `routeChange(workflow:Workflow, kind:'feature'|'release'|'hotfix', slug:string):Result<{base:string;target:string;workingBranch:string}>`, `validateMessage(message:string, workflow:Workflow):Issue[]`.

- [ ] **Step 1:** Assert eligible new defaults are `conventional`/`git-flow` and require confirmation; existing GitHub Flow is preserved against an unapproved explicit Git Flow choice (`MIGRATION_REQUIRED`); enforced conflict blocks. Assert all four strategies route deterministically, incomplete custom routes fail, conventional types/scopes validate, executable custom strings fail, branch prefix conflicts and unavailable checks are diagnosed. Test all five workflow-control families serialize into the correct shared/execution document.
Assertion excerpt for the arranged scenario:

```ts
expect(result).toMatchObject({ok:false,issues:[expect.objectContaining({code:'MIGRATION_REQUIRED'})]});
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/workflow.test.ts`; expect missing workflow functions.
- [ ] **Step 3:** Implement bounded declarative validation without arbitrary regex/scripts, conservative contribution-rule evidence parsing, source explanations and migration proposals. Branch names are selected configuration, not guessed from defaults or observed branch names alone.
- [ ] **Step 4:** Run focused tests/common checks; expect defaults, alternatives, provenance and migration blocking to pass.
- [ ] **Step 5:** Commit `feat: resolve repository workflow choices and migrations`.

## Task 5: Persist protected artifacts, state and a recoverable audit journal

**Depends on:** 1–2.

**Files:** Create `packages/adapters-local/src/{filesystem,atomic-store,artifact-store,audit-journal}.ts`, `packages/application/src/audited.ts`; Test `tests/contracts/storage.contract.ts`, `tests/integration/storage.test.ts`.

**Interfaces:** Implement `StateStore`, `ArtifactStore`, `Audit`; expose `createAuditJournal(directory:string,fs:FileSystem,locks:Locks):Audit`. Inject the ledger-owned lock port (a test implementation here; Task 6 supplies production cross-process exclusion). Own narrow injectable `FileSystem` methods `read(path):Promise<Uint8Array>`, `writeExclusive(path,bytes,mode):Promise<void>`, `createDirectoryExclusive(path,mode):Promise<void>`, `append(path,bytes):Promise<void>`, `syncFile(path):Promise<void>`, `rename(from,to):Promise<void>`, `syncDirectory(path):Promise<void>`, `stat(path):Promise<{size:number;mode:number;isSymlink:boolean}>`, `list(path):Promise<string[]>`, `remove(path):Promise<void>` (all path/argument types are strings, bytes `Uint8Array`, mode number). Produce `audited<T>(audit:Audit,event:Omit<Event,'sequence'>,action:()=>Promise<T>):Promise<T>`; sanitize event fields before persistence, never serialize arbitrary raw errors/provider payloads.

- [ ] **Step 1:** Storage contract asserts readers see old or complete new value after failures at write/sync/rename; restrictive files/directories; artifact corruption returns `ARTIFACT_MISMATCH`. Journal test asserts monotonic sequences and no discarded incomplete-tail evidence after injected partial append; simultaneous append calls must preserve every event with unique ordered sequences; normal workflows stop if audit unavailable. `expect(serialized).not.toContain(secretCanary)` across state/artifact metadata/events. Explicit diagnostic result must label `unjournaled` when recovery reads are necessary.
Assertion excerpt for the arranged scenario:

```ts
expect(serialized).not.toContain(secretCanary);
expect(await artifacts.get(ref)).toEqual(originalBytes);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/storage.test.ts`; expect missing stores/journal.
- [ ] **Step 3:** Implement atomic replacement and durable append with framed records/checksums, preserving corrupt-tail evidence in protected storage before repair. Acquire a journal-specific lock across reading the current tail, assigning sequence, appending and syncing; tail inspection/repair uses that same lock. Resource-level execution locks do not serialize unrelated runs that share this journal. The filesystem adapter exposes exclusive directory creation for storage/lock ownership and append for framed journal records; append durability still requires `syncFile`, and parent-directory creation is explicit with restrictive permissions. Use platform-verified fsync/permission behavior; unsupported durability environments fail closed and are documented. Reserve separate audit capacity. Logging does not recursively log its own writes.
- [ ] **Step 4:** Run focused tests/common checks and storage contract against memory and filesystem stores; expect injected failures never become successful writes.
- [ ] **Step 5:** Commit `feat: persist durable state artifacts and audit events`.

## Task 6: Serialize conflicting executions across processes

**Depends on:** 1, 5.

**Files:** Create `packages/adapters-local/src/resource-locks.ts`, `packages/application/src/lock-keys.ts`; Extend `packages/adapters-local/src/audit-journal.ts` if needed for production lock wiring; Test `tests/integration/locks.test.ts`, `tests/support/lock-worker.ts`.

**Interfaces:** Implement `Locks.acquire(keys:readonly string[],runId:Id):Promise<Lease>`; produce `planLockKeys(plan:Plan,execution:ExecutionConfig):string[]`. Locks protect provisional and stable identities, authoritative sources, and destinations in sorted order. Lock records bind PID, process-start evidence, run and journal intent.

- [ ] **Step 1:** Spawn two local test workers: assert only one acquires overlapping keys; opposite supplied order cannot deadlock. Assert creation keeps provisional lock while binding stable ID; live owner is never reclaimed after clock advance; PID reuse is not proof of ownership; dead owner with unresolved intent requires reconciliation before mutation. Bind two journal instances to production locks in separate workers; assert concurrent appends for disjoint resources retain all events with unique increasing sequences and a crashed partial append cannot interleave with repair.
Assertion excerpt for the arranged scenario:

```ts
expect(simultaneousOwners).toBe(1);
expect(stolenFromLiveOwner).toBe(false);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/locks.test.ts`; expect missing exclusion behavior.
- [ ] **Step 3:** Implement exclusive-directory locks on explicitly supported local filesystems with restrictive ownership records and verified process liveness/start identity. Reject unsupported/network filesystems; never steal by timeout alone. Release after checkpointed waits and reacquire on resume. Keep dead-owner reconciliation a callback returning `Promise<boolean>` passed to `createLocks(fs:FileSystem, reconcile:(runId:Id)=>Promise<boolean>):Locks`. Journal ownership uses the same exclusion contract, but its dead-owner recovery only validates/preserves the storage tail before releasing ownership; it must not append recursively or acquire resource locks while holding the journal lock. Exercise actual journal/lock composition before this task passes.
- [ ] **Step 4:** Repeat focused tests/common checks; expect actual process exclusion, safe recovery and lease cleanup on errors.
- [ ] **Step 5:** Commit `feat: serialize conflicting local repository runs`.

## Task 7: Guard workspace paths, credentials and executable boundaries

**Depends on:** 1, 5.

**Files:** Create `packages/adapters-local/src/{safe-paths,process-runner,gh-credentials}.ts`, `packages/domain/src/local-execution.ts`; Test `tests/integration/local-security.test.ts`.

**Interfaces:** Own `Command = {executable:string;args:string[];cwd:string;authorizationId:Id}`, `ProcessResult = {exitCode:number;stdout:string;stderr:string}`, `ProcessRunner.run(command:Command):Promise<ProcessResult>`. Produce `resolveApprovedPath(root:string,relative:string):Promise<Result<string>>`; own `CredentialSession.withGitHubToken<T>(host:string, action:(token:string)=>Promise<T>):Promise<T>`. Only the Octokit adapter may receive token callback data; UI and application receive identity/availability evidence.

- [ ] **Step 1:** Assert `../`, symlink swaps, occupied clone destinations, case-insensitive path collisions and Unicode variants cannot escape/overwrite approved boundaries. A config value containing shell syntax remains an argument; unauthorized hook/signing/check executable never launches. Inject a `gh` failure containing a secret canary and assert no logs/frontend/error DTO contains it; verify per-host authentication, not default-host token reuse.
Assertion excerpt for the arranged scenario:

```ts
expect(unauthorizedProcessLaunches).toBe(0);
expect(destinationContentsAfter).toEqual(originalContents);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/local-security.test.ts`; expect missing guards.
- [ ] **Step 3:** Implement canonical ancestor checks and repeat immediately at writes, preserve existing contents, use argv execution without shell expansion, and an allowlisted discovered executable policy tied to plan authorization. Reuse secure `gh` credentials only inside compatible adapter callbacks; never export them to host MCP/native sessions.
- [ ] **Step 4:** Run focused tests/common checks; expect zero unauthorized process launches and no secret canary leakage.
- [ ] **Step 5:** Commit `feat: secure local paths processes and credential access`.

## Task 8: Capture snapshots and enforce acknowledged retention

**Depends on:** 2, 5–7.

**Files:** Create `packages/domain/src/recovery.ts`, `packages/application/src/{snapshots,retention}.ts`, `packages/adapters-local/src/snapshot-store.ts`; Test `tests/integration/snapshots.test.ts`.

**Interfaces:** Own `SnapshotStore = {save(snapshot:Snapshot):Promise<void>;get(id:Id):Promise<Snapshot|undefined>;list():Promise<Snapshot[]>;expire(id:Id):Promise<void>}`, `RetentionDecision = {policyDigest:Digest;authorization:Authorization}`. Produce `captureSnapshot(plan:Plan,operation:Operation,before:Observation,artifacts:Artifact[],store:SnapshotStore):Promise<Result<Snapshot>>`, `pruneSnapshots(config:ExecutionConfig,decision:RetentionDecision,store:SnapshotStore,audit:Audit,clock:Clock):Promise<Result<Id[]>>`. Persist all readable affected settings, applicable rules and file/Git evidence, while omissions remain explicit.

- [ ] **Step 1:** Assert prior absence is captured for creation; missing affected readable values returns `BACKUP_COVERAGE_REQUIRED`; disk-full before durable save permits no dispatch. Capacity includes metadata/artifacts. Pinned active evidence survives expiry and clock jumps; unauthenticated retention reduction returns `ACK_REQUIRED`; approved-policy expiry updates availability and logs without deleting audit. Missing retained Git artifacts revoke restore availability.
Assertion excerpt for the arranged scenario:

```ts
expect(provider.calls).toHaveLength(0);
expect((await store.get(activeSnapshot.id))?.availability).toBe('available');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/snapshots.test.ts`; expect missing capture/retention functions.
- [ ] **Step 3:** Implement preflight capacity reservation, protected atomic snapshots, active pins and finite explicit policies. Initial policy expiry, reductions and exceptional deletion require plan-bound irreversible-loss acknowledgment; regular approved-policy pruning does not ask again. Reused snapshots must match current state. Secret/unreadable values require revised partial-reversal disclosure, never secret capture.
- [ ] **Step 4:** Run focused tests/common checks; expect failed snapshot preparation and inadequate capacity to block, audit retained independently.
- [ ] **Step 5:** Commit `feat: capture recovery snapshots and enforce retention consent`.

## Task 9: Discover eligible providers and run reusable adapter contracts

**Depends on:** 1, 7.

**Files:** Create `packages/application/src/provider-selection.ts`, `packages/adapters-github/package.json`, `packages/adapters-github/tsconfig.json`, `packages/adapters-github/src/{bridge,official-mcp,native}.ts`; Test `tests/contracts/provider.contract.ts`, `tests/unit/provider-selection.test.ts`, `tests/integration/bridges.test.ts`.

**Interfaces:** Own `ProviderBridge = {inventory(resource:Resource):Promise<Capability>;read(resource:Resource):Promise<ProviderResult<Observation>>;invoke(operation:Operation,signal:AbortSignal):Promise<ProviderResult<Evidence>>}`. Produce `selectProvider(operation:Operation,candidates:readonly Capability[],requiredGuarantees:readonly string[]):Result<Capability>`, `officialMcpProvider(id:Id,bridge:ProviderBridge):Provider`, `nativeProvider(id:Id,bridge:ProviderBridge):Provider`. Bridges are injected host bindings, not fabricated official tools.

- [ ] **Step 1:** Assert official MCP wins only when eligible; missing signing/conditional-write/backup guarantee selects an eligible native/Octokit candidate before approval. Mismatched principal/host blocks; undiscovered action is unsupported. Contract asserts every failure distinguishes undispatched versus uncertain, and a claimed success with missing/conflicting stable identity becomes uncertain. Verify token refresh preserving identity differs from account substitution.
Assertion excerpt for the arranged scenario:

```ts
expect(selection.value.providerId).toBe(eligibleNative.id);
expect(mismatchedSelection.ok).toBe(false);
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/provider-selection.test.ts tests/integration/bridges.test.ts`; expect missing selection/adapters.
- [ ] **Step 3:** Implement preference after eligibility, sanitized translations and runtime inventory. Common contract is exported as `providerContract(name:string,create:()=>ProviderContractHarness):void`; own harness `{provider:Provider;queue(result:ProviderResult<Evidence>):void;setObservation(value:Observation):void;calls():Operation[]}`. Run against fake-backed official/native adapters now and Octokit/guided adapters when added.
- [ ] **Step 4:** Run focused tests/common checks; expect all contract branches exercised with no live service.
- [ ] **Step 5:** Commit `feat: select providers by verified identity and guarantees`.

## Task 10: Implement Octokit repository and ruleset mappings

**Depends on:** 3–4, 7, 9.

**Files:** Create `packages/adapters-github/src/{octokit,github-mappings,rulesets}.ts`, `packages/components/src/rulesets.ts`, `docs/provider-support.md`; Test `tests/integration/octokit.test.ts`, `tests/unit/rulesets.test.ts`; Update `docs/dependencies.md`.

**Interfaces:** Produce `octokitProvider(id:Id,credentials:CredentialSession,transport:GitHubTransport):Provider`. Own `GitHubTransport.request(input:{method:string;path:string;headers:Record<string,string>;body?:Json},token:string,signal?:AbortSignal):Promise<{status:number;headers:Record<string,string>;body:Json}>`; SDK binding stays internal. Produce `mapRulesets(workflow:Workflow,desired:Resolved,capability:Capability):Result<Json>` with rule labels `github-enforced`, `plugin-only`, `unsupported` in returned mapping data.

- [ ] **Step 1:** Fixture HTTP tests cover personal/org creation, basic update, ruleset create/update/reset, permission denial, entitlement unavailable, 429/retry guidance, timeout-after-dispatch uncertainty and optimistic conflict. Assert unmanaged settings are omitted from requests, identity is read back, no auto-init when local bootstrap selected, unknown response fields do not become capabilities, PR-title plugin validation is not advertised as repository-wide enforcement. Exercise sanitized entitlement/billing and existing workflow-usage read mappings for Task 11; missing permission or unsupported evidence remains explicitly unknown.
Assertion excerpt for the arranged scenario:

```ts
expect(request.body).not.toHaveProperty('unmanaged_setting');
expect(timeoutResult.kind).toBe('uncertain');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/octokit.test.ts tests/unit/rulesets.test.ts`; expect missing mapping/adapter failures.
- [ ] **Step 3:** Verify current primary GitHub endpoint, ruleset entitlement and conditional-write documentation; record exact endpoint/API-version evidence in `docs/provider-support.md`. Implement supported mutation and financial-evidence read mappings and explicit unsupported results; record each read capability and sanitized observation field consumed by Task 11 in `docs/provider-support.md`. No raw API file-write shortcut: file delivery remains governed by Git/workflow unless the full same contract is demonstrated. Lock a maintained Octokit release now.
- [ ] **Step 4:** Run focused tests, provider contract and common checks; expect every mutation mapped with permission/capability/evidence semantics.
- [ ] **Step 5:** Commit `feat: add GitHub repository and ruleset provider mappings`.

## Task 11: Classify financial exposure and enforce distinct consent

**Depends on:** 1–5, 9–10.

**Files:** Create `packages/application/src/{financial,authorization}.ts`, `packages/domain/src/authorization.ts`, `packages/adapters-github/src/financial-evidence.ts`; Test `tests/unit/authorization.test.ts`.

**Interfaces:** Own `FinancialEvidence.read(operation:Operation):Promise<Cost[]>`; produce `preflightCosts(operations:readonly Operation[],evidence:FinancialEvidence):Promise<Result<Cost[]>>`, `authorizePlan(plan:Plan,decisions:readonly Decision[],channel:ConsentChannel):Promise<Result<Authorization[]>>`, `checkAuthorization(plan:Plan,operation:Operation,authorizations:readonly Authorization[]):Issue[]`. Trusted channel issues local receipts; repository DTOs cannot mint them. The production adapter is `githubFinancialEvidence(provider:Provider, trustedDisclosures:ReadonlyMap<Id,Cost[]>):FinancialEvidence`: read entitlement/billing and foreseeable existing automation facts through discovered read capabilities, combine only explicitly trusted bounded disclosures, and return unresolved exposure when unavailable. Extend provider observation with sanitized entitlement/workflow-usage evidence fields; never infer zero cost from absent read permission. Task 10 owns the actual documented read mappings and Task 11 owns their classification.

- [ ] **Step 1:** Assert ordinary plan consent cannot satisfy sensitive/financial/irreversible requirements. Production-adapter fixtures assert unreadable billing/workflow evidence stays unresolved and trusted bounded disclosures retain source/time/owner. Existing-usage push and additional-entitlement cases require evidence-linked consent; unresolved unbounded exposure returns `COST_UNBOUNDED` even with generic risk acknowledgment. Changing billing owner, action or disclosed basis invalidates financial consent; configuration approval text yields no receipt. Missing permission remains blocked despite consent.
Assertion excerpt for the arranged scenario:

```ts
expect(result).toMatchObject({ok:false,issues:[expect.objectContaining({code:'COST_UNBOUNDED'})]});
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/authorization.test.ts`; expect missing financial/authorization functions.
- [ ] **Step 3:** Implement all four cost classes, source/time/billing-owner/basis/uncertainty capture and category/scope/disclosure checks. Evaluate ordinary writes' foreseeable automation triggers. Do not invent free classifications or claim spend enforcement. Authorization storage uses protected state and audit; decision timestamps alone are not trust evidence.
- [ ] **Step 4:** Run focused tests/common checks; expect unbounded costs blocked and separate receipts retained for each required category.
- [ ] **Step 5:** Commit `feat: require evidence-bound financial and operation consent`.

## Task 12: Build immutable minimal plans with relevant-state preconditions

**Depends on:** 2–4, 8–11.

**Files:** Create `packages/application/src/{planner,preconditions,preview}.ts`, `packages/domain/src/planning.ts`; Test `tests/unit/planner.test.ts`.

**Interfaces:** Own `PlanningInput = {draftId:Id;draftRevision:number;resolved:Resolved;observations:Observation[];workflow:EffectiveWorkflow;files:FileChange[];capabilities:Capability[];costs:Cost[];deliveries:Delivery[];execution:ExecutionConfig}`. Produce `buildPlan(input:PlanningInput):Result<Plan>`, `checkPreconditions(operation:Operation,current:Observation,verified:readonly Checkpoint[]):Issue[]`, `previewPlan(plan:Plan):Json`. Freeze a validated copy of `input.execution` in `Plan.execution`. Canonical semantic fingerprint excludes run timestamps/IDs but includes evidence revisions and all disclosed bindings, including destination, delivery goal, state location, retention and audit capacity. These local fields remain in protected local plan storage, never shared repository YAML; UI DTOs expose only the relevant preview values.

- [ ] **Step 1:** Named test `frozen_plan_ignores_run_metadata_not_semantics`: assert equivalent inputs/order normalize to the same fingerprint, changed bytes/source/base/actor/provider/cost/delivery/destination/retention/storage limits differs. `managed_diff_preserves_unmanaged`: assert only explicit managed changes/reset operations appear. `expected_predecessor_is_not_external_drift`: assert prior planned creation/settings success passes, unrelated field changes pass, managed/base/source/enforcement changes return `STALE_PLAN`. Cycles and conflicting ownership block. Pending approved delivery yields no duplicate commit/PR.
Assertion excerpt for the arranged scenario:

```ts
expect(equivalent.fingerprint).toBe(original.fingerprint);
expect(changedContent.fingerprint).not.toBe(original.fingerprint);
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/planner.test.ts`; expect missing planning behavior.
- [ ] **Step 3:** Implement stable topological ordering with deterministic tie-breaks and stable operation IDs; freeze parameters/artifact hashes, grants/disclosures, stage and recovery obligations. Provider changes after approval require a new plan. Preview all managed-scope, cost, browser, file, actor, workflow, backup and irreversible effects, including explicit limitations where conditional writes are unavailable.
- [ ] **Step 4:** Run focused tests/common checks; expect exact minimal operation lists and fingerprint assertions to pass.
- [ ] **Step 5:** Commit `feat: build immutable scoped execution plans`.

## Task 13: Execute one prepared mutation with durable verification

**Depends on:** 5–12.

**Files:** Create `packages/application/src/{executor,verification,revalidation}.ts`, `packages/domain/src/execution.ts`; Test `tests/integration/executor.test.ts`.

**Interfaces:** Own `ExecutionPorts = {state:StateStore;artifacts:ArtifactStore;audit:Audit;locks:Locks;snapshots:SnapshotStore;providers:ReadonlyMap<Id,Provider>;clock:Clock;revalidation:RevalidationPort}`, `Verification = {status:'verified'|'not-applied'|'conflict'|'pending';evidence?:Evidence;issues:Issue[]}`. Produce `executePlan(plan:Plan,authorizations:readonly Authorization[],execution:ExecutionConfig,ports:ExecutionPorts,signal:AbortSignal):Promise<Run>`, `verifyOperation(operation:Operation,observed:Observation,evidence?:Evidence):Verification`. Verification compares stage-specific observable postconditions; success response alone is insufficient. Both `executePlan` and Task 14's `resumeRun` must reject a supplied `execution` that differs from frozen `plan.execution` before mutation; never silently substitute current preferences for approved settings. Own `RevalidationPort.check(plan:Plan,operation:Operation,verified:readonly Checkpoint[]):Promise<Result<Observation>>`; implement `createRevalidationPort(readSource:(source:Source)=>Promise<Source>, providers:ReadonlyMap<Id,Provider>, financial:FinancialEvidence, artifacts:ArtifactStore):RevalidationPort` in `packages/application/src/revalidation.ts`. This re-reads exact authoritative source revisions, provider actor/capability/permission/enforcement, Git base refs through the Git provider, affected state, cost evidence and frozen artifacts before dispatch. Compare expected predecessor transitions; material changes require a new plan/consents. Runtime provides actual committed-source readers from Task 2 and discovered providers, not a fake-only revalidator.

- [ ] **Step 1:** Assert call order is lock → revalidate → durable snapshot → durable intent → dispatch → read-back → durable outcome → checkpoint. Inject failure at each boundary and assert `provider.calls.length` is zero before prepared or at most one after dispatch; no dependent call follows uncertainty/outcome-log failure. Missing artifact bytes, changed actor/permission, unapproved sensitive effect and insufficient coverage block. Altered destination, delivery goal, retention or storage limits after approval return `STALE_PLAN` with zero dispatch; resume applies the same check. Success response with wrong stable ID remains uncertain; known no-op is audited with no dispatch.
Assertion excerpt for the arranged scenario:

```ts
expect(provider.calls).toHaveLength(0);
expect(run.state).toBe('blocked');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/executor.test.ts`; expect absent executor.
- [ ] **Step 3:** Implement the sole sequential dispatcher, relevant precondition checks, expected creation identity transition and mutation preparation protocol. Persist state transitions with correlation IDs; read-back mismatch remains drift/conflict. Lock and preparation failures stop execution; never report all targets applied because a local-stage operation completed.
- [ ] **Step 4:** Run focused tests/common checks; expect strict ordering and no unauthorized dispatch in all fault cases.
- [ ] **Step 5:** Commit `feat: execute approved mutations with durable preparation`.

## Task 14: Reconcile uncertain runs, cancellation and bounded retries

**Depends on:** 13.

**Files:** Create `packages/application/src/{resume,retry}.ts`; Extend `tests/support/fixtures.ts`; Test `tests/integration/resume.test.ts`.

**Interfaces:** Produce `resumeRun(runId:Id,plan:Plan,authorizations:readonly Authorization[],execution:ExecutionConfig,ports:ExecutionPorts,signal:AbortSignal):Promise<Run>`, `reconcileCheckpoint(checkpoint:Checkpoint,operation:Operation,events:readonly Event[],provider:Provider):Promise<Verification>`. Own `RetryPolicy = {maxAttempts:number;maxDelayMs:number}`; `retryDelay(result:ProviderResult<unknown>,attempt:number,policy:RetryPolicy):Result<number>` never authorizes an uncertain mutation retry by itself. Runtime supplies documented bounded retry values as implementation settings.

- [ ] **Step 1:** Assert orphan snapshot does not imply dispatch, intent without outcome forces observation, durable outcome reconstructs a lost checkpoint. Creation collision with matching name but no correlated stable/request evidence returns `ADOPTION_REQUIRED`; explicit create timeout cannot blindly retry. Cancellation during dispatch records uncertainty and schedules no next operation. Safe undispatched retry obeys rate limit and max attempts; longer server delay leaves pending instead of violating guidance.
Assertion excerpt for the arranged scenario:

```ts
expect(provider.calls.filter(op => op.action === 'repository.create')).toHaveLength(1);
expect(run.state).toBe('pending');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/resume.test.ts`; expect missing reconciliation/resume.
- [ ] **Step 3:** Rebuild progress from journal plus actual state, verify remote/commit/PR identity, reacquire locks and recheck approvals. Reconcile before stale lock recovery. No cleanup deletion or automatic rollback. Preserve dependencies and expose operator resolution for unobservable outcomes.
- [ ] **Step 4:** Run focused tests/common checks; expect each safe retry count bounded and zero duplicated creation or dependent writes after cancellation.
- [ ] **Step 5:** Commit `feat: resume interrupted runs without duplicate mutations`.

## Task 15: Bootstrap and clone a coherent protected Git history

**Depends on:** 4, 7, 10, 12–14.

**Files:** Create `packages/adapters-local/src/{git-workspace,git-inspection,git-provider}.ts`, `packages/application/src/bootstrap.ts`, `packages/domain/src/git.ts`; Test `tests/integration/bootstrap.test.ts`.

**Interfaces:** Own `GitInspection = {root:string;empty:boolean;head?:Revision;refs:Record<string,Revision>;dirtyPaths:string[];hooks:string[];signingAvailable:boolean;identity:{author:string;committer:string}}`; `GitWorkspace.inspect(root:string):Promise<Result<GitInspection>>`, `GitWorkspace.dispatch(operation:Operation,signal:AbortSignal):Promise<ProviderResult<Evidence>>`. Produce `bootstrapOperations(resource:Resource,workflow:EffectiveWorkflow,inspection:GitInspection,mode:'remote-initialized'|'local-root',execution:ExecutionConfig):Result<Operation[]>`. Produce `gitProvider(id:Id,workspace:GitWorkspace,resource:Resource,root:string,actor:Actor):Provider` in `packages/adapters-local/src/git-provider.ts`. Its discovery reports local executable/signing/concurrency capabilities, observe returns local refs/files/workflow evidence in `Observation`, and dispatch routes only approved Git actions through `GitWorkspace`; it uses the same executor gates. File and Git evidence is sanitized without credentials.

- [ ] **Step 1:** Temporary bare-remote tests assert clone into selected empty path and exactly one root history; local-root order is compliant first commit → required branches → default selection → satisfiable protections. Remote-initialized mode clones existing root and never creates unrelated history. Existing destination data stays intact. Enforced initial protection or missing required signing/check blocks with zero bypass commands. Git Flow development/primary names come from approved workflow.
Assertion excerpt for the arranged scenario:

```ts
expect(rootCommitIds).toHaveLength(1);
expect(protectionBypassCommands).toHaveLength(0);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/bootstrap.test.ts`; expect missing Git/bootstrap behavior.
- [ ] **Step 3:** Implement read-only Git discovery and approved bootstrap actions via argv runner, selecting one path explicitly in each plan. Execute no discovered hooks/checks without plan or policy authorization. Remote repository creation records prior absence separately; initial remote settings snapshot precedes subsequent changes.
- [ ] **Step 4:** Run focused tests/common checks; expect one ancestry graph, preserved destination, and no policy bypass.
- [ ] **Step 5:** Commit `feat: bootstrap and clone repositories with coherent history`.

## Task 16: Deliver frozen file changes as compliant recoverable commits

**Depends on:** 3–4, 8, 12–15.

**Files:** Create `packages/application/src/content-delivery.ts`, `packages/adapters-local/src/{git-patch,git-commit,git-signing}.ts`; Test `tests/integration/commits.test.ts`.

**Interfaces:** Own `CommitRequest = {operation:Operation;files:FileChange[];workflow:Workflow;root:string;base:Revision;target:string;workingBranch:string;message:string;author:string;committer:string;signOff?:{identity:string;attestationReceipt:Id};signingMechanism?:string;authorizedExecutables:Command[]}`. Produce `prepareContentDelivery(request:CommitRequest,ports:ExecutionPorts):Promise<Result<Delivery>>`, `verifyCommit(request:CommitRequest,evidence:Evidence,git:GitWorkspace):Promise<Result<Evidence>>`. The executor dispatches the Git provider operation; preparation never commits independently.

- [ ] **Step 1:** Assert only frozen approved paths/bytes are committed on correct base/branch with valid message and author/committer; unrelated tracked/untracked edits survive. Required sign-off without attestation or signing without trusted capability blocks. Verified commit evidence checks signature/message/paths. Crash after file write retains approved patch and reports uncommitted plugin edits; crash after successful unrecorded commit locates that exact commit instead of duplicating. Failed hook/signing never reports success or discards files.
Assertion excerpt for the arranged scenario:

```ts
expect(committedPaths.sort()).toEqual(approvedPaths.sort());
expect(unrelatedContentsAfter).toEqual(unrelatedContentsBefore);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/commits.test.ts`; expect missing delivery/commit behavior.
- [ ] **Step 3:** Use isolated index/workspace staging, content-addressed patch and persisted sub-checkpoints. Include every post-creation content change, including YAML configuration and new files. Validate read-back commit; remote API writes cannot substitute for local-only delivery. Local operational state remains outside repository content.
- [ ] **Step 4:** Run focused tests/common checks; expect exact tree changes, preserved unrelated work, verified commit and safe crash recovery.
- [ ] **Step 5:** Commit `feat: create recoverable workflow-compliant content commits`.

## Task 17: Honor delivery endpoints, required reviews and explicit merge

**Depends on:** 10, 14, 16.

**Files:** Create `packages/application/src/{delivery,merge-policy}.ts`, `packages/adapters-github/src/pull-requests.ts`; Test `tests/integration/delivery.test.ts`.

**Interfaces:** Own `MergeEvidence = {head:Revision;approvals:number;checks:Record<string,'pending'|'success'|'failure'>;method:'merge'|'squash'|'rebase';resultMessage:string;signOffVerified:boolean;signatureVerified:boolean;resultGuarantees:'established'|'unknown'}`. Produce `nextDeliveryOperations(delivery:Delivery,workflow:Workflow,merge:MergeEvidence|undefined,explicitMerge:boolean):Result<Operation[]>`, `checkMerge(operation:Operation,evidence:MergeEvidence,workflow:Workflow):Issue[]`. The local Git provider owns branch push and push read-back; GitHub provider owns PR read/create, merge, and approved remote branch deletion. Planner freezes their distinct provider bindings. Both use common evidence semantics; Octokit is not a Git push transport.

- [ ] **Step 1:** Assert local-commit goal makes no remote calls; branch-push makes no PR; PR goal never merges implicitly. Pending existing delivery reuses commit/branch/PR references on unchanged reconcile. Crash after push/before PR and after PR/before checkpoint recovers without duplication. Changed approved head or pending/failed required check blocks merge. Incompatible squash/rebase sign-off/signature/message behavior blocks; post-merge branch deletion requires its own planned/disclosed operation.
Assertion excerpt for the arranged scenario:

```ts
expect(mergeCalls).toHaveLength(0);
expect(delivery.stage).toBe('pr-open');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/delivery.test.ts`; expect missing delivery advancement.
- [ ] **Step 3:** Implement stage-specific read-back and persisted references, exact-head conditional merge where supported, and mandatory immediate pre-merge checks. Require the selected method/provider to establish resulting message/sign-off/signature guarantees **before** dispatch, otherwise block; verify actual resulting commit evidence afterward as well. Waiting releases locks after checkpoint. If resulting signature/attestation guarantees cannot be established, leave a compliant manual/alternative path pending; never falsely promise preservation.
- [ ] **Step 4:** Run focused tests/common checks and relevant provider contract cases; expect each endpoint complete only for its own stage, target state separately reported.
- [ ] **Step 5:** Commit `feat: honor approved push pull-request and merge stages`.

## Task 18: Coordinate authoritative GitOps configuration and managed updates

**Depends on:** 2, 12–17.

**Files:** Create `packages/application/src/{gitops,drift}.ts`; Test `tests/integration/gitops.test.ts`.

**Interfaces:** Produce `coordinateSourceDelivery(source:Source,configurationDelivery:Delivery,target:Plan):Result<Plan>`, `detectDrift(resolved:Resolved,current:Observation,deliveries:readonly Delivery[]):{managed:FieldPath[];pendingDelivery:FieldPath[];unmanaged:FieldPath[]}`. Source delivery uses the same content/Git/approval interfaces, with separate resource bindings and own workflow.

- [ ] **Step 1:** Assert personal defaults select repository-local and organization defaults require configured central source. A central config local commit/unmerged PR does not advance remote authority or release dependent target settings; reaching exact approved remote revision does. Explicit committed local authority may proceed and is labeled. Missing central source creates neither central remote nor competing local file. Two-repository partial success stays visible; managed update preserves unmanaged values; unchanged second application has zero settings writes/commits/PRs.
Assertion excerpt for the arranged scenario:

```ts
expect(targetProvider.calls).toHaveLength(0);
expect(configurationDelivery.stage).toBe('pr-open');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/gitops.test.ts`; expect missing coordination/drift behavior.
- [ ] **Step 3:** Add source-delivery dependencies and exact revision evidence, stable multi-resource locking, separate snapshots and workflow obligations. Target settings that depend on files wait for their actual required target stage. Resolve existing workflow migrations as distinct approved content/settings plans with visible limitations.
- [ ] **Step 4:** Run focused tests/common checks; expect no premature authority claims or duplicate pending delivery.
- [ ] **Step 5:** Commit `feat: coordinate authoritative configuration delivery and drift`.

## Task 19: Build selective restoration and compliant codebase reversal

**Depends on:** 8, 12–18.

**Files:** Create `packages/application/src/{restore,recovery-browser}.ts`; Test `tests/integration/restore.test.ts`.

**Interfaces:** Own `RestoreRequest = {snapshotId:Id;fields:FieldPath[];filePaths:string[];desiredState:'update-authority'|'leave-reported-drift'}`, `RestorePoint = {snapshot:Snapshot;issues:Issue[];restorableFields:FieldPath[];restorableFiles:string[]}`. Produce `listRestorePoints(store:SnapshotStore,artifacts:ArtifactStore,clock:Clock):Promise<RestorePoint[]>`, `planRestore(request:RestoreRequest,snapshot:Snapshot,current:Observation,input:PlanningInput):Result<Plan>`. Result is a normal plan with new fingerprint and consents, not a privileged executor path.

- [ ] **Step 1:** Assert selection restores only captured managed fields; intervening edits produce `RESTORE_CONFLICT` while unrelated edits survive. Expired/missing Git evidence cannot be advertised as restorable. Reverse dependencies are honored. File reversal creates a new compliant revert commit and preserves history. Restore preview either includes authoritative-config delivery or records intentional drift that subsequent reconcile cannot silently overwrite. Changed permission/rules at dispatch blocks.
Assertion excerpt for the arranged scenario:

```ts
expect(restoredUnmanagedValue).toEqual(currentUnmanagedValue);
expect(newCommit.parent).toBe(previousHead);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/restore.test.ts`; expect missing restoration planning.
- [ ] **Step 3:** Compare current to recorded post-change evidence, build selective inverse operations with own backup/cost/approval/verification, and pin required artifacts. Persist a drift-resolution marker in state when requested; future reconciliation presents an explicit new plan/choice. Never auto-delete a created repository; partial side effects remain disclosed.
- [ ] **Step 4:** Run focused tests/common checks; expect restored selections and preserved external work, new commit lineage and accurate restore availability.
- [ ] **Step 5:** Commit `feat: plan selective settings and codebase restoration`.

## Task 20: Execute supervised guidance with observable completion

**Depends on:** 9, 11–14.

**Files:** Create `packages/adapters-github/src/guided.ts`, `packages/application/src/guidance.ts`; Test `tests/integration/guidance.test.ts`.

**Interfaces:** Own `Guidance = {operationId:Id;url:string;instructions:string[];actor:Actor;reportedComplete:boolean}`, `GuidanceChannel.verifyActor(resource:Resource):Promise<Result<Actor>>` and `GuidanceChannel.present(value:Guidance):Promise<'reported-complete'|'cancelled'|'failed'>`. Produce `guidedProvider(id:Id,observer:Provider,channel:GuidanceChannel):Provider`, `buildGuidance(operation:Operation):Result<Guidance>`. The provider dispatch, reached only after executor preparation, presents instructions; user report is not observation evidence.

- [ ] **Step 1:** `guided_step_obeys_preparation` asserts no actionable instructions before durable snapshot/intent/consents; unverified browser identity blocks. `reported_is_not_verified` asserts user report with unobservable state yields pending verification, verified read-back yields success, failure offers manual completion/replan without changing provider. `guided_costs_are_not_exempt` asserts separate financial consent remains mandatory.
Assertion excerpt for the arranged scenario:

```ts
expect(instructionsPresentedBeforePreparation).toHaveLength(0);
expect(userReportOnly.status).toBe('pending');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/guidance.test.ts`; expect missing guided provider.
- [ ] **Step 3:** Implement approved target URL/action generation with allowlisted GitHub host/resource binding, explicit instructions and outcome audit. Observe with a suitable eligible read adapter; browser account must be established before sensitive instruction. Do not implement comprehensive browser automation. Run the reusable provider contract with guided-specific completion fixtures.
- [ ] **Step 4:** Run focused tests/common checks; expect guidance only after preparation and no success by assertion alone.
- [ ] **Step 5:** Commit `feat: provide supervised auditable GitHub guidance`.

## Task 21: Expose shared revisioned drafts and semantic application commands

**Depends on:** 2–4, 11–20.

**Files:** Create `packages/domain/src/interaction.ts`, `packages/application/src/{drafts,service,report}.ts`, `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/src/cli.ts`; Extend `packages/domain/src/execution.ts`, `packages/application/src/{executor,resume}.ts` for durable cancellation checks; Test `tests/integration/interaction.test.ts`.

**Interfaces:** Own `Cancellation = {formatVersion:1;runId:Id;requested:true}` in `packages/domain/src/execution.ts`, stored at `runs/<runId>/cancellation` and never cleared for that run; own `Draft = {formatVersion:1;id:Id;revision:number;configuration:Configuration;execution:ExecutionConfig;validation:Issue[];status:'editing'|'validated'|'planned'}`, `DraftPatch = {fields?:Record<FieldPath,FieldIntent>;components?:string[];execution?:Partial<ExecutionConfig>}`, `Report = {run:Run;operations:{id:Id;status:string;stage?:DeliveryStage;issues:Issue[]}[];drift:FieldPath[];recovery:RestorePoint[]}`. Produce `updateDraft(id:Id,expectedRevision:number,patch:DraftPatch,state:StateStore,locks:Locks):Promise<Result<Draft>>`, `buildReport(run:Run,plan:Plan,observations:Observation[],restorePoints:RestorePoint[]):Report`. Own `ApplicationService` with `inspect(resource:Resource):Promise<Result<Observation>>`, `schema():Promise<Json>`, `createDraft(configuration:Configuration,execution:ExecutionConfig):Promise<Result<Draft>>`, `editDraft(id:Id,revision:number,patch:DraftPatch):Promise<Result<Draft>>`, `validateDraft(id:Id):Promise<Result<Draft>>`, `preview(id:Id):Promise<Result<Plan>>`, `approve(plan:Digest,decisions:Decision[]):Promise<Result<Authorization[]>>`, `execute(plan:Digest):Promise<Result<Run>>`, `cancel(runId:Id):Promise<Result<Run>>`, `resume(runId:Id):Promise<Result<Run>>`, `report(runId:Id):Promise<Result<Report>>`, `restorePoints():Promise<Result<RestorePoint[]>>`, `restore(request:RestoreRequest):Promise<Result<Plan>>`.

- [ ] **Step 1:** `stale_draft_preserves_both_inputs` asserts stale revision returns `DRAFT_CONFLICT` with latest draft and rejected patch references preserved in protected state; validation failure retains values; conversation→form→conversation retains ID/revision. `simultaneous_draft_edits_have_one_winner` races two edits at the same revision across independent service instances and asserts exactly one increments the revision, the other returns `DRAFT_CONFLICT`, and neither input is lost. Race an edit against validation/preview and assert neither status update can restore old values or bind a plan to a different revision. `proposal_is_not_consent` asserts config/provider text cannot mint authorization. `report_distinguishes_delivery` asserts no-op/local/pending/blocked/uncertain/drift remain distinct. CLI and in-memory host adapter yield identical plan fingerprints. `cancel_from_every_surface` asserts authenticated UI/CLI/MCP cancellation persists the request, aborts scheduling and leaves a dispatched write uncertain until reconciled; cancellation never deletes resources or claims rollback. Race cancellation with an outcome/checkpoint save and assert the durable cancellation request survives and no subsequent mutation is scheduled.
Assertion excerpt for the arranged scenario:

```ts
expect(staleResult).toMatchObject({ok:false,issues:[expect.objectContaining({code:'DRAFT_CONFLICT'})]});
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/interaction.test.ts`; expect missing semantic service.
- [ ] **Step 3:** Hold a draft-specific cross-process lock from loading/revision comparison through durable draft persistence; release only after retaining conflict input or the successful next revision. All draft-changing service methods, including validation and preview status updates, use this protocol. Long-running validation/planning may read an immutable draft snapshot outside the lock, then reacquire and compare its revision before saving; a mismatch preserves the newer draft and returns a conflict instead of publishing stale results. Compose service methods using earlier application functions, trusted consent channel injection and protected record loading; audit reads/validation/preview/approvals/recovery as well as mutations. CLI is a thin independent-port demonstrator, with structured JSON output and explicit interactive consent rather than arbitrary approval flags. It must not duplicate the engine or require Codex. Runtime maintains run-scoped AbortControllers and a separate monotonic cancellation record so an executor checkpoint write cannot erase cancellation. Persist it before signaling; the executor checks it before each dispatch and after restart; bind cancel through each trusted UI/CLI/MCP surface.
- [ ] **Step 4:** Run focused tests/common checks; expect all modes to share drafts and service authorization gates.
- [ ] **Step 5:** Commit `feat: expose revisioned drafts and shared lifecycle commands`.

## Task 22: Build schema forms, preview and protected loopback fallback

**Depends on:** 21.

**Files:** Create `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/index.html`, `packages/ui/vite.config.ts`, `playwright.config.ts`, `packages/ui/src/{main,SchemaForm,PlanPreview,ConsentPanel,RunReport,RestoreBrowser}.tsx`, `packages/ui/src/{client,styles}.ts`, `packages/adapters-local/src/loopback-server.ts`; Test `tests/e2e/forms.spec.ts`, `tests/integration/browser-security.test.ts`.

**Interfaces:** Own `UiTransport.call(method:keyof ApplicationService,input:Json):Promise<Json>` as validated public DTO transport; transport never exposes credentials or raw provider responses. Produce `startLoopback(service:ApplicationService):Promise<{url:string;close():Promise<void>}>`; issue short-lived UI-only session credentials, expected origin/host binding and CSRF protection. `SchemaForm` accepts `{schema:Json;draft:Draft;onPatch:(patch:DraftPatch)=>Promise<void>}`; other views accept their named plan/report/restore records and callbacks to `UiTransport`.

- [ ] **Step 1:** E2E `all_refinements_round_trip`: choose branch names/prefixes/types/scopes, merge/review policy, signing/sign-off, each delivery choice, retention/restore point; assert correct shared versus execution persistence, preview and execution effect. Assert recommended/custom/required/dependency/cost/provenance feedback, invalid-input draft preservation and distinct consent controls. Security tests reject non-loopback bind, wrong Host/Origin, CSRF, expired session and stale consent plan; stale UI cannot overwrite a conversational edit. Inject credential canary and assert absent from browser network/DOM.
Assertion excerpt for the arranged scenario:

```ts
expect(wrongOriginResponse.status).toBe(403);
expect(browserPayload).not.toContain(secretCanary);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/browser-security.test.ts` and `npm run test:e2e -- tests/e2e/forms.spec.ts`; expect absent backend/UI behavior. Add the Playwright script/config in `playwright.config.ts` as task-owned infrastructure and lock verified UI/test releases.
- [ ] **Step 3:** Implement schema-driven controls and accessible validation, advanced fields, complete disclosure preview, confirmation separation, progress and basic restore coverage/expiry browser. Loopback routes invoke only `ApplicationService`, validate DTOs and enforce session/CSRF checks. Use authentication state only in backend. Provide explicit renewal preserving draft when UI session expires.
- [ ] **Step 4:** Run commands/common checks; expect all field round-trips, keyboard interaction and malicious-origin rejection passing. Inspect desktop/narrow screenshots for clipped disclosures or hidden pending states; fix before commit.
- [ ] **Step 5:** Commit `feat: add shared configuration forms and secure browser fallback`.

## Task 23: Wire real runtime capabilities, MCP Apps and Codex packaging

**Depends on:** 9–10, 20–22.

**Files:** Create `packages/runtime/src/{composition,capabilities,mcp-server,mcp-apps,host-bridges}.ts`, `plugins/codex/README.md`, `plugins/codex/skills/github-workspace-manager/SKILL.md`, `scripts/validate-host-package.mjs`, `docs/host-support.md`; Update `docs/provider-support.md`, root `package.json`, workspace `package.json` files and build configuration required by the package; Test `tests/integration/host-bindings.test.ts`, `tests/e2e/host-modes.spec.ts`. Create the actual Codex manifest at the filename required by the current verified official format; record that exact filename/schema/version in `docs/host-support.md` before writing it. This is deliberate runtime API verification, not an assumed manifest placeholder.

**Interfaces:** Produce `composeRuntime(config:ExecutionConfig,bindings:RuntimeBindings):Promise<ApplicationService>` and `chooseInteraction(capabilities:HostCapabilities):'embedded'|'browser'|'conversation'`; own `HostCapabilities = {embeddedApps:boolean;loopbackBrowser:boolean;trustedConsent:boolean;providerBridges:ProviderBridge[]}`, `RuntimeBindings = {host:HostCapabilities;consent:ConsentChannel;guidance:GuidanceChannel}`. Runtime wires actual durable stores/Git/credentials/financial evidence and provider adapters. MCP handlers call validated semantic service methods; there is no generic arbitrary shell/API mutation tool.

- [ ] **Step 1:** Assert host with supported MCP Apps opens embedded schema UI, otherwise loopback then conversation; all preserve draft and final-plan digest. Assert actual discovered MCP/native actions map through bridge contracts with observed actor/capability, unknown tools remain unsupported, no direct provider execution from UI. Package validator rejects missing declared entry points, wrong manifest schema and unsupported runtime engine. Smoke installation must load the plugin and complete inspect→draft→preview in the target host without external mutations.
Assertion excerpt for the arranged scenario:

```ts
expect(chooseInteraction({embeddedApps:false,loopbackBrowser:true,trustedConsent:true,providerBridges:[]})).toBe('browser');
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/host-bindings.test.ts` and `npm run test:e2e -- tests/e2e/host-modes.spec.ts`; expect missing production bindings. Before implementation, consult installed supported plugin tooling/official docs for manifest, MCP SDK and MCP Apps API; document evidence URLs, tested versions, capability inventory and exact package entries. No invented SDK v2 package/stability assumption.
- [ ] **Step 3:** Implement real released SDK bindings, protocol resource/tool registration and UI bridge; use discovered tool schemas for official/native mapping rather than presumed names. Document operation-by-operation supported/unsupported/fallback matrix including identity, concurrency, backup, signing and verification. Unsupported integration capability is a visible fallback result, never a fake working stub. Ship thin conversational instructions for proposals and trusted consent only. Validate packaging with official tooling where available plus local schema/entry-point checker. Define the root `build` script and workspace build/export entries, and `validate:host` = `node scripts/validate-host-package.mjs`, in this task before Step 4 invokes them; Task 24 only finalizes these existing scripts.
- [ ] **Step 4:** Run focused tests/common checks, `npm run build`, `npm run validate:host`, and target-host smoke. Expected: loadable Codex package, functional production Octokit/local path, verified supported host mappings and fallback behavior. If a promised host binding cannot be exercised, mark release gate blocked and record precise limitation; do not silently drop embedded UI or mark mocked smoke as real host evidence.
- [ ] **Step 5:** Commit `feat: integrate verified host capabilities and Codex packaging`.

## Task 24: Prove full MVP acceptance and publish operational documentation

**Depends on:** 1–23.

**Files:** Create `tests/integration/lifecycle.test.ts`, `tests/integration/fault-matrix.test.ts`, `tests/e2e/conversation.spec.ts`, `tests/live/github.test.ts`, `scripts/live-test-guard.mjs`, `docs/{installation,configuration,troubleshooting,extensions,security,recovery,acceptance-evidence}.md`, `README.md`; Update `BACKLOG.md`, `docs/adr/README.md`, `package.json` and required lockfile/build script configuration.

**Interfaces:** No new mutation path. Live guard accepts explicit `GWM_LIVE_TESTS=1`, `GWM_TEST_HOST`, `GWM_TEST_OWNER`, `GWM_TEST_RESOURCE_PREFIX` and a local authorization record path `GWM_TEST_APPROVAL`; it validates dedicated test ownership/allowlist, disclosed no-new-paid-service scope and exact planned resources before any network mutation. Missing guard inputs skip live suite with an explicit reason. Cleanup is separately planned/authorized; no production-resource or automatic deletion assumption.

- [ ] **Step 1:** Write lifecycle scenarios for personal/org creation, every component, managed update, unchanged reapply, all delivery choices, central GitOps lag, restore and migration. Fault matrix crosses process lock contention, partial journal/snapshot write, disk-full, cancellation during dispatch, actor mismatch, external edits and write/commit/push/PR interruption points. Conversation E2E supplies natural-language proposals through a scripted host fixture to typed draft changes, then independently trusted final consent; malicious embedded instructions grant no authority. Assertions reference all 25 acceptance rows below and expect exact resulting state/blocked reason, not just HTTP success.
Assertion excerpt for the arranged scenario:

```ts
expect(networkMutationsWithoutLiveAuthorization).toBe(0);
expect(secondUnchangedRunMutations).toHaveLength(0);
```

- [ ] **Step 2:** Run `npm run test -- tests/integration/lifecycle.test.ts tests/integration/fault-matrix.test.ts` and `npm run test:e2e -- tests/e2e/conversation.spec.ts`; new missing integration behavior must fail before fixes. Live guard test asserts `networkMutations === 0` without every prerequisite. The real live suite remains skipped until separately authorized.
- [ ] **Step 3:** Make only integration fixes needed by these tests; write installation/configuration examples, source/provenance/consent rules, support matrix, signing/check/bootstrap troubleshooting, audit/backup capacity and restore limitations, extension contracts and backlog. Documentation must explain no automatic rollback, finite retention, pending delivery, local-only target drift and plugin-only enforcement. Ensure README explicitly says which hosts/platforms and adapter actions were actually validated; unsupported environments fail closed. Finalize build/test scripts without adding advanced CI/release automation as product functionality. User amendment 2026-10-19: document and verify local MVP installation/deployment and the GitHub release artifact; append the release changelog before tagging and derive notes from that committed entry. Marketplace submission/publication is excluded.
- [ ] **Step 4:** Run `npm run typecheck`, `npm run boundaries`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run validate:host`; expect all deterministic suites/build/package validation passing. Then, only with explicit disposable-resource authorization, run `npm run test:live` for supported personal/org provisioning, update/idempotency and partial-failure resume, recording resource IDs and actual results. Report skipped/unavailable live coverage honestly; required release evidence remains open until exercised or the user explicitly revises release acceptance. Run the selected workflow's fresh whole-branch review; resolve findings and rerun only affected checks.
- [ ] **Step 5:** Commit `test: verify full repository lifecycle and recovery guarantees` with docs under actual branch/signing/review policy. Publish or merge only through separately authorized delivery; task completion is verified implementation, not inferred release permission.

## Acceptance and ADR traceability

Task numbers identify implementation and decisive evidence; Task 24 integrates every row. A task cannot be marked complete merely because another task's mock returns the desired value.

| Spec §12 acceptance area | Owning tasks | Required release assertion |
|---|---|---|
| Creation | 9–10, 13–15, 24 | Personal/org authorized create; stable identity and collision handling; optional live resources explicitly gated |
| Configuration | 1–4 | Version/schema/precedence/provenance and trusted enforced source |
| Local operations | 7, 15 | Selected destination preserved; clone/bootstrap one coherent history |
| Basic assets | 3, 16 | Five asset families exact frozen bytes in compliant commits |
| Rulesets | 9–10, 17 | Supported policies applied; unsupported/entitlement/permission outcomes explicit |
| Ongoing lifecycle | 12, 18 | Only managed values/reset change; unrelated state preserved |
| Planning/approval | 11–13 | Fingerprint binds final content/state/actor; expected predecessor and unrelated edits distinguished |
| Idempotency | 12, 14, 16–18 | No duplicate settings/commits/PRs, including pending delivery |
| Recovery | 5–6, 13–17 | Journal/state/read-back reconciliation; no automatic destructive cleanup |
| Reversal | 8, 19 | Selective prior state, own consent and preserved intervening edits |
| Backups | 5, 8, 13 | Durable snapshot before dispatch, prior absence and coverage/capacity failures |
| Audit | 5, 13–14, 20–21 | All categories sanitized; intent failure blocks, outcome failure reconciles |
| Workflow selection | 4, 21–22 | Defaults/alternatives/custom rules selected, validated and persisted |
| Workflow preservation | 4, 18 | Existing conventions constrain until explicit migration |
| Repository workflow | 7, 15–17 | Correct branch/message/check/signature path; no direct-write bypass |
| Codebase reversal | 16–19 | New compliant revert commit, preserved shared history/unrelated work |
| Workflow controls | 4, 16–17, 22 | Branch/type/scope/merge/review/signing/sign-off/delivery honored |
| Recovery controls | 8, 19, 22 | Visible coverage/expiry, active pins, capacity block and prune acknowledgment |
| Authorization | 9, 11, 13 | Permissions and trusted plan/sensitive consents checked per mutation |
| Financial safety | 10–11, 17, 20 | Production evidence for entitlements/usage, bounded consent, unresolved exposure blocked |
| Verification | 13–14, 17–18, 21 | Stage-specific actual results distinguish blocked/uncertain/pending/drift |
| UI | 21–23 | Shared draft, schema forms, conversation and runtime embedded/browser fallback |
| Security | 2, 5–7, 9, 11, 22–23 | Secret exclusion, path/process safety, trusted decision and browser boundary |
| Portability | 1, 9, 21, 23 | Inward imports, fake ports, standalone CLI and thin host bindings |
| Documentation | 23–24 | Install/configure/troubleshoot/extend with verified support and limits |

| ADR | Tasks |
|---|---|
| 001 portable hexagonal core | 1, 9, 21, 23 |
| 002 capability-aware provider preference | 9–10, 23 |
| 003 guided supervised fallback | 20, 23 |
| 004 declarative scope/components | 2–3, 12, 18 |
| 005 enforced/advisory governance | 2, 4, 11 |
| 006 separate cost authorization | 10–11, 17, 20 |
| 007 immutable approved plans | 11–14 |
| 008 local YAML/state/audit | 2, 5–8 |
| 009 hybrid GitOps | 2, 18 |
| 010 adaptive shared-draft UI | 21–23 |
| 011 sequential resumable execution | 6, 13–17 |
| 012 bounded lifecycle MVP | 3, 24 and unchanged backlog |
| 013 reversible where feasible | 8, 11–12, 19 |
| 014 complete audit/mandatory backups | 5, 8, 13–14, 20–21 |
| 015 repository-governed content commits | 4, 7, 15–19 |
| 016 selectable standards/defaults | 4, 21–22 |
| 017 five workflow/recovery refinements | 4, 8, 16–19, 22 |

The five refinements explicitly round-trip through schema, shared/execution persistence, preview, approval and execution: workflow detail (4/16/22), merge/review (4/17/22), signing/sign-off (7/16–17/22), delivery preferences (16–18/22), retention/restore browser (8/19/22). None is relegated to documentation or a future feature.

## Primary technical references and execution-time verification

The approved architecture controls semantics. References below support dependency/API verification and must be checked at their consuming task; they are not evidence that a version is installed or that a given host exposes an action.

- [Node.js release schedule](https://github.com/nodejs/Release): proposed Node 24 LTS baseline; verify security-supported runtime and supported OS behavior in Tasks 1, 5–7.
- [MCP TypeScript SDK documentation](https://ts.sdk.modelcontextprotocol.io/index.html) and [v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/): distinguish released compatibility from development documentation in Task 23; select and lock an actual supported release.
- [MCP Apps quickstart](https://apps.extensions.modelcontextprotocol.io/api/documents/quickstart.html): verify host capability negotiation, bridge/resource registration and supported SDK release in Task 23.
- [GitHub ruleset creation documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository): Task 10 verifies applicable entitlement/permission/enforcement capabilities, not generic “GitHub supports it” assumptions.
- For Codex packaging and official GitHub MCP/native bindings, Task 23 records exact currently supported installed/official schema/tool evidence before writing the binding. This plan deliberately does not assert a manifest shape or tool name not established by those sources.

## Self-review and handoff

Initial planning self-review completed on 2026-10-19. Corrections incorporated: production financial evidence collection, requested required checks, explicit source revalidation, local Git provider and push ownership, pre-dispatch merge-result guarantees, shared fixture factory, and trusted cancellation bindings. No product-scope gaps remain in the mapping; release-time host/API and live evidence are explicit gates, not completed work.

The elevated self-review at **GPT-6 Astra/High**, one level above the original **GPT-6 Astra/Medium** planning effort, completed on 2026-10-19 after resuming an account-usage-limit interruption. The resumed pass received the plan, approved specification/architecture, and project instructions/model policy. It rechecked the saved corrections for the execution-method gate, frozen execution settings, atomic draft updates, filesystem primitives, and financial-read ownership. Additional focused corrections make task prerequisites explicit, assign build/package-validation scripts before first use, serialize shared journal appends and recovery across processes, apply revision checks to validation/preview draft writes, and prevent checkpoint saves from erasing cancellation. These changes clarify implementation contracts within the approved scope. This is completion of one elevated pass on the original work, without recursive elevation, and does not replace required independent implementation reviews. Written-plan approval was granted by the user on 2026-10-19; repository setup selections and the newly requested automation design are the current checkpoint.

The completed planning self-review checked all spec sections, all 25 acceptance rows, ADRs 001–017 and the five refinements against named tasks. Structural validation confirmed 32 valid linked contents entries, all 24 task dependency declarations point backward, and each task has its five test/implementation/verification/commit steps. The plan remains proportionate at about 1.7 times the specification length; code blocks define shared contracts and decisive assertions rather than implementation bodies. This is document validation, not evidence that product tests have run. Shared port signatures and data ownership are centralized; consuming tasks introduce their own named records rather than hidden interfaces. Failure tests cover every spec §12 cross-cutting condition, with the five Review Focus cases assigned to concrete tasks. Setup belongs to the first useful behavior, task commits remain policy-constrained, and neither live resources nor implementation start is authorized here.

Selected execution: **Subagent-driven**, confirmed by the user on 2026-10-19. This is appropriate because 24 dependent tasks cross approval, financial, Git and durable-recovery boundaries, and a fresh review at each boundary can catch an unsafe contract before later adapters depend on it. Use the approved implementation model policy and preserve the repository checkpoint. Do not switch execution methods without a new user instruction.

The plan is approved and subagent-driven execution is selected. The user selected public `github.com/glyad/github-workspace-manager`, local checkout `/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager`, immediate push after commits, Conventional Commits, and the amended own-repository routing above. MIT copyright `Copyright (c) 2026 David Kossoglyad`, solo maintenance, and the custom independent-review Action are selected. Resolve remaining workflow/security, release, and integration details through the repository setup questionnaire. The new Projects/release/review automation design remains distinct from the approved product MVP; see `docs/superpowers/specs/2026-10-19-repository-setup-decisions.md`. Per-managed-repository branch names, trusted policy/source bindings, contributor identity/attestation, delivery choice and retention/storage values are runtime product inputs, not missing product decisions to invent now. If a required supported host/API capability cannot be verified during execution, keep the relevant release gate open and report it rather than quietly narrowing the MVP.
