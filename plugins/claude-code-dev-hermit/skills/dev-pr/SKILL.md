---
name: dev-pr
description: Open a PR from the current feature branch with a body assembled from /dev-quality, commit history, screenshots, and optional work-binding context. Refuses on protected branches, dirty trees, missing/stale /dev-quality runs, or unresolved health-degraded alerts. Run as the final step of a ticket.
---

# /dev-pr

Push the current branch and open a PR with a structured body. Reads `/dev-quality`'s last run, commit history, binding context, and screenshots — assembles them into title + body — then calls `gh pr create` (or the configured equivalent).

Accepts one optional flag: `--force`. See Gate 0 for what it bypasses.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `.claude-code-hermit/config.json` once. Cache `claude-code-dev-hermit.protected_branches`, `commands.pr_create`, `pr_base_branch`, `pr_title_format`, `pr_body_sections`, `pr_template_path`, `dev_watchdog`, and `scope`.

## Plan

### Gate 0 — preconditions

Run all five checks in order. FAIL on the first failure, name it, give the exact command to fix it.

**1. Protected-branch check** (NEVER skipped by `--force`):

```bash
# interactive:
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" \
  --branch "$(git rev-parse --abbrev-ref HEAD)"
# always-on ($HERMIT_AGENT_WORKTREE set):
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-protected-branch.js" \
  --branch "$(git -C "$HERMIT_AGENT_WORKTREE" rev-parse --abbrev-ref HEAD)"
```

Exit code 1 → FAIL:
```
FAIL: cannot open PR from protected branch <branch>
  recovery: create a feature branch with /dev-branch <description>
```

**2. Clean-tree check** (NEVER skipped by `--force`):

```bash
git status --porcelain
# always-on:
git -C "$HERMIT_AGENT_WORKTREE" status --porcelain
```

If non-empty: FAIL with `"commit or stash changes before opening a PR"`.

**3. Commits-ahead check** (NEVER skipped):

Resolve base branch: `pr_base_branch` from config if set, else `protected_branches[0]` (excluding glob entries), else `origin/HEAD`, else `main`/`master` (same resolution as `/dev-branch` Gate 3).

```bash
git rev-list --count <base>..HEAD
# always-on:
git -C "$HERMIT_AGENT_WORKTREE" rev-list --count <base>..HEAD
```

If count is 0: FAIL with `"nothing to PR — no commits ahead of <base>"`.

**4. Quality check** (skipped by `--force`):

Read `state/quality-last.json`.
- Missing: FAIL `"quality-last.json not found — run /dev-quality first"`.
- `commit_sha != current HEAD`: FAIL `"quality report is stale (run on <sha>, now at <head>) — run /dev-quality first"`.
- `test.status === 'fail'`: FAIL `"tests were failing at last /dev-quality run — fix before opening PR"`.

**5. Alert check** (skipped by `--force`; also skipped if `dev_watchdog.enabled === false`):

Read `state/alerts.json`. Filter to entries where `acknowledged === false` AND `binding === current_branch` AND `kind === 'health-degraded'`. If any:
```
FAIL: dev-server is degraded — unresolved health-degraded alert at <HH:MM> (<details>)
  recovery: investigate with /dev-status, then /dev-down and /dev-up to restart
  or skip with --force if the alert is a false positive
```

When `--force` was passed, emit a one-line warning in the output block instead of failing: `force: quality-check and alert-check skipped`.

### Gate 1 — push

Determine remote state:
```bash
git ls-remote --exit-code --heads origin <branch> 2>/dev/null
# always-on:
git -C "$HERMIT_AGENT_WORKTREE" ls-remote ...
```

**No upstream (ls-remote exits non-zero):**
```bash
git push -u origin <branch>
# always-on:
git -C "$HERMIT_AGENT_WORKTREE" push -u origin <branch>
```

**Upstream exists — check divergence:**

Use the SHA already returned by `git ls-remote` — avoids depending on a local tracking ref that may not exist yet:

```bash
REMOTE_SHA=$(git ls-remote origin <branch> | cut -f1)
AHEAD=$(git rev-list --count "$REMOTE_SHA"..HEAD)   # commits we have, remote doesn't
BEHIND=$(git rev-list --count HEAD.."$REMOTE_SHA")  # commits remote has, we don't
```

- `BEHIND > 0`: FAIL `"remote has commits you don't — git pull --rebase first"`.
- `AHEAD > 0`: push with lease using the same `REMOTE_SHA`:
  ```bash
  git push --force-with-lease=<branch>:"$REMOTE_SHA" origin <branch>
  ```
- Both 0 (already in sync): skip push, record `push: already up to date`.

Always-on: prepend `git -C "$HERMIT_AGENT_WORKTREE"` to all git operations.

On push failure: FAIL with stderr tail + recovery hint.

### Gate 2 — assemble title and body

Run all reads in parallel:

