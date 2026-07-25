---
name: pre-release-review
description: "Run the pre-release gate for this multi-plugin monorepo: establish each plugin's release boundary from its last reachable tag to HEAD, audit every changed plugin's [Unreleased] changelog against the actual code diff, identify contract-surface and breaking changes, and optionally run a dedicated Codex correctness review over the exact union release window after explicit approval. Use when the user asks for a pre-release review, release audit, readiness check, release-window review, sanity check before tagging, or whether accumulated unreleased work is ready to ship. Run before release or fleet-release; never bump versions, create tags, commit, or push."
---

# Pre-Release Review

Run this gate immediately before `$release` or `$fleet-release`. Answer:

1. What is actually shipping in each plugin?
2. Does each plugin's `[Unreleased]` changelog accurately describe that diff?
3. If the user authorizes the expensive pass, does a dedicated Codex review find correctness problems in the union release window?

Keep Steps 1–3 read-only. Do not edit changelogs, bump versions, commit, tag, or push. Step 4 may edit only after the user explicitly authorizes the disclosed review-and-fix pass.

## Invocation

- `$pre-release-review` — audit every plugin with commits since its own last tag.
- `$pre-release-review` for `<plugin-slug>` — audit only that plugin.

When installed, `$release-status` is an optional lightweight precursor. `$docs-drift` is the documentation follow-up after this changelog-vs-code audit.

## Step 1 — Establish per-plugin release boundaries

Each plugin versions independently with tags shaped `<slug>--vX.Y.Z`, including `claude-code-hermit--v*`. Never use the single newest repository tag as a global boundary.

Enumerate `plugins/*/.claude-plugin/plugin.json`. For each requested plugin:

```bash
last_tag=$(git tag --list "<slug>--v*" | sort -V | tail -1)
base=${last_tag:-$(git rev-list --max-parents=0 HEAD | tail -1)}
git rev-list "$base"..HEAD --count -- plugins/<slug>/
```

- Skip a plugin with zero scoped commits.
- Mark a plugin with no usable manifest version or no defensible release boundary as `unstructured (skip)`.
- Record its base tag, short base SHA, short HEAD SHA, and scoped commit count.
- If legacy single-dash tags coexist with double-dash tags, or a candidate tag is not an ancestor of HEAD, list the candidates and verify reachability with `git merge-base --is-ancestor`. Choose the newest reachable double-dash tag and explain the choice. Never guess silently.

Compute one `$review_base` for the optional deep review. The oldest in-scope base commit covers the union of all per-plugin windows:

```bash
review_base=$(for b in $in_scope_bases; do
  echo "$(git log -1 --format=%ct "$b") $b"
done | sort -n | head -1 | cut -d' ' -f2-)
```

For one in-scope plugin, use that plugin's base.

If no plugin is in scope, report that nothing is queued for release and stop.

## Step 2 — Build per-plugin release context

For every in-scope plugin, run:

```bash
git log  "$base"..HEAD --oneline --decorate -- plugins/<slug>/
git diff "$base"..HEAD --stat -- plugins/<slug>/
git diff "$base"..HEAD --name-status -- plugins/<slug>/
```

Read full diffs selectively, prioritizing:

- Contract surfaces: `skills/`, `agents/`, `hooks/hooks.json` and referenced scripts, `commands/`, MCP configuration, `state-templates/`, `.claude-plugin/plugin.json`, `.claude-plugin/hermit-meta.json`, and any consumed config schema.
- Source and logic changes under the plugin.
- Added or changed tests, or a conspicuous lack of tests beside behavior changes.
- The plugin's `CHANGELOG.md`, limited to `[Unreleased]`.
- Root release notes or root changes in the window when they explain the plugin diff.

Keep evidence grouped by plugin.

## Step 3 — Audit changelogs against reality

Run the deterministic checks first for each in-scope plugin:

```bash
# Was the changelog touched in this plugin's release window?
git diff "$base"..HEAD --name-only -- plugins/<slug>/CHANGELOG.md | rg -q '.' \
  && echo "changelog touched" || echo "CHANGELOG NOT UPDATED"

# Are [Unreleased] category headings duplicated?
awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && /^### /' \
  plugins/<slug>/CHANGELOG.md | sort | uniq -d

# Did a merge touch the plugin but omit its changelog?
git log --merges --format=%H "$base"..HEAD -- plugins/<slug>/ | while read -r m; do
  git diff --name-only "$m^1" "$m" -- plugins/<slug>/CHANGELOG.md | rg -q '.' \
    || git log -1 --format='%h %s' "$m"
done
```

