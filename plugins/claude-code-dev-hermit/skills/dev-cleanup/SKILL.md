---
name: dev-cleanup
description: Lists and offers to clean up stale or merged git branches. Use when the local repo has accumulated feature branches across sessions.
---
# Dev Cleanup

**Scope:** merged local branches and their associated managed worktrees under `.claude/worktrees/`. When a branch is deleted, its attached worktree (if any, created by `/dev-branch` in active-dev mode) is removed first. The always-on `agent/` worktree is never touched.

List local branches and identify cleanup candidates.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists (core + dev hermit initialized)
- If not: inform the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first, then exit

## Plan

1. Resolve the base branch for merge checking. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" --branch "<first-non-glob-from-config>"
   ```
   In practice: read `claude-code-dev-hermit.protected_branches` from `.claude-code-hermit/config.json` (default: `["main", "master"]` if absent); use the first non-glob entry as the base. Run `git branch --merged <first-protected-branch>` to find fully merged branches. In always-on mode (`$HERMIT_AGENT_WORKTREE` set), run `git -C $HERMIT_AGENT_WORKTREE branch --merged <base>` so branch state reflects the agent's worktree.
2. Run `git branch -v` (or `git -C $HERMIT_AGENT_WORKTREE branch -v` in always-on mode) to find branches with no recent commits.
3. Cross-reference with `.claude-code-hermit/sessions/SHELL.md`
   **and** all `S-*-REPORT.md` files in the sessions directory to
   identify the current working branch and recently active branches
   (do NOT suggest deleting them).
   Also check `.claude-code-hermit/sessions/NEXT-TASK.md` — if it
   exists and references a branch name, do NOT suggest deleting that branch
   (it is part of a pending task from an accepted proposal).
   While reading SHELL.md (already required above), extract any waiting
   reason from the Progress Log. Then check `.claude-code-hermit/state/runtime.json`
   `.session_state`: if `waiting`, any branch referenced in SHELL.md or its
   Progress Log is intentionally idle (e.g., PR submitted, awaiting review) —
   show status as `waiting (<reason>)` and suggestion as `skip (session waiting)`.
4. Present a table:

   | Branch          | Status             | Last Commit | Suggestion             |
   | --------------- | ------------------ | ----------- | ---------------------- |
   | feature/auth    | merged             | 3 days ago  | safe to delete         |
   | fix/typo        | merged             | 7 days ago  | safe to delete         |
   | feature/api-v2  | active (SHELL.md) | today       | keep                   |
   | feature/auth-v2 | waiting (PR #42)   | 5 days ago  | skip (session waiting) |
   | experiment/perf | unmerged           | 14 days ago | review before deleting |

5. Ask operator which branches to delete
6. Before deleting each confirmed branch:
   - Run `git worktree list --porcelain` to find any worktree pinned to that branch.
   - If a worktree entry is found under `.claude/worktrees/` AND its basename is **not** `agent` (literal-segment check — e.g. `.claude/worktrees/feature-agent-handoff/` has basename `feature-agent-handoff`, which is not `agent`, so it IS subject to removal): run `git worktree remove <path>` first. If the remove fails (dirty worktree), surface the error and skip the branch — do not force.
   - Worktrees outside `.claude/worktrees/` or with basename `agent` are operator-owned; report them but do not touch them.
   - Then delete the branch with `git branch -d` (safe delete).
7. For unmerged branches the operator confirms: use `git branch -D`
   only with explicit confirmation (apply the same worktree-removal step first)

## Rules

- Never delete the current branch or any branch that `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" --branch <name>` reports as protected (defaults to main/master)
- Never force-delete without explicit operator confirmation per branch
- Never delete remote branches — local cleanup only
- Cross-reference branches against ALL session reports (`S-*-REPORT.md`),
  not just SHELL.md — a branch may belong to a paused or prior session
- Never delete branches referenced in NEXT-TASK.md (pending accepted proposal tasks)
- Never suggest deleting branches tied to `waiting` sessions — they are intentionally idle
- Log deletions in SHELL.md Progress Log
