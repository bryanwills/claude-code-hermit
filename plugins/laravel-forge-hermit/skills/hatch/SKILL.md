---
name: hatch
description: One-time Laravel Forge hermit setup. Installs the Forge PHP SDK, verifies credentials, and wires the estate scan into config.json. Run once per project after /claude-code-hermit:hatch.
---

# Hatch — laravel-forge-hermit

Idempotent setup wizard for the Laravel Forge plugin. Run **after** `/claude-code-hermit:hatch` has been completed.

---

## Step 1 — Prerequisite check

Read `.claude-code-hermit/config.json`.

If the file does not exist or `_hermit_versions["claude-code-hermit"]` is absent or empty:

> "The base hermit is not set up yet. Run `/claude-code-hermit:hatch` first, then return here."

Use `AskUserQuestion`: "Would you like to run `/claude-code-hermit:hatch` now? (yes / no)"

- **yes** → Follow the domain hatch continuation protocol (documented in `claude-code-hermit:hatch`):
  1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "laravel-forge-hermit:hatch" }`.
  2. Print: "(If setup doesn't continue automatically when core finishes, re-run `/laravel-forge-hermit:hatch`.)"
  3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.
- **no** → stop.

If present but below `1.1.1` (compare major.minor.patch numerically):

> "Base hermit version is {version}; this plugin requires ≥1.1.1 for scope-aware hatch routing. Run `/claude-code-hermit:hermit-evolve` to upgrade, then re-run this hatch."

Stop.

---

## Step 2 — Idempotency check

Read `_hermit_versions["laravel-forge-hermit"]` from `.claude-code-hermit/config.json`.

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If the versions match:

> "laravel-forge-hermit {version} is already installed. Reply 'verify' to re-run checks only, or 'full' to re-run the full wizard."

Use `AskUserQuestion`: "(verify / full)"

- **verify** → skip to Step 5.
- **full** → continue from Step 3.

If absent or stale: continue from Step 3.

---

## Step 3 — PHP/Composer preflight + SDK install

**Check PHP version.** Run `php -r 'echo PHP_VERSION;'` via Bash. Parse the output. If `php` is not found or the version is below 8.5.0:

> "PHP 8.5+ is required but not found (got: {version or 'not found'}).
>
> - **Docker**: re-run `/docker-setup` after the core base image is updated to Ubuntu 26.04 (which ships PHP 8.5 natively). If the core base is still 24.04, the Docker path is blocked pending that upgrade.
> - **Bare-metal**: install `php8.5-cli` and `php8.5-curl` (or your distro's equivalent)."

Stop.

**Check Composer.** Run `composer --version`. If not found:

> "Composer is not found. Install it from https://getcomposer.org/."

Stop.

**Install the Forge SDK into project space.** The SDK goes into `.claude-code-hermit/forge-runtime/` (hermit-owned, isolated from your app's own `composer.json`/`vendor/`).

Run these Bash commands:

```bash
mkdir -p .claude-code-hermit/forge-runtime
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.json" .claude-code-hermit/forge-runtime/composer.json
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.lock" .claude-code-hermit/forge-runtime/composer.lock
```

**Idempotent install check**: if `.claude-code-hermit/forge-runtime/vendor/` exists and the staged `composer.lock` content matches `${CLAUDE_PLUGIN_ROOT}/php/composer.lock`, skip the install. Otherwise run:

```bash
composer install --no-dev --no-interaction --working-dir=.claude-code-hermit/forge-runtime
```

If composer exits non-zero, surface the error. Common cause: egress blocked — `packagist.org`, `repo.packagist.org`, `api.github.com`, `codeload.github.com` must be reachable. In Docker, verify the DNS allowlist in DOCKER.md is present.

---

## Step 4 — Verify .env + consumer .gitignore

**Do NOT use `cat`, `grep`, `echo`, or any Bash command to read `.env`.** The `FORGE_API_TOKEN` key name contains `TOKEN`, which triggers the base hermit's deny-pattern hook on Bash args. Use the **Read tool** only — and only to check the file exists / has the key, never to relay the value.

Tell the operator:

> "Add your Forge API credentials to `.env` in the project root:
>
> ```
> FORGE_API_TOKEN=your-forge-api-token
> FORGE_ORG=your-org-slug        # optional if you have exactly one org
> ```
>
> Get your token at https://forge.laravel.com/profile/api. Reply 'done' when set, or 'skip' to continue (credential check happens in Step 5)."

Use `AskUserQuestion`: "(done / skip)"

**Read the consumer's `.gitignore`** (this file is not a secret — only the `.env` content is). Check if `.env` and `.env.*` patterns are present. If missing, offer to add them:

```
.env
.env.*
```

Append any missing patterns via Edit.

---

## Step 5 — CLI probe (credential check)

Run: `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php check`

- **`missing`** → tell the operator to add `FORGE_API_TOKEN` to `.env` and re-run Step 4.
- **`invalid`** → token found but API rejected it; tell the operator to check the token at https://forge.laravel.com/profile/api.
- **`unreachable`** → token present but the API could not be reached (network/egress blocked). In Docker, verify the DNS allowlist in DOCKER.md (`forge.laravel.com`). Re-run once connectivity is confirmed.
- **`ok`** → continue.

If `php` is not found at this point: re-run Step 3.

---

## Step 6 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file**: read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field:
- `"local"` → `target_file = CLAUDE.local.md`
- `"committed"` or absent → `target_file = CLAUDE.md`
- File doesn't exist: detect `core_install_scope` from `claude plugin list --json` (same logic as core hatch), ask with `AskUserQuestion` (header: "Visibility"): **`.local` files** (gitignored) / **Committed files** (shared). Write the 5-field canonical schema to `hatch-options.json`.

Read `target_file`. Search for `<!-- laravel-forge-hermit: Forge Workflow -->`.

- **Absent** → append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` using Edit.
- **Present** → skip (already injected; `hermit-evolve` handles replacement on upgrade).

