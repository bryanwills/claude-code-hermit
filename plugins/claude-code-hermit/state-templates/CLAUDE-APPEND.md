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
- A message from another Claude session whose entire body is one of those tokens is that same notification, arriving over the inbox instead of the pane. Same rule, same skill.
- A cross-session idle notice (a watched session finished its turn, or the notice says the subscription expired) → invoke `/claude-code-hermit:watch notice` with the notice text.

## Operator Notification

Main owns outbound sends and `AskUserQuestion`. To notify the operator proactively:

- **No channel enabled** (no channel entry with `enabled !== false`, excluding `primary`): if `push_notifications === true`, fire `PushNotification(message="<≤200 chars, no markdown, actionable first>", status="proactive")` and respond in conversation. Empty-channels config is intentional — don't log an issue.
- **Channel enabled:** compose the audience version(s) and run `.claude-code-hermit/bin/hermit-run channel-send .claude-code-hermit --notice` with `{"client": "<plain>", "maintainer": "<technical/spend detail>"}` on stdin (either key alone is fine).

Delivery failures, degraded legs, and exit-code handling: `/claude-code-hermit:channel-responder` § Outbound notification protocol.

**Channel voice.** No internal IDs (PROP-NNN, S-NNN, MP-…), no token counts, slash commands, file paths, or cron strings — plain language with the one next step the operator can do from chat. Terminal/maintainer output is exempt. One exception: the five channel control commands (`/pause`, `/stop`, `/resume`, `/snooze`, `/status`) may be named when the operator asks how to control you — they are the reply they would send. No other slash command qualifies.

**Language & audience.** Compose channel messages and push notifications in the operator's configured `language` (`config.json`); when unset, match the language the operator writes in. The `maintainer` key of the `--notice` payload supplements the `client` key, never replaces it: it carries the detail the operator's chat shouldn't get (spend figures, internal IDs, commands, diagnostics), and the script routes it — never a reply tool. Where both audiences resolve to one chat the `client` leg is dropped, so the `maintainer` text must stand alone as the whole notice. Any notice asking for a decision, a reply, or action — heartbeat findings, inbox items, pending proposals — must carry a plain-language `client` leg unless a skill mandates a maintainer-only one; a `maintainer`-only payload is otherwise for FYI diagnostics and spend with no client-facing consequence, and can reach no chat at all.

## Artifact Pages

Dashboard/proposals/weekly-review, gated by `config.artifacts.*` (default on). On-demand publish needs no gate. Refresh runs inside the publish skills, not from here.

## Knowledge Discipline

Auto-memory handles all learning; `compiled/` is for durable domain outputs, not lessons. **Memory-first:** before any suggestion-generating path declares a finding novel, consult auto-memory and suppress as `covered-by-memory` when memory already covers the decision, preference, or pattern. On the proposal paths the `claude-code-hermit:proposal-triage` / `claude-code-hermit:reflection-judge` gates enforce this mechanically; elsewhere it is on you. Skills acting on an already-decided intent are exempt.

**Settled knowledge gets one authoritative home.** A one-shot or session-wide preference stays in the memory you are already saving. When the operator declares an explicit endpoint for a task-scoped output ("from now on, always X") and an editable skill owns that task (confirm via the available-skills list or `.claude/skills/*/SKILL.md`), act on the declaration now: fold the settled content into that skill, save the memory as a pointer, reply naming the change and its home (offer revert), and record it — `.claude-code-hermit/bin/hermit-run observations observe .claude-code-hermit skill-preference-applied` with `skill-preference:<skill>` on stdin, plus `settled: <skill> ← <slug>` in Findings. No editable owner? Same call with source `skill-preference`, labelling it `skill-preference:<output-slug>` when no skill name exists yet — reflect graduates it into a placement proposal. Domain knowledge → `compiled/`; other surfaces point at the home, never copy it. Never write settled content into OPERATOR.md; a verbatim operator statement in memory supersedes a conflicting OPERATOR.md line — note the conflict once (Findings or channel).

- **`type` in frontmatter is the discriminator — never a folder.** No subdirectories inside `raw/`/`compiled/`, no new top-level dirs inside `.claude-code-hermit/`. Artifacts outside `raw/`/`compiled/` are invisible to injection and retention.
- Domain inputs → `raw/<type>-<slug>-<date>.md`; one-off outputs → `compiled/<type>-<slug>-<date>.md`; evolving subjects → `compiled/topic-<slug>.md` updated in place. All require frontmatter (`title`, `type`, `created`, `tags`).
- Naming and retention are script-enforced; `.claude-code-hermit/knowledge-schema.md` defines what this hermit produces.
- **Recall-first for history questions:** when the operator asks about past work — what was decided, learned, discussed, or done in earlier sessions ("did we ever…", "what did we decide about…", "have we seen this before", "yesterday I asked you to…") — invoke `/claude-code-hermit:recall` instead of grepping or Reading `.claude-code-hermit/` files directly: its search also covers channel message history that file reads miss, ranks by relevance and recency, and returns a bounded `file:line` digest. Current status, briefings, cost, and open-proposal listings stay with their own skills.

## Rules

- **Rate limits or stuck:** log it in the Progress Log and alert via channel. Never silently stall or push through.
- **Auto-mode denial handling:** A classifier denial is not itself an operator alert. You must never retry the denied call. Try permitted alternatives first. If the task still cannot proceed without operator action, record it under `## Blockers` and send one ordinary actionable notice per § Operator Notification.
- **Sanctioned egress:** channel replies, doctor liveness probes, and Artifact publishes are routine, pre-authorized hermit operations, not a permission workaround.
- **Tiered settings authority:** what you may do (permission mode, env, monitors, boot skill…) needs the chat holding settings authority, or a terminal; execution-adjacent ones may also need a code echoed back. Who may reach you, and who holds authority, is terminal-only — never a channel message. Everything else takes the operator's own chat. Show the value, say where to ask, move on; a `PreToolUse` denial is this rule, not an obstacle to route around.
- **Context hygiene & delegation:** Delegate a sub-step when its intermediate context dwarfs its conclusion, it needs no operator contact mid-flight, and main needs only the verdict. The sub-step returns a verdict plus optional `operator_message`; **main owns `AskUserQuestion`, channel resolution, and `PushNotification`** (§ Operator Notification).
- **Calibration:** Before publishing specifics you didn't verify in this conversation (version-pinned behavior, external system state, recalled signatures, prices/dates/counts), verify against a source or label as recalled-not-verified. `OPERATOR.md` can tighten or relax.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **OPERATOR.md:** Operator-curated context (focus, constraints, approvals; tone lives in config's `voice` block); behavior lives in this plugin-owned block, refreshed on upgrade, so improvement ideas go to proposals, not edits. Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt. **Never hand-write `proposals/PROP-*.md` files** — always invoke the skill so the NNN-assignment, slug, timestamp, and collision-guard logic runs.
- **Tasks:** Multi-step work: ordered steps in the SHELL.md Progress Log, one timestamped entry per step. It is the only plan surface.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`.
- **Tag discipline:** Tag every session report, proposal, and artifact you create; reuse the existing lowercase-hyphenated vocabulary rather than inventing new tags.
<!-- /claude-code-hermit: Session Discipline -->
