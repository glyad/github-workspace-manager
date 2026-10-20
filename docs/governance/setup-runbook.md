# Repository setup runbook

## Table of contents

- [Authority and current state](#authority-and-current-state)
- [Read-only preflight](#read-only-preflight)
- [Bounded setup session](#bounded-setup-session)
- [Uncertain creation and restoration](#uncertain-creation-and-restoration)
- [Evidence identity](#evidence-identity)
- [Verification and remaining gates](#verification-and-remaining-gates)

## Authority and current state

The approved repository is public `glyad/github-workspace-manager`, at
`/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager`.
The approved setup exception covers identifiable repository and Project setup
on main, including repository-root and `.github` files. Signed commits and
local validation still apply. Only the existing authenticated `glyad` identity
is eligible; normal merge authority remains with `glyad`.

This file is prepared in local staging. No repository, Project, setup bypass,
credential, signing key or hosted workflow is created by these controls.
`governance/activation.json` records all automation as inactive and ordinary
integration as blocked. Plan Tasks 2–4 deliver and verify the actual baseline.

## Read-only preflight

Use `preflightSetup(port, desired)` from `tools/governance/setup.mjs` with
`createReadOnlyGitHubPort()` from `tools/governance/github.mjs` and the parsed
`governance/repository.json`. The adapter invokes `gh` with argument arrays,
uses existing secure authentication, never returns subprocess stderr and
provides no remote mutation method. GitHub GraphQL input is JSON through
stdin. Preserve only sanitized returned observations and evidence.

The checks bind host, authenticated account, HTTPS configuration, exact
repository identity, destination and ancestors, existing signing identity,
Project scope/existence and effective rules. Existing nonempty destinations
block automatic setup pending explicit inspection; preserve their contents.
Unknown remote results remain uncertain. A repository absence is accepted
only from an authenticated read with an actual HTTP 404 response.

The existing-key probe requires configured name, email and signing key. It
creates a disposable local repository, signs an empty commit with the existing
identity, runs `git verify-commit`, and compares the signing identity with
GitHub's signing-key association. It removes its own disposable repository.
It neither generates nor uploads keys. Missing signing configuration, local
trust, GitHub association, Project authorization or effective-rule access
blocks preflight. The normal repository workflow token cannot authorize a
personal Project. Any secure authorization or new signing-key flow is handled
separately by the user-authorized setup controller.

Preflight evidence expires after five minutes. Repeat observations immediately
before consequential operations. GitHub signature verification of resulting
pushed commits remains mandatory in Task 2; a disposable local signature is
not evidence of a verified remote baseline.

## Bounded setup session

`openSetupSession(snapshot, approvedPaths, existingActor)` records a bounded
session only after verified preflight and a real repository ID exist. Rerun
preflight after repository creation. Freeze the exact path manifest for this
session: approved root contributor files, governance settings, Tasks 1–4 tools
and tests, native templates and approved Markdown source copies. Product
packages, synced `AGENTS.md`, `sources/`, traversal and absolute paths are
excluded. The intended repository may receive separately reviewed editable
instructions during Task 2; this mirror's synced instructions stay unchanged.

Opening a scope record installs no bypass. Before any mutation, Task 2/4's
trusted adapter must verify the authenticated actor again, exact repository
ID, supported ruleset controls and observed revision, then journal the precise
before/desired rules and operation intent. No broad actor grant is inferred.
Use `authorizeSetupPath` for every manifest path; read actual paths without
following symlinks, freeze content digests, and revalidate before staging.
Only the exact manifest paths receive authorization. Current scope operations
are baseline files, repository settings, Project baseline and safeguard
restoration; no product development or release authority is granted.

The eventual selected checkout must store an append-only JSONL setup journal
under `.governance-local/setup/` in a mode-0700 directory, ignored by Git.
Persist operation IDs, sanitized snapshots, intents, results and unresolved
work before/after mutations. Do not store tokens or private keys. The trusted
mutation adapters and durable journal writer are baseline-stage work; they
must exist before any automated mutation is admitted. Current staging is
not a substitute for that journal and does not open an actual session.

## Uncertain creation and restoration

After a lost create response, call `reconcileRepositoryCreation` with the
persisted exact creation intent. It rereads the exact resource and accepts
only its expected owner, name, public visibility and resource ID. It never
calls create. A missing resource after a lost response remains uncertain;
investigate before authorizing any retry. Preserve created resources on later
failure instead of deleting them as compensation.

`closeSetupSession` first journals closure intent, requests restoration through
the trusted adapter and then rereads effective protections even if the request
times out. Its readback must identify the same repository and prove temporary
bypass removal, main force-push/deletion safeguards and verified release
routing. A successful write acknowledgement does not prove closure. Persist
the observed closure result before closing the local scope record. Failed
restoration, contradictory observations or journal failure leave the session
open with ordinary work blocked. Recover through fresh observations and the
recorded before/desired settings; never widen the bypass to proceed.

Journal reads and writes return `Result<T>`. Both closure writes require a
verified result with fresh persistence evidence and the exact persisted
operation ID, repository ID and phase. A blocked, uncertain or conflict intent
write prevents restoration; a nonverified final write prevents session
closure. Void acknowledgements and results for another record are rejected.
Creation recovery accepts only a verified journal read containing the exact
intent, and propagates nonverified reads before observing the remote resource.

Task 4 must additionally verify main signed-commit safeguards, develop
protections, expected check issuers, final develop ancestry and inactive
release grants. Native branch rules do not by themselves enforce source-branch
routing for every direct push; report the trusted release-adapter/maintainer
boundary explicitly. Session closure does not activate ordinary integration.

## Evidence identity

Accepted evidence must be fresh and identify the expected authenticated actor.
For closure, that actor is the session's recorded actor. For creation recovery,
the operation must carry `actorId` from trusted authenticated preflight input;
do not infer expected authority from the journal being checked.

Resource identity has an explicit mapping: journal reads/appends identify the
exact operation ID in `resourceId`; protection observations identify the exact
repository node ID. Creation recovery's repository observation identifies the
observed repository node ID, or the exact approved `owner/name` only when the
repository is absent. Preflight accepts the exact approved `owner/name` or the
observed repository node ID. Every evidence item must match its boundary;
mixed or contradictory actor/resource identities are rejected. This validates
the trusted adapter's evidence contract and does not establish a cryptographic
journal or grant authority to an untrusted caller.

Preflight copies the enclosing verified Result's validated evidence into the
returned snapshot, replacing any missing or divergent nested evidence. The
same snapshot validator therefore applies when opening the setup session.

## Verification and remaining gates

Run `node --test tests/governance/setup.test.mjs` from the eventual checkout.
The suite uses synthetic GitHub observations and actual temporary destination
files. It exercises fail-closed identity, destination, scope, signing,
restoration and uncertain-creation behavior. A passing local suite is not a
live GitHub capability or protection verification.

Current live observations reported by the setup controller on 2026-10-20:
`glyad` is authenticated over HTTPS with repo/workflow/gist/read:org scopes;
the exact repository returned authenticated HTTP 404 and the destination was
absent. Subsequently the user explicitly authorized a dedicated SSH signing
key and public-key registration; the controller verified a disposable signed
commit locally and completed secure Project authorization. Target-local Git
signing configuration and a fresh full preflight remain required before setup;
these staging files do not configure keys or credentials. Refresh observations
before use.

Task 1 remains locally prepared and blocked on actual preflight/signing
verification. No commit is possible until Task 2 creates the signed repository.
Hosted review funding/credentials, local guards, controller trust, release
identity and renewal permissions remain separate later activation gates.
