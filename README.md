# GitHub Workspace Manager

Portable AI-assisted GitHub provisioning and configuration management.

## Contents

- [Status](#status)
- [Development](#development)
- [Documentation](#documentation)
- [Community](#community)
- [License](#license)

## Status

Repository governance and contributor baseline for the approved v0.1.0 plan. Product implementation has not started; there is no installable plugin or product CLI yet. The MVP will be installed locally from a verified GitHub Release archive once implemented.

Current handoff, 2026-10-28: Ready CI, PR Draft controls, native Project sync (with installed `PROJECTS_TOKEN`), and the `glyad-workspace-reviewer` App publisher are delivered and active. The owner deleted reviewer scheduling; fresh independent local Astra/High reviews run on demand at actual work checkpoints after current successful Ready CI, using included allowance and existing App reviews/replies. Sol/High self-review remains separate. Genuine App approvals and token revocation were observed for PR63/65; inline/reply/fix behavior awaits genuine future product work, without manufactured findings or idle polling. See the [operational handoff and recovery](docs/governance/reviewer-app-publish.md).

Release packaging/publication is postponed until first delivery and is not a prerequisite for starting product development. Setup closure remains subject to restored and verified branch safeguards; the intended native develop CI gate is pending actual readback. See the [current setup handoff](docs/governance/setup-runbook.md#current-native-operations). Historical formal specs/plans and product scope remain preserved.

The current owner direction uses native Project built-ins and ordinary GitHub Actions. Agent logs, context and checkpoints stay local; Actions needs none of them. External services and custom durability/provenance infrastructure are not setup prerequisites. See the [current operating clarification](docs/project-instructions.md#current-native-setup-direction).

## Development

Install Node.js 24.19.0 and the npm version pinned in package.json. From this checkout run:

```sh
npm ci
npm run check:local
```

These commands validate the governance implementation and contributor baseline. Product build, typecheck and end-to-end commands will be introduced with working product packages.

## Documentation

- [Approved specification](docs/superpowers/specs/2026-10-19-github-workspace-manager-design.md)
- [Architecture](docs/architecture/2026-10-19-github-workspace-manager-architecture.md)
- [Product implementation plan](docs/superpowers/plans/2026-10-19-github-workspace-manager.md)
- [Repository setup plan](docs/superpowers/plans/2026-10-20-repository-and-project-management-setup.md)
- [Architecture decisions](docs/adr/README.md)
- [Deferred backlog](BACKLOG.md)
- [Setup operations and recovery](docs/governance/setup-runbook.md)
- [Ready CI runbook](docs/governance/ready-ci.md) — installed, actual Linux CI verified
- [PR Draft-control runbook](docs/governance/pr-draft.md) — installed, remaining hosted scenarios pending
- [Native Project-sync runbook](docs/governance/native-project-sync.md) — installed access and metadata/closure observations, remaining scenarios pending
- [Local reviewer operational handoff](docs/governance/reviewer-app-publish.md) — on-demand App reviews, observed approvals/revocation and remaining genuine-work observations
- [Owner workflow](AGENTS.md)

## Community

See [contributing](CONTRIBUTING.md), [support](SUPPORT.md), [security reporting](SECURITY.md), and the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Copyright (c) 2026 David Kossoglyad. The adapted [Contributor Covenant](CODE_OF_CONDUCT.md) retains its CC BY-SA 4.0 license and attribution.
