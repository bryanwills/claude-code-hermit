# Changelog — laravel-forge-hermit

## [0.0.9] - 2026-07-26

### Added
- `forge.php deploy-watch <server-id> <site-id> <deploy-id>` replaces the hand-transcribed watch loop in `forge-deploy`; terminal statuses now come from the shared `STATUS_*` constants. `deploy` points at it in its `Watch with:` hint, and a failing poll now emits the exception class as a watch event instead of surfacing only as a `status=timeout` 15 minutes on.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the hardcoded `1.1.1` floor its prose carried. That floor sat many minor versions below what the manifest declared, so the wizard proceeded against a core too old for it. The PHP 8.5 floor is unaffected and still checked in Step 2.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight laravel-forge-hermit` resolves the target, `ensure-target` records an operator override, `sync-block` writes the block. The skill no longer detects install scope from `claude plugin list --json` or stamps `hatch-options.json`.
- `hatch` re-reads `config.json` immediately before merging its scheduled check, runtime-dir registration and version stamp, instead of reusing the copy it loaded before the wizard ran. Anything written to the file during the wizard is no longer clobbered.
- Requires core `>=1.2.34` for the shared `domain-hatch` protocol. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- The CLAUDE-APPEND block keeps the surface-then-approve rule and the outage warning but drops the restated 4-step walk (`forge-deploy` and `forge-servers` own it), two of three `call` examples, and the `forge-failed-deploys` contract. 2,993 B → ~2,265 B. Enforcement is now stated accurately: the hook and the in-PHP gate are two layers with the PHP gate authoritative, replacing "neither can be bypassed".
- `[hygiene]` and `[deploy-safety]` proposal prefixes removed — no skill produces either, so both were vocabulary paid for in every session. `[reliability]` remains.

## [0.0.8] - 2026-07-21

### Fixed
- No-op `Write(<path>)` allow rules were removed from `settings.json`; their `Edit(...)` equivalents still grant access and avoid the boot warning.

## [0.0.7] - 2026-07-15

### Added
- Log access for apps running as Forge background processes through `background-process-log <server> <process-id>` and `backgroundProcessLog` (#606).
- Previously unreachable site logs through `site-log <server> <site> <type>` for `application`, `nginx-access`, and `nginx-error`.
- 43 SDK detail, output, and config read methods in the allowlist, while secret-bearing reads remain excluded and test-enforced.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the new log commands are picked up from the plugin install path on the next session.

No config.json changes required.

## [0.0.6] - 2026-07-10

### Fixed
- `server-log <server> php` now resolves the server's PHP-FPM log key, such as `php-8.3`, from `php_version`.
- Missing `server-log` keys now show a readable message instead of throwing an uncaught exception.

## [0.0.5] - 2026-07-03

### Changed
- The `forge-failed-deploys` skill now names `reflect --scheduled-checks`, the surviving core invocation; the scheduled-check behavior is unchanged.

## [0.0.4] - 2026-06-26

### Fixed
- Hatch now idempotently adds `forge-runtime` to `config.storage_drift.ignore`, preventing false storage-drift reports for the Composer vendor tree. Requires `claude-code-hermit` 1.2.12 or later.
- Nginx `server-log` keys use hyphens: `nginx-error` and `nginx-access`; underscored variants return 404.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Register `forge-runtime` in `storage_drift.ignore`.** Read `.claude-code-hermit/config.json`. If `storage_drift.ignore` is absent or not an array, add `"storage_drift": {"ignore": ["forge-runtime"]}` at the top level. If it is already an array but does not contain `"forge-runtime"`, append it. Write the updated file.

No other `config.json` changes required.

## [0.0.3] - 2026-06-24

### Fixed
- Hatch writes a state marker before delegating to core, which automatically resumes this skill without a manual rerun. Requires `claude-code-hermit` 1.2.11 or later.

## [0.0.2] - 2026-06-23

### Fixed

- The Forge API token URL now uses `/profile/api` instead of `/user-profile/api`, including the `forge.php` “no orgs found” error.
- Hatch now shows the domain-resume instruction before invoking core, so the terminal action does not drop Step 2.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the laravel-forge hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill and script.

No `config.json` changes required.

## [0.0.1] — 2026-06-22

### Added

- A pure-PHP `forge.php` dispatcher over `laravel/forge-sdk` v4, with closed-allowlist reads, previews, `--confirm`-gated writes, deploy polling, and estate-wide failed-deploy scans.
- A fail-open `write-confirm-gate` PreToolUse Bash hook that blocks `deploy` and `server-reboot` without `--confirm`.
- Six skills: `hatch`, `forge-servers`, `forge-sites`, `forge-deploy`, `forge-logs`, and `forge-failed-deploys`.
- Non-blocking `forge-deploy` watches through `/claude-code-hermit:watch`, polling `deploy-status` and relaying terminal outcomes through the Operator Notification protocol.
- A daily analysis-only `forge-failed-deploys` check using `organizationSites()->lazy()` that routes `[reliability]` proposals.
- A scrubbed failed-deploy log artifact at `compiled/deploy-incident-<site>-<date>.md`.
- Vendor-free shipping with `composer.json` and `composer.lock`; Hatch installs the SDK with `--no-dev` into `<project>/.claude-code-hermit/forge-runtime/`.
- Docker support in `DOCKER.md` for `php-cli`, `php-curl`, and `composer`, plus Forge and package-registry DNS allowlists on Ubuntu 26.04 LTS.
