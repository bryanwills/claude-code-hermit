---
name: dev-branch
description: Create a feature branch from a clean tree before delegating to the implementer or starting direct edits. Validates working state, picks the right base from protected_branches, and refuses on collisions.
---

# /dev-branch

Create a feature branch with the same gating discipline the rest of the plugin enforces. Run before delegating to the implementer or starting direct edits on a fresh task.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists (core + dev hermit initialized)
- If not: inform the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first, then exit

## Argument shapes

Accepts two forms:

- **Full branch name with prefix** — `feature/PROJ-123-add-auth`, `fix/login-redirect` — used as-is (no further transformation).
- **Bare description** — `PROJ-123 add auth flow`, `add auth flow` — ask the operator once which prefix to use (`feature` / `fix` / `chore` / `hotfix`), then slugify the rest.

If the operator skips the prefix question, default to `feature`.

**Slugification rules** — applied to the description portion only (never the prefix):
1. Lowercase
2. Replace whitespace runs with single `-`
3. Drop any character not in `[a-z0-9-]`
4. Collapse consecutive `-` to a single `-`
5. Strip leading and trailing `-`

`/` is preserved only as the prefix separator. If the input contains `/` mid-description (`feature/foo/bar`), only the first `/` is kept as prefix-boundary; subsequent `/` is replaced with `-` (`feature/foo-bar`).

## Plan

### Gate 0 — already on a feature branch

Read `claude-code-dev-hermit.protected_branches` from `.claude-code-hermit/config.json` and run `git rev-parse --abbrev-ref HEAD` in parallel. Cache the config for Gate 3. If the current branch is NOT in the resolved protected-branches set, short-circuit. Glob matching: treat `*` as zero-or-more chars within a branch segment — `release/*` matches `release/v1` but not `release`; `*` alone matches anything.

```
already on feature/PROJ-123-add-auth — nothing to do
```

Do NOT append to SHELL.md (no work happened).

### Gate 1 — clean working tree

Run `git status --porcelain`. If non-empty, stop and surface the diff summary:

```
working tree is dirty — /commit or stash before creating a branch
```

### Gate 2 — fetch

Run `git fetch origin` (or the configured default remote). Soft-fail on network error — warn `fetch failed (offline?) — proceeding with local refs` and continue. Record the offline state for Gate 5.

### Gate 3 — resolve base branch

Try each option in order, silently falling through on failure. Do NOT warn at each step — only surface the final result. Reuse the config.json already read in Gate 0.

1. First entry of `claude-code-dev-hermit.protected_branches` from config that does NOT contain `*` or `?` (skip glob entries like `release/*`).
2. `git symbolic-ref refs/remotes/origin/HEAD` — returns a literal ref like `refs/remotes/origin/develop`; strip the `refs/remotes/origin/` prefix to get the branch name. Exits 128 when origin/HEAD is unset (fresh clones, mirror clones, CI flows); treat as a normal fall-through.
3. Check if `main` exists. When online (Gate 2 succeeded): `git ls-remote --exit-code --heads origin main`. When offline: `git rev-parse --verify refs/remotes/origin/main` (local cache only).
4. Same check for `master` — `git ls-remote` when online, local `git rev-parse --verify refs/remotes/origin/master` when offline.
5. If all fail and the session is interactive: ask the operator which base to use (AskUserQuestion). If non-interactive (no TTY, called from another skill chain): fail loud — `cannot resolve base branch — configure claude-code-dev-hermit.protected_branches`.

Surface the resolved base in the output. Emit no intermediate "fell back" lines.

### Gate 4 — worktree collision

Run `git worktree prune`, then `git worktree list --porcelain | grep -F "branch refs/heads/<name>"`. If matched:

```
worktree exists at <path> — finish or remove it before recreating the branch
  recovery: git worktree remove --force <path>
```

Do not call `--force` from this skill. Surface the path and let the operator decide.

### Gate 5 — branch-name collision

Check for existing branches:
- Local: `git rev-parse --verify <name>` — FAIL if branch exists
- Remote: `git ls-remote --exit-code --heads origin <name>` — FAIL if branch exists; soft-fail this check if Gate 2 went offline

On collision:

```
branch <name> already exists (local / remote) — choose a different name
```

### Gate 6 — create

```bash
git checkout -b <name> origin/<base>
```

Use the remote-tracking ref so the new branch is not stale relative to origin.

### Gate 7 — log

Append a one-line entry to `.claude-code-hermit/sessions/SHELL.md` Progress Log in the existing format (e.g., `[HH:MM] created branch <name> from <base>`). Only on actual creation — never on Gate 0 short-circuit or any earlier abort.

## Output

```
dev-branch
  base:    main (from claude-code-dev-hermit.protected_branches[0])
  name:    feature/PROJ-123-add-auth
  status:  created
```

When Gate 0 short-circuits, emit only:

```
already on feature/PROJ-123-add-auth — nothing to do
```

## Rules

- v1 accepts any branch name. If your team enforces a naming pattern, reject the proposed name interactively — there is no automated validation.
- Never operates on remote refs beyond `git fetch` and `git ls-remote`. No push, no remote branch creation, no remote deletion.
- SHELL.md append happens only on successful creation. Aborts and short-circuits stay quiet.
- Non-interactive callers: fail loud rather than blocking on AskUserQuestion. Gate 3 unresolved → exit with config-fix instruction.
- This skill is for the **main session**. The `claude-code-dev-hermit:implementer` agent creates its own branch inside its worktree independently — that is a separate code path and does not interact with `/dev-branch`. Operators may still invoke the implementer directly without running `/dev-branch` first.
