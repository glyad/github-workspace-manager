# Contributor baseline operations

## Contents

- [Preparation and authority](#preparation-and-authority)
- [Durable recovery](#durable-recovery)
- [Verification and limitations](#verification-and-limitations)

## Preparation and authority

The approved setup addendum permits bounded repository and Project setup on main, including root and .github changes. Ordinary product work remains excluded. The exact reviewed file manifest freezes SHA-256 content. The baseline adapter permits an additional AGENTS.md path only when its independently approved digest is recorded in the setup session as supplementalAgentsDigest. Other scope continues through the Task 1 setup path checks.

Use the maintainer's existing secure GitHub CLI authentication and approved signing key. Configure signing only in the destination repository. The disposable verification wrapper preserves the existing local allowed-signers and signing-program settings; no key bytes or credentials are read into application evidence. Before the initial branch exists, verify repository rulesets and administrative identity explicitly; a missing branch rules endpoint does not prove the absence of applicable rules.

The approved product specification, architecture, plans, and project instructions are copied without rewriting historical approval statements. The later approved 2026-10-20 addendum and recorded user amendments govern this setup. ADRs 001–017 and deferred backlog preserve the earlier approved decisions. Public release PDFs remain in the preparation workspace pending later approved rendering and content verification.

## Durable recovery

Create the local journal before any live mutation. Its .governance-local/setup directory is ignored and mode 0700; records are mode 0600 JSONL. Appends serialize through exclusive operation locks, hash-chain records, sync the file and directory metadata, and read back the result. Newly created directory links are synced through their parents. A leftover lock, malformed record, incomplete line, unexpected permissions or symlink blocks writes. Investigate and reconcile the actual remote resource before any manual lock recovery.

Record a stable creation operation ID, authenticated actor ID, and exact repository name. Persist creation intent before the final absent-state observation and one creation attempt. A successful creation response is durably recorded with its exact repository ID before independent readback. That receipt is attribution evidence, not proof of a verified baseline. A failed readback may resume only against the receipt ID. If the creation response is lost and no attributable exact receipt exists, fresh observation does not establish ownership by this setup: the operation remains uncertain pending an explicit adoption decision. It never causes an automatic second create. An unexpected resource before creation is recorded as a precondition conflict and cannot be adopted by resuming the same intent. A previous verified repository ID cannot silently become a recreated repository. A preexisting unjournaled resource requires explicit adoption review. Never delete a created repository as compensation for a later setup failure.

The baseline operation records its frozen file manifest before settings changes. Settings acknowledgements are insufficient: read back effective settings, the GitHub-verified signed main commit, matching develop commit, and the full remote file tree. Every directory must be an expected parent of a frozen file; every other entry must be an approved regular file. Unexpected submodules, symlinks, paths, and duplicate entries block verification. Description and repository Projects availability are included in effective setting checks. Restore and verify protections under the separate setup closure task before ordinary SDLC.

## Verification and limitations

Use the exact Node/npm declarations in package.json and .node-version, then run:

```sh
npm ci
npm run check:local
```

The aggregate runs node:test governance tests, ESLint over actual governance JavaScript, Prettier, and the public-seed policy checker. The initial Task 1 reviewed bytes and approved historical source documents remain frozen; formatting applies to the new baseline files. Issue forms are JSON-formatted YAML 1.2 with explicit JSON formatting checks and required-field validation. No product build or typecheck command is advertised.

The local journal trusts the authorized local maintainer and OS permissions; it cannot authenticate records against the same OS user deliberately rewriting the journal. Its hash chain detects corrupt or incomplete retained records. GitHub APIs do not supply a universal transaction: a race after the final read remains a fail-closed reconciliation boundary. The tools do not activate hooks, hosted CI, paid review, release identity, Project automation, or ordinary integration. Live outcomes are reported only after actual readback, separately from local tests and review.
