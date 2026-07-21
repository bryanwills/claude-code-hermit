# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Fixed
- **hatch: register the `briefs` archive in `storage_drift.ignore`** — prevents core session-start and reflect checks from reporting feed-hermit's canonical archive as layout drift.

### Upgrade Instructions

Read `.claude-code-hermit/config.json`. Ensure `storage_drift.ignore` is an array that includes `"briefs"`: if `storage_drift` or `ignore` is absent or malformed, normalize it while preserving valid sibling keys and existing array entries; if the array is valid but does not contain `"briefs"`, append it. Write the updated file. Do not move or rewrite anything under `.claude-code-hermit/briefs/`.

---

## [0.1.0] - 2026-07-20

### Added
- **Initial plugin — feed-to-brief pipeline extracted from a standalone feed hermit.** One domain plugin, four internal layers: (1) brief engine (`feed-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `FEEDS.md` tone template, archive-frontmatter analytics contract, `pending-delivery` recovery queue), (2) source curation (`feed-sources.md`/`feed-categories.md` registry with a `validate-sources` PostToolUse hook, plus `add-source`/`source-scout`/`source-health`), (3) fetch adapters (`reddit-fetch.ts` unauthenticated-by-default with optional authed path; Chrome-typed sources skip gracefully when Chrome is down), (4) `story-arcs` + `deep-dive` follow-ups.
- **`fetch-guard` PreToolUse hook** — WebFetch domain allowlist derived from `feed-sources.md` plus an infra list; blocks off-allowlist fetches (fail-open on unreadable registry) as prompt-injection containment.
- **`hatch`** — seeds empty `feed-sources.md`/`feed-categories.md`/`FEEDS.md` (opt-in starter pack), registers morning/evening/weekly routines and a monthly `source-scout` scheduled check, and appends the Feed Workflow block to the consumer's `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/feed-hermit:hatch` in a project that already has the core hermit hatched.
