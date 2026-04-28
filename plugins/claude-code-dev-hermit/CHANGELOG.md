# Changelog

## [0.2.2] - 2026-04-28

### Added

- **dev-pr: new skill** — opens a PR from the current feature branch. Assembles title + body from `/dev-quality` output, commits, work-binding context, screenshots, and an optional project PR template. Gates: protected-branch, clean tree, commits-ahead, fresh quality report, no unresolved health-degraded alerts. Accepts `--force` to skip quality and alert gates. Writes PR URL to `state/bindings.json`.
- **watchdog: health + error monitors** — `watchdog-health.js` polls `dev_health_url` and emits `health-degraded`/`health-recovered`; `watchdog-errors.js` tails the dev-server log and emits `error-spike`/`error-cleared` when rolling error count crosses `dev_watchdog.log_error_alert_threshold`. Registered by `/dev-up` Gate 5b in always-on mode; skipped in interactive mode or when `dev_watchdog.enabled === false`.
- **`scripts/lib/alerts-store.js`** — atomic `state/alerts.json` helpers with MAX_ALERTS=50 pruning and deduplication. Shared by both watchdog processes and `/dev-status`.
- **`scripts/lib/pr-body-builder.js`** — pure function assembling PR title + body from commits, quality report, binding, screenshots, and project template.

### Changed

