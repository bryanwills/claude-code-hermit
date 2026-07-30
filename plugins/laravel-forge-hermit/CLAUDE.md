# laravel-forge-hermit

A Laravel Forge domain layer for `claude-code-hermit`: deployment skills, server/site management, estate health monitoring, and a daily failed-deployment scan — all over the official `laravel/forge-sdk` PHP v4.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard: `/laravel-forge-hermit:hatch`
- `skills/forge-servers/` — server list, detail, reboot flow
- `skills/forge-sites/` — site list and detail
- `skills/forge-deploy/` — preview → approve → deploy; failure → deploy-incident artifact
- `skills/forge-logs/` — deployment + server logs, triage mode
- `skills/forge-failed-deploys/` — daily scheduled estate scan (analysis-only)
- `php/forge.php` — PHP dispatch script: curated commands, generic dispatch, write-confirmation gate
- `php/forge-operation.php` — the write gateway: request capture, canonicalization, plan store, hash-checked execution
- `php/forge-lib.php` — derived predicates (`isEndpointMethod`, `takesOrgFirst`), deny tiers, policy loading, output scrubber
- `php/composer.json` + `php/composer.lock` — shipped; `php/vendor/` is gitignored (hatch installs SDK into project space)
- `hooks/write-confirm-gate.ts` — PreToolUse Bash hook: blocks deploy/server-reboot without `--confirm`
- `state-templates/CLAUDE-APPEND.md` — Forge Workflow block injected by hatch
- `settings.json` — pre-approved Bash and hermit-state permissions
- `DOCKER.md` — apt deps + DNS allowlist for `/docker-setup`
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`)

## Architecture

The agent calls `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php <command>` directly via Bash. The SDK handles all HTTP — no hand-rolled API client, no bun CLI, no bridge process.

The vendor tree is **not committed to this repo** — hatch installs `laravel/forge-sdk` `--no-dev` via Composer into the consumer project's `.claude-code-hermit/forge-runtime/vendor/` (persistent, bind-mounted in Docker, isolated from the app's own `composer.json`/`vendor/`).

## Hatch target routing

`/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit`; core's `scripts/domain-hatch.ts` resolves the target and stamps `hatch-options.json`. Step 5 records any operator override with `domain-hatch ensure-target laravel-forge-hermit --target <choice>` and writes the block with `domain-hatch sync-block laravel-forge-hermit`.

## Core Rules

- **Surface-then-approve on every write.** Preview first, relay canonical target, wait for explicit approval, then execute. No exceptions.
- **Two write paths, two different enforcement mechanisms.** For the curated `deploy` / `server-reboot` commands the layers are the write-confirm-gate hook plus the in-PHP `--confirm` check; neither is optional. For generic dispatch the layers are the **plan hash** (code-enforced: `execute` re-captures the request and refuses unless it hashes to the approved one) and the **operator's channel approval** (protocol-enforced: the resolver fires on an inbound channel message, which an agent cannot fabricate). `--confirm` plays no part there — it only ever proved a flag was typed, and the agent types the flag. Note that generic dispatch also reaches `createDeployment` and `createServerAction`, so `deploy` and `server-reboot` have a second route that the hook does not see: on that route the plan hash and the operator's approval are the only gate.
- **Never echo, cat, or Read `.env`** — check credential state with `forge.php check` (self-reports `missing`/`invalid`/`unreachable`/`ok`). The `TOKEN` substring in `FORGE_API_TOKEN` triggers the base hermit deny-pattern hook.
- **Deployment and server logs may contain secrets.** Scrub before relay and before persistence — see CLAUDE-APPEND secret-hygiene rule.
- **Generic dispatch reaches the whole SDK minus two deny tiers** (`secrets`, `destructive`), because the Forge API token is what authorizes an operation — this plugin owns autonomy and context hygiene, not authorization. Reads go through `call`, writes through `preview` → approval → `execute <plan-id>`. Reachability is derived from the installed SDK by reflection and from the captured HTTP verb, never from a hand-maintained list. `forge.php policy` prints the effective state.
- **`php/forge-operation.php` is the security-critical file.** Capture, canonicalization, plan storage and the hash check live there, with no CLI parsing or output formatting, so `php/tests/run.php` drives it directly. Its Blocks A and B run first in the suite for a reason: if the captured request is not what the SDK would really send, every other guarantee is decorative.

## Development

Test locally without publishing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/plugins/laravel-forge-hermit
```

Under `--plugin-dir`, `${CLAUDE_PLUGIN_ROOT}` is NOT substituted — use the absolute plugin path in commands.

For tests, first install the SDK into a local vendor tree:

```bash
cd plugins/laravel-forge-hermit
composer install --working-dir=php
bun test
php php/tests/run.php
```

## Development constraints

- The `tests/skill-structure.test.ts` expects exactly 6 skills, each with a matching `name` field in frontmatter. Add a new skill → update the `SKILLS` array in that file.
- The deny-pattern hook blocks any Bash arg containing literal `TOKEN`. Never put `FORGE_API_TOKEN` on a command line.
- When aligning with a new core version, sweep `skills/`, `state-templates/`, `docs/` for stale hermit-facing terms.
