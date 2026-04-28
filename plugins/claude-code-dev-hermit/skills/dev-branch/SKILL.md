---
name: dev-branch
description: Create a feature branch (and worktree in active-dev mode) before delegating to the implementer. Validates working state, picks the right base from protected_branches, refuses on collisions, and emits Worktree:/Branch: tokens for the caller.
---

# /dev-branch

Create a feature branch — and in active-dev mode a git worktree — with the same gating discipline the rest of the plugin enforces. Run before delegating to the implementer. In active-dev, the emitted `Worktree:` path must be included verbatim in the implementer's prompt.

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

## Always-on worktree mode

When `$HERMIT_AGENT_WORKTREE` is set (always-on tmux/docker mode), git operations that check or modify the **working tree** target the agent worktree, not the main checkout. This keeps the operator's main checkout untouched while the agent creates its branch.

Affected gates:
- **Gate 0** — checks the worktree's current branch
- **Gate 1** — checks the worktree's cleanliness
- **Gate 4** — filters the agent's own worktree entry from the porcelain output (see below)
- **Gate 6** — creates the branch in the worktree

Repo-level operations (Gate 2 fetch, Gate 3 base resolution, Gate 5 collision check) share the same `.git` and need no change.

## Plan

### Gate 0 — already on a feature branch

Get the current branch (`git rev-parse --abbrev-ref HEAD`, or `git -C $HERMIT_AGENT_WORKTREE rev-parse --abbrev-ref HEAD` in always-on mode) and read the config for Gate 3 (`claude-code-dev-hermit.protected_branches` from `.claude-code-hermit/config.json`).

**Detached HEAD** (output is the literal string `HEAD`) is **not** treated as "already on a feature branch." Proceed to the gates — do not short-circuit. This handles the always-on boot state where the agent worktree starts detached until the first `/dev-branch` creates a real branch.

Otherwise, check whether the current branch is protected:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" \
  --branch "$(git rev-parse --abbrev-ref HEAD)"
# in always-on mode:
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" \
  --branch "$(git -C "$HERMIT_AGENT_WORKTREE" rev-parse --abbrev-ref HEAD)"
```

Exit code 0 (not protected) → already on a feature branch → short-circuit. Emit tokens so the caller can invoke the implementer without re-running `/dev-branch`:

- **Always-on mode:** `Worktree:` is `$HERMIT_AGENT_WORKTREE` (already known). `Branch:` is the current branch.
- **Active-dev mode:** run `git worktree list --porcelain` and find the entry for the current branch. If a managed worktree exists under `.claude/worktrees/`, emit its path. If none is found (operator checked out the branch manually), emit a note: "No managed worktree found for `<branch>` — run `/dev-branch` from a protected branch to create one before invoking the implementer."

```
already on feature/PROJ-123-add-auth — nothing to do
Worktree: /abs/path/to/worktree
Branch:  feature/PROJ-123-add-auth
```

Do NOT append to SHELL.md (no work happened). Exit code 1 (protected) → proceed to Gate 1 to create a feature branch.

### Gate 1 — clean working tree

Run `git status --porcelain` (or `git -C $HERMIT_AGENT_WORKTREE status --porcelain` in always-on mode). If non-empty, stop and surface the diff summary:

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

Run `git worktree prune`, then `git worktree list --porcelain`. In always-on mode, **filter out the entry whose path equals `$HERMIT_AGENT_WORKTREE`** before scanning for collisions — the agent worktree is permanent infrastructure and its presence is never a collision.

Scan the remaining entries for `branch refs/heads/<name>`. If matched:

```
worktree exists at <path> — finish or remove it before recreating the branch
  recovery: git worktree remove --force <path>
```

Do not call `--force` from this skill. Surface the path and let the operator decide.

**Active-dev slug-path guard** (interactive mode only, `$HERMIT_AGENT_WORKTREE` unset):

Derive the worktree slug from the branch name — strip the `feature/` / `fix/` / `chore/` / `hotfix/` prefix, then apply the same slugification rules as the branch name (lowercase, kebab). Proposed path: `.claude/worktrees/<slug>/`.

1. Run `git worktree list --porcelain`. If an entry at `.claude/worktrees/<slug>/` is already registered → **fail loud**: "worktree at `.claude/worktrees/<slug>/` already exists — reuse or remove it."
2. If the path is NOT in `git worktree list` but the **directory exists on disk** → **refuse**: "stale directory at `.claude/worktrees/<slug>/` (not a registered worktree) — manually remove it before proceeding." Do not silently bump the slug suffix.
3. Both checks pass → proceed to Gate 5.

### Gate 5 — branch-name collision

Check for existing branches:
- Local: `git rev-parse --verify <name>` — FAIL if branch exists
- Remote: `git ls-remote --exit-code --heads origin <name>` — FAIL if branch exists; soft-fail this check if Gate 2 went offline

On collision:

```
branch <name> already exists (local / remote) — choose a different name
```

### Gate 6 — create

**Always-on mode (`$HERMIT_AGENT_WORKTREE` set):**

```bash
git -C "$HERMIT_AGENT_WORKTREE" checkout -b <name> origin/<base>
```

The branch is created in the agent worktree. No new worktree is created — the implementer will run inside the existing `$HERMIT_AGENT_WORKTREE`. Emit:

```
Worktree: <abs-path-of-HERMIT_AGENT_WORKTREE>
Branch: <name>
```

**Active-dev mode (`$HERMIT_AGENT_WORKTREE` unset):**

```bash
git worktree add .claude/worktrees/<slug> -b <name> origin/<base>
```

Use the remote-tracking ref so the new branch is not stale relative to origin. Emit:

```
Worktree: <abs-path-of-.claude/worktrees/<slug>>
Branch: <name>

To invoke the implementer, include the Worktree: line above verbatim in the
implementer's prompt. The agent will cd there itself (bash CWD does not
propagate through Task subagents).
```

### Gate 7 — log

Append a one-line entry to `.claude-code-hermit/sessions/SHELL.md` Progress Log in the existing format (e.g., `[HH:MM] created branch <name> from <base>`). Only on actual creation — never on Gate 0 short-circuit or any earlier abort.

## Output

```
dev-branch
  base:    main (from claude-code-dev-hermit.protected_branches[0])
  name:    feature/PROJ-123-add-auth
  status:  created

Worktree: /path/to/repo/.claude/worktrees/proj-123-add-auth   (active-dev)
  — or —
Worktree: /path/to/hermit-worktree                             (always-on)
Branch:  feature/PROJ-123-add-auth
```

Both modes emit `Worktree:` and `Branch:` on their own lines so callers can parse without mode awareness. In active-dev mode the additional prompt instructs the caller to pass the token to the implementer verbatim.

When Gate 0 short-circuits, emit only:

```
already on feature/PROJ-123-add-auth — nothing to do
```

(No `Worktree:` token on short-circuit — the caller should already have it from the prior `/dev-branch` run.)

## Rules

- v1 accepts any branch name. If your team enforces a naming pattern, reject the proposed name interactively — there is no automated validation.
- Never operates on remote refs beyond `git fetch` and `git ls-remote`. No push, no remote branch creation, no remote deletion.
- SHELL.md append happens only on successful creation. Aborts and short-circuits stay quiet.
- Non-interactive callers: fail loud rather than blocking on AskUserQuestion. Gate 3 unresolved → exit with config-fix instruction.
- Running `/dev-branch` before invoking the implementer is **mandatory**. The implementer refuses on prompts missing the `Worktree:` token (Step 0a) and on protected branches (Step 0b). `/dev-branch` is the single place that prepares both.