- **dev-up: worktree `cwd` support** — when `$HERMIT_AGENT_WORKTREE` is set, the dev-server Monitor pipeline `cd`s into the worktree first so the server runs on the agent's branch, not the operator's checkout. A `cd` failure emits a `[dev-up] Fatal:` sentinel surfaced as a notification rather than silently falling back.
- **dev-up: watchdog registration (Gate 5b)** — in always-on mode, registers `dev-watchdog-health` and `dev-watchdog-errors` as persistent Monitor entries after the dev-server starts. Both shut down on `/dev-down`.
- **dev-up: `dev_port_agent` config key** — when `$HERMIT_AGENT_WORKTREE` is set, resolves the port from `dev_port_agent` instead of `dev_required_ports[0]`, so the agent's server doesn't collide with the operator's.
- **dev-adapt: PR template + GitLab detection** — reads `.github/PULL_REQUEST_TEMPLATE.md` / `docs/pull_request_template.md` during discovery; detects `.gitlab-ci.yml` and sets `commands.pr_create` default for GitLab remotes.
- **dev-quality / dev-status / dev-branch / dev-down / dev-cleanup / dev-doctor** — surface watchdog alerts in status output; `/dev-down` shuts down watchdog entries.
- **state-templates/CLAUDE-APPEND.md** — `/dev-pr` usage rules and watchdog alert acknowledgement flow added.
- **required_core_version: bumped to `>=1.0.22`** — worktree cwd support depends on `$HERMIT_AGENT_WORKTREE` set by hermit-start.py v1.0.22.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-pr/SKILL.md` | New skill |
| `scripts/lib/pr-body-builder.js` + `.test.js` | New: PR body builder (66 tests) |
| `scripts/lib/alerts-store.js` + `.test.js` | New: atomic alerts store (16 tests) |
| `scripts/watchdog-health.js` + `.test.js` | New: health watchdog (19 tests) |
| `scripts/watchdog-errors.js` + `.test.js` | New: error-spike watchdog (27 tests) |
| `skills/dev-up/SKILL.md` | Worktree cwd, watchdog registration, `dev_port_agent` resolution |
| `skills/dev-adapt/SKILL.md` | PR template detection; GitLab `commands.pr_create` default |
| `skills/dev-quality/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-status/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-branch/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-down/SKILL.md` | Watchdog Monitor entry shutdown |
| `skills/dev-cleanup/SKILL.md` | Watchdog state cleanup |
| `skills/dev-doctor/SKILL.md` | Watchdog config checks |
| `state-templates/CLAUDE-APPEND.md` | `/dev-pr` rules + watchdog ack flow |
| `.claude-plugin/hermit-meta.json` | `required_core_version`: `>=1.0.21` → `>=1.0.22` |
| `README.md` | Rewrite for hermit fleet marketing launch |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** all `skills/dev-*.md` files from the updated plugin.
2. **Copy** `scripts/lib/alerts-store.js`, `scripts/watchdog-health.js`, `scripts/watchdog-errors.js`, and `scripts/lib/pr-body-builder.js` into the hermit's scripts directory.
3. **Append** the `/dev-pr` usage rules and watchdog alert acknowledgement section to the hermit's `CLAUDE.md` (from `state-templates/CLAUDE-APPEND.md`).

No `config.json` changes required.

**Note:** Two new optional config keys: `dev_port_agent` (integer, port for the agent-worktree dev server) and `dev_watchdog` (object with `enabled`, `log_error_alert_threshold`, `poll_interval_ms`). Watchdog is enabled by default when `dev_health_url` is set.

### Internal

- **Structure cleanup** — promoted watchdog scripts to `scripts/` (entrypoints), added `tests/run-all.sh` central runner, moved `skill-structure.test.js` to `tests/`, removed empty `.claude/` artifact and `.vscode/` personal-pref file. Added `scripts/lib/ must be pure` rule to CONTRIBUTING.md.
- **Doc corrections** — bumped prereq refs from `v1.0.21+` → `v1.0.22+` in README and CONTRIBUTING; removed `docs/SKILLS.md` (redundant with per-skill `SKILL.md` files); refreshed skill list in CLAUDE.md (added `dev-pr`); updated CONTRIBUTING project structure and test runner command.

## [0.2.1] - 2026-04-27

### Fixed

- **`dev-up`: dev server no longer killed by Monitor on chatty output** — Gate 5 now wraps `commands.dev_start` in `{ … } 2>&1 | tee .claude-code-hermit/state/dev-server.log | grep --line-buffered -E <pattern> || true`. Monitor receives only error-matched lines and never trips its notification-rate limit. Full stdout is preserved in the log file for forensics. Error pattern defaults to anchored Node/Vite/Next.js signals (e.g. `^\s*(Error|TypeError|...):`, `EADDRINUSE`, `Uncaught`) to avoid false-positives on the bare word "error" common in Next.js compile output; override via `dev_error_pattern` in config.

### Added

- **`scripts/lib/dev-server-command.js`** — builds the Monitor pipeline command for `/dev-up` Gate 5. Handles shell-escaping of `commands.dev_start`, log path, and error pattern via `shellQuote`; ships the anchored default regex; exports `buildDevServerCommand({ devStart, logPath, errorPattern })`. Co-located `dev-server-command.test.js` covers input validation, defaulting, shell-injection safety (`bash -n` round-trips for adversarial inputs), and runtime smoke (filter correctness, zero-match exit-0 guard).

### Changed

- **`dev-adapt` and `dev-up` examples neutralized for OSS** — dropped `local:dev` from the `package.json#scripts` priority list; swapped worked-example output to `npm run dev` / `direnv status`. Detection logic unchanged.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-up/SKILL.md` | Gate 5 rewritten to use tee\|grep pipeline via helper; error pattern resolution documented |
| `scripts/lib/dev-server-command.js` | New: pipeline builder with shell-safe composition and default error regex |
| `scripts/lib/dev-server-command.test.js` | New: 18 tests covering validation, escaping, and runtime behaviour |
| `skills/dev-adapt/SKILL.md` | OSS example neutralization |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `skills/dev-up/SKILL.md` from the plugin.

No `config.json` changes required.

**Note:** `/dev-up` now writes full dev-server stdout to `.claude-code-hermit/state/dev-server.log` each session (truncated at each boot). Only error-matched lines appear as Monitor notifications. To tune the error pattern, set `claude-code-dev-hermit.dev_error_pattern` in `.claude-code-hermit/config.json`.

## [0.2.0] - 2026-04-27

### Added

