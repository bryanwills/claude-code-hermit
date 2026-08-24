---
name: rc-gate
description: Open, close, or check the Remote Control spawn gate — the hermit-managed `claude remote-control` server that lets a phone spawn new sessions into this project. Activates on messages like "open the spawn gate", "let me start sessions from my phone", "close the gate", "is the gate open", "give me the remote link", "clean up the leftover worktrees".
---
# RC Gate

The spawn gate is a `claude remote-control` server the hermit runs as its own
tmux child. While it is open, the operator can spawn **new** sessions into this
project from claude.ai/code or the mobile app; each spawn lands in its own git
worktree, so this folder stays single-session and the hermit keeps its own state.

This is a different leg from `config.remote`, which makes *the hermit itself*
reachable. Both can be on; neither implies the other.

## Verbs

All four are `.claude-code-hermit/bin/hermit-run rc-server <verb>`:

| Verb | What it does | Output |
|---|---|---|
| `start` | opens the gate (tmux session `hermit-rc-gate`), waits for the server | `ready <url>` or a one-line refusal |
| `status` | one pane read | `down`, `starting` (up but not serving yet), `ready`, or `connected N/32` |
| `stop` | closes the gate, then sweeps | `closed` / `down`, plus any removals |
| `gc` | sweeps worktrees left by archived spawns | one line per worktree removed, or kept because it holds uncommitted work |

`start` prints the `claude.ai/code?environment=…` URL — that is what the operator
opens or scans. Hand it over as a link, not as a command.

## Authority

Opening the gate widens who can reach this machine, so treat it like an
execution-adjacent setting, not an everyday one:

- **Terminal** — always fine.
- **Chat** — only the settings chat, and only with an echoed confirmation code
  (the `nonce` tier in `docs/security.md` § Tiered settings authority). Any other
  chat: report the current status, say where to ask, and stop.
- `status` and `gc` are reads/cleanup — the everyday `allowed` tier.

Be honest about what enforces this: `channel-settings-gate.ts` covers
`settings-edit` writes, not this verb, so the fence here is your judgment. Do not
route around a refusal by invoking the tmux command directly.

## Behavior

Report state, not mechanics. The operator wants to know whether they can spawn
from their phone, and the link if so — never the tmux session name, the flags, or
the pane text.

A time-boxed open ("open it for two hours") is `start` now plus a Progress Log
note naming the close time; there is no scheduler behind it, so say that you will
close it when you next see the clock pass that mark, and close it when you do.

When `start` refuses with the not-logged-in verdict, that is final: Remote Control
requires a claude.ai `/login` on this machine and this install's auth does not
carry it. Say so once, don't retry, and don't propose workarounds.

Run `gc` whenever the operator mentions leftover or stuck worktrees, and after
any `stop`. Archiving a spawned session from the Claude app reads as a crash to
the server and leaves a locked worktree behind — that sweep is the hermit's job,
not the server's. A `kept` line means that worktree still holds uncommitted work;
tell the operator it is there and let them decide, never delete it for them.
