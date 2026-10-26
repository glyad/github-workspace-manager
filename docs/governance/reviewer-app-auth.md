# Reviewer App authentication check

## Contents

- [Scope](#scope)
- [Manual execution and acceptance](#manual-execution-and-acceptance)
- [Protocol and limits](#protocol-and-limits)

## Scope

This manual smoke check authenticates the owner-created `glyad-workspace-reviewer`
App (5487224, client ID `Iv23ctaEdWaFhBYqhbZg`), installation 175625005, and
`glyad/github-workspace-manager` (1427426748), owned by `glyad` (4238205).
The installation grants contents/metadata read and pull requests write. The probe
mints only contents/pull requests **read**, with implicit metadata read.
It posts no reviews, comments or checks and activates no paid controllers.

## Manual execution and acceptance

Reviewed integration and default-branch delivery precede a deliberate manual
main run under the existing setup authorization. Select **Reviewer App
authentication check → Run workflow → main**. Job admission rejects other branches and repositories. The existing
Actions secret `REVIEWER_APP_PRIVATE_KEY` enters only the trusted script step;
never copy a private key into local commands or logs. No workflow inputs exist.

A successful run prints only the App, installation and repository IDs, read-only
permissions, and `revoked: true`. Acceptance requires independent repository
readback **and** successful revocation. Local fake HTTP tests do not establish
live authentication acceptance. Integration, default-branch delivery and the
actual manual run remain pending; paid review activation remains separately gated.

Every failure fails the run. If issuance is uncertain or revocation fails,
inspect the owner App installation and credentials before a deliberate new run;
there is no automatic mutation retry. An issued token can remain usable until
expiry if no usable token was received or revocation could not be confirmed.
Never paste raw response bodies or credentials into investigation notes.

## Protocol and limits

Built-in Node crypto creates an RS256 JWT, issued 60 seconds in the past and
expiring nine minutes in the future. JWT-authenticated App and installation GETs
verify exact identity, selected-repository mode, permissions and nonsuspended
state. The token POST explicitly selects the one numeric repository ID and
read-only permissions. The response restrictions and a separate installation
repository listing must both identify exactly that repository. Every received
usable token is masked immediately and revoked in `finally`, including after
restriction/readback failure. JWTs are masked before use. Token validation accepts
variable-length formats without a fixed prefix.

Requests use only `https://api.github.com`, reject redirects, allow ten seconds
per request including reads, and cap response JSON at 64 KiB. The workflow has a
three-minute timeout and no dependency installation, caching or artifacts. Raw
API/crypto exceptions, response bodies and Authorization headers are never logged.
A runner termination can interrupt cleanup; successful cleanup is never inferred.

Official protocol references: [JWT generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[installation token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
and [installation repository reads and token revocation](https://docs.github.com/en/rest/apps/installations).
