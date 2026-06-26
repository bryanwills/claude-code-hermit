---
name: ha-command-router
description: Route a natural-language house command (in the operator's locale) to a Home Assistant actuation. Resolves the target entity via the CLI, maps the verb to a CLI actuate call, asks on ambiguity, and confirms sensitive actions over the channel. Use when the operator tells the house to DO something (turn on/off, open/close, set level) — not for state questions (use ha-house-status).
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

# HA Command Router

Turn a spoken/typed house command into a concrete, safe Home Assistant call.

## Steps

1. **Locale**: read the stored language from OPERATOR.md (`## HA hermit` section).
   All replies are in that locale (default English).

2. **Parse** the utterance into: a verb (the intent), a target phrase (the device),
   and any parameter (a percentage / level). The model handles typos and synonyms —
   do not shell out for this. Map the verb to a CLI verb via the Verb Lexicon below
   to infer the target's likely **domain** (e.g. "turn on" → `light`).

3. **Prefer a script** when the whole utterance names a routine, not a single device
   (see Scripts). Otherwise continue.

4. **Resolve the target** to an `entity_id`:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha resolve-entity "<target phrase>" --domain <inferred-domain>
   ```
   Branch on the JSON:
   - `{"match": "<id>"}` → use that `entity_id`.
   - `{"candidates": [...]}` → **ask, never guess**. Present the friendly names and
     let the operator pick (interactive: `AskUserQuestion`; over a channel: reply
     with a short numbered list and wait for the reply). Re-run with the chosen id.
     If the result also carries `"truncated": true`, tell the operator there are more
     matches and ask them to narrow the phrase.
   - `{"none": true}` or `{"none": true, "reason": "no_snapshot"}` → reply that you
     don't recognize the device and suggest `/claude-code-homeassistant-hermit:ha-refresh-context`.

5. **Actuate** the target. Choose the command based on the target type:

   **Single entity** (resolved via `resolve-entity`):
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha actuate <entity_id> <verb> [--level <N>]
   ```
   Branch on the JSON:
   - `{"status": "ok", ...}` → confirm the result to the operator in their locale (Format below).
   - `{"status": "blocked", ...}` → the entity is in `strict` mode; surface a proposal instead.
   - `{"status": "needs_confirmation", ...}` → the entity needs confirmation (see Confirmation).
   - `{"status": "error", "message": "..."}` → surface the message as a friendly error.

   **Area command** (utterance targets a room/zone, e.g. "turn off all the kitchen lights"):
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha actuate-area "<area name>" <verb> [--level <N>]
   ```
   Expands the area via `POST /api/template`, filters to the verb's domain, then gates each entity.
   Branch on the JSON:
   - `{"status": "ok", ...}` → confirm to operator (list friendly names or count).
   - `{"status": "partial", actuated:[...], blocked:[...], errors?:[...]}` → some entities were
     blocked or failed; surface which and, if `blocked` is non-empty under `ask` mode, surface a
     proposal for those.
   - `{"status": "needs_confirmation", sensitive:[...], actuatable:[...], blocked:[...]}` → one or
     more entities need confirmation (see Confirmation — area variant).
   - `{"status": "error", "message": "..."}` → unknown area or verb has no actuatable members;
     surface a friendly error.

## Verb Lexicon (English → CLI verb)

| Utterance verb               | CLI verb       | Domain  |
|------------------------------|----------------|---------|
| turn on, switch on           | `on`           | `light` / `switch` |
| turn off, switch off         | `off`          | `light` / `switch` |
| open                         | `open`         | `cover` |
| close, shut                  | `close`        | `cover` |
| set to N%, dim to N%         | `set --level N`| `light` (brightness_pct) / `cover` (position) |
| lock                         | `lock`         | `lock`  |
| unlock                       | `unlock`       | `lock`  |

The model recognises equivalent verbs in the operator's locale and maps them to the same CLI verbs.
Domains covered by `ha actuate`: `light`, `switch`, `fan`, `cover`, `lock`.
Domains NOT supported (sensors, climate, media, input, etc.) return `{status:"error"}` — surface a
proposal instead. Sensitive locks/alarms follow the confirmation flow; under `strict` they return
`{status:"blocked"}` and always become a proposal.

## Scripts (whole-routine utterances)

A whole-routine utterance ("good morning", "leaving home") names a routine, not a single
device. `ha actuate` rejects `script.*` entities (returns `{status:"error",
message:"script entities route to a proposal"}`). There is no verified path to
call HA scripts safely yet. List candidates with
`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts`, name the routine, and
surface it as a proposal rather than actuating.

## Confirmation (sensitive actions)

Sensitive domains (`lock`, `alarm_control_panel`, security-keyworded
`cover`/`switch`/`button`) return `{"status": "needs_confirmation", ...}` when
`ha_safety_mode` is `ask` and `--confirmed` is not passed.

- **Interactive session**: use `AskUserQuestion` and re-run with `--confirmed` on
  approval:
  - Single entity: `ha actuate <entity_id> <verb> [--level <N>] --confirmed`
  - Area: `ha actuate-area "<area>" <verb> [--level <N>] --confirmed`
- **Channel session** (any channel — Telegram/Discord/voice): do NOT call with
  `--confirmed` yet. Append **one** pending entry to
  `.claude-code-hermit/state/pending-ha-actions.json` — create the file as
  `{"pending": []}` if it does not exist. Entry schema:
  - Single entity: `{id, entity_id, verb, level?, channel, created_at}`
  - Area command: `{id, area, verb, level?, channel, created_at}` (no `entity_id`)

  Reply "Confirm <action>? (yes/no)". On the operator's next affirmative, this
  skill is re-invoked in `--resolve` mode.

`strict` mode never actuates sensitive entities — the CLI returns `{status:"blocked"}`
and a proposal is surfaced instead.

### `--resolve` mode

When invoked to resolve a pending confirmation: read
`state/pending-ha-actions.json`.

**Matching:** filter entries whose `channel` matches the current channel. If
multiple remain, take the most recent (`created_at` descending — LIFO). If no
entry matches the channel, reply that there is no pending action for this channel
and do nothing.

**TTL:** reject any matched entry whose `created_at` is more than 300 seconds
(5 minutes) old. Remove it from the file, inform the operator that the
confirmation window has expired, and do nothing. Clean up any other expired
entries in the same pass.

After matching and TTL checks pass: dispatch based on the entry shape:
- Entry has `entity_id` → `ha actuate <entity_id> <verb> [--level <N>] --confirmed`
- Entry has `area` → `ha actuate-area "<area>" <verb> [--level <N>] --confirmed`

Remove the entry from `pending`, write the file back, and confirm the result in
the operator's locale.

`--resolve` only handles **entity-targeting and area** pending actions. Scripts
have no confirmed path — route them to a proposal (see Scripts).

## Format

- **Text channel** (Telegram/Discord/etc.): short, markdown allowed, name the device by its friendly name.
- **Voice**: 1–2 short sentences, numbers spelled out, no symbols or entity IDs.
- Friendly errors only — never surface raw `entity_id`s or stack traces to the operator.
