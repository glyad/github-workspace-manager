# Reviewer App authentication check

## Contents

- [Scope](#scope)
- [Manual execution and acceptance](#manual-execution-and-acceptance)
- [Protocol and limits](#protocol-and-limits)
- [Safe failure investigation](#safe-failure-investigation)

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

Before API use, the run prints only the public SPKI key fingerprint as a safe
diagnostic. The final success summary contains the App, installation and
repository IDs, read-only permissions, and `revoked: true`. Acceptance requires independent repository
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

## Safe failure investigation

Failures identify a fixed phase (`app`, `installation`, `token-issuance`,
`repository-read`, or `token-revocation`) and a numeric HTTP status when available.
Transport, response-read and JSON-parse failures are distinguished without copying
server bodies, headers, URLs or exception messages. Redirect and response-size
failures also have fixed diagnostic labels. A combined read/revocation failure
retains both safe diagnostics; issuance uncertainty and cleanup requirements still
fail the run. Diagnostics add no endpoint fallback or automatic retry.

`Public key fingerprint SHA256:...` is the SHA-256 hash of the provided key's
**public SPKI DER** bytes, encoded as base64. It is not a private key or JWT.
The owner can compare it to the public fingerprint displayed for the App's key,
without copying the private key or saved secret. The fingerprint is not pinned
in source; key rotation requires no code change. A fingerprint comparison alone
is not authentication acceptance and this correction claims no live match.

The initial manual run failed before token issuance with an indistinguishable
request error. That evidence does not identify the failing endpoint or establish
a key, identity, clock or protocol cause. Use a reviewed, deliberately executed
manual run's phase/status and public fingerprint to narrow investigation. The
selected API version was independently accepted by GitHub; do not change versions,
credentials or endpoints as a speculative fallback. Never read the saved secret,
print a PEM/JWT/token, expose raw API bodies, or blindly repeat issuance to debug.
