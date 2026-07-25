
---
<!-- claude-code-dev-hermit: Development Workflow -->

## Git Safety (always applies)

These rules apply to every agent doing dev work in this project — the native `Agent` tool, custom subagents, the main session. The `git-push-guard` hook backs them at strict profile.

- **Never `git push`** from agent context. Stop and ask the operator. The sanctioned answer is `/claude-code-dev-hermit:dev-pr`, which runs Gate 0 checks then pushes + opens a PR. This forbids *improvised* pushes, not the push performed by that skill itself: while executing it, its Gate 1 push **is** the sanctioned action — run it, don't stop to ask.
- **Never use `--no-verify`** on any git command (commit, push, merge, rebase). Pre-commit hooks exist for a reason.
- **Never commit to a branch in `claude-code-dev-hermit.protected_branches`** (defaults to `main`/`master` if unset). Always work on a feature branch.
- **Never force-push from agent context.** No bare `--force` or `-f`. `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case); ambiguous-target leases and leases to protected branches are blocked. When in doubt, surface the divergence and let the operator resolve.
- **Stay in your worktree.** When the session runs in a git worktree, never edit files in the original checkout or a sibling worktree — that's another session's territory. The `worktree-boundary-guard` hook hard-blocks edits that escape the worktree.

If a task would require violating these rules, stop and ask the operator. Do not attempt workarounds (alternate commands, env vars, manual git plumbing).

## Branch Discipline

If the project's own CLAUDE.md or skills define a branch-naming convention (e.g. `<short-slug>/vX.Y.Z` for plugin releases, ticket-prefixed branches, or anything else), follow that. The rules below are the fallback for projects without one.

Before starting code changes:

1. Verify clean working tree (`git status --porcelain` returns empty). If dirty, stop and surface the diff — let the operator commit or stash before proceeding.
2. Branch from the first entry of `claude-code-dev-hermit.protected_branches` (defaults to `main`). Use `git checkout -b <prefix>/<slug> origin/<base>` so the new branch tracks the latest remote.
3. Name it `<prefix>/<kebab-slug>`, prefix from {feature, fix, chore, hotfix} matched at the start of the input, default `feature`.
4. Append a one-line entry to `.claude-code-hermit/sessions/SHELL.md` Progress Log: `[HH:MM] created branch <name> from <base>`.

## Implementation Flow

If the project's own CLAUDE.md or skills define a commit/test/PR sequence, follow that. The fallback: run `commands.test` (`claude-code-dev-hermit.commands.test`, set via `/claude-code-dev-hermit:hatch`) → `/claude-code-dev-hermit:dev-quality` → commit → `/claude-code-dev-hermit:dev-pr`.

- Cleanup edits from `/claude-code-dev-hermit:dev-quality` must land **before** the commit — that ordering is why the quality gate runs first. `/claude-code-dev-hermit:dev-pr` Gate 0 then enforces a fresh passing test at the current HEAD sha mechanically; don't restate its checks, just run it.
- Never declare the task done with broken tests.
- Working inside a nested git repo (submodule, Composer path package, npm/pnpm path workspace, vendored dep)? Pass the same `--cwd <relative/path>` to `/claude-code-dev-hermit:dev-quality` and `/claude-code-dev-hermit:dev-pr`. State stays under the parent's `.claude-code-hermit/`.
- If `/feature-dev:feature-dev` is installed, run it first when the code path is genuinely unfamiliar (framework lifecycle hooks, ORM internals, build-tool plugins, auth middleware). The trigger is unfamiliarity, not urgency.

## Technical Constraints

Session state (`in_progress`/`waiting`/`idle`/`dead_process`) lives in `.claude-code-hermit/state/runtime.json` (`.session_state`). SHELL.md `Status:` is cosmetic — never parse it for programmatic checks.

Core rules (artifact frontmatter, tag discipline, proposals) apply to all dev work — see the `## Session Discipline (claude-code-hermit)` block above.

## Before Archiving a Task

- `/claude-code-dev-hermit:dev-pr` run, or PR opened via other means — URL recorded in `state/bindings.json`.
- Feature branch committed, no uncommitted changes.
- If partial: Session Summary describes what remains.

## Dev Session Hygiene

Serialize and delete all Tasks at task boundaries; skip `TaskCreate` for trivial single-step work. Keep the Progress Log compact — summarize older entries once it grows long.

## Dev Knowledge

Durable dev artifacts (architecture decisions, health assessments, review-pattern summaries, dependency audits) go to `compiled/`; ephemeral inputs (CI logs, snapshots under analysis) go to `raw/`. Lessons and patterns go to auto-memory — don't duplicate them into `compiled/`. Consult the project's `knowledge-schema.md` before writing any `compiled/` artifact.

## Dev Proposal Categories

Use these prefixes in proposal titles for consistent sorting:
- **[missing-tests]** — Uncovered code paths
- **[tech-debt]** — Code that works but should be refactored
- **[dependency]** — Stale, vulnerable, or unnecessary deps
- **[tooling]** — Missing linter rules, CI checks, dev scripts
- **[architecture]** — Structural improvements

All dev proposals must pass the core three-condition gate (repeated pattern, meaningful consequence, operator-actionable); `/claude-code-dev-hermit:domain-brainstorm` ideas are single-pass, so the recurrence condition is waived.

Tier mapping:
- **Tier 2** (micro-approval): `[tech-debt]`, `[tooling]`, `[dependency]` updates
- **Tier 3** (full PROP-NNN): `[missing-tests]`, `[architecture]`, `[dependency]` removals

## Dev Quick Reference

- One-time setup / re-config: `/claude-code-dev-hermit:hatch`
- Mid-task test run + cache warm: `/claude-code-dev-hermit:dev-test`
- Pre-wrap quality gate: `/claude-code-dev-hermit:dev-quality`
- Open the PR: `/claude-code-dev-hermit:dev-pr`
- Cleanup pass: `/claude-code-hermit:simplify` (parallel reviewers, applies its own edits)
<!-- /claude-code-dev-hermit: Development Workflow -->