- **`/dev-branch` skill** — feature-branch creation gate. 8 checks: prerequisites, clean tree, fetch, base resolve, worktree/name collision, checkout from `origin/<base>`.
- **`/dev-up` skill** — boot a session-scoped dev server in a Monitor entry; gated on ports, optional auth probe, optional HTTP health-poll until 2xx.
- **`/dev-down` skill** — stop the dev-server Monitor entry; runs `commands.dev_stop` if configured, else SIGTERM-drain-SIGKILL via `/watch`.
- **`/dev-log-watch` skill** — generator emitting a Monitor entry that tails the dev log; rotating-vs-fixed pattern detection per stack.
- **`/dev-status` skill** — three-line read-only status: branch, dev-server, worktree refs. Fail-soft per section, no setup required.
- **`scripts/lib/` shared Node helpers** — `resolve-command`, `port-check`, `health-poll`, `log-watch-builder`, `shell-utils`, each with a co-located `.test.js`.
- **`docs/DEV-LOG-WATCH.md`** — recipe for tailing rotating dev logs into a `/watch` monitor. Cross-linked from `/dev-log-watch`.

### Changed

- **`dev-doctor` check #4 promoted WARN → FAIL** — missing/empty `protected_branches` now hard-fails; required by `/dev-branch` base resolution.
- **`dev-doctor` check #14 added** — env-leakage scan flags credential-like keys in auto-loaded `.env*` files; framework-public prefixes excluded.
- **`dev-doctor` checks #15–17 added** — `commands.dev_start` reachable; `dev_log_path_pattern` parent exists; `dev_required_ports` range and `dev_expected_listeners ⊆ dev_required_ports`.
- **`dev-doctor` check #5 migrated to `scripts/lib/resolve-command.js`** — same behaviour as before; single source of truth shared with check #15.
- **`dev-adapt` extended for dev-server profiling** — new "Dev environment" proposal block detects `commands.dev_start`, ports, health URL, auth, log pattern. Skipped on mobile/desktop/library projects.
- **`CLAUDE-APPEND.md`: `/dev-branch` step inserted into Implement** — main session runs `/dev-branch` first when on a protected branch.
- **`CLAUDE-APPEND.md`: Local Dev Environment subsection added** — frames `/dev-up`/`/dev-down`/`/dev-log-watch` as operator-invoked, session-scoped (Monitor stops at `/session-close`).
- **`docs/SKILLS.md` now documents all nine skills** — backfilled `dev-adapt`/`dev-branch`/`dev-doctor`; added `dev-up`/`dev-down`/`dev-log-watch`/`dev-status`.
- **README skills table + hatch Available-skills report list the five new skills** — discoverable post-install. README "How It Works" Implement step names `/dev-branch` explicitly; lifecycle-skills preamble added.
- **plugin.json: native `dependencies` field added; range tightened to `^1.0.18`** — enables Claude Code's native resolver to auto-install core; `required_core_version` and `requires` stay `>=` for runtime gating.
- **manifest: move hermit-internal fields to `hermit-meta.json` sidecar.** `required_core_version` and `requires` removed from `plugin.json` so `claude plugin tag --push` passes the native validator cleanly.
- **Prerequisite bumped to Claude Code v2.1.110+** — required by `claude plugin tag` and the dep resolver. Updated `docs/HOW-TO-USE.md`, `CONTRIBUTING.md`.
- **Per-plugin release skill removed** — root `/release claude-code-dev-hermit` covers the full validation suite; per-plugin skill was a lower-fidelity duplicate.
- **core requirement bumped to `>=1.0.21` / `^1.0.21`** — was `>=1.0.18` / `^1.0.18`. Aligns the dev plugin with the upcoming core release. `required_core_version` + `requires` (in `hermit-meta.json`) and `dependencies[0].version` (in `plugin.json`) all bumped together. Updated `README.md` (badge + Prerequisites), `CLAUDE.md` (Depends On), `CONTRIBUTING.md` (also clears stale `v1.0.16+` reference).