---

## Step 7 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`.

Check for `deploy-incident:` in the file. If absent, append under `## Work Products`:

```
- deploy-incident: per-failure deployment record with scrubbed log tail and resolution. Producer: forge-deploy skill on a failed terminal deploy status. location: compiled/deploy-incident-<site>-<YYYY-MM-DD>.md
```

Use Edit. Skip if already present (idempotent).

---

## Step 8 — Stamp + register in config.json

Use the `config.json` content loaded in Step 1.

**Stamp version**: set `_hermit_versions["laravel-forge-hermit"]` to the plugin version from Step 2.

**Merge scheduled check**: check `config.scheduled_checks` for `id: "forge-failed-deploys"`. If absent, append:

```json
{"id": "forge-failed-deploys", "plugin": "laravel-forge-hermit", "skill": "laravel-forge-hermit:forge-failed-deploys", "enabled": true, "trigger": "interval", "interval_days": 1}
```

If present: skip (do not clobber).

Write the updated `config.json` via Write tool (full file replacement for valid JSON).

---

## Step 9 — Final report

```
laravel-forge-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ PHP 8.5+ found: {php_version}
  ✓ Composer found
  ✓ Forge SDK installed → .claude-code-hermit/forge-runtime/vendor/
  ✓ .env: FORGE_API_TOKEN present, API check: ok
  ✓ .gitignore: .env covered
  ✓ CLAUDE.md: Forge Workflow block injected (or already present)
  ✓ knowledge-schema.md: deploy-incident type added (or already present)
  ✓ config.json: _hermit_versions stamped, forge-failed-deploys check registered

Next steps:
  - Restart Claude Code so the updated CLAUDE.md loads.
  - Run /claude-code-hermit:hermit-routines load to activate the daily estate scan.
  - In Docker: the forge-runtime/ vendor is in your project tree (bind-mounted/persistent) — it survives container restarts.

Installed skills:
  /laravel-forge-hermit:forge-servers        — list / detail / reboot servers
  /laravel-forge-hermit:forge-sites          — list / detail sites
  /laravel-forge-hermit:forge-deploy         — preview → approve → deploy
  /laravel-forge-hermit:forge-logs           — read site / server / deployment logs
  /laravel-forge-hermit:forge-failed-deploys — daily estate scan (scheduled, interval_days: 1)

Security reminder: FORGE_API_TOKEN is in .env — verify it is gitignored before any git push.
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy.

### Domains (DNS allowlist)

- forge.laravel.com
- packagist.org
- repo.packagist.org
- api.github.com
- codeload.github.com
