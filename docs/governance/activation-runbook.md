# Controller activation gates

## Contents

- [Current boundary](#current-boundary)
- [Required live capabilities](#required-live-capabilities)
- [Ledger authenticity](#ledger-authenticity)
- [Execution boundary](#execution-boundary)

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
