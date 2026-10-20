# Architecture decision records

## Contents

- [Provenance](#provenance)
- [Decisions](#decisions)

## Provenance

Materialized without changing the 17 approved decisions from [specification section 13](../superpowers/specs/2026-10-19-github-workspace-manager-design.md#13-tradeoffs-and-architecture-decision-records), approved 2026-10-19. The repository setup addendum applies only to this repository governance.

## Decisions

- [001: Portable hexagonal core; thin host/provider adapters](001.md)
- [002: Official GitHub MCP preferred, native harness tools and Octokit as appropriate](002.md)
- [003: Guided supervised browser fallback first](003.md)
- [004: Declarative components with explicit management scope](004.md)
- [005: Enforced/advisory governance with defined precedence](005.md)
- [006: Cost preflight and separate financial consent](006.md)
- [007: Deterministic immutable plans and explicit approvals](007.md)
- [008: Local filesystem state, YAML configuration, append-only audit](008.md)
- [009: Hybrid repository-local/central GitOps configuration](009.md)
- [010: Adaptive schema-driven UI with shared drafts](010.md)
- [011: Sequential, idempotent, resumable execution; no automatic destructive rollback](011.md)
- [012: Repository lifecycle first; broader platform capabilities deferred](012.md)
- [013: Reversal wherever feasible; explicit warning and acknowledgment for irreversible effects](013.md)
- [014: Comprehensive operation audit and mandatory pre-change settings snapshots](014.md)
- [015: Repository-governed commits for all post-creation codebase changes](015.md)
- [016: Selectable workflow conventions; Conventional Commits and Git Flow defaults](016.md)
- [017: Workflow detail, merge/review, signing/sign-off, delivery, and recovery controls in MVP](017.md)
