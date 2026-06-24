# Changelog — laravel-forge-hermit

## [0.0.3] - 2026-06-24

### Fixed
- **hatch: domain auto-resume** — writes a state marker before delegating to core; core terminus invokes this skill via the Skill tool automatically. Removes the manual re-run. Requires `claude-code-hermit` ≥1.2.11.

## [0.0.2] - 2026-06-23

### Fixed

- **hatch: correct Forge API token URL** — was `/user-profile/api`, now `/profile/api` (also corrected in `forge.php` "no orgs found" error).
- **hatch: domain resume after core hatch** — Step 1 now prints the re-run instruction before invoking core as the terminal action, so the operator sees it. Removes the "then continue" assumption that silently dropped Step 2.

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Correct token URL in setup prompt and invalid-token message; domain resume stop-instead-of-continue |
| `php/forge.php` | Correct token URL in "no orgs found" error message |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the laravel-forge hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill and script.

No `config.json` changes required.

## [0.0.1] — 2026-06-22

### Added

- **forge.php: dispatch script** — pure PHP v8.5+ over `laravel/forge-sdk` v4; read-only generic dispatch (`call <method>`, closed allowlist), curated read commands, preview commands, `--confirm`-gated `deploy` (fire-and-return) + `server-reboot`, `deploy-status` poll, `failed-deploys` org-wide scan.
- **write-confirm-gate hook** — PreToolUse Bash hook; blocks `deploy`/`server-reboot` lacking `--confirm`, passes all preview/read commands, fails open on unparseable input.
- **6 skills**: `hatch`, `forge-servers`, `forge-sites`, `forge-deploy`, `forge-logs`, `forge-failed-deploys`.
- **forge-deploy watch via the hermit watch registry** — `deploy` returns immediately with canonical IDs; the skill arms a non-blocking watch through `/claude-code-hermit:watch` that polls `deploy-status` to a terminal state, then relays the outcome via the core Operator Notification protocol.
- **`forge-failed-deploys` scheduled check** — daily estate scan via `organizationSites()->lazy()`; analysis-only, routes `[reliability]` proposals.
- **`deploy-incident` artifact** — on a failed terminal deploy status, `forge-deploy` writes a scrubbed log tail to `compiled/deploy-incident-<site>-<date>.md`.
- **Vendor-free shipping** — `composer.json` + `composer.lock` ship; `hatch` installs SDK `--no-dev` into `<project>/.claude-code-hermit/forge-runtime/` (isolated from app deps).
- **Docker support** — `DOCKER.md` wires `php-cli`, `php-curl`, `composer` apt packages + `forge.laravel.com` + packagist/github DNS allowlist; targets Ubuntu 26.04 LTS base (core prerequisite).
