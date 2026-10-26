# Ready CI runbook

## Contents

- [Delivered behavior](#delivered-behavior)
- [Trust and freshness limits](#trust-and-freshness-limits)
- [Operation and pending setup](#operation-and-pending-setup)

## Delivered behavior

`.github/workflows/ready-ci.yml` defines Linux-only `Ready CI` for `pull_request` / `ready_for_review` targeting `develop`. Draft, opened, synchronize, push and scheduled events do not start it. It has no manual dispatch trigger. A maintainer may explicitly retry a failed run; that retry checks the original event candidate and creates no new review authority.

Before checkout, an inline read-only GitHub API step compares the current repository ID/name, PR ID/number, head repository/ref/SHA and base repository/ref/SHA with the event. The current PR must be open, non-Draft and target `develop`. Mismatch or failed reads fail the job. Checkout selects the exact event head SHA with persisted credentials disabled. Pinned checkout/setup-node actions reuse the existing candidate CI pins. Node `24.19.0` and npm `11.21.1` run actual `npm ci --ignore-scripts` and `npm run check:local`; npm lifecycle scripts are disabled during dependency installation, while the configured checks deliberately execute candidate code. There is no dependency cache or extra credential. Permissions are read-only `contents` and `pull-requests`; only the standard repository `GITHUB_TOKEN` is used. Observation steps pass it to `gh`; checkout does not persist it, and candidate check commands receive no explicit token environment variable.

A second job, after successful checks, repeats the API observation on a fresh runner without candidate checkout. Both jobs must pass for the workflow to succeed. Checks cover the existing governance tests, lint, formatting and public-file policy; no product build or E2E check is invented.

## Trust and freshness limits

The observation code is inline workflow code and imports no candidate modules. Candidate checks run as untrusted code with read-only repository permissions and no reviewer/API/Project secrets. A standard `pull_request` workflow may itself be changed by the PR; review workflow changes before relying on them. This workflow is ordinary CI, not an independently trusted admission or review issuer, and supplies none of the dormant protocol-v2 guarantees.

The final observation uses an independent runner to avoid candidate changes to tools/environment. GitHub reads are separate observations, not an atomic snapshot. Head/base/Draft/closure drift can occur after a read, and an intervening Draft→Ready cycle with unchanged SHAs is not detected. A historical success is not proof of current readiness or review approval. Recheck the current PR, pair of commits and applicable independent review before integration. A later push or base movement does not trigger this workflow automatically.

## Operation and pending setup

Actions activation, delivery to the required repository branches (including default branch), hosted success/failure/retry verification, and any required-check/protection configuration remain pending. This source addition performs no live activation or settings change. GitHub also applies its normal fork-run approval and merge-conflict limitations for `pull_request` workflows; see [event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) and [token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

Automatic failure→Draft and push→Draft controls are still pending. Until delivered, a maintainer/agent must return failed or changed review candidates to Draft and verify the transition before continuing edits. Deliberately mark the updated Draft ready only after local checks; neither a retry nor an old success authorizes a new review.

Native Project intake is configured separately; the Project lifecycle Action for evidence-based status updates remains pending. Independent reviewer identity, credentials and review automation are also pending: submit normal GitHub PR reviews through a separate user or App, never Copilot. This workflow does not submit a review, update the Project, merge a PR, or call a paid review API. Actions uses no external state service and no local agent checkpoint/context files. Existing dormant workflows and historical evidence are retained.
