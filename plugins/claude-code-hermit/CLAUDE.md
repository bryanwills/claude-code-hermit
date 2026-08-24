# claude-code-hermit

A personal assistant that lives in your project — memory-driven learning, daily rhythm, idle agency, and operational hygiene for Claude Code.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
```

After install, run `/claude-code-hermit:hatch` in the target project to create the state directory.

## Plugin Structure

- `agents/` — subagent definitions (proposal-triage, reflection-judge, evolve-runner, skill-eval-runner; hermit plugins add more subagents)
- `skills/` — skill definitions (namespaced as `/claude-code-hermit:*`): session, session-start, session-close, brief, watch, heartbeat, hermit-routines, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, capability-brainstorm, channel-responder, channel-setup, hatch, hermit-evolve, docker-setup, docker-security, simplify, smoke-test, hermit-evolution, cost-reflect, hermit-health, weekly-review, migrate, hermit-doctor, recall, relogin, hermit-dashboard-design, rc-gate
- `hooks/hooks.json` — hook registrations
- `scripts/` — hook implementation scripts + boot scripts (hermit-start.ts, hermit-stop.ts)
- `state-templates/` — templates copied into target projects by the `hatch` skill
- `.claude-plugin/plugin.json` — plugin manifest

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs)
  and plugins (https://claude.com/plugins) for native features that already cover it.
  If overlap exists, delegate — don't build.

## Subagent delegation

The shipped hermit applies a **main-as-orchestrator** pattern: the long-lived main session delegates heavy sub-steps to isolated-context subagents and keeps only the verdict. Delegate a sub-step when its intermediate context dwarfs its conclusion, it needs no operator contact mid-flight, and main needs the result, not the artifact. Subagents inherit `CLAUDE.md`/`CLAUDE.local.md` (a fixed re-seed cost per dispatch), so it's a net win only above that noise threshold, not a blanket rule. Delegation *bookends* main rather than bypassing it: a dispatch costs the re-seed plus **≥2 main turns at full context** (the dispatch turn and the completion-ingestion turn) — batch dispatches, and for trivial sub-steps prefer a single inline main turn (measured live across production hermits). A delegated sub-step returns a verdict/`operator_message`; main owns `AskUserQuestion` and operator notification. Illustrative dispatchers (not exhaustive): `heartbeat`/`reflect`/`brief`/`weekly-review`/`hermit-evolution` → `skill-eval-runner`; `hermit-evolve` → `evolve-runner`; `proposal-act` → `general-purpose` for the accept-flow tail. The operator-facing version is in `state-templates/CLAUDE-APPEND.md` § Rules.

## Per-Project State

When installed in a target project, state lives in `.claude-code-hermit/`:

- `sessions/SHELL.md` — current session (with tags, monitoring)
- `sessions/S-NNN-REPORT.md` — archived reports
- `proposals/PROP-NNN-<slug>-HHMMSS.md` — improvement proposals
- `templates/` — session and proposal templates
- `state/` — runtime observations (alert-state.json, reflection-state.json, routine-metrics.jsonl, proposal-metrics.jsonl, usage-metrics.jsonl, usage-archived.json, micro-proposals.json, state-summary.md, monitors.runtime.json)
- `raw/` — domain inputs (fetched content, snapshots, logs); flat layout only (no subdirectories). `raw/.archive/` holds expired artifacts. See [plugin-hermit-storage](docs/plugin-hermit-storage.md).
- `compiled/` — durable domain outputs (briefings, decisions, assessments) injected at session start; flat layout only (no subdirectories)
- `knowledge-schema.md` — per-hermit behavioral schema (what it produces and when)
- `config.json` — project config (identity, channels, routines, idle agency, scheduled checks)
- `OPERATOR.md` — human-curated context (draft changes, confirm before writing; hard-blocked in always-on mode)

`hatch` also seeds `bin/` (lifecycle scripts), `docker/` (container scaffolding), `HEARTBEAT.md`, and `SESSION-REPORT.md` — see `state-templates/` for the full set.

### State ownership under residency

A hatched folder can hold more than one session, so every state file needs an owner. `startup-context.ts` decides resident-vs-guest once per session and records the verdict with `lib/guest-marker.ts`; hooks read it with `isGuest(stateDir, payload.session_id)` (they run per turn with no model in the loop, so the guest banner cannot reach them). Three buckets — a new state file belongs to exactly one:

- **Resident-owned** — liveness signals, context-reset stamps, session-id caches, CC-payload snapshots. Guests never write: gate the write on `isGuest`. Gated so far: `state/.heartbeat` (stop-pipeline), `runtime.json.last_context_reset_at` (precompact-stamp). Still ungated and known: `state/cc-stop-snapshot.json`, `sessions/.status.json`, cost attribution.
- **Folder-shared** — `sessions/SHELL.md` Progress Log, the cost log. Any session writes; entries carry provenance instead of a gate (the PreCompact breadcrumb labels a guest's reset). `SHELL.md` stays one file: "the only plan surface" is a contract, and its read-modify-write is already serialized by `withProgressLogLock`.
- **Session-keyed** — anything that must vary per session is keyed by session id (like the guest markers), never a singleton.

## Hatch target routing

`scripts/domain-hatch.ts` owns target resolution and stamping for every consumer — core `hatch`, `hermit-evolve`, `docker-setup`, and all five domain hatches. Routing is derived from the plugin's install scope (read from `claude plugin list --json`): `scope=local` → `CLAUDE.local.md` + `.claude/settings.local.json`; `scope=project` → `CLAUDE.md` + `.claude/settings.json`; `scope=user` or no detectable scope → `.local` files (safer default). Advanced mode lets the operator override the scope-derived default via the Visibility prompt.

The resolved target is stamped into `.claude-code-hermit/state/hatch-options.json` by `domain-hatch.ts` alone; no consumer re-derives it. Domain hatches reach it through `.claude-code-hermit/bin/hermit-run domain-hatch <preflight|ensure-target|sync-block> <plugin-id>` — `preflight` returns the resolved `target`/`target_file`/`target_default`/`needs_target_question` plus the version verdict, `ensure-target` records an operator override, and `sync-block` writes the CLAUDE-APPEND block into the resolved file. `hermit-evolve` Steps 6, 7, 8 are target-aware and will not re-add committed files after a `.local` migration.

## Migrations

When a change needs to be applied to existing hermits (not just the template for new ones), document it in `CHANGELOG.md` under the relevant version's `### Upgrade Instructions` section. The `hermit-evolve` skill reads and **executes** those instructions — write them as imperative steps the skill will follow, not passive notes.