Then compare every `[Unreleased]` claim with the actual diff:

- **Missing entry** — an operator-visible behavior change lacks a bullet. This includes skills or triggers, commands, hook matchers or effects, MCP behavior, agent contracts, config keys, templates, and core-requirement changes. Pure refactors, tests, docs, and comments are correctly omitted under repository policy.
- **Overstated** — a bullet promises behavior the implementation does not deliver.
- **Understated or omitted breaking change** — a command or config contract was removed or renamed, a default changed, or `required_core_version` tightened without clear migration impact. Treat this as blocking.
- **Style drift** — the bullet violates the repository's terse style: plain sentence case under `Added`, `Changed`, or `Fixed`; no `**component:**` prefix; no leading Added/Changed/Fixed verb; no `### Files affected`; use backticks for code. Note style drift without making it blocking by itself.

For each plugin, state whether these contract surfaces changed:

- commands or skills
- hooks
- MCP behavior
- agents
- config or customization points
- `required_core_version`, `requires`, or native `dependencies`

Say `no contract changes` explicitly when none changed.

## Step 4 — Dedicated Codex correctness review

Do not start this step automatically. After reporting Steps 1–3, ask whether to run the deep pass and wait for an explicit yes.

Disclose the exact scope, cost, and mutation behavior:

> Steps 1–3 are complete. The deep pass will run a dedicated `codex review` over `<review_base>...HEAD`. It can take several minutes and consume additional tokens. Native Codex review is read-only; after it returns, I will verify each finding and apply only confirmed fixes to the working tree, then run relevant checks. Run it now? (yes / stop here)

If the user declines, stop after Step 3.

On explicit approval, use a custom review prompt because `codex review --base` accepts a branch, while the release boundary may be a tag or commit:

```bash
codex review "Review only the committed diff in <review_base>...HEAD. Find concrete correctness, regression, security, efficiency, reuse, and repository-convention problems. Cite a file and line for every finding, explain the impact, and ignore changes outside this range. Do not modify files."
```

The three-dot range matches the release-window comparison when `$review_base` is an ancestor of HEAD.

After the review:

1. Verify every finding against the current code and exact range. Reject false positives.
2. Apply minimal fixes only for confirmed findings. The Step 4 approval covers these disclosed fixes; do not expand scope.
3. Add or update regression coverage when behavior changes.
4. Add a terse `[Unreleased]` changelog bullet only for shipped code or behavior changes. Do not add one for docs-only or comment-only fixes.
5. Run the affected plugin's complete suite plus `bunx tsc --noEmit`.
6. Re-audit any changed changelog text against the fixed diff.
7. Never commit, tag, or push.

The Step 1–3 per-plugin audit remains authoritative for what is shipping. The union `$review_base...HEAD` may include already-released commits from a plugin with a newer tag; call this out, but do not narrow the range and miss cross-plugin interactions.

## Report

Lead with blocking findings and use this structure:

```text
# Pre-Release Review — <date>

## Release boundaries
| Plugin | Base tag | Base | HEAD | Commits |
|--------|----------|------|------|---------|
| hermit-scribe | hermit-scribe--v0.0.6 | a1b2c3d | e4f5a6b | 4 |

Skipped: <zero-commit or unstructured plugins>

## Changelog-vs-reality audit
### <slug> — VERDICT: clean | needs-attention | blocking
- correctly documented: <bullet> ↔ <file:line>
- missing entry: <operator-visible change at file:line> has no changelog bullet
- understated breaking change: <impact and file:line>
- contract surfaces changed: <list or "none">

## Deep review
Scope: <review_base>...HEAD
Status: not run | declined | clean | findings fixed | findings remain
- <prioritized finding or fix summary>

## Verdict
Ready to tag: <slugs>
Fix first: <slugs and one-line reason>
```

A plugin with an omitted breaking change or a missing changelog entry for a contract change is not ready to tag.
