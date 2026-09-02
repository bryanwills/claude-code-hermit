---
name: hermit-routines
description: Schedules routines via one persistent Monitor subprocess (zero-token skips); CronCreate fallback where Monitor is unavailable. heartbeat-restart stays a CronCreate re-arm anchor.
---
# Routines

Register and manage scheduled routines. Where the Monitor tool is available, all enabled routines except `heartbeat-restart` run from ONE persistent Monitor subprocess that decides eligibility outside the session — a skipped fire costs zero model tokens. `heartbeat-restart` stays a CronCreate **re-arm anchor**: its skill IS `load`, so its daily fire re-arms the monitor and the anchor CronCreate — and, unless `heartbeat.enabled` is explicitly false, restores the heartbeat monitor too. The watchdog re-arms a monitor whose liveness has gone stale as a second net, on a resting session too. Where Monitor is unavailable (Bedrock/Google Cloud Agent Platform/Foundry, `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), `load` falls back to per-routine CronCreates.

## Usage

```
/claude-code-hermit:hermit-routines load              register/reconcile: monitor mode if available, else CronCreate diff-register
/claude-code-hermit:hermit-routines load --reset      unconditional reset: tear down + recreate everything
/claude-code-hermit:hermit-routines run <ids>          [internal] ROUTINE_DUE handler — invoked by the monitor's notification
/claude-code-hermit:hermit-routines list               list configured routines from config.json
/claude-code-hermit:hermit-routines status              show monitor/anchor state (or CronCreate registrations in fallback mode)
/claude-code-hermit:hermit-routines stop [id]           stop the monitor (or a specific fallback-mode CronCreate)
/claude-code-hermit:hermit-routines stop --all          stop everything
```

## Plan

### load

Called automatically by `hermit-start.ts` on always-on launches. Can also be called manually to apply config changes mid-session.

1. Resolve the plugin root path: derive it from this skill's **Base directory**, which the harness injects into the invocation context as `<plugin_root>/skills/hermit-routines`. Strip the trailing `/skills/hermit-routines` to get `pluginRoot`. This works in both installed and `--plugin-dir` modes. (`$CLAUDE_PLUGIN_ROOT` is NOT a Bash env var at runtime — evaluating it in Bash always returns empty. The braced `${CLAUDE_PLUGIN_ROOT}` form is text-substituted in skill markdown only in installed mode. Neither is reliable here — always use the Base-directory derivation.) The resolved `pluginRoot` must be baked into the Monitor `command` and into any CronCreate-delivered prompt at registration — it is not available inside either subprocess or cron-delivered prompts.

   **Validate `pluginRoot` before proceeding.** If `pluginRoot` is empty, or either of `<pluginRoot>/scripts/routines.ts` (the `log-event`/`precheck`/`cron-registry` verbs all live in it) or `<pluginRoot>/scripts/routine-monitor.sh` does not exist (`test -f` — pass the bare file path, never a path with a verb appended), abort `load` immediately — do not register/delete anything — and log one line: `Routine load aborted: plugin scripts not found at "<pluginRoot>". No routines registered or reset.`
2. **Ask what needs arming:**
   ```
   bun <pluginRoot>/scripts/routines.ts arm begin .claude-code-hermit <pluginRoot>
   ```
   It reads config, the runtime mirror and both liveness files, and returns the whole plan. Append ` --reset` for `load --reset` (below). Its first line decides the branch:

   - **`HEALTHY|routines=<mode:n>|anchor_age=<d.d>d|heartbeat=<ok|disabled>`** — the monitor is registered, ticking, and current; the anchor and heartbeat legs are too. **Log that one line and stop.** Re-arming a healthy monitor is what the daily anchor used to spend a dozen full-context calls on, and this fast path is the whole saving.
   - **`ARM|<legs>|<reasons>`** — execute the plan block that follows, in order. Every subsequent line is optional and appears only when it applies.
   - **`ARM|routines,heartbeat|check-error:<reason>`** — the verb could not read `config.json` or the mirror, so it emitted no plan. Abort `load`: register or delete nothing, and log `Routine load aborted: arm check failed — <reason>. No routines registered.`

3. **Execute the `ARM` plan block.** The lines, in the order they are printed:
   - `OLD_TASK:<id>` — `TaskStop` it (ignore not-found). Printed unless the record belongs to a previous boot, whose task died with that process; a record with no `boot_id` at all was written by this one.
   - `FIRST_TRANSITION:1` — this is a first transition into monitor mode (never printed on the `--fallback` leg, where those crons are the routines). Also `CronList` and `CronDelete` every entry whose prompt contains `[hermit-routine:` **except** `[hermit-routine:heartbeat-restart]` — live crons from an in-process upgrade that the mirror no longer tracks (duplicate-fire hazard). Skip this sweep entirely when the line is absent.
   - `MONITOR_CMD:<command>` — register the Monitor: `description: "routine-monitor"` (reserved slot), `command:` **the string verbatim, unedited** (it is already absolute; `$PWD` would trigger Claude Code's `simple_expansion` approval), `timeout_ms: 86400000` (schema-required boilerplate on a persistent monitor — it does not expire on this deadline), `persistent: true`.
   - `MONITOR_SKIP:zero-scheduled` — instead of the above: register no Monitor (only the anchor is enabled), and pass `none` as the task id in step 4.
   - `DELETE:<id>` / `CREATE:<id>|<schedule>` / `WARN:<id>|<reason>` / `KEEP:<n>` / `WAKESPREAD:…` — the planner's diff, scoped to the anchor in monitor mode and to the full enabled set in fallback. Execute per the **CronCreate flow** below. Skip the `WAKESPREAD` advisory in monitor mode (meaningless over one routine).
   - `ANCHOR_PROMPT_BEGIN` … `ANCHOR_PROMPT_END` — the anchor's `CronCreate` prompt, rendered for you. Pass the enclosed text **verbatim** as the `prompt` for the `heartbeat-restart` `CREATE:` line: it is what makes the next daily fire short-circuit on `HEALTHY`. The planner's `promptHash` does **not** cover the prompt text (only id/skill/flags/shifted schedule/plugin root), so a hand-composed or drifted prompt is registered silently and stays live until the 5-day age cliff or a boot-id change — `load --reset` is the way to force a rendered prompt onto an already-registered anchor.

4. **Commit:**
   ```
   bun <pluginRoot>/scripts/routines.ts arm commit .claude-code-hermit <pluginRoot> <task-id|none> --created "<succeeded-csv>"
   ```
   `<task-id>` is the Monitor's task id, or `none` after `MONITOR_SKIP`. Append ` --reset` when `begin` got it. The verb waits for the monitor's first liveness tick internally (≤10s) and writes `state/routine-monitor.runtime.json` and the registry mirror. Its output:
   - `OK|monitor|<n> scheduled|anchor <created|kept>` — done. Log it.
   - `FALLBACK|liveness-absent` — the subprocess never ticked (seccomp/nested-userns). `TaskStop` the task you just registered and go to Step 3-F.
5. **Step 3-F — fallback** (Monitor unavailable, registration failed, or `commit` returned `FALLBACK`): run
   ```
   bun <pluginRoot>/scripts/routines.ts arm begin .claude-code-hermit <pluginRoot> --fallback
   ```
   which re-plans over the full enabled set (scheduled routines + anchor) and prints the same block minus `MONITOR_CMD`. Execute its `DELETE:`/`CREATE:` lines via the **CronCreate flow** below, then commit with `arm commit .claude-code-hermit <pluginRoot> fallback --created "<succeeded-csv>"`, which records `{"mode":"croncreate-fallback", …}`.

   **CronCreate flow** (executes the `DELETE:`/`CREATE:` lines from any `arm begin` block — monitor-mode anchor, fallback, or `--reset`):
   1. Parse the block's planner lines: `DELETE:<id>`, `CREATE:<id>|<schedule>`, `WARN:<id>|<reason>`, `KEEP:<n>`, optional trailing `WAKESPREAD:<distinct>|<max>|<loneliest>`.
      - No `DELETE:`/`CREATE:` lines (only `KEEP:<n>`, optional `WAKESPREAD:`): already current — log `Routines unchanged: <n> current, 0 registered.` (plus the wake-spread line if present). No `CronList`, no `CronCreate`, no `CronDelete` this run; go straight to the `arm commit` call.
      - Otherwise, if any `DELETE:` lines: call `CronList` once, `CronDelete` each entry whose prompt contains `[hermit-routine:<id>]` (skip silently if absent).
   2. For each `CREATE:<id>|<schedule>` line, call `CronCreate`: `cron: <schedule>` (as-is — already tz-shifted), `recurring: true`, `durable: false`, `prompt:` the rendered `ANCHOR_PROMPT_*` text for `heartbeat-restart`, or one built per **Shared execution semantics** below for any other id. **Per-routine error isolation:** if `CronCreate` throws for one routine, record the failure and continue — track which ids succeeded.
   3. Log: `Routines registered: <N> ok, <M> failed, <K> kept[, <W> tz-warned]`. List failures/warnings on their own lines. If `WAKESPREAD:<distinct>|<max>|<loneliest>` was present: `WARN: wake spread — <distinct> distinct 30-min wake windows (max <max>); consider clustering: <loneliest>` (advisory only).

**`load --reset`:** the unconditional escape hatch for suspected drift. Append ` --reset` to **both** the `arm begin` and `arm commit` calls (an unforced `commit` replan would carry stale `registered_at` forward, undoing the reset's clock). `begin --reset` never returns `HEALTHY`: it always emits a plan, deletes `state/routine-schedule.json` (a deliberate baseline reset — the ordinary re-arm's "preserve the cursor" rule doesn't apply here), and makes every enabled routine a `CREATE`. On top of the plan block, also `CronList` → `CronDelete` every live `[hermit-routine:*]` entry (anchor included) before creating.

#### Shared execution semantics

Used both by the fallback CronCreate prompt (built at `CREATE:` time) and by the `run <ids>` handler (below) — one definition, two callers.

One shared template for both `run_during_waiting` (rdw) values — `routines.ts precheck` takes `rdw` as an argument and consults the waiting-check and the binding pause flag internally. Default `run_during_waiting` is `false` when the field is absent.

**Model-override substitution.** Read the routine's optional `model` field. First, if `id === "heartbeat-restart"`, treat `model` as absent regardless of its value — its re-arm must run in the session, so it is never dispatched to a subagent. Then: if `model` is absent/null, invoke `/<skill>` directly. If set to a non-null `<model>`, dispatch instead: resolve `<abs-project-dir>` as the session's current absolute working directory (the project root) and `dispatch the skill via the Agent tool: subagent_type "general-purpose", model "<model>", prompt "The hermit project is at <abs-project-dir>; its state lives in <abs-project-dir>/.claude-code-hermit/. Invoke the skill /<skill> to completion, following its instructions exactly, and resolve any project-relative .claude-code-hermit/ reads/writes against <abs-project-dir> — pass the absolute <abs-project-dir>/.claude-code-hermit path to any hermit script the skill runs rather than relying on your cwd. Return only a one-line status."` **Language clause:** when `config.language` is set, append one more sentence to that prompt — `All operator-facing prose you produce (channel messages, push notifications, report text) must be written in <language>.` — substituting the configured language; append nothing when it is null. No script call: the dispatching session already holds the language in its Operator Preferences context. This anchors the subagent's own project-relative state paths without constraining where else it may work — a dispatched skill that legitimately changes directory for unrelated work (e.g. a custom routine touching a sibling repo) is unaffected, since `.claude-code-hermit/` always lives under `<abs-project-dir>` regardless of the subagent's cwd at invocation time. The Agent runs in isolated context and returns only a one-line status; the precheck call, the `finish` call, and any `heartbeat-restart`/`reflect_after` appends stay in the session turn at the session model.

Base execution, one routine, `<delivery>` = `cron-create` (fallback prompt) or `monitor` (`run` handler):
```
Run: bun <pluginRoot>/scripts/routines.ts precheck <id> <rdw> <delivery>
If the output is SKIP, stop. If PROCEED, then invoke /<skill> (or dispatch per the model-override rule above). After it completes, run:
bun <pluginRoot>/scripts/routines.ts finish <id> <delivery>
```
Replace `<pluginRoot>`, `<id>`, `<rdw>` (`true`/`false`; default `false`), and `<skill>` (passed verbatim to the slash invocation — `claude-code-hermit:brief --morning` becomes `/claude-code-hermit:brief --morning`).

**Optional `precheck`: the wake gate.** A routine may declare `precheck` — either the builtin `"reflect"`, or a project-relative path to an executable the operator owns. The routine monitor runs it at fire time, before waking the session: on `SKIP` the fire is consumed and stamped `skipped-precheck` at **zero token cost**, and nothing is emitted. On `WAKE`, any non-zero exit, a timeout (`precheck_timeout_s`, default 30s, max 300), or unparseable output, the routine fires exactly as it would with no gate, and a failure stamps `precheck-error` with the reason. Contract for an operator script: print `SKIP` or `WAKE` as its **first stdout line and nothing else that matters** — no output reaches the session, so a gate that has found something hands nothing over; the skill re-queries its own source, using the `ROUTINE_LAST_FIRED` env var (ISO timestamp of the last successful fire, empty on the first ever fire — treat empty as "everything is new"). Also in the environment: `HERMIT_DIR`, `ROUTINE_ID`. Gates must be read-only and cheap; anything that mutates state belongs in the skill, which only runs when the gate says so. The hermit may write the script for the operator on request. In CronCreate fallback mode the gate still runs, but after the wake — same behavior, no token saving.

**`finish` is unconditional and owns the ledger row** — call it whether or not the skill looked successful, and never decide the outcome yourself. It prints `fired`, or `failed|<reason>|<detail>` when the routine declared an `expect_artifact` contract that its run did not satisfy (`artifact-missing`, `artifact-unchanged`, `verification-error`). **On a `failed|…` line, notify the operator** per § Operator Notification, naming the routine and the expected path. Do not retry the skill: routines include channel sends, session closure and archival, none of them guaranteed idempotent.

**Special case — `heartbeat-restart`:** the anchor does not use this template at all. Its prompt is rendered by `arm begin` between `ANCHOR_PROMPT_BEGIN`/`ANCHOR_PROMPT_END` and used verbatim, because what it must say is the short-circuit: run `arm anchor`, and on `HEALTHY` reply with one line and stop. A prompt composed here instead would drift from the `promptHash` the planner computes over it, and every drift is a full re-registration.

The daily fire is still the re-arm that keeps the monitor and, in fallback mode, the routine CronCreates clear of the 7-day auto-expiry — `arm anchor` stamps `fired` on a `HEALTHY` verdict precisely so the ledger records the anchor as alive without a re-registration. The heartbeat leg is decided at fire time from `heartbeat.enabled`, never baked in at registration, so flipping it takes effect at the next 4am fire, and `false` keeps meaning off (bootstrap and the watchdog's re-arms honour it the same way — see `doRearm` in `hermit-watchdog.ts`). The daily fire is not the only recovery that reaches a resting session: the watchdog also re-arms a monitor whose liveness file has gone stale, at `session_state: idle` included, which is where a healthy hermit rests between arcs. An operator with `heartbeat.enabled: false` who wants one for just the current session types `/claude-code-hermit:heartbeat start` themselves.

**`reflect_after: true`:** append after the trailing `finish` call (and after the `heartbeat-restart` append if both apply). Skip when `skill` is `claude-code-hermit:reflect` — chaining reflect after reflect is a config foot-gun.
```
Then, only if `routines.ts precheck` returned PROCEED (not SKIP), run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot> --quick. If its first output line is exactly `EMPTY`, do not invoke reflect. Otherwise (a `RUN|<hash>` line) invoke /claude-code-hermit:reflect --quick --precheck-verdict '<that full line>'.
```

**Special case — `skill` is exactly `claude-code-hermit:reflect`:** reflect's body should not load on days with nothing to reflect on. Replace the invoke clause with:
```
If the precheck output carried a second line `REFLECT RUN|<phases-json>`, invoke /claude-code-hermit:reflect --precheck-verdict 'RUN|<phases-json>' — do NOT run reflect-precheck.ts yourself; it already ran, and running it again appends its observation rows a second time.
Otherwise run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot>. If its first output line is exactly `EMPTY`, do not invoke reflect; fall through to the `finish` call. Otherwise (a `RUN|<phases-json>` line) invoke /claude-code-hermit:reflect --precheck-verdict '<that full line>'.
```
The `REFLECT` line is present whenever the routine declares `"precheck": "reflect"` (the shipped default): the gate then ran subprocess-side before the wake, and an EMPTY day never woke the session at all. Without it — an older config, or a monitor registered before the gate existed — the fallback clause keeps the pre-gate behavior, where an EMPTY day costs one wake but never loads the reflect skill body. Does not apply to `--scheduled-checks` invocations (no cadence precheck) — `--quick` gets its own via the `reflect_after` append above.

### run &lt;ids&gt;

The `ROUTINE_DUE` notification handler — invoked when the monitor emits `ROUTINE_DUE [hermit-routine:&lt;id&gt;] ...`. Parse the bracketed ids. For each, look up the routine in `config.routines` and execute per **Shared execution semantics** above with `<delivery>` = `monitor`. Ids no longer present in config are skipped silently.

### list

Show configured routines from `config.json` (not the live view — that's `status`).

1. Read `config.routines`. If empty: "No routines configured."
2. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    RA     Model   Status
  1. heartbeat-restart  0 4 * * *     claude-code-hermit:hermit-routines load  true   false  -       enabled
  2. weekly-review      0 23 * * 0    claude-code-hermit:weekly-review         false  false  -       disabled
```
`RA` is `true` when `reflect_after: true`. `Model` is the `model` value if set, otherwise `-`.

### status

1. Read `state/routine-monitor.runtime.json`. The scheduled-routine count comes from `config.routines` (enabled, minus the anchor), not from the runtime file — the runtime file records the registration, and config is what it should match.
   - **Monitor mode:** report `mode`, `started_at`, `interval`, the scheduled count, and `state/routine-monitor-liveness.json`'s `last_peek_at`. Call `CronList` filtered to `[hermit-routine:` — in steady state only `[hermit-routine:heartbeat-restart]` should appear; more means "legacy CronCreates still active — run `load` to clean up."
   - **Fallback mode:** `CronList` filtered to `[hermit-routine:`, displayed as:
     ```
     Active routine CronCreates:
       ID                 CRON-ID    SCHEDULE
       heartbeat-restart  4e007cf4   0 4 * * *
     ```
     (Extract id from the `[hermit-routine:<id>]` prefix.) If none: "No active routine CronCreates. Run `load` to register."
   - **Absent runtime file:** "Not yet loaded. Run `/claude-code-hermit:hermit-routines load`."

### stop

**Monitor mode:**
- `stop` or `stop --all` (no id, or `--all`): `TaskStop` the monitor task, clear `state/routine-monitor.runtime.json`, `CronDelete` the anchor. Log: "Stopped routine monitor and anchor."
- `stop <id>` (id ≠ `heartbeat-restart`): routines share one subprocess — do not stop it. Reply: "Routines share one monitor subprocess — to stop just `<id>`, set `enabled: false` on that entry in config.json and run `load`."
- `stop heartbeat-restart`: `CronDelete` the anchor alone (the monitor, if any, keeps running).

**Fallback mode (unchanged):**
- `stop <id>`: `CronList`, find the `[hermit-routine:<id>]` entry, `CronDelete` it (or "not active").
- `stop` (no id): `CronList` filtered to `[hermit-routine:*]` — 0 active: report; 1 active: stop without asking; 2+: list and ask (or `--all`).
- `stop --all`: `CronDelete` every `[hermit-routine:*]` entry.

## Notes

- **Monitor mode defers only while an operator turn is open** (a Stop-cleared marker, 60-min TTL backstop), coarser than CronCreate's turn-level idle gate. A routine wake can still interject mid-conversation (same trade the heartbeat monitor accepts) — CronCreate never fires mid-task. A session left `in_progress` with no open operator turn no longer starves routines.
- **Routine ids** must match `^[A-Za-z0-9._-]{1,64}$` (enforced by `validate-config.ts`) — ids travel through bracket markers, `--ids` CSVs, and JSONL rows.
- **Changes take effect immediately.** `hermit-settings routines` invokes `load` after writing config; hand-edited `config.json` needs a manual `load`.
- **Interactive mode does not auto-register routines.** `hermit-start.ts` calls `load` only on always-on launches.
- **`model` (optional)** runs a routine's skill in an isolated-context subagent at the named model (`opus`/`sonnet`/`haiku`) — returns only a one-line status, so skip it on routines whose value is the rich chat output. Ignored on `heartbeat-restart` (re-arm must run in the session). Validated by `scripts/validate-config.ts`.
- **Converting a costly broad-skill routine into a scoped one?** See [Routine Authoring](../../docs/routine-authoring.md).

### CronCreate fallback details

- **Timezone.** CronCreate flow shifts each cron from `config.timezone` to machine-local (CronCreate only knows machine time) at minute granularity — half-hour/45-minute zones (Kolkata, Adelaide, Kathmandu) work. Null `config.timezone` passes through unchanged. Monitor mode needs no shift — `routines.ts due` evaluates directly in `config.timezone`.
- **DST.** Recomputed every `load`; `heartbeat-restart`'s daily reload self-corrects within 24h. On the transition day, one fallback-mode fire may land at the wrong hour. Inexpressible-after-shift schedules pass through unchanged with a `WARN:` line.
- **`durable: false`.** CronCreates die with the session; re-registered on every always-on launch.
- **7-day auto-expiry depends on `heartbeat-restart`.** CC's recurring-task expiry is a hard 7-day cliff, reset only by re-creating. The diff planner re-registers any routine whose age crosses a conservative threshold even with unchanged config; `heartbeat-restart`'s daily `load` is what crosses it. Disable it in fallback mode and routine CronCreates expire after 7 days.
- **`state/cron-registry.json`** is a derived mirror, never hand-edited — `--reset`, a missing/corrupt mirror, or a `.boot-id` mismatch all fall back to treating every enabled routine as needing registration.
