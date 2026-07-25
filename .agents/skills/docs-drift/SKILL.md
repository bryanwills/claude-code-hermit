---
name: docs-drift
description: Pre-release documentation-drift audit for this six-plugin monorepo. Read each in-scope plugin's [Unreleased] changelog section and verify that plugin READMEs, docs, CLAUDE.md or AGENTS.md files, and root documentation still describe the behavior about to ship. Report meaningful contradictions with concrete proposed edits and wait for approval before changing files. Use when preparing a release or when the user asks for "docs drift", "check the docs", "are the docs up to date", "docs audit", "did the docs keep up", or whether documentation matches unreleased changes. Complements pre-release-review, which checks changelog claims against code; this skill checks changelog claims against docs.
---

# Docs Drift

Verify that documentation still tells the truth after the changes accumulated in each plugin's `[Unreleased]` changelog section.

Keep the audit read-only. Do not edit, commit, tag, or push until the user explicitly approves specific findings.

## Invocation

Use `$docs-drift` for all plugins with unreleased changes, or ask to narrow the audit to one plugin slug.

Typical release order, when the sibling skills are installed:

`$release-status` → `$pre-release-review` → `$docs-drift` → `$release`

## Step 1 — Scope plugins with unreleased changes

From the repository root, identify plugins whose `[Unreleased]` section contains non-blank content:

```bash
for p in plugins/*/CHANGELOG.md; do
  slug=$(basename "$(dirname "$p")")
  awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && NF' "$p" | rg -q '.' \
    && echo "$slug"
done
```

If the user named a plugin, limit the scope to that slug after verifying it exists. Plugins with an empty or absent `[Unreleased]` section are out of scope.

If nothing is in scope, stop with: `No unreleased changes in any plugin — nothing to drift-check.`

Use `[Unreleased]` as the audit window. If you notice older drift incidentally, keep it separate as pre-existing debt rather than mixing it into the release verdict.

## Step 2 — Extract doc-checkable claims

Read only the `[Unreleased]` section of each in-scope changelog. Turn each bullet into zero or more claims a document could contradict:

- **Removal or rename** — a skill, command, script, hook, config key, doc file, or CLI was removed or renamed.
- **New operator-visible surface** — a new skill, command, config block, hook, CLI, or channel behavior should appear where sibling surfaces are enumerated.
- **Changed default or behavior** — documentation may still state the previous default or behavior. Treat this as the highest-severity class.
- **Count claim** — a hand-written count may still contain the old number.
- **Promised documentation** — a cited file or anchor must exist and cover what the changelog promises.

Mark pure internal fixes, refactors, and test-only changes as `no doc surface`. Do not manufacture a finding for every bullet.

## Step 3 — Sweep relevant documentation

For each in-scope plugin, consider the files that exist among:

- `plugins/<slug>/README.md`
- `plugins/<slug>/docs/*.md`
- `plugins/<slug>/CLAUDE.md`
- `plugins/<slug>/AGENTS.md`
- top-level plugin extras such as `SAFETY.md`, `DOCKER.md`, or `CONTRIBUTING.md`

Once per audit, check the union of all claims against:

- root `README.md`
- root `CLAUDE.md`
- root `AGENTS.md`
- root documentation extras that are relevant to a claim

Work claim-first, not file-first. For each claim, use `rg -n` for old names, numbers, defaults, removed paths, or sibling enumerations. Read only files with relevant hits, plus the narrow context needed to judge a missing enumeration.

When more than two plugins are in scope and agent delegation is available, delegate one plugin audit per worker agent. Give each worker only that plugin's claims and require findings in this form:

`file:line — contradicted claim — current text — suggested fix`

Keep the root-file sweep in the main session because it needs the cross-plugin union. Respect the available agent-slot limit: run a second wave if needed. If delegation is unavailable, perform the same checks sequentially.

## Step 4 — Judge meaningfulness

Propose an edit only when a reader would be factually misled after the release:

- **Meaningful:** references a removed or renamed surface; states an old default or behavior; gives a now-wrong count; omits a new surface from a sibling enumeration; or promises documentation that does not exist or does not cover the claim.
- **Not meaningful:** tone preferences, formatting, absent marketing coverage, missing documentation for internal fixes, or changelog-vs-code accuracy that `$pre-release-review` owns.
- **Borderline:** a possible mismatch whose reader impact is unclear. Report it separately with a one-line rationale and no proposed edit.

Do not pad findings.

## Step 5 — Report and wait for approval

Use this shape:

```text
# Docs Drift — <date>

## Scope
In scope (non-empty [Unreleased]): <slugs>. Skipped: <slugs> (empty).

## Findings
### <n>. <slug> — <misleading | stale-reference | missing-doc>
- Claim: <abbreviated changelog bullet> (CHANGELOG.md [Unreleased])
- Drift: <doc file:line> — currently says: "<excerpt>"
- Proposed edit: <exact replacement text, or "add section X covering Y">

## Borderline (no edit proposed)
- <file:line> — <one-line rationale>

## Pre-existing drift (not this release)
- <anything noticed outside the [Unreleased] window>

## Verdict
<N> meaningful findings across <M> files | Docs are clean for this release.
```

Ask which findings to apply: all, selected finding numbers, or none. The audit request itself is not approval to edit.

After the user approves:

1. Apply only the approved edits with `apply_patch`.
2. Match each document's existing style.
3. Re-read the changed passages and run `git diff --check`.
4. Do not add a changelog entry for documentation-only edits; repository guidance explicitly excludes them.
5. Report the uncommitted files and verification. Never commit or push from this skill.
