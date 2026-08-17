---
name: hermit-doctor
description: Returns a twenty-four-check health report on the hermit installation (runtime, config, hooks, state-file integrity, cost, proposals, deps, version currency, permissions, docker, archival, reflect loop, scheduler, watchdog, context age, opus-wake spend, routine cost, heartbeat, routine monitor, raw storage size, plugin credential expiry, model pricing, channel liveness, context scan). Use when diagnosing an install, before a release, or after suspicious behavior. Activates on messages like "/hermit-doctor", "health check", "diagnose the hermit", "what's wrong", "run diagnostic".
---

# Hermit Doctor

Runs twenty-four read-only health checks against the current hermit install (`channel-liveness`
is the only one that performs outbound API calls — see Notes) and surfaces the summary. Safe
to run at any time. Produces no side effects beyond writing
`.claude-code-hermit/state/doctor-report.json` and `.claude-code-hermit/state/doctor-alerts.json`,
and appending a summary block to SHELL.md.

## Notification route

A finding gets one notification per unresolved episode: the check script records it, you send it
once, and it stays silent until it resolves. A send that never reached the operator is re-offered
on the next run rather than counted as delivered.
The optional flag changes its destination, not whether doctor notifies:

- **Default (no arguments):** send the notification to the primary operator chat. This preserves
  the legacy `hermit-doctor` behavior.
- **Maintainer (`--maintainer`):** prefer the configured `maintainer_channel_id`. When no maintainer
  destination is configured, fall back to the primary operator chat for every operator profile.
  When a configured maintainer destination is unreachable, fail closed to SHELL.md Findings and
  never spill the notification into the primary chat.

## Steps

1. Run the check script:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .claude-code-hermit
   ```
   The script writes `.claude-code-hermit/state/doctor-report.json` and prints the same
   JSON to stdout. It exits 0 unconditionally — on any internal failure the failing
   check reports `status: "fail"` in its own entry rather than crashing the report.

2. Parse the JSON. For each of the twenty-four checks in the report (`runtime`, `config`, `hooks`, `state`, `cost`,
   `proposals`, `dependencies`, `version-currency`, `permissions`, `docker-security`, `archive`, `reflect`, `scheduler`, `watchdog`,
   `context-age`, `opus-wake`, `routine-cost`, `heartbeat`, `routine-monitor`, `raw-size`, `credential-expiry`, `model-pricing-known`, `context-scan`, `channel-liveness`), emit one line using this format:
   - `✓ <id> — <detail>` when `status: ok`
   - `⚠ <id> — <detail>` when `status: warn`
   - `✗ <id> — <detail>` when `status: fail`

3. Append a summary section to `.claude-code-hermit/sessions/SHELL.md` under a new
   `## Doctor Report (<ts>)` heading. Use the same twenty-four lines from step 2. Place it
   above the `## Monitoring` section so it sits with session-level context, not
   with monitoring chatter.

4. Return the twenty-four lines to the caller. Cap total output at 30 lines.

5. **Escalation.** The script already computed this — do not recompute it, and do not write alert
   state yourself. Read the `escalation` object from the step-1 JSON:

   - `escalation.new` — findings owed to the operator, each `{id, status, detail}`. Empty means
     everything currently failing has already been announced; say nothing.
   - `escalation.resolved` — check ids whose finding cleared. Recorded, never announced: there is
     no "recovered" ping.
   - `escalation.persisted: false` — the ledger could not be written. `prior_state_known: false` —
     the ledger was unreadable and had to be rebuilt, so what was already announced is unknown.
     **On either, send nothing** and record the findings under `## Findings` in SHELL.md instead;
     a notification you cannot dedup would repeat every run.

   **When `escalation.new` is non-empty.** Compose one complete, concise summary covering every
   listed check, its detail, and a named next action, in the operator's configured language.
   Deliver it once through the canonical notice path:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --notice
   ```
   Choose one payload from the invocation:
   - Without `--maintainer`, send `{"client": "<complete summary>"}`. Do not include a `maintainer` leg.
   - With `--maintainer`, send
     `{"maintainer": "<complete summary>", "fallback": "primary"}`. Do not include a `client` leg.

   **Then confirm delivery**, so those findings stop being re-offered — only when the send actually
   landed (exit 0):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .claude-code-hermit --mark-notified <id> [<id>…]
   ```
   Pass the `escalation.new[].id` values you just announced. If the send failed or degraded, skip
   this step — leaving them unconfirmed is what makes the next run retry instead of dropping them.
   For exit-code handling and the Findings fallback, follow
   `/claude-code-hermit:channel-responder` § Outbound notification protocol.

