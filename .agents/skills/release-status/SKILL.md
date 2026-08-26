---
name: release-status
description: Use this skill to answer "what's ready to ship?", "where does the release pipeline stand?", "any plugins awaiting tag?", "give me a pipeline overview/snapshot", or any pre-release-session check-in. Shows all plugins' current version, last tag, commits ahead, whether there are unreleased changes, and whether required_core_version is stale or unsatisfied. No mutations — read-only.
---

# Release Status

Read-only diagnostic — `git status` for the release pipeline. No mutations.

## Steps

### 1. Collect plugin data

Glob `plugins/*/.claude-plugin/plugin.json`. For each slug:

```bash
# version
jq -r .version plugins/<slug>/.claude-plugin/plugin.json

# last tag (double-dash format)
git tag --list "<slug>--v*" | sort -V | tail -1

# commits since last tag, scoped to this plugin's directory
# use HEAD as base if no tag exists
git rev-list <last-tag-or-HEAD>..HEAD --count -- plugins/<slug>/

# non-empty [Unreleased] section
awk '/^## \[Unreleased\]/{flag=1; next} /^## \[/{flag=0} flag && NF' \
  plugins/<slug>/CHANGELOG.md

# hygiene: duplicate section headers inside [Unreleased] (fragmented changelog
# from parallel worktree merges)
awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && /^### /' \
  plugins/<slug>/CHANGELOG.md | sort | uniq -d

# hygiene: merges since last tag that touched the plugin but not its CHANGELOG
# (likely missing an [Unreleased] entry; use the repo's initial commit if no tag)
git log --merges --format=%H <last-tag-or-initial>..HEAD -- plugins/<slug>/ | while read m; do
  git diff --name-only "$m^1" "$m" -- plugins/<slug>/CHANGELOG.md | grep -q . \
    || git log -1 --format='%h %s' "$m"
done
```

For plugins with no `plugin.json` version or no recognizable tags: mark as `unstructured (skip)` and stop collecting data for that plugin.

### 2. Get latest core reference

```bash
git tag --list "claude-code-hermit--v*" | sort -V | tail -1
```

Extract just the version number (strip `claude-code-hermit--v`). Call it `latest_core_version`.

### 3. Read dependency constraints (domain plugins only)

For each plugin that has `plugins/<slug>/.claude-plugin/hermit-meta.json`:

```bash
jq -r .required_core_version plugins/<slug>/.claude-plugin/hermit-meta.json
```

### 4. Determine status per plugin

| Condition | Status |
|-----------|--------|
| `plugin.json` version > last tag version | `awaiting-tag` |
| `[Unreleased]` section is non-empty | `prep-needed` |
| version matches last tag, no `[Unreleased]` | `up-to-date` |
| no version or no tags | `unstructured` |

### 5. Apply core-req flags (domain plugins)

Parse the version floor from `required_core_version` (the number after `>=`). Compare to `latest_core_version`:

| Condition | Flag |
|-----------|------|
| floor > latest_core_version | `✗ ERROR: unsatisfied` |
| floor == latest_core_version | `✓` |
| floor < latest_core_version | `⚠ WARN: stale` |

### 6. Print output

```
Plugin                            Version   Last Tag   Ahead  Status         Core Req
claude-code-hermit                1.0.22    1.0.21     2      awaiting-tag   —
claude-code-dev-hermit            0.2.2     0.2.1      2      awaiting-tag   >=1.0.22 ✓
claude-code-homeassistant-hermit  0.0.6     0.0.6      0      up-to-date     >=1.0.21 ⚠ stale (core: 1.0.22)
claude-code-fitness-hermit        —         —          —      unstructured (skip)
```

After the table:

- List any **ERROR** items with a one-line explanation.
- List changelog-hygiene warnings from step 1 (these block a clean `/release` and should be fixed first):
  - `⚠ <slug>: fragmented changelog — duplicate '### <header>' inside [Unreleased]; consolidate (one header per section, see /commit)`
  - `⚠ <slug>: <N> merge(s) since <last-tag> touched the plugin without a CHANGELOG entry: <hash> <subject>, ...` — verify each is genuinely operator-invisible (pure refactor/test-only) or backfill a bullet.
- End with one of:
  - `Nothing ready to ship.` — no plugin is `awaiting-tag` or `prep-needed`
  - `Ready to ship: <slug>, <slug>` — plugins where status is `awaiting-tag` or `prep-needed`
