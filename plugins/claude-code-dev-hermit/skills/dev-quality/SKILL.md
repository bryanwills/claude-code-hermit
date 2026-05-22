---
name: dev-quality
description: Pre-wrap quality gate. Runs /code-review on the working-tree diff, applies findings with a derivable fix, re-runs commands.test, and reports results. Suggests /code-review:code-review when installed. Run this before committing.
---

# /dev-quality

Run a quality pass on the working-tree diff before declaring the task done. Invokes `/code-review` (read-only since CC 2.1.146), applies the findings whose fix is derivable from the summary, surfaces the rest, then re-runs the configured test command. Call this at task wrap-up, before committing.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `commands.test` from `.claude-code-hermit/config.json`. If unset, the test step is skipped — `/code-review` still runs.

## Plan

### Argument

Optional `--cwd <path>`. When set, all git operations and the test re-run target `<path>` instead of `$PWD`. `<path>` must be a git working tree. Use this for nested-repo workflows (see CLAUDE-APPEND §Implementation Flow). State (`last-test.json`, hermit dir) still resolves from `$PWD`.

In the gates below, use `git -C "<path>"` for every git invocation when `--cwd` is set, otherwise omit the `-C` and run against `$PWD` as today. Below this is written as `git -C "$TARGET"` with `$TARGET` standing for either form.

### Gate 0 — preconditions

```bash
git -C "$TARGET" diff --quiet && git -C "$TARGET" diff --cached --quiet
```

If both are empty: working tree is clean. Before failing, check whether HEAD has commits ahead of the base:

1. Resolve `BASE_NAME` using the same priority order as `/dev-pr` Gate 0 step 4 (`pr_base_branch` → first non-glob `protected_branches` → `origin/HEAD` → `main`/`master`).
2. Resolve `BASE_REF`: try `git -C "$TARGET" rev-parse --verify "$BASE_NAME" 2>/dev/null`; on failure try `git -C "$TARGET" rev-parse --verify "origin/$BASE_NAME" 2>/dev/null`; if neither resolves, skip the NOTICE.
3. If `git -C "$TARGET" rev-list --count "$BASE_REF..HEAD"` > 0, emit before failing:

   ```
   NOTICE: working tree is clean but HEAD has N commits ahead of <BASE_NAME>.
           /dev-quality is designed to run BEFORE commit (so /code-review findings can be applied to the working tree before they're locked into a commit).
           Correct order: /dev-quality → commit → /dev-pr.
           To verify the committed state passes tests, run /dev-test instead.
   ```

Then FAIL `"no working-tree diff — nothing to code-review"`. Append the hint `hint: if edits are in a nested git repo, re-run with --cwd <path>` unless `--cwd` was already passed.

### Gate 1 — run `/code-review`, apply findings

Invoke `/code-review` on the current diff. Wait for it to complete.

When `--cwd <path>` is set, scope `/code-review` to files under `<path>` — list them via `git -C "<path>" diff --name-only` and pass that file set as the focus. Don't review files outside `<path>`.

`/code-review` emits a JSON array of `{file, line, summary, failure_scenario}`. Empty array → record `code-review: 0 findings` and continue to Gate 2.

For each finding, decide:

- **apply**: the fix is unambiguous from `summary` + `failure_scenario` (e.g. off-by-one, missing null guard, `=` vs `==`). Read `file:line` to confirm, then Edit.
- **surface**: fix is ambiguous, multi-location, or requires judgment. Leave the working tree untouched.

When in doubt, surface. Track `M` = total, `N` = applied, `K = M − N`.

If the response isn't a valid JSON array, record `code-review: surfaced (apply skipped — output not parseable as JSON array)` and continue to Gate 2. Never block on parser ambiguity.

### Gate 2 — re-run tests

If `commands.test` is unset: skip this gate, record `tests: skipped`, and proceed to Gate 3 pass path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
```

When `--cwd <path>` is set, append `--cwd "<path>"` to the invocation. The script runs the test command from `<path>` and records `<path>`'s HEAD SHA into `last-test.json` (so `/dev-pr` cache checks against the right commit).

Use `timeout: 600000`. Records the result to `last-test.json`.

### Gate 3 — report

**Tests pass:**

Report the outcome. Then check whether `/code-review:code-review` is in the agent's available slash-command list. If available, append:

```
next: suggest the operator run /code-review:code-review for a deeper review before commit
```

Do **not** invoke `/code-review:code-review` autonomously — operator decision only. Skill exits clean; reviewed changes remain uncommitted for the operator to commit.

**Tests fail:**

Read `state/last-test.json` and include `likely_cause` in the failure message if present. FAIL with `"tests regressed after /code-review (exit <N>[, likely OOM|timeout|user-interrupt]) — investigate before committing"` and the last 20 lines of stderr. Leave the working tree as-is (post-apply state) — the agent or operator decides whether to fix forward or revert the applied findings manually (`git checkout -- <files>`).

## Output

`code-review:` is `N/M findings applied (K surfaced)`, dropping the `(K surfaced)` when `K == 0`; `0 findings` when `M == 0`. The optional `unapplied:` block lists surface-only findings as `<file>:<line> — <summary>` (truncate to ~80 chars); omit when `K == 0`.

```
dev-quality
  diff:        12 files modified
  code-review: 3/5 findings applied (2 surfaced)
  unapplied:   path/foo.js:42 — possible race in lock acquisition
               path/bar.js:18 — consider error handling for fetch failure
  tests:       pass (12.3s)
  next:        suggest operator run /code-review:code-review (installed)
  status:      ok
```

When invoked with `--cwd <path>`, prepend a `target:` line:

```
dev-quality
  target:      packages/foo
  diff:        3 files modified
  code-review: 1/1 findings applied
  tests:       pass (4.1s)
  status:      ok
```

On Gate 3 failure:

```
dev-quality
  diff:        12 files modified
  code-review: 2/3 findings applied (1 surfaced)
  tests:       FAIL (exit 137, likely OOM, 8.7s)
  recovery:    investigate the regression; fix forward or `git checkout -- <files>` to revert the applied findings
  status:      tests-regressed
```

When `commands.test` is unset:

```
dev-quality
  diff:        12 files modified
  code-review: 1/1 findings applied
  tests:       skipped (commands.test not configured)
  status:      ok
```

On Gate 0 failure (clean tree, commits ahead):

```
dev-quality
  NOTICE: working tree is clean but HEAD has 3 commits ahead of main.
          /dev-quality is designed to run BEFORE commit (so /code-review findings can be applied to the working tree before they're locked into a commit).
          Correct order: /dev-quality → commit → /dev-pr.
          To verify the committed state passes tests, run /dev-test instead.
  FAIL (Gate 0): no working-tree diff — nothing to code-review
```

On Gate 0 failure (clean tree, no commits ahead or base unresolvable):

```
dev-quality
  FAIL (Gate 0): no working-tree diff — nothing to code-review
                 hint: if edits are in a nested git repo, re-run with --cwd <path>
```

(The `hint:` line is omitted when `--cwd` was already passed.)

## Rules

- **Main session only.** Subagents cannot invoke skills (see CLAUDE-APPEND §Technical Constraints) — `/dev-quality` only fires from the main session.
- **Never invokes `/code-review:code-review`.** Suggests it to the operator when available; the operator decides.
- **Never commits.** Leaves the diff uncommitted for the operator.
- **Never modifies the working tree on test failure.** Surfaces the regression and stops; no rollback.
- **Writes `last-test.json`, but no cross-skill contract.** The record is written at the pre-commit HEAD. After committing, `/dev-pr` sees a stale SHA and re-runs tests — expected behaviour.