### Files affected

| File | Change |
|------|--------|
| `skills/dev-branch/SKILL.md` | Added: feature-branch creation gate (8 checks) |
| `skills/dev-up/SKILL.md` | Added: boot the session-scoped dev server (7 gates) |
| `skills/dev-down/SKILL.md` | Added: stop the dev server (3 gates) |
| `skills/dev-log-watch/SKILL.md` | Added: generate a Monitor entry tailing dev logs (4 gates) |
| `skills/dev-status/SKILL.md` | Added: read-only branch/dev-server/worktree status (fail-soft) |
| `scripts/lib/resolve-command.js` + `.test.js` | Added: shared command-resolver; powers dev-doctor #5/#15 |
| `scripts/lib/port-check.js` + `.test.js` | Added: lsof/ss listener probe with allowlist match |
| `scripts/lib/health-poll.js` + `.test.js` | Added: HTTP health probe with retry until timeout |
| `scripts/lib/log-watch-builder.js` + `.test.js` | Added: emits canonical bash one-liner per `dev_log_path_pattern` shape |
| `scripts/lib/shell-utils.js` | Added: shared POSIX single-quote escaper |
| `scripts/lib/skill-structure.test.js` | Added: structural lint for new SKILL.md files |
| `skills/dev-adapt/SKILL.md` | Extended: Dev environment proposal block + fourth AskUserQuestion |
| `skills/dev-doctor/SKILL.md` | Check #4 WARN→FAIL; checks #14, #15, #16, #17 added; #5 migrated to helper |
| `docs/DEV-LOG-WATCH.md` | Added: recipe for tailing rotating dev logs |
| `docs/SKILLS.md` | Backfilled dev-adapt/dev-branch/dev-doctor; added dev-up/dev-down/dev-log-watch/dev-status |
| `skills/hatch/SKILL.md` | Available-skills report lists dev-branch + dev-up/dev-down/dev-log-watch |
| `state-templates/CLAUDE-APPEND.md` | dev-branch step inserted into Implement; Local Dev Environment subsection added |
| `README.md` | New skills rows in table; DEV-LOG-WATCH link; Implement step + lifecycle preamble |
| `CLAUDE.md` (plugin-local) | Refreshed Plugin Structure to match new layout |
| `docs/HOW-TO-USE.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `CONTRIBUTING.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `.claude-plugin/plugin.json` | `dependencies` array added; range tightened to `^1.0.18` |
| `.claude/skills/release/SKILL.md` | Deleted: superseded by root `/release` skill |
| `.claude-plugin/hermit-meta.json` | `required_core_version` + `requires`: `>=1.0.18` → `>=1.0.21` |
| `.claude-plugin/plugin.json` | `dependencies[0].version`: `^1.0.18` → `^1.0.21` |
| `README.md` | Badge + Prerequisites line: `v1.0.18+` → `v1.0.21+` |
| `CLAUDE.md` | Depends On: `v1.0.18+` → `v1.0.21+` |
| `CONTRIBUTING.md` | Prereq: `v1.0.16+` → `v1.0.21+` (stale) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `/claude-code-dev-hermit:dev-adapt`** to populate `protected_branches` (now FAIL if missing) and the new `dev_*` config block.
2. **Refresh `state-templates/CLAUDE-APPEND.md`** so projects pick up the `/dev-branch` Implement step and the Local Dev Environment subsection.

**Note:** `/dev-up`, `/dev-down`, `/dev-log-watch`, and `/dev-status` ship enabled but the new `dev_*` keys are individually optional — configs without them are unaffected, and the lifecycle skills refuse cleanly when their fields are unset. `dev-doctor` check count: 13 → 17.

`config.json` schema additions (all under `claude-code-dev-hermit.*`, all optional): `commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`. `commands.dev_start` is the minimum for `/dev-up`.

## [0.1.9] - 2026-04-27

### Changed

