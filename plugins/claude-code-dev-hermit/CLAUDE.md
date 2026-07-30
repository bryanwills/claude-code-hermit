# claude-code-dev-hermit

Language-agnostic safety layer for any agent doing dev work in a hermit project. Ships a `git-push-guard` hook, a one-time `/hatch` wizard, a `/dev-pr` skill, and a CLAUDE-APPEND template that injects safety rules into the project's CLAUDE.md.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard. Idempotent, re-runnable, defaults to strict hook profile.
- `skills/dev-pr/` — push the current feature branch and open a PR with an inline-assembled body. Refuses on protected branches, dirty trees, or zero commits ahead.
- `skills/dev-quality/` — pre-wrap quality gate: runs `/claude-code-hermit:simplify` on the working tree (cleanup pass) and re-runs `commands.test` if configured. Surfaces failures; suggests native `/code-review` for a deeper correctness review.
- `skills/dev-test/` — run the configured test suite and record the result to `state/last-test.json`. Useful for mid-task verification and warming the `/dev-pr` test cache.
- `skills/domain-brainstorm/` — on-demand codebase friction brainstorm: reads git churn, last test signal, manifest drift, and README coverage to surface at most 2 `[prefix]`-tagged improvement proposals. Operator-invoked only. Kill criteria: retire if triage-survival < 25% or PROP-acceptance < 30% after ≥8 runs.
- `skills/diagnosing-bugs/` — diagnosis loop for hard bugs and performance regressions. Builds a red-capable feedback loop and runs it before hypothesising. Complements `feature-dev:code-reviewer` (static read) by running actual repros. Adapted from mattpocock/skills (MIT).
- `skills/resolving-merge-conflicts/` — autonomous 5-step conflict resolution for in-progress git merge/rebase. Never `--abort`; runs project checks after resolving. Adapted from mattpocock/skills (MIT).
- `scripts/git-push-guard.ts` — strict-profile-only `PreToolUse` hook for Bash. Blocks `--no-verify`, `--force`/`-f` (always), `--force-with-lease` on protected branches or without an explicit refspec, `--mirror`/`--all`, and direct push to any branch in `claude-code-dev-hermit.protected_branches`.
- `scripts/worktree-boundary-guard.ts` — `PreToolUse` hook for `Edit`/`Write`. In a linked git worktree, blocks edits that escape into the main checkout (`.claude-code-hermit/` carved out). Self-limiting (no profile gate — inert outside worktrees); `WORKTREE_GUARD=off` disables it.
- `hooks/hooks.json` — registers `git-push-guard.ts` and `worktree-boundary-guard.ts`.
- `state-templates/CLAUDE-APPEND.md` — single-source template, annotated with `<!-- mode:standard-only -->` / `<!-- mode:safety-only -->` markers. Standard rendering has all sections: §Git Safety, §Branch Discipline, §Implementation Flow, §Technical Constraints, §Before Archiving a Task, §Dev Session Hygiene, §Dev Knowledge, §Dev Proposal Categories, §Dev Quick Reference. Safety rendering is a strict subset: no §Implementation Flow or `/dev-quality`/`/dev-test` references, trimmed §Dev Quick Reference, and a reworded §Before Archiving bullet (recommended for projects that already have their own commit/PR/release skills). `/hatch` injects the mode-appropriate rendering into the target project's `CLAUDE.md`.
- `scripts/render-append.ts` — renders `CLAUDE-APPEND.md` for a mode: `bun scripts/render-append.ts <standard|safety>` strips the mode markers and emits the mode-specific block to stdout (unknown mode → stderr + exit 1). Exports a pure `render(mode, templateText)`. Standard output is byte-identical to the pre-collapse standard file; safety output to the pre-collapse safety file (proven by `scripts/render-append.test.ts` against golden fixtures in `tests/fixtures/`).
- `tests/` — `run-all.sh` central runner + `skill-structure.test.ts` structural lint.
- `docs/` — `GIT-SAFETY.md` (what the hook blocks), `HOW-TO-USE.md` (workflow), `RECOMMENDED-PLUGINS.md` (companion suggestions). `WORKFLOW.md` describes the end-to-end mechanics.
- `.claude-plugin/plugin.json` — plugin manifest.
- `.claude-plugin/hermit-meta.json` — `required_core_version` and `requires` (hermit-internal, validator-invisible).

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs) and plugins (https://claude.com/plugins) for native features that already cover it. If overlap exists, delegate — don't build. Specifically: built-in skills (`/code-review`, `/batch`) and the plugin-owned `/claude-code-hermit:simplify` cleanup pass already cover common surfaces; link to them from CLAUDE-APPEND or this README rather than reimplementing. (Note: `/debug` enables Claude Code session debug logging — it is not a code-debugging surface.)

## Hook Profiles

`git-push-guard` activates at **strict** profile only. `/hatch` defaults to installing strict and offers an explicit opt-out; once strict, `/hatch` re-runs never silently downgrade. See `docs/GIT-SAFETY.md` for the full profile model.

## Hatch target routing

`/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-dev-hermit`; core's `scripts/domain-hatch.ts` owns install-scope detection, target resolution, and stamping `hatch-options.json`. The preflight verdict hands back `target`, `target_file`, `target_default`, and `needs_target_question` — the skill only surfaces the Visibility prompt when asked to, records the answer with `domain-hatch ensure-target claude-code-dev-hermit --target <choice>`, and never reads or writes `hatch-options.json` itself. Step 3 pipes the mode-specific rendering into `domain-hatch sync-block claude-code-dev-hermit --rendered-stdin`, so both renderings of the single-source `CLAUDE-APPEND.md` (standard and safety, emitted by `scripts/render-append.ts`) land in the resolved file and a mode change becomes a block replacement.

**Upgrade refresh.** After updating the plugin, re-run `/claude-code-dev-hermit:hatch`. Core `hermit-evolve` defers this block because only `scripts/render-append.ts` can resolve its mode annotations; hatch renders it and delegates writing to `domain-hatch sync-block ... --rendered-stdin`.

## Depends On

- `claude-code-hermit` (core). Authoritative source: `.claude-plugin/hermit-meta.json` (`required_core_version` field) — read at runtime by the `domain-hatch preflight` verb, never restated in skill prose.

## Core Contracts

1. **Profile-gating**: `AGENT_HOOK_PROFILE` values are `minimal`/`standard`/`strict`. The `git-push-guard` hook self-gates on this and exits 0 immediately if the profile is not `strict`.
2. **Safety rules live in the rendered CLAUDE-APPEND block**: the plugin no longer ships its own implementer agent. The rules in `CLAUDE-APPEND.md` rendered for the chosen mode (via `scripts/render-append.ts`) apply to whatever agent the operator uses. The `git-push-guard` hook backs §Git Safety at strict profile.
3. **Session state**: `.claude-code-hermit/state/runtime.json` is authoritative for session lifecycle. SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks.
4. **Learning loop**: `reflect` runs at every task boundary (per core hermit's contract).
5. **Proposal gate**: the three-condition rule and tier mapping live in the single-source `CLAUDE-APPEND.md` §Dev Proposal Categories section (mode-independent, so both renderings carry it).
