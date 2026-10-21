# Project baseline runbook

## Contents

- [Authority and scope](#authority-and-scope)
- [Reviewed local preparation](#reviewed-local-preparation)
- [Apply and recovery](#apply-and-recovery)
- [Native presentation verification](#native-presentation-verification)
- [Completion evidence](#completion-evidence)
- [Verified native baseline](#verified-native-baseline)

## Authority and scope

The approved setup plan Task 3 creates a public personal Project named **GitHub Workspace Manager**, associated with `glyad/github-workspace-manager`. Project 1, **Web Components 2.0 — AI-DLC**, is unrelated and must remain untouched. The bounded setup exception permits reviewed setup commits on main; only glyad retains merge authority. No reviewer API spending, secrets, release actor or product implementation is enabled here.

`governance/project.json` defines exact native Status, Priority and Size options. `governance/labels.json` selects fourteen labels and preserves unmanaged labels. Issue types are organization managed; this personal repository uses the selected `type:*` labels. `governance/scope.json` preserves the full approved acceptance content, source section digest and dependency mapping for twenty-four product tasks, eleven separate governance/setup tasks, twelve deferred product backlog entries and one version umbrella. This is forty-eight Issues. The twenty-four product Issues begin Planned under milestone `v0.1.0`; repository setup does not complete product Task 1. Deferred entries remain Backlog without a milestone. Priority and Size remain empty until selected by the owner.

## Reviewed local preparation

Read the actual checkout's AGENTS.md, project instructions, model policy and approved setup/product plans. Confirm the open setup session contains only the six Task 3 additions and the existing package.json path. Run the focused project baseline tests and `npm run check:local` with pinned Node 24.19.0/npm 11.21.1. Freeze a digest manifest for the six additions plus package.json, obtain Sol/High self-review and fresh Astra/High independent review against those exact bytes, then release remote operations. The pure planner never publishes anything.

Construct the configuration by combining project.json with labels.json's `labels` array; pass the approved scope and a fresh authenticated snapshot into `planProjectBaseline(snapshot, config, scope)`. The snapshot must identify glyad, the expected immutable repository ID, and the current Project inventory. A duplicate target title blocks. Check the proposed operation manifest against the scope before applying.

## Apply and recovery

Use `createProjectGitHubPort({root, session})` with the actual authorized session and run `applyProjectBaseline(port, operations)` inside `withProjectBaselineLock(root, callback)`. The port transports exact GraphQL variables or REST bodies through JSON stdin; credentials and raw errors are excluded from evidence. Fresh authenticated owner, repository identity and open session are checked before every operation. A whole-run exclusive local lock prevents concurrent baseline workers; the durable setup journal records operation fingerprints, intent, exact returned node IDs and independent readback.

The journal is private under `.governance-local/setup/`, excluded from Git. It reuses the Task 2 integrity-checked fsync journal rather than inventing a second store. Preserve it between attempts. An unresolved creation intent or lost response is uncertain, and automatic retry stops. An attributable returned ID is recorded before readback; a later run can reuse that exact ID after readback failure. Existing Issue titles or body links do not establish ownership. A changed desired operation fingerprint requires explicit reconciliation rather than silently updating scope. Do not delete or recreate resources to compensate for failure.

The adapter supports a bounded initial baseline of fewer than one hundred resources in each queried connection/list, and stops when pagination would be needed. It never truncates observations or claims complete state from a partial page. This is sufficient for the reviewed initial scope, not a general future Project reconciler.

Read every operation's result. A `verified` apply result covers the configured API postconditions only; the native UI and scope review gates below remain separate. Preserve bindings in the public scope manifest only after independent verification, with source keys retained. Never derive native IDs from titles or copy them between Issue numbers, REST database IDs and GraphQL node IDs.

## Native presentation verification

The current GitHub GraphQL API supports creating/updating named views and their layout/filter/visible fields. Its view configuration input exposes only visibleFieldIds, so configure and verify board Status grouping and table Milestone grouping through the native UI. Read back the saved views' groupByFields, verticalGroupByFields, layout, filter and visible fields; inspect native screenshots before claiming completion. Root controls the browser during setup.

Use the named Status board, Planning by milestone table, Current release, Future releases and Triage views. Current release uses the documented `milestone:"v0.1.0"` filter. Future releases uses `has:milestone -milestone:"v0.1.0"` and must be checked against actual native results; unversioned deferred entries remain separately tracked.

Triage is saved with `no:milestone OR no:priority OR no:size`, which shows an item missing **any** milestone, Priority or Size. Root verified explicit OR in the current native UI using missing-milestone and populated-Status controls, then verified the canonical saved view. Independent API readback confirms this exact filter on view 6. This observed native capability supersedes the currently outdated official statement that cross-field OR is unsupported. A comma in `no:milestone,priority,size` did not provide the desired union; `no:milestone no:priority no:size` is an AND. No extra test Issue or arbitrary Priority/Size value was created to obtain this evidence.

Use native colors and readable text. Verify the selected labels in light and dark mode, with screenshots showing text/contrast. Icons are optional. Keep Conventional Commit type/scope prefixes first in commit/PR titles; Issue titles also preserve explicit semantic prefixes. Links and Markdown checkbox task steps provide context, but only native parent/dependency readback proves relationships.

## Completion evidence

Verify public Project visibility, immutable repository association, exact native field options/colors/descriptions, all forty-eight Issue memberships, all current-version milestone assignments, twenty-four native child relationships and every mapped native dependency. Verify missing Priority/Size remains visible to triage and no product task is claimed complete. Persist stable returned IDs with requirement keys and sanitized evidence URLs; retain native UI evidence separately.

Run relevant local checks after final edits, recheck current main/develop refs and reviewed bytes, sign the setup commit `chore(project): establish version scope and planning views`, immediately push, verify GitHub signature/content and propagate the same baseline to develop with checks. Root coordinates exact review and commit gates. Task 4 must close the temporary exception and verify safeguards before ordinary work; API success alone does not complete baseline handoff.

Primary references: [Projects GraphQL API](https://docs.github.com/en/graphql/reference/projects), [Project filtering](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects), [native sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [native dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), and [organization Issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types-in-an-organization).

## Verified native baseline

The public [Project 2](https://github.com/users/glyad/projects/2) has node ID `PVT_kwHOAECrfc4Bn_FB`, with its repository association and exact native field options read back. All 286 reviewed API operations completed with durable receipts and independent observation: 48 Issue memberships, 24 native parent links and 141 native dependencies. Fresh aggregate readback found 36 Planned and 12 Backlog items, with Priority and Size empty. Public project/scope manifests preserve returned IDs, Issue URLs/numbers and source-key relationship mappings. They keep node IDs distinct from Issue numbers and dependency endpoint pairs.

The saved Status board uses native vertical Status grouping, and the Planning by milestone table uses native Milestone grouping. Saved Triage filter evidence is described above and captured in `task-3-triage-saved.png`; dark-mode label inspection is captured in `task-3-labels-dark.png`. Light-mode label verification remains pending. Root observed one enabled GitHub default Project workflow and left it unchanged; this is distinct from the inactive custom governance automation. The unmanaged native View 1 is retained.

The original private 286-operation driver is historical evidence after this final metadata update. Do not replay it: its frozen hashes and original empty-Triage fingerprint intentionally differ from the finalized native view. Use exact IDs and a separately reviewed narrow operation for later changes. These native configuration results do not establish product completion, active hosted reviewer/release automation or restored Task 4 safeguards. No commit/push is claimed by this section.