- **Monorepo housekeeping.** Plugin source moved into `plugins/claude-code-dev-hermit/` of the `gtapps/claude-code-hermit` monorepo. `required_core_version` reconciled to semver-range form (`>=1.0.18`); a parallel `requires.claude-code-hermit` field was added to mirror it. Inner `.claude-plugin/marketplace.json` removed (the repo-root marketplace catalog is now authoritative). README and Documentation links now point at the monorepo.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup only.

No `config.json` changes required.

## [0.1.8] - 2026-04-24

### Changed
- **Minimum core version bumped to v1.0.18** — adapts to the `/doctor` → `/hermit-doctor` rename in claude-code-hermit v1.0.18; `dev-doctor` manual mode composition and the hatch prereq gate are updated accordingly.

### Added
- **`docs/WORKFLOW.md`** — end-to-end task lifecycle reference (what fires, in what order, what state it writes); linked from README Documentation.

---

## [0.1.7] - 2026-04-24

### Added
- `create-pr` skill — push, draft title/body, open PR via `gh`
- `dev-doctor` skill — manual + scheduled modes, composes core validators
- `dev-adapt` skill — project profiling, config persistence, compiled artifact
- Implementer stop conditions + config-driven test command
- Config-driven `git-push-guard` with tokenizer parser + propagate protected branches

### Fixed
- Hardened implementer worktree isolation — branch-handoff, safety rails, `.worktreeinclude`
- Implementer handoff, dev-quality bugs, commit-format detection

### Changed
- Rewrote `/dev-quality` — deterministic commands, surgical undo, judgment risk assessment
- Namespaced dev-hermit config keys under `claude-code-dev-hermit`

---

## [0.1.6] - 2026-04-22

### Changed

- **implementer: stronger Concerns contract** — The Concerns return section now requires flagging any non-obvious, load-bearing choice with a `Rejected alternatives:` sub-bullet naming what was considered and why it was rejected. This prevents the main session from "tidying" the implementer's code into a regression (motivated by a real incident where a misleading PHPDoc caused the caller to replace correct-but-unusual framework wiring with a more idiomatic approach that failed). The implementer also now treats caller-provided architectures (e.g. from `/feature-dev:feature-dev`) as hard constraints, surfacing deviations in Concerns rather than silently picking a different approach.
- **dev workflow: verify before overriding implementer choices** — `CLAUDE-APPEND.md` step 3 now instructs the main session to run the implementer's tests before overriding any non-obvious choice; if they pass, the choice should be treated as potentially load-bearing and traced before replacement. If no tests exist, trace before overriding.
- **dev workflow: `/dev-quality` vs `/simplify` clarification** — Step 4 now explains that `/dev-quality` is the end-of-task gate (it wraps `/simplify` plus test invocation); direct `/simplify` calls should be reserved for mid-task cleanup and post-`/batch` follow-up only. Consistent across `CLAUDE-APPEND.md`, `HOW-TO-USE.md`, and `README.md`.
- **dev workflow: optional planning gate via feature-dev** — A new optional step between Plan and Implement suggests running `/feature-dev:feature-dev` when the task touches unfamiliar code paths or framework internals (features, refactors, or bugfixes alike — trigger is unfamiliarity, not urgency). The chosen architecture should be recorded in the Task or Progress Log before invoking the implementer. Updated across `CLAUDE-APPEND.md`, `HOW-TO-USE.md`, `README.md`, and `RECOMMENDED-PLUGINS.md`.
- **dev-quality: code-review step removed** — `/simplify` already runs parallel reuse/quality/efficiency review agents on the changed files, so the follow-up `code-review:code-review` call was redundant overhead for the typical solo workflow. The pass is now tests → `/simplify` → tests. The `code-review` plugin remains an optional companion in `hatch` for PR review, security-sensitive code, and large refactors — invoke `/code-review` explicitly when the stakes warrant it.
- **hatch: no scheduled_checks entry for code-review** — since it is no longer part of any default code path, there is no reason to health-check it on a cadence. `docker.recommended_plugins` still records it when selected.

