# Offline runtime bridge

## Contents

- [Executable boundary](#executable-boundary)
- [Evidence protocol](#evidence-protocol)
- [Local durable test backend](#local-durable-test-backend)
- [Verified command composition](#verified-command-composition)
- [Production boundary](#production-boundary)

## Executable boundary

`controller-runtime.mjs` exposes `handleTrustedEvent`, `handleTrustedReadinessRequest`, `handleTrustedCiContinuation`, `handleTrustedWorkerCallback` and the dormant `createReadinessRuntime` composition as executable async entrypoints. They parse bounded data-only bytes and normalize permitted event fields. Neither executes candidate code, reads environment/credentials, nor opens a network connection. Trusted callers inject transport, configuration and a protocol evidence resolver. The default production path denies; only explicit `mode: 'offline-test'` invokes the bridge. No active workflow calls this runtime.

`github-port.mjs` implements existing Task 6 observation, ledger append/readback, Draft and worker verification interfaces. `admitCandidate` remains the shared locked admission policy. Worker results are checked by existing Task 7 `acceptWorkerResult` before Task 6 transitions. The offline composition explicitly continues admitted CI once through a durable claim; dispatch history grants no execution permission. It grants no spending authority and selects no limits.

HTTP responses must be complete bounded strings with expected status, schemas and exact per-page continuation URLs. Pagination has ten pages and 2 MB aggregate limits; reaching a limit denies completeness. Mutations have no automatic retries. Draft adds a complete authenticated native observation immediately before GraphQL conversion, requires the exact expected candidate/attempt/open Ready lifecycle and previously authenticated PR node identity, validates the response, and retains the controller's mandatory pre/post observations; no atomic GitHub conditional Draft operation is claimed.

## Evidence protocol

The offline protocol uses externally supplied Ed25519 verification keys to validate signed JSON archive bytes. Only ephemeral test keys are generated in tests; no key/account/issuer is created or selected for production. These signatures establish the implemented protocol's bindings, not GitHub-native provenance. Signature input must be canonical padded 88-character base64 representing exactly 64 bytes; encoding/type/length are checked before decoding.

Each archive binds version, purpose and expected run: repository ID, workflow ID, immutable workflow definition SHA (`sha`), execution commit SHA (`executionSha`), run ID, run attempt, actor ID and triggering event. `head_sha` read from GitHub authenticates execution identity only; it never proves immutable workflow definition identity. Run lookup uses the exact attempt endpoint. Journal parsing additionally requires controller default-branch ref and the configured trusted definition SHA.

Protocol-v2 native history evidence binds the exact current PR snapshot digest, complete ordered timeline digest from creation and latest Ready event ID. Admission additionally requires the retained accepted request/proof/window; native history alone supplies no admission. The adapter independently derives current native Ready/Draft state and close/reopen history. Missing proof denies. Native Ready timeline metadata/current PR reads cannot establish historical SHAs or correlate a webhook to a timeline ID by themselves. The approved [admission-time amendment](../superpowers/specs/2026-10-22-verified-admission-design.md) replaces that historical SHA requirement for v2. Legacy event-time evidence remains safety/history data and cannot newly admit a candidate. Ambiguous window/writer evidence denies.

Journal evidence binds exact comment body bytes, candidate, controller execution and a complete signed comment index. Edited comments, missing index proofs, mismatched digests, unrelated run/actor/definition and malformed rows deny. The index issuer must retain immutable committed membership to detect deletion; signing only whatever list happens to exist now cannot satisfy that production contract. The HTTP list alone cannot prove deletion absence. Result envelopes bind exact canonical JSON bytes, candidate, worker and expected execution. Additional diagnostics are excluded from trusted result fields.

The protocol resolver must be trusted code backed by an independently authenticated archive. A payload assertion, artifact existence, caller boolean or ordinary run URL does not supply this capability. No such production archive/resolver has been implemented or proved on GitHub.

## Local durable test backend

`LocalDurableStore` is a filesystem **test** backend. One hashed per-PR directory lock excludes other local processes. Successful calls release it; any thrown outcome, fulfilled `{kind: 'uncertain'}` result or killed holder retains it for explicit recovery. Locks have no lease, stale timeout, automatic reclaim or refund. This is not a cross-runner production lock.

A hash-chained append log writes each record under the lock, fsyncs the file and parent directory before returning, and rejects partial/corrupt tails without truncation. Logs are bounded at 8 MB. Pending external-write obligations are durable before send, and resolve only after exact authenticated public journal readback. Authenticated closure/drift observations create durable safety obligations before return. Successful invalidation result readback can resolve those safety obligations in the same live transaction. Restarting with unresolved obligations blocks the next lock holder, even if public rows disappear or the candidate is restored. Outages before a pending append retain the lock rather than silently forgetting uncertainty.

Explicit recovery must establish actual outcome and reconcile pending obligations under the same lock. There is deliberately no operator override or recovery command in this chunk; removing locks manually is not authorization to erase pending facts or resume work. No reservation/billing settlement is implemented.

## Verified command composition

`createReadinessRuntime({mode,productionBackend,portConfig,requestContext})` composes the actual `createGithubPort` with injected store, HTTP, archive and public verification key. `ciContinuation` receives only its trusted `approvedDefinition`, selecting the concrete E store adapters rather than continuation-method stubs. `LocalDurableStore` is the local test backend. Its configured `authorizeReadinessRequest` must independently reauthenticate the original retained dispatch bytes/actor/run on every read; a current rerun cannot rewrite that authority. Original controller and CI definitions, numeric actor allowlist, request-context scalars, functions and worker mappings are snapshotted before awaits. No payload or candidate configuration chooses them. Production defaults deny before any I/O; no workflow supplies live providers. The workflow recipes deliberately perform no runtime checkout/import: independently approved immutable source bootstrap is a missing production capability. A dispatch-selected workflow SHA/ref or environment configuration cannot establish source trust. A separately reviewed external bootstrap/protected configuration must authenticate source and executing definition before loading any runtime code; the injected local composition does not implement that hosting capability.

The composition exposes:

- `command({inputs,archive})`: exact six strings `pr`, `expected_base_ref`, `expected_base_sha`, `expected_head_sha`, `request_id`, `protocol_version` (exact `2`). Extra fields deny. Resolve immutable PR node/repository and original initiating human from trusted providers; never substitute fresh PR SHAs for the expected pair. Authenticate through A, run B/C/D under the shared operation lock, then explicitly invoke E only after verified admission. Returns a candidate and claim ID with “Ready and admitted for these commits” only when both admission and continuation bind successfully. Every other result says “Not admitted; reconciliation required”. Neither response is worker permission.
- `ciCallback({body,archive,dispatchInputs?})`: bounded data `{type,candidate,worker:'ci',outcome,claimId}`. Resolve the durable claim's original expected run, then call D's `handleTrustedWorkerCallback` for start and completion. Optional dispatch inputs must exactly assert the durable claim/request/candidate/definition. Archive and native lookups independently verify the original execution; worker-supplied run/attempt/candidate assertions cannot select authority. Only a verified newly consumed start returns `value.execute:true`; completion returns false. Duplicate starts, lost permission responses and workflow reruns cannot execute again.
- `reconcileCi(claimId)`: explicit E discovery/binding of the original occupied slot, with no resend and no worker permission. Lost dispatch responses may later bind the original run; ambiguous discovery remains pending. No generic lock takeover, timeout, automatic refund or automatic Ready restoration exists.

E's dispatch POST sends only `{ref,inputs:{claim_id,request_id,candidate,definition_sha}}`. The signed `ci-dispatch-discovery` archive must independently bind exact dispatch bytes, full candidate, request/claim, pinned definition and exactly one original run. An API run list or an echo of supplied fields is insufficient. C's retained proof and complete phase archive, immutable journal membership and original run attribution remain required at worker time. See the [command and recovery runbook](workflow-runbook.md#verified-readiness-command) and [live capabilities](activation-runbook.md#verified-admission-capabilities).

The positive command tests use the shared `composed-adapter-fixture.mjs`, real local store and real port with synthetic HTTP/archive responses. They begin at native Draft, authenticate the request, retain phases/proof, admit through D, dispatch once through E, consume one start and accept only the original completion. This is offline protocol acceptance, with disposable synthetic signing keys; it does not prove hosted acceptance, production identity/writer coverage or cross-runner fencing.

## Production boundary

Actions remains globally disabled; existing false workflow gates and failing preflights are unchanged. Review limits and production funding/credential/backend/issuer configuration remain unselected. Setup remains closed, ordinary work Draft-only, integration false.

Remaining work includes production request/archive provenance and registered writer coverage, shared durability/serialization, complete immutable journal-index authority, disposable hosted evidence, live dispatcher/claim/settlement, runner/proxy isolation and actual resource enforcement. These are separate from this concrete local protocol implementation. No production backend is guessed from Actions concurrency or comment read/append; no conditional-write guarantee is invented.

Official protocol references: [GitHub timeline API](https://docs.github.com/en/rest/issues/timeline), [workflow run API](https://docs.github.com/en/rest/actions/workflow-runs), and [GraphQL pull-request mutations](https://docs.github.com/en/graphql/reference/mutations). These API documents do not prove the external archive capability.
