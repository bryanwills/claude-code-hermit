# Changelog

All notable changes to this project will be documented in this file.

---

## [0.0.2] - 2026-05-03

### Changed

- **hatch: core hermit floor raised to ≥1.0.26** — prerequisite for docker-security overlay and recent hermit-evolve reliability fixes. Hatch now warns and stops if the installed core version is below `1.0.26`.
- **hatch: docker-security DNS allowlist** — added `strava.com` domain entry under a new `## Docker network requirements` section so `/claude-code-hermit:docker-security` can surface it when the operator enables LAN containment.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.0.26` |
| `.claude-plugin/plugin.json` | `dependencies.claude-code-hermit` bumped to `^1.0.26` |
| `skills/hatch/SKILL.md` | Version check floor raised to `1.0.26`; docker-security DNS block added |
| `CLAUDE.md` | Core version reference updated to `≥1.0.26` |
| `README.md` | Core version badge updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core hermit version** — run `/claude-code-hermit:hermit-doctor` and confirm it reports `claude-code-hermit ≥1.0.26`. If not, run `/claude-code-hermit:hermit-evolve` on the core plugin first.

No `config.json` changes required.

---

## [0.0.1] — 2026-04-28

### Added

- **Initial public release.**

### Upgrade Instructions

No previous version — first install; run `/claude-code-fitness-hermit:hatch`.
