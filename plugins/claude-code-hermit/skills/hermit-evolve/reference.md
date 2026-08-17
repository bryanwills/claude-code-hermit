# Hermit Evolve — Upgrade Steps Reference

This file is the instruction spec for the isolated-context subagent dispatched by `hermit-evolve/SKILL.md`'s `## Execution routing` section (`evolve-runner`). The subagent reads this file directly — not `SKILL.md`, which stays a thin routing stub — and executes steps 0 through 9 exactly as written below. Step 10 (report handling) lives in `SKILL.md` and runs in the main loop after the subagent returns its report.

The dispatch prompt supplies the resolved absolute plugin root — substitute it for `<plugin_root>` throughout this file. Do not use the `${CLAUDE_PLUGIN_ROOT}` token: it is not substituted in this file's content and is empty as a Bash variable.

### 0. Verify Claude Code CLI version

- Read `<plugin_root>/.claude-plugin/hermit-meta.json`. If the file
  doesn't exist or `min_claude_code_version` is not set, skip this step.
- Run `claude --version` and parse the leading semver (format:
  `X.Y.Z (Claude Code)`). If the command fails or the version cannot be parsed,
  report: "Could not detect Claude Code CLI version — proceeding anyway." and
  skip the comparison.
- Compare the detected version against `min_claude_code_version` (supports
  `>=X.Y.Z` or bare `X.Y.Z`, treated as `>=`). If the CLI version is below the
  minimum, report:

  ```
  This hermit version requires Claude Code >=<min> (you have <detected>).

  Upgrade Claude Code (`claude update` or your package manager) and re-run
  /claude-code-hermit:hermit-evolve.
  ```

  Substitute `<min>` with the value from `min_claude_code_version` and
  `<detected>` with the parsed CLI version. Then stop. Do not prompt to bypass.

### 0b. Verify the bun runtime (hard gate)

- Read `required_bun_version` from the same `hermit-meta.json`. If not set, skip
  this step.
- Run `bun --version`. If the command fails (bun not installed) or the version is
  below the requirement, report:

  ```
  This hermit version requires bun <required> — hooks and scripts run on it.
  You have: <detected or "not installed">.

  Install:  curl -fsSL https://bun.sh/install | bash
  Upgrade:  bun upgrade

  Then re-run /claude-code-hermit:hermit-evolve.
  ```

  Then **stop. Do not prompt to bypass and do not continue the upgrade** — completing
  it without bun would leave every hook fire erroring at spawn. (Docker operators are
  unaffected: the image bakes bun in.)

### 1. Resolve hatch target, then run the pre-pass

First determine `hatch_target` (the pre-pass needs it, and so do Steps 6, 7, 8):

Run `bun <plugin_root>/scripts/domain-hatch.ts preflight claude-code-hermit` and take `target` as `hatch_target`. It owns the whole chain — the stamped file first, then core's own block in `CLAUDE.local.md` or `CLAUDE.md`, then install-scope detection — so hatch, evolve and every domain hatch resolve the target identically.

If it returns `needs_target_question: true` the project has no stamped target. Use the returned `target_default` and stamp it with `bun <plugin_root>/scripts/domain-hatch.ts ensure-target claude-code-hermit --target <target_default>`, so the next run of anything reads an answered file instead of re-deriving.

Then run the deterministic pre-pass — a single read-only analyzer that computes the version gap, the bounded CHANGELOG slice, new config keys, changed templates/bin, and the CLAUDE-APPEND block diff, so the steps below act on its output instead of reading and diffing whole files:

```
bun <plugin_root>/scripts/evolve-plan.ts .claude-code-hermit --hatch-target=<hatch_target>
```

Parse stdout as JSON (the "plan"). The plan's `errors` array is the **sole error channel** — objects of `{code, message}`:

- If `errors` contains an entry with `code == "no_config"` → report "No config found. Run `/claude-code-hermit:hatch` first." and stop.
- Else if `errors` is non-empty (any other code, e.g. `no_hatch_target`) **or** stdout is not valid JSON → report "evolve-plan failed: <joined messages> — re-run or report." and stop. Do not fall back to reading and diffing the files by hand.

