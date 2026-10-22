# Offline runtime bridge

## Contents

- [Executable boundary](#executable-boundary)
- [Evidence protocol](#evidence-protocol)
- [Local durable test backend](#local-durable-test-backend)
- [Production boundary](#production-boundary)

## Executable boundary

`controller-runtime.mjs` exposes `handleTrustedEvent` and `handleTrustedWorkerCallback` as executable async entrypoints. They parse bounded data-only bytes and normalize permitted event fields. Neither executes candidate code, reads environment/credentials, nor opens a network connection. Trusted callers inject transport, configuration and a protocol evidence resolver. The default production path denies; only explicit `mode: 'offline-test'` invokes the bridge. No active workflow calls this runtime.

`github-port.mjs` implements existing Task 6 observation, ledger append/readback, Draft and worker verification interfaces. `admitCandidate` remains the shared locked admission policy. Worker results are checked by existing Task 7 `acceptWorkerResult` before Task 6 transitions. This chunk does not dispatch workers, grant spending authority or select limits.

HTTP responses must be complete bounded strings with expected status, schemas and exact per-page continuation URLs. Pagination has ten pages and 2 MB aggregate limits; reaching a limit denies completeness. Mutations have no automatic retries. Draft adds a complete authenticated native observation immediately before GraphQL conversion, requires the exact expected candidate/attempt/open Ready lifecycle and previously authenticated PR node identity, validates the response, and retains the controller's mandatory pre/post observations; no atomic GitHub conditional Draft operation is claimed.

## Evidence protocol

The offline protocol uses externally supplied Ed25519 verification keys to validate signed JSON archive bytes. Only ephemeral test keys are generated in tests; no key/account/issuer is created or selected for production. These signatures establish the implemented protocol's bindings, not GitHub-native provenance. Signature input must be canonical padded 88-character base64 representing exactly 64 bytes; encoding/type/length are checked before decoding.

Each archive binds version, purpose and expected run: repository ID, workflow ID, immutable workflow definition SHA (`sha`), execution commit SHA (`executionSha`), run ID, run attempt, actor ID and triggering event. `head_sha` read from GitHub authenticates execution identity only; it never proves immutable workflow definition identity. Run lookup uses the exact attempt endpoint. Journal parsing additionally requires controller default-branch ref and the configured trusted definition SHA.

Native history evidence binds the exact current PR snapshot digest, complete ordered timeline digest from creation, latest Ready event ID and the original exact candidate at that event. The adapter independently derives current native Ready/Draft state and close/reopen history. Missing proof denies. Native Ready timeline metadata/current PR reads cannot establish historical SHAs or correlate a webhook to a timeline ID by themselves. The external evidence protocol must prove that correlation; ambiguous matches are unavailable evidence.

Journal evidence binds exact comment body bytes, candidate, controller execution and a complete signed comment index. Edited comments, missing index proofs, mismatched digests, unrelated run/actor/definition and malformed rows deny. The index issuer must retain immutable committed membership to detect deletion; signing only whatever list happens to exist now cannot satisfy that production contract. The HTTP list alone cannot prove deletion absence. Result envelopes bind exact canonical JSON bytes, candidate, worker and expected execution. Additional diagnostics are excluded from trusted result fields.

The protocol resolver must be trusted code backed by an independently authenticated archive. A payload assertion, artifact existence, caller boolean or ordinary run URL does not supply this capability. No such production archive/resolver has been implemented or proved on GitHub.

## Local durable test backend

`LocalDurableStore` is a filesystem **test** backend. One hashed per-PR directory lock excludes other local processes. Successful calls release it; any thrown outcome, fulfilled `{kind: 'uncertain'}` result or killed holder retains it for explicit recovery. Locks have no lease, stale timeout, automatic reclaim or refund. This is not a cross-runner production lock.

A hash-chained append log writes each record under the lock, fsyncs the file and parent directory before returning, and rejects partial/corrupt tails without truncation. Logs are bounded at 8 MB. Pending external-write obligations are durable before send, and resolve only after exact authenticated public journal readback. Authenticated closure/drift observations create durable safety obligations before return. Successful invalidation result readback can resolve those safety obligations in the same live transaction. Restarting with unresolved obligations blocks the next lock holder, even if public rows disappear or the candidate is restored. Outages before a pending append retain the lock rather than silently forgetting uncertainty.

Explicit recovery must establish actual outcome and reconcile pending obligations under the same lock. There is deliberately no operator override or recovery command in this chunk; removing locks manually is not authorization to erase pending facts or resume work. No reservation/billing settlement is implemented.

## Production boundary

Actions remains globally disabled; existing false workflow gates and failing preflights are unchanged. Review limits and production funding/credential/backend/issuer configuration remain unselected. Setup remains closed, ordinary work Draft-only, integration false.

Remaining work includes supported exact event-time/archive provenance, production shared durability/serialization, complete immutable journal-index authority, disposable hosted evidence, dispatcher/claim/settlement, runner/proxy isolation and actual resource enforcement. These are separate from this concrete local protocol implementation. No production backend is guessed from Actions concurrency or comment read/append; no conditional-write guarantee is invented.

Official protocol references: [GitHub timeline API](https://docs.github.com/en/rest/issues/timeline), [workflow run API](https://docs.github.com/en/rest/actions/workflow-runs), and [GraphQL pull-request mutations](https://docs.github.com/en/graphql/reference/mutations). These API documents do not prove the external archive capability.
