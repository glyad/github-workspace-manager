# Security policy

## Contents

- [Report privately](#report-privately)
- [Supported versions](#supported-versions)

- [CI and reviewer trust boundary](#ci-and-reviewer-trust-boundary)

## Report privately

Send vulnerability reports privately to [david@logoui.co.il](mailto:david@logoui.co.il). Include affected revision, impact, and safe reproduction details. Do not put credentials or exploit details in public Issues. GitHub private vulnerability reporting may be used when separately verified enabled. No response SLA is selected.

## Supported versions

The project is in development and has no published supported release. Security updates and supported release lines will be documented when releases exist.

## CI and reviewer trust boundary

Candidate CI and review are inactive. CI may execute untrusted candidate scripts only in a separate unprivileged Linux job with no mutation credentials, API key or secret-bearing cache. Read-only checkout credentials are not persisted. Diagnostic artifacts are untrusted data, expire after 14 days, and are never independent proof of run/result provenance. Durable release evidence is separate.

The reviewer must use trusted runner code and a separately validated PR-data extraction path, with no candidate hooks, AGENTS, skills, MCPs or scripts in its executable/configuration path. Model tools must not receive API keys or posting credentials. Privileged result posting is separate and requires independently authenticated exact-byte/run binding plus fresh candidate admission. Public forks remain blocked pending a disposable malicious-input boundary demonstration. The selected Action's read-only strategy alone is insufficient for secret isolation; no local test claims that demonstration. See [activation gates](docs/governance/activation-runbook.md#isolated-workers-and-review-activation).