Example: removing a line from an operator-editable file (like `HEARTBEAT.md`) that `hermit-evolve` would otherwise skip.

## Feature defaults (research preview)

Follow Claude Code's research-preview model: **new features ship enabled by default, opt-out not opt-in.** When you launch a new capability:

- **Template default is on.** Set the feature enabled in `state-templates/config.json.template` (or the relevant default) so new hermits get it from `hatch` without extra steps.
- **Upgrade Instructions enable it for existing hermits.** Write the `### Upgrade Instructions` so `hermit-evolve` turns the feature on for already-installed operators by default, rather than leaving it off pending opt-in. Note how to disable it for operators who don't want it.

Reserve opt-in defaults for features that are genuinely risky, costly, or destructive: state why in the CHANGELOG when you choose opt-in over opt-out.

## Authorship layers

An installed hermit belongs to its operator — they rewrite it, and the plugin's job is to keep working underneath that. Two layers, different rules:

**Contracts (plugin owns — stay strict).** State-file schemas, hook exit codes and fail-open, the `hermit-run` → `hermit-exec.sh` verb path, hatch target stamping, deny patterns, the token/script-mediation boundary. Customization works *because* these are rigid. `hermit-exec.sh` resolves a bare name to `$PLUGIN_ROOT/scripts/<name>.ts` only, rejecting `*/*` and `*..*` so a permission glob spanning `/` can't drive it outside `scripts/` — that guard is load-bearing for the allow-list, not incidental. There is deliberately no local-verb fallback; `bin/hermit-run` is a resolver, not an operator-extensible table (and it's a state-template copy that `hermit-evolve` refreshes, so local edits there don't survive).

