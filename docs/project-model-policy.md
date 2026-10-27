# Project model and reasoning policy

Project: GitHub Workspace Manager Plugin  
Source: Explicit user instruction, 2026-10-19

## Table of contents

- [Activity assignments](#activity-assignments)
- [Execution and approval state](#execution-and-approval-state)
- [Additional project instructions](#additional-project-instructions)
- [Current setup clarification](#current-setup-clarification)

## Activity assignments

Use Superpowers for this project's approved development workflow with these role assignments:

| Activity                                                | Model                       | Reasoning effort |
| ------------------------------------------------------- | --------------------------- | ---------------- |
| Brainstorming                                           | GPT-6 Astra (`gpt-6-astra`) | High             |
| Architecture design                                     | GPT-6 Astra (`gpt-6-astra`) | High             |
| Implementation planning                                 | GPT-6 Astra (`gpt-6-astra`) | Medium           |
| Implementation                                          | GPT-6.1 Sol (`gpt-6.1-sol`) | Medium           |
| Document rendering (PDF, Word/DOCX and similar outputs) | GPT-6.1 Sol (`gpt-6.1-sol`) | Medium           |
| Implementation self-review                              | GPT-6.1 Sol (`gpt-6.1-sol`) | High             |
| Independent code review and fix recheck                 | GPT-6 Astra (`gpt-6-astra`) | High             |
| Architecture review                                     | GPT-6 Astra (`gpt-6-astra`) | High             |

For document rendering, format conversion and output-layout work, use GPT-6.1 Sol / Medium (user instruction, 2026-10-20). This includes PDF, Word/DOCX and similar document outputs. Content authoring retains its activity-specific model assignment; rendering self-review follows the existing one-level effort elevation rule (Sol/High).

Apply the selected activity's assignment when dispatching its work. Do not silently substitute another model or effort if an assignment is unavailable; report the limitation. The user explicitly assigned fresh Astra/High independent code review and fix rechecks, separate from Sol/High implementation self-review. Apply that independent code-review role to task/PR and whole-branch code reviews; its assignment does not derive from the architecture-review row. Preserve any additional independent review stages required by the applicable Superpowers workflow.

Automatic GitHub review when a draft PR becomes ready is selected. Pin independent review evidence to the exact base/head commits and recheck fixes; a changed base or head requires a new review. The custom Codex GitHub Action mechanism is selected; credentials, separately billed API spending, and check enforcement remain pending. `glyad` remains the owner principal. The 2026-10-23 standing delegation permits agents to merge reviewed PRs and delete only eligible remote head branches after verified parent integration, with routing, signatures, fresh synchronization, exact base/head checks/review and applicable protection gates preserved. Direct normal-release develop→main authority remains with glyad; this grants no standing bypass, protection change or activation. Model selection does not itself authorize API charges or create a second GitHub approver.

This policy governs future work; it does not claim that earlier documents were created with these settings. Earlier architecture drafting used Astra/Medium at the user's then-current request, and the user subsequently approved that architecture. Do not redo approved documents merely to apply this policy retroactively.

## Execution and approval state

The policy does not grant implementation or remote-resource authorization. Specification and architecture approval are recorded; subagent-driven execution and written implementation-plan approval are recorded. The repository/Project automation design was approved with amendments on 2026-10-20. The remote repository checkpoint remains active; prepare/review the addendum implementation plan and resolve applicable activation gates before execution.

This file is editable project documentation. Synced `AGENTS.md` and all files in `sources/` remain untouched.

## Additional project instructions

Follow [project custom instructions](project-instructions.md): normally elevate self-review one level on the same model, place a linked ToC near the start of project Markdown, and render PDFs of final approved documents. Planning: Astra/Medium → self-review Astra/High. Implementation: Sol/Medium → self-review Sol/High. Under the user's latest exception, Astra/High work self-reviews at Astra/High by default; mandatory or automatic Astra/XHigh escalation is removed. XHigh is optional only for a genuinely necessary task-specific choice, not a routine requirement. Do not claim the same-effort pass is elevated. Do not recursively elevate a self-review or reinterpret historical completed XHigh reviews. Self-review does not replace required independent review, which remains Astra/High.

Prefer included Codex usage and eligible resets for app work, subject to authoritative eligibility checks and explicit confirmation for each redemption. Resets do not fund the selected Action's separately billed API-key usage. Defer its funding question until enablement requires it; no paid calls, credentials, or automatic-review enablement are authorized yet. Follow the linked instructions for the usage/billing distinction and do not claim app reviews are the configured GitHub automation.

## Current setup clarification

The owner's 2026-10-25–26 direction is to execute the existing approved repository setup through native Project built-ins and ordinary Actions, without another architecture/approval cycle for that setup. Local agent logs, context and checkpoints stay local and are not Actions inputs. External services, custom durability/provenance infrastructure, dormant controller activation and approval of the discarded amendment are not prerequisites for these ordinary flows. Earlier formal product documents and historical implementations remain preserved; this clarification does not amend product scope or create a blanket future waiver.

Normal GitHub PR reviews use a separate user/App, exclude Copilot, and await the owner-postponed reviewer identity/setup decision until the remaining setup is ready. The earlier custom Codex Action selection is not a current setup prerequisite. Do not ask prematurely for API keys/funding or infer paid-use authorization. All activity model/effort assignments, separate self-review and independent-review roles, branching/checks and actual access/protection boundaries remain unchanged; no model substitution, credential grant or reviewer activation follows from this clarification. See the [current operating direction](project-instructions.md#current-native-setup-direction).

Latest owner selection, 2026-10-27: use fresh local Codex GPT-6 Astra/High
independent reviewers under included allowance, with actual model/effort selection
in the invocation; retain separate Sol/High self-review. The existing
`glyad-workspace-reviewer` App is the native publishing persona. This replaces the
postponed identity/paid-reviewer setup direction above for current ordinary setup.
The [local handoff](governance/reviewer-app-publish.md) carries only bounded public
review text/target metadata; full local context stays private. Publication cannot
prove model authorship. Manual publication does not install the later local app
heartbeat or establish its end-to-end acceptance. No paid API fallback is authorized.