## Silence policy

- If every check is `ok`, return only: `All twenty-four checks passed.` Do not notify via
  channel (Tier 0). Still append to SHELL.md so the run is traceable. Clearing the stale
  `doctor:*` entries is the script's job, not yours — it happens on every run.
- If any check is `warn` or `fail`, return the full twenty-four-line summary. Notification is
  governed by `escalation.new` (step 5), not a blanket per-run ping: only findings not yet
  confirmed delivered notify the selected route.

## What each check looks at

| id | What it verifies | Status rules |
|---|---|---|
| `runtime` | Runs `bun --version` and compares against `required_bun_version` in the plugin's `hermit-meta.json`. | `fail` if bun is absent or below the required version; `ok` with the detected version otherwise. |
| `config` | Runs `validate-config.ts` against `.claude-code-hermit/config.json`. | `fail` on any error; `warn` on any warning. |
| `hooks` | Parses `hooks/hooks.json`; verifies each referenced script file exists on disk. | `fail` if any script is missing. |
| `state` | `JSON.parse` every `.claude-code-hermit/state/*.json`; warns if expected files missing. | `fail` on unparseable file; `warn` if any expected file (`alert-state.json`, `reflection-state.json`, `runtime.json`, `monitors.runtime.json`) is absent. |
| `cost` | Sums today's `estimated_cost_usd` and `total_tokens` from `.claude/cost-log.jsonl`; reports today's spend, token count, and cache-read tokens for efficiency diagnosis. | `ok` with today's spend + tokens; `warn` if cost-log absent. |
| `proposals` | Counts `proposals/PROP-*.md` with `status: open`; ages via `created:` frontmatter. | `warn` if any open PROP > 30 days, or if more than 10 open. |
| `dependencies` | Reads `required_core_version` from each sibling plugin's `plugin.json` and verifies the installed core version satisfies the range. Sibling plugins live next to core under `plugins/<name>/` (monorepo) or in the marketplace cache (legacy). | `warn` if any sibling declares a `required_core_version` that the running core version doesn't satisfy. Unrecognized range forms (e.g. `^`, `~`, `||`) are treated as ok. |
| `version-currency` | Compares this install's `.claude-plugin/plugin.json` version against the same plugin's entry in the local marketplace-cache `marketplace.json` (the file `claude plugin marketplace update` refreshes — there is no automatic background refresh, so the cache is only as current as the last explicit update). Silent no-op in a monorepo/dev checkout (no marketplace cache to compare against). | `warn` if the marketplace cache lists a newer version than installed, naming both versions and the cache's mtime — wording escalates ("includes Fixed entries") if any CHANGELOG section in the gap has a `### Fixed` heading; remediation is `/plugin marketplace update` → `/plugin update` → `/claude-code-hermit:hermit-evolve`. `ok` when current, when the cache has no comparable entry, or when there's no cache to compare against. |
| `permissions` | `fs.statSync(p).mode & 0o777` on `config.json`, `state/*.json`, and `proposals/`. | `warn` if any world-readable (`mode & 0o004 ≠ 0`). |
| `docker-security` | Cross-references `docker.security.*` in `config.json` against the presence of `docker-compose.security.yml` at the project root. When both are present and the check runs on the host, also merges the base + overlay compose files via `docker compose config` to inspect ports, `network_mode`, and subnets. | `warn` on a posture/overlay mismatch either way (re-run `/docker-security`), when the overlay subnet overlaps another Docker network, or when the `docker` subprocess fails (daemon down / CLI missing — transient, never escalated to `fail`). `fail` when the `hermit` service publishes ports while joining netguard's network namespace. `ok` when both match, neither is configured, when `docker-compose.hermit.yml` is absent (nothing to merge), or when the check runs inside the container (no docker CLI there — compose verification runs on the host). |
| `archive` | Reads `state/runtime.json`. Detects sessions that should have been archived but weren't. | `warn` if `session_state ∈ {in_progress, waiting}` with `updated_at` >2 days old (stale active session) or `session_state: idle` with non-null `session_id` >2 days old (orphaned). `ok` when runtime missing (covered by `state` check) or all timestamps fresh. |
| `reflect` | Reads `state/reflection-state.json` counters. Reports the loop's shape: run count, empty rate, output (proposals + micro-proposals), and the judge suppress mix by code. | Always `ok` — informational, never warns. A high empty rate is not a fault: a hermit with nothing left to evolve is a legitimate steady state, and the counters can't tell which caller (routine, session finalization, `session-close`, manual) produced the empties. `fail` only on unreadable state. `/hermit-health` carries the same numbers in more detail. |
| `scheduler` | Reads `state/cc-stop-snapshot.json` (written by stop-pipeline.ts at each Stop). Reports armed cron count, background-task count, and snapshot age. | `ok` if snapshot present with counts and `captured_at`; `ok` (not yet captured) if snapshot absent (first run post-upgrade); `warn` if `session_crons` or `background_tasks` state is `unsupported_or_unreachable` (old CC build or registry unreachable — never reported as "0 crons"). |
| `watchdog` | Reads `config.watchdog`, `config.post_close_clear`, `config.context_hygiene.compact.enabled`, `state/watchdog-state.json` (`last_run` liveness + `consecutive_stale` + `last_hygiene_eval` + the durable `hygiene_eval_counts` outcome tallies), `state/context-surface.json` (the recorded fixed-surface upper bound, printed alongside the hygiene line), `state/runtime.json` (`runtime_mode`, `session_state`, shutdown stamps), `state/watchdog-events.jsonl`, and — on Linux in tmux/unknown mode — the generated systemd unit's own `ExecMainStatus`/`Result` via `systemctl --user show` (unit name derived from the hermit dir, not the working directory, since systemd answers `show` for a nonexistent unit with `ExecMainStatus=0`/`Result=success`). Steps 0a-0c (post-close clear, emergency clear, routine-hygiene compact) run independent of `watchdog.enabled`, so the check treats any of those as "active" even when the restart tier is off. First checks for a shutdown stamp on a still-alive session (bricks both hygiene and restart recovery until the next `hermit-start`), then liveness: the watchdog stamps `last_run` on every invocation before any gate, so a fresh stamp proves the scheduler/loop is firing. The unit probe runs ahead of the staleness gate: a unit failing on every invocation is a more specific diagnosis than "not firing", and waiting out the stale window to say something vaguer helps nobody. If stale (>20m) or missing, summarizes restarts/nudges/re-arms/clears/compacts over the last 7 days plus the most recent hygiene skip/fire reason otherwise. | `fail` when the systemd unit's last run failed — exit 127 (the unit cannot resolve `bun` on its PATH) points at re-running `bin/hermit-watchdog install`; any other failure points at `journalctl --user -u <unit>`. `ok` when nothing is active (restart tier off and no hygiene feature on), or firing and quiet (appends "last tick Nm ago", or "restart tier disabled, hygiene tier active" when only hygiene runs); `warn` if a stamp is stuck on an alive session, if `last_run` is stale/missing — "enabled but not firing" with remediation keyed to `runtime_mode` (`tmux` → `bin/hermit-watchdog install`; `docker` → recreate the container; unknown → both hints) — or, when firing, if any restart in the last 7 days or a stale cycle is in progress. |
| `context-age` | Reads `config.context_hygiene.compact` (threshold), `state/runtime.json` (active session + session id, with the idle-phase fallback to `sessions/.status.json` used by the hygiene tiers), the active session's last cost-log entry (`last_call_prompt_tokens`, falling back to `max_prompt_tokens`, or the per-call average of a multi-call estimate-only turn — matching what the compact tier judges), `state/context-surface.json` for the recorded fixed-surface upper bound, and `state/watchdog-events.jsonl` for the most recent `context-compact`/`context-clear`/`post-close-clear` event. Judges the same quantity the compact tier acts on — estimated compactible conversation (total prompt minus the recorded surface, or the 50k cold-start assumption) — and prints both numbers. A symptom tripwire for the whole context-hygiene-disabled failure class, not a specific root cause. | `warn` if the active session's compactible conversation exceeds `min_context_tokens` and no hygiene event fired in the last 24h; `ok` if the compact tier is off, no active session, context is under threshold, or hygiene fired recently. |
| `opus-wake` | Scans `.claude/cost-log.jsonl` for the last 7 days for automated (heartbeat/routine) turns billed on Opus. | `warn` if any found — names the count and cost, since automated wakes are the usual source of tier-drift spend; `ok` otherwise. |
| `routine-cost` | Computes `$/run` per enabled routine from `.claude/cost-log.jsonl` rows stamped `source_attribution_version: 2` — cost is every such row for `routine:<id>` (subagent rows included, however long after the wake they land), runs is the count of those rows with `subagent !== true` and `source_inherited !== true`, i.e. one per invocation (a subagent-completion ingestion turn is billed to the dispatching source but is the same fire, so it adds cost without adding a run). Both sides come from the same population, so there is no cross-mechanism skew: a CronCreate-delivered skip wakes the model and writes a row, a routine-monitor skip writes none. Rows predating the attribution fix carry no stamp and are ignored, since their `source` could be captured by any tool output naming a routine id. | `warn` naming the routine, its `$/run`, the peer median, and the threshold, when `$/run` exceeds both 3× the peer median (the other routines' median, so a lone or uniformly-priced fleet won't warn) and `doctor.routine_cost_floor_usd` (default $2); `ok` when fewer than 2 routines have ≥3 attribution-v2 runs (including right after an upgrade, while clean history accumulates) or none exceed the threshold. |
| `heartbeat` | Reads `config.heartbeat`, `state/runtime.json`, `state/heartbeat-liveness.json`, and `state/heartbeat-monitor.runtime.json`. Verifies the monitor loop is actually running by checking the liveness timestamp written on every poll iteration. A tick older than the monitor's `started_at` is ignored (leftover from a prior session). | `ok` when disabled, no active session, the trusted tick is fresh, or the monitor is within a short startup grace (~2m); `fail` when a trusted tick is older than 3× the configured interval, or no trusted tick exists past the startup grace (Monitor subprocess spawn blocked). |
| `routine-monitor` | Reads `config.routines`, `state/routine-monitor.runtime.json`, `state/runtime.json`, and `state/routine-monitor-liveness.json`. Same active-session-only, startup-grace, and trust-liveness-against-`started_at` logic as `heartbeat`, applied to the routine-scheduling Monitor subprocess instead. Reports the registration mode (`monitor` or `croncreate-fallback`). | `ok` when no non-anchor routine is enabled, not yet loaded, in `croncreate-fallback` mode, no active session, or the trusted tick is fresh/warming up; `fail` when a trusted tick is older than `max(10× poll interval, 10m)`, or no trusted tick exists past the startup grace (Monitor subprocess spawn blocked). |
| `raw-size` | Sums file sizes in `raw/` (plus `raw/.archive/`) and checks `runtime.json.last_raw_archive_at`. | `warn` if `raw/` exceeds 50 MB, or if raw files exist and the archive routine hasn't run in >14 days (or never); `ok` otherwise. |
| `credential-expiry` | Executes each declared `hermit-meta.json` `credentials[].expiry_probe` (bash, 5s timeout, one-line `OK`/`EXPIRES:<iso>`/`EXPIRED` protocol) — core's own manifest plus every sibling plugin's. Core declares its `setup-token` credential this way, since nothing refreshes a long-lived token and renewal needs a human. Still does not check the Claude Code session's own OAuth *access* token — Claude Code refreshes that silently (~8h cycle, no operator action), so checking it produced false alarms. | `warn` if any credential is EXPIRED or inside its warn window (per-credential `warn_days`, default 7; core's setup-token uses 14), or if a probe times out or prints malformed output; `ok` otherwise (including when no plugin declares a credential). |
| `model-pricing-known` | Compares `config.model`, each `routines[].model`, and `config.heartbeat.model` against the pricing table (`scripts/lib/pricing.ts`); also scans `.claude/cost-log.jsonl` for the last 7 days (inert today — cost-log model strings are pre-collapsed to `haiku\|sonnet\|opus` before logging, so this only activates once raw model ids persist). | `warn` naming every unpriced model and where it's configured — cost tracking silently falls back to sonnet pricing for unknowns; `ok` if every configured model is known. |
| `context-scan` | Reads `state/context-scan.json`, written by `startup-context.ts` on every `SessionStart` — which injected entries (compiled bodies/stubs, catalog summaries, OPERATOR.md/SHELL.md excerpts, last report) tripped the injection-marker scan and were blocked. The scan never mutates files; this check only surfaces its verdict. | `ok` if no record yet or the last scan found nothing; `warn` naming the blocked sources (content stays on disk — inspect or remove the flagged files) if any hit. |
| `channel-liveness` | For each enabled channel in `config.channels`, resolves its bot token from `<state_dir>/.env` and makes one token-authed liveness call (Telegram `getMe`, Discord `/users/@me`) with a 5s timeout. The only check that leaves the machine. | `ok` if reachable or no channels configured; `warn` if unreachable (timeout/network error) or no token configured; `fail` if the platform rejects the token (401/403 — bot token invalid or revoked). |

No automatic fixes. Doctor reports; the operator acts.

## Notes

- The check logic lives in `scripts/doctor-check.ts` so it can be unit-tested without
  invoking the model.
- Re-runs are cheap. No locking needed.
- `channel-liveness` is the only check that leaves the machine: one token-authed liveness
  call per already-configured, enabled channel, 5s timeout, fail-soft. Disabling a channel
  disables its probe — there is no per-check opt-out in v1. Every other check is a local
  filesystem read.
