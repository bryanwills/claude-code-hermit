# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

---

## [0.0.1] — 2026-04-28

### Added

- **Initial release.** Extracted fitness-domain content from `claude-code-rex-hermit` into a standalone, installable Claude Code plugin.
- **Strava MCP wiring** — `hatch` writes `.mcp.json` with the `@r-huijts/strava-mcp-server` entry and prompts for the four Strava OAuth env vars.
- **`activity-deep-dive` skill** — per-activity coaching analysis: zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate. Saves a compiled artifact.
- **`strava-data-cruncher` subagent** — Haiku bulk-aggregation agent for multi-week trend tables and zone distributions.
- **Four routine prompt templates** — `strava-sync` (daily), `strava-health-check` (daily), `weekly-load-review` (Sunday), `monday-planning` (Monday). Dropped into `.claude-code-hermit/compiled/` by `hatch`.
- **`hatch` wizard** — idempotent setup: prereq check, `.env` verification, MCP registration, routine registration, CLAUDE.md append, knowledge-schema extension.
- **`.claude-plugin/hermit-meta.json`** — hermit-internal sidecar with `required_core_version: >=1.0.21`.

### Changed
- **Monorepo migration** — ships from the `claude-code-hermit` fleet marketplace (`gtapps/claude-code-hermit`). Install: `claude plugin marketplace add gtapps/claude-code-hermit`.
- **Prerequisite version floor** — `hatch` gate is `≥1.0.21` (aligned with `hermit-meta.json`).

### Known follow-ups
- `hatch` Step 6 defers CLAUDE.md block replacement to `hermit-evolve` on re-run; align with HA-hermit's three-branch pattern in a future version.
- `hatch` Step 8b adds all four routines silently; add per-routine opt-in prompts in a future version.

### Upgrade Instructions

No previous version — first install; run `/claude-code-fitness-hermit:hatch`.