**Commits:**
```bash
git log --first-parent <base>..HEAD --pretty=format:'%H%x00%s%x00%b%x1e'
# always-on: git -C "$HERMIT_AGENT_WORKTREE" log ...
```
Parse: split on `%x1e` (record separator), each record splits on `%x00` → `{sha, subject, body}`.

**Screenshots:**
Compute `binding_id`:
- If `state/bindings.json` has an entry for the current branch with `external.id` → use that.
- Otherwise: `branch.replace(/\//g, '-')`.

Read `.claude-code-hermit/raw/screenshots/<binding_id>/manifest.json` if it exists. Parse for `[{criterion, path}]`. Missing manifest → empty list (no screenshots, not an error).

**Scope warning:** if any screenshot entry has a non-`https://` path AND `config.scope === 'local'`, queue a warning for the output block: `warn: screenshots in raw/ are gitignored under local scope — they will appear as broken images in the PR (use project scope or upload-to-URL).`

**Project PR template:**
Read `pr_template_path` from config if set; else try `.github/PULL_REQUEST_TEMPLATE.md` then `docs/pull_request_template.md`. Use first found; null if none.

**Assemble:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pr-body-builder.js" '<json>'
```

JSON input:
```json
{
  "commits": [...],
  "qualityReport": { ...parsed quality-last.json... },
  "binding": { "external": {...} },
  "screenshots": [...],
  "config": {
    "pr_body_sections": [...],
    "pr_title_format": "...",
    "pr_base_branch": "..."
  },
  "projectTemplate": "...",
  "branch": "<current-branch>"
}
```

Parse `{ title, body, sectionsCount, screenshotsCount, templateUsed }` from stdout.

### Gate 3 — create the PR

Write the body to a temp file to avoid shell-quoting issues with multi-line Markdown:
```bash
PR_BODY_TMP=$(mktemp)
# write body to $PR_BODY_TMP
```

Run:
```bash
<commands.pr_create> --title "<title>" --body-file "$PR_BODY_TMP" --base <base>
# e.g.: gh pr create --title "PROJ-123: fix login redirect" --body-file /tmp/pr-body-XXXX --base main
```

- Capture stdout; extract the first line matching `^https?://` as the PR URL.
- On stdout containing `"pull request already exists"` or similar: offer to update the existing PR.
  - Use `AskUserQuestion` with options: `Update existing PR body` / `Cancel`.
  - If Update: run `gh pr edit --body-file "$PR_BODY_TMP"` (or the platform equivalent) targeting the existing PR number (parse from stderr or `gh pr view --json number`).
- On `gh auth` error in stderr: FAIL `"not authenticated — run: gh auth login"`.
- On any non-zero exit: FAIL with stderr tail + exit code.

Clean up `$PR_BODY_TMP` after use.

### Gate 4 — record

**Write `state/bindings.json`:**
Read the file (create `{}` if missing), set `bindings[branch].pr_url = url`, atomic-write (temp+rename):
```bash
# example shape after write:
{
  "feature/PROJ-123-fix-login": { "pr_url": "https://github.com/org/repo/pull/456" }
}
```

**Append to SHELL.md Progress Log:**
```
[HH:MM] PR opened: <url>
```

## Output

```
dev-pr
  branch:   feature/PROJ-123-fix-login
  base:     main
  push:     pushed (3 commits)
  title:    PROJ-123: fix login redirect on expired session
  url:      https://github.com/org/repo/pull/456
  body:     4 sections, 2 screenshots attached
  template: builtin
  status:   created
```

On `--force`:
```
dev-pr
  force:    quality-check and alert-check skipped
  branch:   feature/PROJ-123-fix-login
  ...
```

On Gate 0 FAIL: name the failed check and give the exact command to satisfy it. Example:
```
dev-pr
  FAIL (Gate 0 — quality check): quality report is stale (run on abc1234, now at def5678)
  recovery: /claude-code-dev-hermit:dev-quality
```

On Gate 3 FAIL: show the host-tool exit message + a one-line recovery hint.

## Rules

- **Never skips clean-tree or protected-branch checks** regardless of `--force`.
- **No code edits, no test runs.** Those belong to `/dev-quality` and the implementer. `/dev-pr` is a push-and-create operation only.
- **No screenshot creation.** Reads from `raw/screenshots/<binding-id>/manifest.json`. Producing screenshots is a stack-specific plugin's job.
- **No merge.** Opening the PR is the terminal step; merging is a separate operator decision.
- **Session→PR auto-link.** Calling `gh pr create` via Bash preserves Claude Code's native session→PR linking. The operator can resume this session later with `claude --from-pr <number>`.
- **Always-on mode.** All git operations that read branch state or push use `git -C "$HERMIT_AGENT_WORKTREE"` when `$HERMIT_AGENT_WORKTREE` is set. The state files (`quality-last.json`, `alerts.json`, `bindings.json`) are in `.claude-code-hermit/state/` in the main checkout (CWD-relative) — no worktree prefix needed for those.