**Stale-runtime check (before everything else):** if the plan's `loaded_core_older_than_applied` is `true`, this session loaded an older plugin copy (v`to`) than the version this hermit has already applied (v`from`) — a stale install, not a pending upgrade. Report: "This session is running plugin v<to>, older than this hermit's applied state v<from> — a stale plugin install. hermit-evolve cannot fix it: update the install that resolves to this plugin root, then re-run." **Stop there.** Do not run any other step: Step 7's sibling migrations would apply while Step 9 refuses to stamp, leaving siblings migrated but unstamped and replaying on the next run. Sibling work waits until the install is fixed — sibling stamps stay where they are and re-plan cleanly.

**Version check:** the plan reports `from`, `to`, `up_to_date`, and `work_pending`. If `work_pending` is `false` (core current AND no sibling gap, drift, path-unresolved, or warnings), report "You're up to date (v<to>). Nothing to upgrade." and stop. If `up_to_date` is `true` but `work_pending` is `true` (sibling-only work), announce: "Core is current (v<to>); processing sibling hermits." and run only Steps 7, 8, 9, and 10 — the core-content steps (2 through 6) have no pending work when core is current. (Sibling migrations and CLAUDE-APPEND sync happen inside Step 7.) Otherwise (core has a gap) announce: "Upgrading from v<from> to v<to>." and run all steps.

### 2. Present the changelog

Present the plan's `changelog_slice` to the operator: "Here's what changed:" followed by the slice. It already contains only the entries in `(from, to]`, oldest-first — no full-file read.

### 2b. Execute version migrations

Within `changelog_slice` (already ordered oldest-first), each version entry may contain a `### Upgrade Instructions` section:

1. Find the `### Upgrade Instructions` section within each version's entry
2. If found, execute every instruction in that section — these are the authoritative migration steps
3. Collect any version-specific operator notes for the step-10 report (delegated mode has no operator to present to live)
4. **Delegated mode:** if a step is interactive (poses an either/or), do not ask. Apply the non-destructive default (e.g. a delete/cleanup offer → keep the file) and note it for step 10. If the step has **no safe default**, **defer** — skip it and record a verbatim deferred-migration block per the Delegated mode rules.

The CHANGELOG.md `### Upgrade Instructions` sections are the single source of truth for migrations — do not skip or merely display them. The same pattern applies to sibling-hermit upgrades in Step 7.

**Surgical docker-template migrations.** An Upgrade Instruction may surgically patch a wizard-rendered docker template (`Dockerfile.hermit`) and re-record its `template-manifest.json` baseline. When it does, it sets the report's `Docker rebuild` field to `base-patched`. Treat the corresponding `docker_templates` drift entry as resolved — do **not** surface it as unresolved upstream drift in Step 10.

### 3. New config keys

The plan's `new_config_keys` array lists every key in the current `config.json.template` that is missing from the project's config, each as `{path, default}` — a dotted `path` for a nested leaf, or a fully-absent parent carrying its whole default subtree. Operator-set values are never listed, so acting on these never overwrites them.

### 4. Apply new settings

**Delegated mode:** add **every** entry in the plan's `new_config_keys` silently with its `default` from the plan — operator-set values are never listed by the plan, so this never overwrites a choice. There is no prompting (the subagent can't `AskUserQuestion`). The former identity/preference keys below are almost always already set by evolve time, so they rarely appear; when one does, it takes the plan `default` and the operator adjusts via `/hermit-settings`. Collect every silently-set key for the step-10 report. If `new_config_keys` is empty, skip this step.

