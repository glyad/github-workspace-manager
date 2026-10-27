# Local review App handoff

## Contents

- [Operating scope](#operating-scope)
- [Prepare and dispatch](#prepare-and-dispatch)
- [Publication and recovery](#publication-and-recovery)
- [Acceptance still required](#acceptance-still-required)

## Operating scope

The selected reviewer is a fresh local Codex **GPT-6 Astra/High** agent using
included allowance, independent of the implementer and the separate Sol/High
self-review. Freeze the exact current `develop` base/head pair and local review
material after successful current Ready CI. The existing
`glyad-workspace-reviewer` App publishes its result as a native GitHub review or
review-thread reply. App 5487224, installation 175625005, repository 1427426748,
and bot user **348541410** are fixed in source. The App is a publishing persona;
publication cannot prove which model wrote a document or guarantee reviewer assignment.

Only `glyad` can dispatch the manual publisher on `main`. The trusted runner
shares the existing authentication implementation, mints one repository's
contents-read/pull-requests-write installation token, and revokes it in `finally`.
The workflow's separate read-only `GITHUB_TOKEN` has `actions: read` for CI/run
observations. No App Actions grant, model API, provider proxy, local PEM,
external service, PR checkout, dependency installation or dormant controller is needed.
The [read-only authentication check](reviewer-app-auth.md) retains its own contract.

## Prepare and dispatch

Use pinned Node 24.19.0/npm 11.21.1 and existing authenticated `gh` on the local
host. Save prepared public JSON and pending files outside tracked source, for
example `.governance-local/local-reviews/`. Keep full source snapshots, agent logs
and review evidence private. `reviewer.evidence` is an opaque descriptive label,
not a local path, secret, full log or authority certificate. All supplied JSON
fields are sent to GitHub and must be intended public metadata/text.

The version 1 envelope requires exactly these fields:

```json
{
  "version": 1,
  "operationId": "review-unique-001",
  "repository": "glyad/github-workspace-manager",
  "repositoryId": 1427426748,
  "prNumber": 123,
  "prId": 123456,
  "baseRepositoryId": 1427426748,
  "headRepositoryId": 1427426748,
  "baseRef": "develop",
  "headRef": "chore/example",
  "baseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reviewer": {
    "model": "gpt-6-astra",
    "effort": "high",
    "evidence": "review-evidence-001"
  },
  "operation": {
    "type": "review",
    "event": "REQUEST_CHANGES",
    "summary": "Explain the actual review outcome.",
    "complete": true,
    "comments": [
      { "path": "example.mjs", "line": 12, "side": "RIGHT", "body": "Explain the defect." }
    ]
  }
}
```

Replace every example target identity/ref/SHA with fresh native observations.
`event` is explicitly `APPROVE`, `REQUEST_CHANGES` or `COMMENT`; comments may be
empty. An inline range adds both `start_line` and `start_side` (same side, earlier
line). Maximum 20 comments, 6,000 UTF-8 bytes per inline body and 12,000 per
summary/reply; complete serialized dispatch inputs including escaping/wrapper
must fit **48 KiB**. Oversize reviews remain pending locally for deliberate
concise rewriting or separately prepared bounded reviews. Never silently truncate
findings or use `APPROVE` for incomplete material.

For a reply, replace only `operation` with
`{"type":"reply","commentId":123456,"body":"Rechecked the change."}`.
The original top-level native review comment must belong to the target PR; older
thread commits and Draft PRs are allowed. Replies do not approve or resolve threads.
Use the root review-comment ID, not a reply ID or an issue-comment ID.

```sh
node tools/governance/reviewer-app-handoff.mjs prepare /absolute/public-review.json /absolute/private-pending
node tools/governance/reviewer-app-handoff.mjs send /absolute/public-review.json /absolute/private-pending
node tools/governance/reviewer-app-handoff.mjs resume /absolute/private-pending/review-unique-001.json /absolute/private-pending
```

The helper records a canonical SHA-256 content digest and immutable operation ID,
checks native state, dispatches only `reviewer-app-publish.yml` on `main`, and
finds the run by its operation name. An immediate dispatch may precede run
visibility: use `resume` to observe later. One atomic checkpoint writer is guarded
by a directory lock; after process death, inspect the retained item and GitHub
before manually clearing an abandoned `.lock`. This is a local file checkpoint,
not a durable scheduler or cross-host controller. Changed content requires a new ID.

## Publication and recovery

Review admission verifies the actual Ready workflow ID, latest associated run,
immutable run head SHA, completed successful `checks` and final
`Confirm current Ready candidate` jobs. The executed `ready-ci.yml` at that SHA
must exactly match the trusted main checkout's file, whose sole trigger is
`pull_request`/`ready_for_review`. REST `run.event` is `pull_request`; it does not
expose the action. Current parent ancestry, open/non-Draft PR database identity,
base/head repository IDs, refs, SHAs, and current `develop` tip are checked.
Mutable run PR-association objects do not prove historical event-time SHAs.

Native review submission sets `commit_id` explicitly and includes inline findings
in one submitted-review call. Anchors must exist in the exact diff; truncated
anchored hunks fail. Approval requires parsed addition/deletion counts to equal each native file record's nonnegative integer counters, including the total changes count. This rejects a complete prefix that omits a later whole hunk. Approval also fails if any changed file lacks a patch
(including binary files); use a supported complete review path, not a fabricated
approval. The visible body records the exact pair/model and an operation/digest
marker. Readback verifies the pinned bot user, submitted state, commit, body and
every inline finding. Replies bind the native PR/thread and current pair.
Pagination is bounded to 15 pages of 20; incomplete totals, size limits or an
exhausted bound fail safely. Requests have a 10-second deadline. Authentication/scope/cleanup observations retain the 64-KiB smoke-check response limit; fixed publication observations use a separate bounded 2-MiB JSON response profile, including App native objects and read-only Actions metadata.

Per-PR workflow concurrency serializes review/reply with cancellation disabled;
GitHub does not guarantee FIFO delivery of queued runs. Both operations search
native objects before writing. Collisions, multiple matches or different content
stop. Lost write responses trigger read-only reconciliation; absence is
`uncertain`, never an automatic repeat POST. Earlier runs for the same operation
or rerun attempts also prevent a fresh POST when no matching native object exists.
An apparently failed/cancelled run may already have published.

Local states are `prepared`, `dispatched`, `verified`, `stale`, `uncertain`.
Resume always observes GitHub, reads the trusted run's safe receipt from its log,
and independently reconciles the native object without any local write endpoint.
An authenticated stale publisher receipt stays stale even when fresh native readback again matches the old pair. An observed stale item stays stale even if refs later return to the old pair; prepare fresh review evidence and a new operation.
No run/receipt or unknown revocation remains uncertain; do not delete the item or
blindly redispatch. Operator investigation is required for unresolved ambiguity.
Successful publication plus cleanup failure records both facts and fails the run.
Never infer revocation after process cancellation or token issuance uncertainty.

GitHub has no atomic base-SHA condition for create-review. A changed pair/Draft
at final observation makes the receipt stale; integration must freshly recheck
pair and conversations. No automatic dismissal/remediation is promised. Between
reads a transient change can evade observation. Do not count stale evidence for
current integration, promise exactly-once delivery, or infer branch-protection
review-count behavior from the bot's native review alone.

## Acceptance still required

Mocked tests establish local behavior only. After reviewed trusted-main delivery,
observe one genuine independent review with an inline thread, native App author,
exact anchors/pair/event, successful revocation, then a fix/thread reply recheck.
Do not manufacture an approval solely to test publishing.

Automatic start is a separate next operational step: install a real local Codex
app heartbeat in the repository chat, with bounded cadence and a prompt that
reconciles pending items and discovers Ready/current successful CI and changed
discussion. It must invoke a fresh **Astra/High** reviewer through an available
local agent mechanism with model/effort in the invocation. Stay quiet when nothing
requires action; report publication, failure or required user action. Observe a
real Ready+CI transition, reviewer invocation, App publication and fix/thread
recheck before claiming automation accepted. No heartbeat is installed by these
files. Offline host, sleep, allowance exhaustion or unavailable fresh-model
invocation pauses review without a paid API fallback.
