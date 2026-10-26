# Native PR Draft controls

## Contents

- [Operation](#operation)
- [Reconciliation and limits](#reconciliation-and-limits)
- [Delivery and acceptance](#delivery-and-acceptance)

## Operation

`.github/workflows/pr-draft.yml` runs `tools/governance/native-pr-draft.mjs` from the trusted default-branch commit supplied by GitHub for its two event types. Checkout/setup-node use the existing pinned actions and Node24.19.0. No PR code, candidate dependency, artifact, cache, local checkpoint, review provider or custom secret is loaded. Only repository `GITHUB_TOKEN` contents/actions read and pull-request write permissions are requested. The control changes only Draft metadata; it never launches CI or review on a push.

A `pull_request_target: synchronize` event targeting `develop` can return a still-current Ready PR to Draft after a pushed head change. The runner verifies the canonical repository, PR identity, open/Ready state, full current head/base pair, head repository/ref, native event before/after SHAs and the event PR snapshot. The latest native `ready_for_review` timeline witness must precede the snapshot's `updated_at`. That native snapshot time is used as a conservative push cutoff, not as an atomic push transaction witness. A later Ready witness prevents an old push from downgrading that intentional cycle. A PR initially opened Ready without a native Ready transition needs manual reconciliation; use Draft then intentionally Ready to establish the ordinary workflow.

For `workflow_run: completed`, the runner fetches the exact workflow at `.github/workflows/ready-ci.yml` and checks its ID/name/path against `Ready CI` and the event/run. Only `pull_request` runs with `failure`, `timed_out` or `cancelled` conclusions apply. The event and fetched run ID/attempt, associated PR ID/number/head/base, repository, head repository/ref, original creation time and current PR pair must match. The run's immutable `head_sha` must match both the event and the current PR head: this Ready CI explicitly checks out that source head. Associated PR metadata on historical runs can advance to a newer head, so that mutable association alone cannot identify the tested candidate. Empty or multiple PR associations need manual reconciliation. Original `created_at`, rather than rerun start time, is compared with the current Ready witness so a rerun does not renew an old cycle.

Both paths read native lifecycle history, including intervening Draft, close and reopen events. A second complete observation immediately precedes one mutation, checking the same Ready witness and candidate again. A separate PR read must confirm Draft on that pair. Nothing is retried automatically after an uncertain mutation.

## Reconciliation and limits

The runner prints a bounded JSON outcome: `drafted`, `noop` (inapplicable/stale), or `manual`. Manual outcomes fail the job so the maintainer can inspect native PR/timeline/run state and deliberately reconcile it. Missing identities/history, conflicting lifecycle events, API errors, more than 2,000 timeline entries or an unconfirmed write stop automation. Inspect actual native state before rerunning a failed job; a failed HTTP response does not prove the mutation was absent.

GitHub timestamps have finite precision. Equal Ready/run-creation seconds are accepted because routine Ready CI creation can occur in that same second. Equal push/Ready seconds and multiple Ready events in one second are ambiguous and require manual reconciliation. Visible later Ready events invalidate older results even when SHAs are unchanged. A delayed event/run creation within the timestamp boundary cannot always be attributed uniquely with these native metadata reads. This is ordinary metadata automation; it does not provide the dormant protocol-v2 causality guarantees.

API reads and the Draft mutation are separate operations. GitHub's mutation provides no conditional head/base/Ready compare-and-set. A native Ready/edit/push can race after the final observation, and readback can discover a conflict only after a write. Repository-wide concurrency serializes participating Draft-control jobs only; native edits and other workflows remain concurrent. GitHub can replace pending concurrency jobs, so this workflow is not a durable queue or a guarantee that every intermediate event executes. Maintainers must still return a reviewed PR to Draft before editing it. Required checks/protections remain the separate integration safeguards.

## Delivery and acceptance

Trusted/default-branch delivery, Actions activation and hosted tests are still pending. `Ready CI` is delivered in a separate increment; both workflows must be available on the appropriate branches before activation. This source change does not enable Actions or modify permissions, settings, required checks or protections. Separate reviewer identity is postponed until the other setup work is ready and does not block this source task.

Hosted acceptance must exercise Ready push, failed/timed-out/cancelled CI, stale run, newer unchanged-SHA Ready cycle, fork identity and denied/uncertain mutation cases. Verify the actual token permissions and default-branch checkout, inspect resulting Draft state and manual outcomes, and ensure no push dispatches CI/review. GitHub's actual event policy, fork and delivery behavior must be checked at activation; this increment claims local fake-API acceptance only.

GitHub documents [default-branch event execution and workflow_run prerequisites](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [privileged-event checkout risks and applicable Actions event policies](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [workflow run metadata](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run), [timeline pagination](https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue), [native Ready/lifecycle events](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) and the [Draft mutation](https://docs.github.com/en/graphql/reference/pulls#convertpullrequesttodraft). No new policy or trust infrastructure is introduced by these references.
