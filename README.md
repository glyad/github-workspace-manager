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
- [Owner workflow](AGENTS.md)

## Community

See [contributing](CONTRIBUTING.md), [support](SUPPORT.md), [security reporting](SECURITY.md), and the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Copyright (c) 2026 David Kossoglyad. The adapted [Contributor Covenant](CODE_OF_CONDUCT.md) retains its CC BY-SA 4.0 license and attribution.
