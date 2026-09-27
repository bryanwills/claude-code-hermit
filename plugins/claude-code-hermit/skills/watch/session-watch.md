# Session watches

Read this procedure for `/watch session`. The shared rules in [SKILL.md](SKILL.md) apply.
Step 5 uses `SKILL.md` § Starting an ad-hoc watch steps 6–9 for registry writes and task notes.
When entering from another skill after it has already sent work with `notify_when_idle: true`,
read those shared rules and registry steps, then follow only steps 3–5 below using that send's result.

### Starting a session watch (`/watch session <name|glob> [note] [--record <T-id>] [--proposal <PROP-id>] [--implement] [--id <bg-id>]`)

1. Parse optional `--record <T-id>`, `--proposal <PROP-id>`, `--implement` and `--id <bg-id>`
   with the name and note. If `<name>` contains `*` or `?`, take the **glob branch** below instead of
   resolving an exact name. The glob branch ignores `--record`, `--proposal`, `--implement` and `--id`.

   With `--id`, first poll the bg id in one Bash call every 2s for up to 30s.
   A busy, blocked or done row is started; null or idle status with working
   state is not. Output columns are status, state and waitingFor:
   ```bash
   deadline=$((SECONDS + 30))
   while (( SECONDS <= deadline )); do
     row=$(claude agents --json | jq -r --arg id <bg-id> '.[] | select(.id==$id and (.status=="busy" or .state=="blocked" or .state=="done")) | [.status, .state, .waitingFor] | @tsv')
     if [[ -n "$row" ]]; then
       printf '%s\n' "$row"
       break
     fi
     (( SECONDS + 2 <= deadline )) || break
     sleep 2
   done
   ```

   If no row is printed, answer `No session named <name> is reachable from here.`
   and stop. If its state is `done`, give step 2's "not working on anything"
   decline and stop.

   Resolve `<name>` with `ListAgents`. The row must be a Claude Code
   session on this machine — `notify_when_idle` covers nothing else, so a
   cloud/remote agent or an in-process subagent row does not qualify. If no such
   row matches, answer `No session named <name> is reachable from here.` and do
   not write the registry.

   **Glob branch:** match the glob against the session *name* of every
   `ListAgents` row that qualifies by the same rule — whole name,
   case-sensitive, matching only the name that opens the row and not its
   trailing `[ref]`, kind, status, or tmux address. `ListAgents` omits this
   session from its own listing, so no self-exclusion is needed. Skip a match
   with a live `peer-idle` entry for that target, or one step 2 rules out because
   its turn has already ended; say which ones you skipped and why. No match:
   answer
   `No session matching <name> is reachable from here.` and do not write the
   registry. One or more remaining matches: show the operator each matched name
   with the live status its row reports (`idle`, `busy`, `waiting`, `shell`; some
   rows carry none, so show the name alone there) and wait for confirmation
   before doing anything else. On confirmation, run steps 2–5 below once per
   matched name, each producing its own registry entry; do step 3's relay check
   on the first match before subscribing to the rest, and if it comes back
   operator-only, stop there and decline the whole set rather than subscribing
   the others.
2. With `--id`, decide from the polled row's status and state rather than the
   `ListAgents` status or a re-read: `busy` subscribes as below; `blocked`
   subscribes and reports the polled `waitingFor` as below.
   Without `--id`, apply the row checks below, including the one re-read.
   Call `SendMessage` with `to: <name>` and `notify_when_idle: true`. Omit
   `message`: this is a pure subscription and costs the watched session nothing.
   A target whose turn has already ended fires its notice at once for that same
   turn, so do not send a bodyless subscription to a row showing `idle` or
   `waiting` (except the blocked case below), nor to a target you are sending work to: arm that one by passing
   `notify_when_idle: true` on the same `SendMessage`, then record the entry with
   steps 3 to 5. A session just launched or resumed with a prompt can take a
   moment to show busy, so without `--id`, re-read its row once before deciding. If it still
   shows `waiting`, read that name's row in `claude agents --json`. When its
   `state` is `blocked`, send the bodyless `notify_when_idle` subscription,
   record the entry through steps 3 to 5, and tell the caller the session is
   blocked on its `waitingFor`. A subscription taken while blocked stays
   silent until the prompt is answered, then fires when the turn ends.
   For `idle`, or `waiting` with any other state or no registry row, answer `<name> is not working on anything right
   now, so there is no turn to watch; the next message sent to it arms the
   watch.` and do not write the registry.
3. Read the tool result: it says whether the notice will be shown to you or only
   to the operator. When it is operator-only (this session holds peer messages
   for approval, e.g. under `bypassPermissions`), no relay is possible — say so
   plainly instead of claiming the watch is live, and do not write the registry.
4. Generate id `session-<name>-<epoch>-<4char-random>` — same timestamp + random
   suffix convention as an ad-hoc id, so two watches on one name in the same
   second do not collide.
5. Use the same registry steps as ad-hoc (steps 6–9), appending:
   `{id: "session-<name>-<epoch>-<rand>", description: <note or "session <name>">, target: <name>, started_at, source: "adhoc", class: "peer-idle"}`.
   When given, store `--record` as `record`, `--proposal` as `proposal` and
   `--implement` as `purpose: "implement"` on that entry. Do not add `task_id` (`task_id` means a Monitor task and drives
   `TaskStop`).
