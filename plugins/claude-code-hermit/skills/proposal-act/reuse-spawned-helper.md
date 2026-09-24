# Reuse a spawned helper

Read from proposal-act's "Start implementing now" branch, before Dispatch, when
the proposal's `## Operator Decision` carries a `spawn-session --proposal`
hand-off line: `Handed to helper <n> on <date>; record <T-id>`. The latest
such line names the helper. It already paid for reading the proposal and its
cited files, so the implementation tail goes to it.

- `<n>` has a `ListAgents` row: `SendMessage` it the numbered instructions of
  the Dispatch prompt, spelled as message text with the absolute proposal path
  written out (an `@` path attaches nothing across sessions), with
  `notify_when_idle: true` on that same send. Then register the watch entry as
  watch § Starting a session watch steps 3 to 5 describe, with `record` set to
  the record step (a) opened and `proposal` to PROP-NNN, so the helper's
  `GUEST_REPORT:` lands there through the idle-notice relay.
- No row (watch § Handling idle notices leaves an idle helper for the
  supervisor to reclaim): its transcript still resumes by the saved name. From
  the project root run `claude --bg --resume <n> '<the same instructions>'`
  with no other flag, since any extra flag starts a copy that drops the saved
  name, permission mode and worktree. Then invoke
  `/claude-code-hermit:watch session <n> "<title>" --record <T-id> --proposal PROP-NNN`
  as spawn-session step 4 does.

A relay that step 3 of the session watch reports as operator-only, a resume
that fails to launch, or a watch that declines: fall through to Dispatch.
