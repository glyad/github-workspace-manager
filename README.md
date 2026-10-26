# GitHub Workspace Manager

Portable AI-assisted GitHub provisioning and configuration management.

## Contents

- [Status](#status)
- [Development](#development)
- [Documentation](#documentation)
- [Community](#community)
- [License](#license)

## Status

Repository governance and contributor baseline for the approved v0.1.0 plan. Product implementation has not started; there is no installable plugin or product CLI yet. The MVP will be installed locally from a verified GitHub Release archive once implemented. Repository automation activation and live protection evidence are tracked separately in the setup runbook.

The current owner direction is to finish the approved repository setup using native Project built-ins and ordinary GitHub Actions. Agent logs, context and checkpoints stay local; Actions needs none of them. External services and custom durability/provenance infrastructure are not setup prerequisites. Reviewed Ready CI, PR Draft controls and Project synchronization source are prepared separately; Ready CI has passed an actual Linux run. Default-branch delivery and live acceptance of the remaining controls, including Project access through `PROJECTS_TOKEN`, are pending. Setup is not complete. Normal GitHub PR reviews use a separate user/App, exclude Copilot, and await the owner-postponed identity/setup decision once the remaining setup is ready. See the [current operating clarification](docs/project-instructions.md#current-native-setup-direction).

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
- [Ready CI runbook](docs/governance/ready-ci.md) — separately prepared source, Linux run verified
- [PR Draft-control runbook](docs/governance/pr-draft.md) — separately prepared source, hosted acceptance pending
- [Native Project-sync runbook](docs/governance/native-project-sync.md) — source prepared, Project credential and default-branch delivery pending
- [Owner workflow](AGENTS.md)

## Community

See [contributing](CONTRIBUTING.md), [support](SUPPORT.md), [security reporting](SECURITY.md), and the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Copyright (c) 2026 David Kossoglyad. The adapted [Contributor Covenant](CODE_OF_CONDUCT.md) retains its CC BY-SA 4.0 license and attribution.
