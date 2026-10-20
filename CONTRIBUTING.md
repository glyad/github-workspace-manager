# Contributing

## Contents

- [Plan and propose](#plan-and-propose)
- [Develop and validate](#develop-and-validate)
- [Review and delivery](#review-and-delivery)

## Plan and propose

Use Issues for bounded work and Discussions for questions and design. Include acceptance criteria, dependencies, linked work, and the proposed version. The maintainer assigns the authoritative milestone and native relationships. Only the human product owner approves scope reduction or deferral. Follow [repository instructions](AGENTS.md) and the [code of conduct](CODE_OF_CONDUCT.md).

## Develop and validate

Use Node.js and npm pinned in package.json. Run `npm ci` and `npm run check:local`. No product package commands exist yet. Work on isolated semantic branches from the fetched current develop parent: feature/**, chore/_, doc/_, or fix/*. Literal parent merges are required before resuming interrupted work and before integration. Preserve dirty work; resolve, validate, sign and immediately push changed merge results. Do not rebase or force-push.

Keep Conventional Commit prefixes parseable. Cryptographically sign every commit; DCO trailers are optional. Configure an existing approved signing identity locally and verify its GitHub association. These instructions grant no key provisioning or credential authority. Local hooks and hosted automation are not installed or activated by running these commands; see the setup runbook for staged status.

## Review and delivery

Open an atomic Draft PR linked to its Issue. Draft skips hosted CI and review. Deliberate readiness must admit current CI; fresh independent Astra/High review follows passing CI while Ready. Changes to base or head invalidate evidence and require the approved Draft/revalidation cycle. Only glyad may authorize integration. Develop requires the selected enforced checks before ordinary integration. Only develop merges main through the approved direct normal-release merge. The temporary setup exception must be closed and safeguards verified before ordinary SDLC. See [full workflow instructions](docs/project-instructions.md).