---

## [0.1.5] - 2026-04-22

### Changed

- **Minimum core version bumped to v1.0.16** — dev-hermit now requires `claude-code-hermit` v1.0.16+ so that the `scheduled-checks` standalone routine (which runs dev-hermit's `scheduled_checks` entries) is guaranteed to be present in the project config.

---

## [0.1.4] - 2026-04-22

### Changed

- **BREAKING: minimum core version bumped to v1.0.15** — dev-hermit now requires `claude-code-hermit` v1.0.15+ to reflect the `scheduled_checks` rename and other protocol changes in the core.
- **hatch: `plugin_checks` → `scheduled_checks`** — All five references in the hatch skill updated to match core v1.0.15's renamed config key; `RECOMMENDED-PLUGINS.md` and `CLAUDE.md` updated likewise.
- **hatch: dev-cleanup routine gate removed** — The `< 1.0.12` version guard is redundant now that the min floor is v1.0.15; the cleanup routine question is shown unconditionally.
- **hatch report: surfaces `hermit-settings boot-skill`** — "Other core skills" block now includes the v1.0.14 boot-skill management command.
- **CLAUDE-APPEND: reflect suppression codes** — The reflect note now mentions structured Progress Log suppression codes (`no-evidence`, `weak-recurrence`, etc.) for tuning proposal tiers.
- **CLAUDE-APPEND: knowledge-schema.md pointer** — Dev Knowledge section points at `knowledge-schema.md` if present, matching core v1.0.15's new template.
- **release skill: `claude plugin validate` step** — Release flow now runs validation between file updates and commit, surfacing errors before they land in git.
- **marketplace.json: full metadata** — Added `author`, `license`, `homepage`, `repository`, and `keywords` fields to match core v1.0.15's expanded schema.

---

## [0.1.3] - 2026-04-21

### Changed

- **Skill renamed: `dev-hatch` → `hatch`** — The `dev-` prefix was redundant; the plugin namespace (`claude-code-dev-hermit:`) already conveys scope. Invoke as `/claude-code-dev-hermit:hatch`.

---

## [0.1.2] - 2026-04-20

### Added

- **dev-hatch: weekly dev-cleanup routine** — Phase 3 wizard now offers an optional weekly branch cleanup routine (`0 10 * * 1`); requires hermit v1.0.12+. Routine is written to `config.json` and registered via `hermit-routines load` immediately.
- **dev-hatch report: `hermit-routines` entry** — "Other core skills" section now surfaces `/claude-code-hermit:hermit-routines` for managing the reflect routine and dev-cleanup.

### Changed

- **CLAUDE-APPEND: reflect phase note** — Step 6 (task boundary) now notes that reflect runs as a daily routine and that `newborn`-phase hermits (<3 days) produce fewer proposals — expected behaviour, not a gap.
- **CLAUDE-APPEND quick reference: `hermit-routines`** — Added entry with schedule details (reflect 9am daily, dev-cleanup weekly if enabled).

### Fixed

- **`plugin.json` invalid JSON** — Stray closing `}` removed.

---

## [0.1.1] - 2026-04-15

### Fixed

- **Fully qualified agent/skill names enforced throughout skill instructions** — Bare names (`implementer`, `/dev-quality`, `code-review`) were replaced with canonical forms (`claude-code-dev-hermit:implementer`, `/claude-code-dev-hermit:dev-quality`, `code-review:code-review`) in all skill and template files. Mirrors the fix applied in claude-code-hermit v1.0.2.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | `implementer` → `claude-code-dev-hermit:implementer` (table + workflow step + checklist) |
| `skills/dev-hatch/SKILL.md` | `implementer` → `claude-code-dev-hermit:implementer` (report output) |
| `skills/dev-quality/SKILL.md` | `code-review` → `code-review:code-review`; `implementer` → `claude-code-dev-hermit:implementer` |

---

## [0.1.0] - 2026-04-15

Initial public release.
