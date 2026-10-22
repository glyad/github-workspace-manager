# Controller activation gates

## Contents

- [Current boundary](#current-boundary)
- [Required live capabilities](#required-live-capabilities)
- [Ledger authenticity](#ledger-authenticity)
- [Execution boundary](#execution-boundary)

- [Isolated workers and review activation](#isolated-workers-and-review-activation)

## Current boundary

This source is inactive. No ledger Issue, credential, actor grant, workflow execution, paid call, remote mutation or hosted check is created by Task 6 staging. `inactivePort()` refuses execution without network access. Actions must remain disabled; the workflow also has an unconditional false job gate. Existing setup closure admits ordinary Draft work only; integration is false. Do not reopen setup or reinterpret historical activation snapshots as current live evidence.

## Required live capabilities

Activation requires a separate approved live adapter and disposable acceptance evidence for all of the following:

- A controller-owned public-safe ledger Issue: verify repository/Issue node identity, creator and write authority through independently authenticated API reads; create and read back only after separate authorization.
- Exact controller actor numeric/node identity, trusted default-branch workflow ID/revision and run attempt. Verify run repository, actor, workflow, ref, event, conclusion and immutable workflow revision. Permissions, issuer support and workflow identity are unresolved.
- Independently authenticated binding between exact journal comment bytes and trusted controller-run output. An Issue comment author or plausible run URL alone proves no content provenance. Verify comment edits/deletions, pagination completeness and durable attestation authority; incomplete/oversized histories block admission. No attestation issuer has been selected or verified.
- Complete native readiness and closure/reopen history, independently authenticated event-time Ready base/head evidence, and current repository/PR/base/head reads. Bind verified closure history to the current Ready attempt with `lifecycle.verified`, `lifecycle.attempt` and `lifecycle.closedSinceReady`. Preserve any closure since that attempt across reopen and missing/replaced close handlers; a current-open snapshot alone is insufficient. Verify the original candidate separately from the current PR snapshot and expose the bound candidate through `readiness.candidate` only with `candidateVerified=true`; missing history/provenance blocks first admission as well as worker starts. PR-controlled labels, bodies, artifacts and webhook claims never supply identity or readiness authority.
- A durable shared per-PR lock covering every worker start, completion and mutation; verify repository-wide controller serialization and replacement/recovery behavior. The workflow concurrency expression is a preliminary scheduling hint. Unverified workflow-run-to-PR mappings and unresolved PR identities must stop before mutation. No durable live lock adapter exists yet. The adapter must preserve a pending authenticated invalidation obligation across unknown journal outcomes/process failures and withhold subsequent eligibility until its persistence or explicit recovery is verified. Releasing a request after failed persistence and then treating missing ledger rows as fresh eligibility is not permitted. Local fixture locking does not prove this durable outage behavior.
- Worker run provenance from the trusted isolated workflow, exact candidate and run attempt; outcome fields from PR-controlled artifacts are insufficient. Task 7 must supply verified result transport and duplicate-dispatch reservations. No paid review before separate funding, credentials and limits are approved.

## Ledger authenticity

`parseJournal(entries, context)` consumes sanitized envelopes and independently verified context. It enforces at most 1,000 entries, 16 KiB per body and 1 MB total body bytes, candidate/action schemas, stable operation hashes, actor/Issue/run provenance and exact-body digest bindings. Reaching limits requires explicit archival/reconciliation design, never silent truncation. The trusted adapter must stamp the current run identity on appends; raw controller records do not contain authenticated run claims. It must read the appended record back through the same verification chain, preserve append-only history and reject conflicting records. Context evidence cannot be derived from the comment being authenticated. Local fixtures verify policy only; they cannot prove a real GitHub actor or run.

## Execution boundary

The inactive Linux workflow listens only to relevant PR metadata and candidate worker completion. There is no push or schedule CI trigger, no Actions checkout dependency and no PR code execution. Read-only workflow defaults are retained; only the dormant controller job declares metadata mutation permissions. Before activation, minimize and verify those permissions against the selected APIs. Pin any future external Action to a separately verified immutable SHA. Fetch/run only trusted default-branch controller code with mutation authority; candidate CI must remain unprivileged with no mutation credentials. Public-fork execution remains blocked.

Projects reconciliation is separate and inactive. Personal Projects access requires separately scoped, verified credentials; the normal workflow token is not claimed to authorize it. Release, renewal, review spending and ordinary integration remain separate blocked gates. Remove the false workflow condition only after live identity, ledger, lock, trust and permission evidence passes independent review and explicit activation authorization.

## Isolated workers and review activation

Task 7 adds offline policies and dormant recipes only. Actions remains globally disabled, setup closed, ordinary work Draft-only and integration false. Removing a false condition is insufficient: each recipe first exits with failure. No skipped job or missing product/scanner implementation is a successful governance check.

Before enabling, implement Task 6's authenticated native/event-time/lifecycle observations, public ledger Issue transport, exact-byte/run attestation issuer, durable PR serialization and durable outage recovery. Add a trusted default-branch/pinned workflow dispatcher and verify both the workflow ID and immutable definition SHA independently of dispatch inputs. Raw PR artifact/run URL claims are insufficient. No live worker/result transport exists in this staging change.

`acceptWorkerResult` consumes trusted observations and exact result-body digest/run bindings; it returns only a proposed transition. The live bridge must map Task 6's full admitted origin/lifecycle/journal result to these facts under its shared PR lock, independently resolve the expected worker/run and issuer, then call Task 6 admission again before persisting or applying a transition. These booleans are not an authentication mechanism. A stale failure returns no transition; fresh findings return current Draft and require a new deliberate Ready cycle.

`reserveReviewBudget` requires an authenticated complete funding-scope ledger, approval of all five exact positive integer limits, one global reservation lock and fresh admission reads before append and after readback. The adapter must coordinate Task 6 PR locking with a consistent lock order. Duplicate request IDs cannot spend again. Every retry uses a new request ID and consumes another call slot; reserved/unknown slots occupy concurrency across PRs, completed calls still consume the attempt budget across restored base/head pairs. No automatic expiry releases ambiguous billing. Durable uncertainty across outages and crashes, complete history, single-use dispatch claim, settlement/reconciliation and policy-revision authority remain unimplemented live gates. A returned reservation is not reusable permission to dispatch repeatedly.

All API limits remain **UNSELECTED**: `callsPerAttempt`, `maxOutputTokens`, `maxInputBytes`, `maxRunSeconds`, `maxConcurrentCalls`. Test fixture numbers are not owner approval. At enablement only, obtain spending consent and secure credential reuse/new-key/destination decisions through the OpenAI Platform flow. This staging task deliberately performs no credential inspection, provisioning or API-backed work, per the explicit no-key scope. Prove the exact Action/model/High availability and fresh-session behavior; never substitute another model or XHigh/Copilot automatically.

The dormant Codex Action revision is `bdf19a4a223ec2549a3e2274a0cf61556bc07675` (v1.13). Its public inputs expose model, effort, permission profile and ephemeral CLI arguments. This is not proof of account access, malicious-PR resistance, output-token caps or call-count enforcement. Implement and verify a trusted bounded proxy/runner that measures complete input bytes, constrains actual upstream calls including tool/model loops and retries, caps output, enforces elapsed execution, concurrency and cancellation, and records uncertain billing. Action/CLI/proxy dependencies must be pinned and audited before activation. A job timeout alone cannot guarantee cancellation or a hard billed-token/currency ceiling. These controls bound calls/resources, not guaranteed money; unresolved required hard spending guarantees block activation.

Demonstrate malicious PR instructions cannot access the real key, privileged posting credentials, trusted home/config, hooks/skills/MCPs or writable runner control files. Never run candidate code in the key-bearing analysis path; provide bounded PR data via a trusted extraction step and independent runner, keep privileged posting separate, and verify the selected proxy/sandbox behavior on disposable Linux resources. Public forks remain blocked until that succeeds; current policy blocks all forks. No such demonstration was performed locally.

Only after separate consent and all evidence passes, run one real admitted candidate, verify `governance/ci`, `governance/review`, `governance/admission` on its exact base/head/attempt from the expected issuer, then enforce them on develop. A local agent review is not the selected hosted review. Durable release evidence must be retained separately from 14-day diagnostics. No hosted checks, enforcement, release or merge are delivered here.
