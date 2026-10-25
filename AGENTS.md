# Repository instructions

## Contents

- [Authority and scope](#authority-and-scope)
- [Workflow](#workflow)

## Authority and scope

Follow [project custom instructions](docs/project-instructions.md) and [model policy](docs/project-model-policy.md). These editable repository instructions carry forward the approved owner workflow. The 2026-10-20 [setup design](docs/superpowers/specs/2026-10-20-repository-and-project-management-design.md) and [setup plan](docs/superpowers/plans/2026-10-20-repository-and-project-management-setup.md) supersede earlier bootstrap restrictions only for bounded repository and Project setup. Approval history inside copied documents is historical; later approved amendments take precedence.

## Workflow

Use the selected Superpowers subagent workflow and assigned models. Keep ordinary work on isolated branches targeting develop. Merge commits only; signed commits and real local checks are required. Only develop merges main. glyad remains the owner principal; the 2026-10-23 standing delegation permits agents to merge reviewed PRs and delete only their eligible remote head branches after verified parent integration. Preserve signatures, fresh parent synchronization, exact base/head checks and review, and applicable protections. Direct normal-release develop→main authority remains with glyad. No standing bypass is granted. Read all linked project instructions before work. No paid API calls or secrets are authorized by this baseline. Automation remains inactive until its separate gates pass. Before each task inspect the canonical setup ledger, Git state and the completed-code inventory; reuse canonical modules and implement only demonstrated gaps. PR49/50 are settled closed/unmerged as superseded by PR51; retain `chore/30-local-workflow-guards` and `chore/31-readiness-admission`, and do not regenerate their foundation. See the [Project runbook](docs/governance/project-runbook.md#lifecycle-checkpoints-and-continuity).
