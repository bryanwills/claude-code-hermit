# claude-code-dev-hermit

Git safety, quality workflow, and dev conventions for claude-code-hermit.

## Plugin Structure

- `agents/` — implementer agent (runs on a caller-prepared branch; **requires `Worktree:` token in prompt**, provided by `/dev-branch`)
- `skills/` — hatch, dev-adapt, dev-branch, dev-up, dev-down, dev-log-watch, dev-status, dev-quality, dev-cleanup, dev-doctor, dev-pr
- `hooks/hooks.json` — git-push-guard hook (strict profile only)
- `scripts/` — process entrypoints (git-push-guard, watchdog-health, watchdog-errors, check-protected-branch); `scripts/lib/` — shared pure helpers (resolve-command, port-check, health-poll, log-watch-builder, dev-server-command, shell-utils, alerts-store, pr-body-builder, **protected-branches**) with co-located `.test.js` runners
- `tests/` — `run-all.sh` central runner + `skill-structure.test.js` + `agents-structure.test.js` structural lint
- `state-templates/` — CLAUDE-APPEND.md (dev workflow rules appended to CLAUDE.md)
- `docs/` — DEV-LOG-WATCH.md, GIT-SAFETY.md, WORKFLOW.md, HOW-TO-USE.md, RECOMMENDED-PLUGINS.md
- `.claude-plugin/plugin.json` — plugin manifest

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs)
  and plugins (https://claude.com/plugins) for native features that already cover it.
  If overlap exists, delegate — don't build. Specifically: built-in skills (`/simplify`, `/batch`, `/debug`) and the `code-review@claude-plugins-official` plugin already cover common surfaces; link to them from the relevant skill instead of reimplementing. Invoke `/code-review` explicitly for PR review and high-stakes code.

## Hook Profiles

The `git-push-guard` hook activates at **strict** profile only (`AGENT_HOOK_PROFILE=strict`).
The `hatch` skill recommends enabling strict profile during setup.

## Depends On

- `claude-code-hermit` v1.0.22+ (core)

## Core Contracts

1. **Profile-gating**: `AGENT_HOOK_PROFILE` values are `minimal`/`standard`/`strict`. Hooks self-gate on this.
2. **Session lifecycle**: `/session-close` is operator-only — never invoke programmatically. Dev workflow operates within core's session loop.
3. **Ambient rules always apply**: git safety, task checklist, and proposal categories apply to all dev work regardless of how the session started.
4. **Learning loop**: invoke `reflect` at every task boundary.
5. **Proposal gate**: three-condition rule and tier mapping live in `state-templates/CLAUDE-APPEND.md` (Dev Proposal Categories §).
6. **Session state**: `.claude-code-hermit/state/runtime.json` is authoritative. SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks.
7. **Implementer caller contract**: run `/dev-branch` before invoking the implementer; pass its `Worktree:` line verbatim in the implementer's prompt. The implementer refuses on missing token (Step 0a) and protected branches (Step 0b). `/dev-branch` is the single place that prepares both.
