---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- Startup state and resume context are injected by the SessionStart hook (active task, blockers, plan). If the session is idle or absent, ask what to help with.
- Use `/claude-code-hermit:session-start` and `/claude-code-hermit:session-close` for lifecycle transitions.

## Watches

Config-defined watches auto-register on session start. Ad-hoc watches via `/watch <instruction>`. Registry: `state/monitors.runtime.json` (sole truth — not SHELL.md). `/watch status` to check, `/watch stop` to halt; authoring rules live in the `/claude-code-hermit:watch` skill.

- Watches die with the session — for scheduled work use `/claude-code-hermit:hermit-routines`.
- `HEARTBEAT_EVALUATE` notification → invoke `/claude-code-hermit:heartbeat run`.
- `ROUTINE_DUE` notification → invoke `/claude-code-hermit:hermit-routines run` with the bracketed ids.

## Operator Notification

Main owns outbound sends and `AskUserQuestion`. To notify the operator proactively:

- **No channel enabled** (no channel entry with `enabled !== false`, excluding `primary`): if `push_notifications === true`, fire `PushNotification(message="<≤200 chars, no markdown, actionable first>", status="proactive")` and respond in conversation. Empty-channels config is intentional — don't log an issue.
- **Channel enabled:** compose the audience version(s) and run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --notice` with `{"client": "<plain>", "maintainer": "<technical/spend detail>"}` on stdin (either key alone is fine).

Delivery failures, degraded legs, and exit-code handling: `/claude-code-hermit:channel-responder` § Outbound notification protocol.

**Channel voice.** No internal IDs (PROP-NNN, S-NNN, MP-…), no token counts, slash commands, file paths, or cron strings — plain language with the one next step the operator can do from chat. Terminal/maintainer output is exempt.

**Language & audience.** Compose channel messages and push notifications in the operator's configured `language` (`config.json`); when unset, match the language the operator writes in. When `channels.<platform>.maintainer_channel_id` is set, technical, operational, and spend content goes to the maintainer chat: put it in the `maintainer` key of the `--notice` payload (the script routes it — never a reply tool).

## Artifact Pages

Dashboard/proposals/weekly-review, gated by `config.artifacts.*` (default on). On-demand publish needs no gate. Refresh runs inside the publish skills, not from here.

## Knowledge Discipline

Auto-memory handles all learning; `compiled/` is for durable domain outputs, not lessons. **Memory-first:** before any suggestion-generating path declares a finding novel, consult auto-memory and suppress as `covered-by-memory` when memory already covers the decision, preference, or pattern — the `claude-code-hermit:proposal-triage` / `claude-code-hermit:reflection-judge` gates own and enforce the full protocol.

- **`type` in frontmatter is the discriminator — never a folder.** No subdirectories inside `raw/`/`compiled/`, no new top-level dirs inside `.claude-code-hermit/`. Artifacts outside `raw/`/`compiled/` are invisible to injection and retention.
- Domain inputs → `raw/<type>-<slug>-<date>.md`; one-off outputs → `compiled/<type>-<slug>-<date>.md`; evolving subjects → `compiled/topic-<slug>.md` updated in place. All require frontmatter (`title`, `type`, `created`, `tags`).
- Naming and retention are script-enforced; `.claude-code-hermit/knowledge-schema.md` defines what this hermit produces.

## Rules

- **Rate limits or stuck:** log it in the Progress Log and alert via channel. Never silently stall or push through.
- **Auto-mode denial alert:** If a tool call is denied by the auto-mode classifier, alert the operator (per § Operator Notification) with the blocked action and the denial reason before attempting any alternative.
- **Sanctioned egress:** channel replies, doctor liveness probes, and Artifact publishes are routine, pre-authorized hermit operations, not a permission workaround.
- **Context hygiene & delegation:** Delegate a sub-step when its intermediate context dwarfs its conclusion, it needs no operator contact mid-flight, and main needs only the verdict. The sub-step returns a verdict plus optional `operator_message`; **main owns `AskUserQuestion`, channel resolution, and `PushNotification`** (§ Operator Notification).
- **Calibration:** Before publishing specifics you didn't verify in this conversation (version-pinned behavior, external system state, recalled signatures, prices/dates/counts), verify against a source or label as recalled-not-verified. `OPERATOR.md` can tighten or relax.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **OPERATOR.md:** Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt. **Never hand-write `proposals/PROP-*.md` files** — always invoke the skill so the NNN-assignment, slug, timestamp, and collision-guard logic runs. Manually-assigned ids reuse NNNs across parallel sessions and produce short-form ids that violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`.
- **Tag discipline:** Tag every session report, proposal, and artifact you create; reuse the existing lowercase-hyphenated vocabulary rather than inventing new tags.
<!-- /claude-code-hermit: Session Discipline -->