Special-default keys (apply the noted default when the key is in `new_config_keys`):
- `language` (0.0.1) / `timezone` (0.0.1): when missing, the subagent **auto-detects** the value (`$LANG` / system timezone via `date +%Z`/`timedatectl`) and writes that, rather than the static plan default. (These are 0.0.1 keys, set at hatch, so they are almost never missing at evolve time.)
- All other keys: apply the plan's `default` verbatim (operator tunes via `/hermit-settings` afterward). The canonical defaults live in `state-templates/config.json.template`; `evolve-plan.ts` derives each `new_config_keys[].default` from it, so there is no separate default list to maintain here.

The actual write happens in step 9 (merge into config, missing-only); this step just records which keys to set.

### 4b. Legacy plan-table check

If an active SHELL.md has a `## Plan` section (legacy plan table), note it for the step-10 report: "Close active sessions before upgrading, or the old plan table will be orphaned." **Delegated mode: warn only — never strip** (stripping needs operator confirmation, which the subagent can't get).

### 5. Update templates

`templates_changed` is now a list of classified file objects `{ name, class }` (not bare strings). Each entry represents a file that differs from upstream or is absent. Resolve by class:

- **`missing`**: `templates/<name>` was absent. Copy `<plugin_root>/state-templates/<name>` → `.claude-code-hermit/templates/<name>`. Report: "Restored missing template: `<name>`."
- **`unmodified`**: operator never customized it (baseline == on-disk, or no manifest entry). Copy upstream over it silently.
- **`customized-kept`**: operator edited it and the template hasn't moved. **Keep the operator's copy unchanged.** Collect in a summary line at the end: "Kept N operator-customized template(s): `<name>`, ..."
- **`conflict`**: both the operator and the template changed since hatch.
  - **Delegated mode** (always — non-boot templates): write upstream as `<name>.new` beside the operator's copy, keep the operator's copy live (lossless; conflict resolution needs a prompt the subagent can't issue). Collect for the step-10 report: "N template conflict(s) parked as .new — review when convenient: `<name>`, ..."

If `templates_changed` is empty, skip.

After all template resolutions (see manifest-write note at end of Step 5b).

**Never touch:** sessions, proposals, OPERATOR.md, HEARTBEAT.md (operator-editable), or config.json (handled separately).

Only update files in `templates/`:

- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

Note: SHELL.md.template has no `## Plan` section — plan steps live in the `## Progress Log`.

### 5a. Migrate obsidian/ surface

If `<project-root>/obsidian/` exists in the target project:

- Leave the directory untouched — operators may have customised it.
- Append to `.claude-code-hermit/sessions/SHELL.md` Findings: `"obsidian/ no longer maintained by hermit; safe to delete or keep as personal vault."`
- Also leave `.claude-code-hermit/cortex-manifest.json` in place if present — operator-managed.

### 5b. Update boot script wrappers

`bin_changed` entries carry `boot_critical: true` (all bin/ wrappers are boot wrappers — a stale one can dead-end the hermit). Resolution by class:

- **`missing`**: wrapper was absent. Copy `<plugin_root>/state-templates/bin/<name>` → `.claude-code-hermit/bin/<name>`. `chmod +x`. Report: "**Restored missing boot wrapper: `<name>`.**"
- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept N operator-customized wrapper(s): `<name>`, ..."
- **`conflict`** (any context — **no `.new` parking for boot-critical files**): replace with the upstream version (`chmod +x`) and save the operator's copy as `<name>.bak`. Report loudly in the run report and channel (if applicable): "**Boot wrapper `<name>` had local changes — replaced with new version; your copy saved as `<name>.bak`.**"

If `bin_changed` is empty, skip the copy (still confirm executability for all files in `bin/`).

**Bootstrap safety net** (`manifest_bootstrap: true` in the plan): on the first evolve after this feature ships (no manifest yet), any template or bin file that gets overwritten or restored also gets a one-time `<name>.bak` alongside it. This makes the quiet bootstrap recoverable: if an existing customization was already present before the manifest was seeded, it survives in the `.bak`. One noisy set of `.bak` files, once, then quiet thereafter.

### 5c. Update the Docker entrypoint (boot-critical, manifest-managed)

`docker_entrypoint` in the plan is a single classified object `{ name, class, boot_critical }`, or `null` when the project has no deployed `docker-entrypoint.hermit.sh` (non-Docker project — skip this step). The entrypoint is placeholder-free, so it is managed exactly like a boot-critical `bin/` wrapper. On-disk file: `<project-root>/docker-entrypoint.hermit.sh`; upstream: `<plugin_root>/state-templates/docker/docker-entrypoint.hermit.sh.template`. Resolve by class:

- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept operator-customized docker-entrypoint.hermit.sh."
- **`conflict`** (any context — no `.new` parking for boot-critical files): replace with the upstream version, and save the operator's copy to a **gitignore-safe backup inside the state tree**: `.claude-code-hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`. Do NOT write the backup next to the project-root entrypoint — that path is not gitignored and would surface as an untracked file in the operator's repo. Report loudly (run report + channel): "**docker-entrypoint.hermit.sh had local changes — replaced with the new version; your copy saved as `<backup path>`.** Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`."
- (`missing` is never emitted for the entrypoint — the plan returns `null` when it is absent — so there is no restore branch.)

**Per-file bootstrap (`bootstrap: true` on the entry).** The plan sets this when no docker entrypoint baseline was recorded yet (e.g. a Docker deploy from before this version, where the manifest exists for `templates/`/`bin/` but `/docker-setup` never recorded the entrypoint hash). In that state the class falls back to `unmodified`, but a silent overwrite would destroy an operator customization that can't be distinguished from an old upstream copy. So: **whenever `bootstrap` is true and you are about to overwrite, FIRST write the operator's current copy to the gitignore-safe `.claude-code-hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`**, then apply the class action, and report the backup path. This is a one-time net — the manifest records the baseline below, so it won't recur. (The global `manifest_bootstrap: true` net does NOT cover this case: the manifest is present, just missing the docker key.)

The replaced entrypoint takes effect only after a rebuild (Step 10 carries the reminder).

**After resolving Steps 5 (templates), 5b (bin/), and 5c (docker entrypoint)**, record the new pristine-baselines in `state/template-manifest.json` via `manifest-seed.ts` — **do not hand-compute the hashes** (the script makes them correct by construction; an LLM cannot sha256 reliably). Decide *which* files to record, then hand them to the script:
- **Which files:** every file that was copied, replaced, or restored in Steps 5/5b/5c. Build one `{ "key": "<prefix>/<name>", "file": "<on-disk path of the new content>" }` entry per such file. Prefixes: `templates/` (file `.claude-code-hermit/templates/<name>`), `bin/` (file `.claude-code-hermit/bin/<name>`), and for the entrypoint the literal key `docker/docker-entrypoint.hermit.sh` (file: the project-root `docker-entrypoint.hermit.sh`).
- **`customized-kept` files:** do NOT include them — the script preserves their existing manifest entry unchanged via foreign-key preservation.
- **If `manifest_bootstrap` was true:** include the full managed set — every `templates/` and `bin/` file (and the entrypoint, if deployed), hashing whatever is now on-disk after any overwrites. This is the one-time baseline seeding.
- **Run** `bun <plugin_root>/scripts/manifest-seed.ts .claude-code-hermit` with `{ "pluginVersion": "<plan.to>", "entries": [ ... ] }` on stdin. The script hashes each on-disk file, merges into the existing `files` map — preserving untouched prefixes, sibling-hermit keys, and the `docker/docker-compose.hermit.yml.template` / `docker/Dockerfile.hermit.template` baselines `/docker-setup` records (Step 10 reads them) — and writes `{ "version": 1, "files": { ... } }`. It refuses to overwrite a present-but-corrupt manifest. This replaces the manual "merge into the existing `files` map, never replace wholesale" handling.
- **Ordering:** run this *after* Step 8 has ensured the plugin permissions, so `bun */scripts/manifest-seed.ts*` is allowed. The files resolved in Steps 5/5b/5c are stable on disk, so deferring the manifest write to after Step 8 does not change the recorded hashes.

### 6. Update CLAUDE-APPEND block

The target file is determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `CLAUDE.local.md`
- `hatch_target == "committed"` → `CLAUDE.md`

If `plan.claude_append_ambiguous` is `true`, report `claude-code-hermit block-ambiguous — the marker appears more than once in <target>, manual review needed` and apply no Edit.

If the plan's `claude_append_changed` is `false`, skip this step. If `true`, read `<plugin_root>/state-templates/CLAUDE-APPEND.md` for the new content, then branch on the plan's `claude_append_old_block`:

- **`claude_append_old_block` present** (marker found — replace case): the new content is the marker-onward portion of `CLAUDE-APPEND.md` — from the `<!-- claude-code-hermit: Session Discipline -->` marker through its closing `<!-- /claude-code-hermit: Session Discipline -->` marker when the template carries one, else to the end of the block (the leading `---` already sits above the marker in the target). Apply a targeted `Edit` to the target file with `old_string` = `claude_append_old_block` (the exact current block) and `new_string` = that marker-onward content. **Do not read the whole target file** — the exact `old_string` is supplied by the plan, and the `---` must not be duplicated.
- **`claude_append_old_block` absent** (marker not found — append case): append the **full `CLAUDE-APPEND.md` including its leading `---`** to the target file (same as init — the `---` separates the project's content from the block).
- Report what changed.

### 7. Hermit upgrades

The plan's `siblings[]` array is the authoritative list (registry-driven from `_hermit_versions`; path-resolved by `evolve-plan.ts` with the project-scope + realpath filter). Do not re-run `claude plugin list --json` here.

For each entry in `plan.siblings`:

- **Version gap (`up_to_date == false`):**
  - Present: "{name}: upgrading from v{from} to v{to}. Here's what changed:" followed by `changelog_slice` (already bounded to the gap range, oldest-first).
  - **Execute migrations** — within `changelog_slice`, find each version's `### Upgrade Instructions` section and execute every instruction in version order. Same rules as Step 2b: non-interactive default on ambiguous steps; defer if no safe default.
  - **Sync CLAUDE-APPEND block** — apply the Edit **only here, on a version gap**, branching on the sibling's flags first:
    - `sibling.claude_append_needs_render` → report `<name> block refresh deferred to /<name>:hatch (template requires rendering)`; apply no Edit. Core cannot render a template carrying `mode:` markers — that is the owning plugin's own hatch's job.
    - `sibling.claude_append_block_missing` → report `<name> block-missing — run /<name>:hatch to install it`; apply no Edit. **Never append a sibling's block** — core has no way to guarantee an append would render it the way the sibling's own hatch does.
    - `sibling.claude_append_ambiguous` → report `<name> block-ambiguous — the marker appears more than once, manual review needed`; apply no Edit.
    - Otherwise: same replace procedure as Step 6, using `sibling.marker` and `sibling.claude_append_old_block`.
  - Collect the sibling name for the `--sibling=<name>=<to>` flag in Step 9.

- **No version gap (`up_to_date == true`) + `claude_append_changed == true`:**
  - **Do NOT apply a CLAUDE-APPEND Edit.** We cannot distinguish a deliberate operator edit from a missed sync at this diff level; auto-writing would clobber operator changes.
  - Report by cause, checking the specific flags before falling back to the generic label:
    - `sibling.claude_append_block_missing` → `<name> block-missing — run /<name>:hatch to install it`.
    - `sibling.claude_append_ambiguous` → `<name> block-ambiguous — the marker appears more than once, manual review needed`.
    - Otherwise → `<name> block-drifted` — advisory note for the operator to review manually.

- **No version gap + `claude_append_changed == false` (or absent):** report `<name> current`, skip. (`claude_append_needs_render` may also be set here — it is a static property of the sibling's template, not pending work; core only acts on it inside the version-gap branch above.)

If `plan.siblings_path_unresolved` is non-empty, report each as `<name> path-unresolved` (registered in `_hermit_versions` but not found in the project-effective plugin list).

If `plan.siblings_detected_unregistered` is non-empty, report each as "detected but not activated: <name> — run `/<name>:hatch` to register." Never auto-activate; the opt-in gate stays.

If `plan.siblings_warnings` is non-empty, surface each warning (e.g. plugin-list unavailable, CHANGELOG unreadable).

### 8. Ensure plugin permissions in settings file

Same logic as init step 8, but target the file determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `.claude/settings.local.json`
- `hatch_target == "committed"` → `.claude/settings.json`

Run the sync verb — it is the single owner of this list, so do not restate the entries here or diff them by hand. It holds the canonical `HERMIT_ALLOW` (so it can't drift from what `hatch` installs), writes via `fs` (so it works even under the strict hook profile, where an `Edit`/`Write` to `.claude/settings*.json` is denied), and is idempotent:

```
bun <plugin_root>/scripts/apply-settings.ts <resolved-settings-file> permissions-sync
```

where `<resolved-settings-file>` is `.claude/settings.local.json` (local) or `.claude/settings.json` (committed) per `hatch_target`, and `<plugin_root>` is the baked absolute plugin root.

**Delegated mode: run it without asking** (a missing `bun` permission breaks hooks, so this is non-optional). It adds every sealed entry the target lacks and removes only entries this plugin shipped in a previous version and has since retired — an operator's own rules are never touched, and a target that is already current is not rewritten at all. Parse its one JSON line, `{"missing":[...],"obsolete":[...]}`, and report the two counts in the step-10 report. Both empty means the target was already current; say nothing.

(On a hermit whose allow-list predates `apply-settings.ts` itself, this command may hit a permission gate inside this subagent, which can't prompt — relay that to the step-10 report so the operator can add `Bash(bun */scripts/apply-settings.ts*)` and re-run, rather than wedging.)

### 9. Write updated config

- **Re-read `.claude-code-hermit/config.json` now** — Step 2b migrations may have written keys since the pre-pass ran.
- For each entry in `new_config_keys` (with the defaults applied in Step 4), set `path` to its value **only if that path is still missing** in the freshly-read config. Never overwrite an existing operator or migration-set value. Write these merged keys to `.claude-code-hermit/config.json` before running the finalizer below.
- **Bump `_hermit_versions` deterministically — do NOT hand-edit this key.** After the `new_config_keys` merge above is written to disk, run the finalizer. It re-reads config from disk, writes the version bumps atomically, and prints the confirmed on-disk values:

  ```
  bun <plugin_root>/scripts/evolve-finalize.ts .claude-code-hermit --core=<to> --plugin-root=<plugin_root> [--sibling=<name>=<vNEW> ...]
  ```

  - `<to>` is the plan's `to`. Add one `--sibling=<name>=<vNEW>` for each sibling hermit with a **version gap** that was upgraded in Step 7 (where `name` is the sibling's plugin name and `vNEW` is its `sibling.to`). Omit `--sibling` for no-gap siblings (no version to bump). Omit `--sibling` entirely if no siblings had a gap.
  - **When `plan.up_to_date` is `true` (core current, sibling-only run):** the plan's `to` is still used as `--core=<to>`. Here `to` equals the on-disk stamp, so evolve-finalize re-stamps the same version — a genuine no-op that keeps the finalizer as the single atomic writer. (This is only reached when core is *current*; the config-ahead case never gets here, because the stale-runtime check above stops the run before Step 2. The finalizer independently refuses a lower `--core` with `core_version_regression`.)
  - Parse stdout as JSON. The finalizer's `core.confirmed` is the **authoritative on-disk version** — use it as `vNEW` in the Step 10 report, NOT `plan.to`.
  - If `core.matched` is `false` or `errors` is non-empty, the bump did not land: set the `Upgrade:` line in the Step 10 report to `blocked: config version bump failed (<joined errors>)` and stop.