**Core depends on nothing downstream.** Domain plugins depend on core; core never depends on them. Nothing in this plugin may import a sibling, hardcode a sibling slug in logic, or branch on one being installed — sibling discovery is generic (`resolve-siblings.ts` matches name-contains-`hermit`, not a list) and core consumes only what a sibling *declares* in its `hermit-meta.json` (`hermit.boot_skill`, hatch continuation). Naming a plugin as an example in a comment, doc, or `docker.recommended_plugins` entry is fine; conditioning behavior on it is not. Every new cross-plugin capability goes through a declared field or a `hermit-run` verb behind a `required_core_version` floor.

**Content (operator owns — stay loose).** Extension is declarative, not code injection into core's dispatch path:

| Surface | What the operator can put there |
|---|---|
| `routines[]`, `boot_skill`, `shutdown_skill`, `monitors[]` | any skill string, including their own local plugins' skills |
| `config.env`, `docker.packages`, `docker.recommended_plugins` | arbitrary values |
| `OPERATOR.md`, `HEARTBEAT.md`, `knowledge-schema.md`, the CLAUDE-APPEND block, `docker/` | free-form rewrite; on-disk beats template (see the `hermit-docker update` gotcha below) |

When authoring above the contract line, give skills data + goal + voice and let the model compose — don't hardcode content, edge-case copy, checklists, or opinions about how the operator should work. Loose ≠ vague: a skill still states its goal and verdict shape precisely.

**The upgrade rule.** Anything operator-editable must survive `hermit-evolve`. Adding a new operator-owned surface means saying in `### Upgrade Instructions` how existing edits are preserved, not just how the template changes.

## Development

To test locally against a target project:

```
cd /path/to/target-project
claude --plugin-dir /path/to/this-repo
```

Then run `/claude-code-hermit:hatch` to set up the target project.

Run tests:

```
bun test
```

**Development constraints (non-negotiable):**

- **Runtime is Bun (TypeScript-native).** Hooks and scripts are `.ts` run directly by `bun` —
  no transpile, no build. The minimum version lives in `.claude-plugin/hermit-meta.json`
  (`required_bun_version`) — `doctor-check` and the `hermit-start` preflight both read it
  dynamically. The Docker template pins its own `BUN_VERSION`; bump it together with the meta.
- No runtime dependencies — shipped code imports only the standard library and Bun built-ins
  (`Bun.*`, `bun:*`, `node:*` modules). The repo-root `package.json` is dev-only toolchain
  (typecheck via `bunx tsc`, test-only fuzzing); nothing under `plugins/` may import from
  `node_modules` outside `*.test.ts` files.
