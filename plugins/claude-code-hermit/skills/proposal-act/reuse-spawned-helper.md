# Reuse a spawned helper

Read from proposal-act's "Start implementing now" branch, before the
falsification gate and Dispatch, when the proposal's `## Operator Decision`
carries a `spawn-session --proposal` hand-off line:
`Handed to helper <n> on <date>; record <T-id>`. The latest such line names
the helper. It already paid for reading the proposal and its cited files, so
the implementation tail goes to it. The helper works in its own worktree, so
what it implements lands as a pull request from that branch.

**Instructions.** The numbered instructions of the Dispatch prompt, spelled as
message text with the absolute proposal path written out (an `@` path attaches
nothing across sessions), with two changes:

- Step 1 adds: before editing, re-verify every cited path and symbol against
  the current code, since the investigation may predate later commits. If the
  proposal is already done, its paths are stale, it is too vague to act on, or
  a file it must change is gitignored (`git check-ignore`) and so cannot land
  through a pull request, stop and report that as the verdict instead of
  implementing.
- After verification: commit on the worktree branch and open a pull request
  from it; never merge. Name the pull request link on the `Evidence:` line of
  the `GUEST_REPORT:`.

**Delivery.**

- `<n>` has a `ListAgents` row: `SendMessage` it the instructions with
  `notify_when_idle: true` on that same send. Then register the watch entry as
  watch § Starting a session watch steps 3 to 5 describe, with `record` set to
  the record step (a) opened, `proposal` to PROP-NNN and `purpose` to
  `implement`, so the idle-notice relay records the report as implementation
  rather than triage.
- No row (watch § Handling idle notices leaves an idle helper for the
  supervisor to reclaim): its transcript still resumes by the saved name. From
  the project root run `claude --bg --resume <n> '<the instructions>'` with no
  other flag: the saved options include the helper system prompt, and any
  extra flag starts a copy that drops them all, name, permission mode and
  worktree included. The instructions are one single-quoted
  argument, so replace every `'` in them with `'\''` first, as spawn-session's
  limits require. Then invoke
  `/claude-code-hermit:watch session <n> "Implement PROP-NNN" --record <id> --proposal PROP-NNN --implement`,
  where `<id>` is the record step (a) opened, not the hand-off line's helper
  record.

**Fallback.** A send that errors or a resume that fails to launch never reached
the helper: run the falsification gate, then Dispatch. Once they have reached
it (the send succeeded or the resume launched), never also Dispatch, or two
agents implement the same proposal. If the relay is operator-only or the watch
declines, note on the record that `<n>` is implementing unwatched and tell the
operator.

**After the report.** The relay files it on the record and notes the pull
request on the proposal, which stays `accepted`. Run
`/proposal-act resolve PROP-NNN` once the pull request merges, as the Dispatch
path does on `Status: implemented`. A report saying the change cannot land
through a pull request takes the fallback: falsification gate, then Dispatch.
