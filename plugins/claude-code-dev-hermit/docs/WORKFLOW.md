# Task Workflow

End-to-end mechanics of a ticket from branch → PR. Read this once to understand what fires in what order; for day-to-day workflow tips see [How to Use](HOW-TO-USE.md).

The plugin's contribution to the workflow is two-part:

1. **A CLAUDE-APPEND template** is injected into the project's `CLAUDE.md` by `/hatch`. The template chosen depends on `hatch_mode`:
   - **`standard`** (`state-templates/CLAUDE-APPEND.md`): full workflow — §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR, and supporting sections. For greenfield projects without existing dev skills.
   - **`safety`** (`state-templates/CLAUDE-APPEND.md` rendered by `scripts/render-append.ts safety`): git safety and branch discipline only. No §Implementation Flow or §Tests Before PR. For projects that already have their own `/commit`, `/create-pr`, or `/release` skills — dev-hermit's safety layer without the prescriptive workflow.
2. **`/dev-pr`** is the operator-invoked terminal step that pushes the branch and opens the PR.

Everything between (planning, branch creation, code, tests, cleanup) is the agent following the injected rules. There's no "dev-hermit pipeline" — the rules ARE the pipeline.

---

## The Cycle

### Step 1 — Plan

Operator describes the task. The agent breaks it into Tasks via `TaskCreate`. Trivial single-step tasks skip this.

If the code path is unfamiliar AND `/feature-dev:feature-dev` is installed, the agent runs it first to architect-and-explore before writing code. Trigger is **unfamiliarity, not urgency** — see CLAUDE-APPEND `§Implementation Flow` step 3.

### Step 2 — Branch

Per `§Branch Discipline`:

1. `git status --porcelain` must be empty. If dirty: stop, surface the diff, let the operator commit/stash.
2. Resolve base: first entry of `claude-code-dev-hermit.protected_branches` (defaults to `main`).
3. `git checkout -b <prefix>/<slug> origin/<base>`.
4. Slugify the description per the 5-step rules in CLAUDE-APPEND. Prefix detection: longest case-insensitive match of `hotfix|feature|fix|chore` at input start, else `feature`.
5. Append a one-line entry to `.claude-code-hermit/sessions/SHELL.md` Progress Log.

### Step 3 — Implement

Agent writes code on the feature branch. The `§Git Safety` rules apply throughout (no `git push` from agent context except via `/claude-code-dev-hermit:dev-pr`, no `--no-verify`, no commits to a `protected_branches` branch, no force-push in any flavor). The authoritative wording lives in `state-templates/CLAUDE-APPEND.md` §Git Safety.

At strict hook profile (`AGENT_HOOK_PROFILE=strict`), `git-push-guard` enforces these at `bash` time. At lower profiles, the prose is the only enforcement — agents may or may not weight it. `/hatch` defaults to strict for that reason.

### Step 4 — Tests

Per `§Implementation Flow`: agent runs `claude-code-dev-hermit.commands.test` before declaring the task done. If tests fail, fix or surface. Never declare done with broken tests.

### Step 5 — Cleanup pass and re-test

Per `§Tests Before PR`:

1. Run `/claude-code-dev-hermit:dev-quality` on the working tree. It invokes `/claude-code-hermit:simplify` (three parallel reviewers, applies its own edits), then re-runs `commands.test`.
2. If tests pass → proceed.
3. If tests fail → `git checkout -- <changed-files>` to revert the applied edits, surface the regression, stop.

For high-stakes changes, optionally invoke `/code-review` (built-in) after the dev-quality pass — that's the deeper bug-finding option.

### Step 6 — PR

Operator (or the agent on the operator's behalf) runs:

```
/claude-code-dev-hermit:dev-pr
```

`/dev-pr` runs five gates (Gate 0 through Gate 4):

- **Gate 0 — preconditions**: forge/tool sanity (`commands.pr_create` set and matching origin host), protected-branch refusal, clean-tree refusal, commits-ahead refusal. No `--force` flag exists; the only escape is to fix the failing condition.
- **Gate 1 — push**: regular push if upstream missing or you're ahead. If `BEHIND > 0`, refuses with "git pull --rebase first" (no force-push).
- **Gate 2 — assemble title and body**: title from binding (e.g. `PROJ-123:`) + first commit subject (conventional-prefix-stripped). Body sections in order: Summary (deduped commit subjects), Context (binding link), Verification (last test result), Screenshots (from `raw/screenshots/<binding-id>/manifest.json` if any), Notes (operator-supplied). Project PR template (`pr_template_path` or forge-specific path) appended verbatim if found.
- **Gate 3 — create**: writes the body to a temp file, calls `gh pr create` (GitHub), `glab mr create` (GitLab), or the configured `commands.pr_create`. Flag layout is forge-aware: glab uses `--description "$(cat ...)"` and `--target-branch`; custom commands receive gh-style flags and should wrap if needed.
- **Gate 4 — record**: writes `state/bindings.json` with the PR URL, appends to SHELL.md.

Native session→PR auto-link: when using `gh pr create` on GitHub, Claude Code preserves session linking. The operator can resume this session later with `claude --from-pr <number>`. This feature is GitHub-specific.

### Step 7 — Reflect

At the task boundary, `reflect` (core hermit) runs to surface patterns — recurring blockers, cost trends, improvement ideas. These become proposals you can accept, defer, or dismiss. See CLAUDE-APPEND `§Dev Proposal Categories` for the prefix conventions.

---

## State Files

The plugin reads/writes a small set of files under `.claude-code-hermit/`:

| Path | Purpose | Owned by |
|------|---------|----------|
| `config.json` → `claude-code-dev-hermit.*` | Test/lint/format commands, protected branches, PR template path, hook profile | `/hatch` |
| `state/bindings.json` | Branch → PR URL mapping, optional external ticket binding | `/dev-pr` |
| `sessions/SHELL.md` | Append-only progress log | Every agent following CLAUDE-APPEND |

Session lifecycle state (`runtime.json`, `monitors.runtime.json`) is owned by core hermit; this plugin never writes those.

---

## Always-on Mode

The plugin no longer ships an always-on-aware mode (no `$HERMIT_AGENT_WORKTREE` branching, no separate ports). When the hermit runs in Docker / tmux always-on, it operates on its own clone of the repo — the operator's local checkout is unaffected. All workflow steps above apply unchanged. See [the core hermit's always-on docs](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md).