- No build step — skills are plain markdown, hooks are standalone `.ts`/`.sh` scripts.
- Avoid overengineering.
- Hooks fail open — a hook must never block Claude Code. Catch all errors, `process.exit(0)`. Never exit non-zero on transient failures.
- Consume stdin — every hook must read stdin to completion even if unused (avoids broken pipe errors).
- Agent references in skill instructions must always use the full namespaced form `claude-code-hermit:<agent-name>` (e.g., `claude-code-hermit:proposal-triage`). Bare names are auto-namespaced by the harness on load, so bare-name invocations from skill text will fail with "Agent type not found".
- **Hermit `state-templates/CLAUDE-APPEND.md` blocks must not restate `config.json` contents** (routine schedules, Discord/Telegram user IDs, morning-brief times, `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`). Those are loaded structurally from `config.json` on every session start. CLAUDE-APPEND describes behaviors, conventions, and workflow shape — not the wiring. Restating config values leaks them into `CLAUDE.md`, which the hatch's OPERATOR.md scan reads, tempting the model to mirror them again into OPERATOR.md prose. Naming routines by `id` and referencing `enabled` state is fine — those are stable; schedules and flags drift.
- **Default `config.json` source of truth is `state-templates/config.json.template`.** Skills (especially `hatch`) must overlay operator choices onto the template — never re-declare a parallel inline default object in SKILL.md text. The `tests/template-skill-sync.test.ts` contract test catches drift between the template's top-level keys and `hatch/SKILL.md` references; if you add a field to the template, also reference it by name in hatch.
- **SKILL.md size: trim before splitting.** Sibling files (e.g., `skills/<name>/EXTRA.md`) are not auto-loaded — only `SKILL.md` is. The model must explicitly `Read` siblings, which is unreliable for branch-conditional flow. When a SKILL.md grows large, prefer trimming verbose prose, collapsing redundant tables, and removing duplicated sections over splitting into multiple files.
- **Token discipline: keep the script-mediation boundary.** State costs tokens only where
  it crosses into context — hook stdout, skill-driven `Read`s, and helper-script output.
  Hooks and helper scripts print verdict-sized digests, never raw logs or full state dumps
  (everything a hook prints on success is injected into context). Skills must not `Read`
  unbounded surfaces (`cost-log.jsonl`, `*.jsonl` event logs, the channel DB) directly —
  front them with a script that returns a bounded summary (the `cost-report.ts` /
  `heartbeat.ts precheck` / `lib/search.ts` pattern); a bounded slice (e.g. reflect's
  tail-20 of cost-log) is the ceiling, not the norm. Session-start injection
  (`startup-context.ts`, `generate-summary.ts`) is the largest recurring cost — a new
  section there must justify its per-session tokens against how often it changes behavior.
  No numeric budgets: this is a boundary rule (where digestion happens), not a size quota.
  (SKILL.md size has its own rule above.) **The atom of cost is the API call**: every
  tool-call round trip re-reads the full accumulated context from cache, so
  cache_read+cache_write dominates an always-on hermit's bill (≈85-90%, measured live
  across production hermits), not per-prompt injection — the boundary rule above therefore
  also covers **native tool outputs** (`CronList` returning full prompt text per entry,
  etc.), not just file reads.

## Debugging gotchas

- `read_only: true` on the hermit container is incompatible with Claude Code's credential-refresh write path — Prompt 2 of `/docker-security` was removed in v1.0.30 for this reason. Hermits 401 with `Invalid authentication credentials` once the access token expires (~8h after `/login`) because the refresh write fails silently under the current tmpfs / named-volume layout. Do not reintroduce without verifying refresh writes survive whatever layout is added.
- The hermit Ubuntu image has **no `strace`** and `apt install` is blocked when `read_only: true` is on the container. For fs/network tracing inside hermit, use `NODE_DEBUG=fs,http,https,net,tls claude ...` instead.
- **Enforce mode is authoritative, not advisory** — verified live (dnsmasq 2.92, throwaway container): with `no-resolv` + `--conf-file`, unmatched queries NXDOMAIN and are never forwarded. The `forwarded <host> to 127.0.0.11` line some operators see in `docker logs <stack>-hermit-netguard-1` comes from **log-only** mode, which passes neither `--conf-file` nor `--no-resolv` and forwards everything to `/etc/resolv.conf`'s resolver by design (block-nothing is the point of that mode). Static `address=/host/ip` records in the allowlist are honored in both modes (see `dnsmasq.allowlist.template`).
- `grep` returning no matches breaks `&&` chains in diagnostic one-liners — silently truncates the rest of the pipeline. Use `; grep ... || true` if continuation matters.
- **`hermit-docker update` rebuilds with the on-disk entrypoint, not the template.** When writing `### Upgrade Instructions` for an entrypoint-template change, the operator's on-disk `docker-entrypoint.hermit.sh` must be refreshed first (re-run `/docker-setup` or surgically-patch via hermit-evolve), THEN `hermit-docker update`. Just bumping the plugin and running `update` rebuilds with the same stale entrypoint.
