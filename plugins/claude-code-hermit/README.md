<p align="center">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.1.10-green.svg" alt="Version 1.1.10" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-hermit

Claude Code plugin that turns it into a 24/7 personal AI assistant. **Self-learning**, **Pro-Active**, **Cost-aware**, **Observable**, **One Claude subscription, multiple hermits**.

<p align="center">
  <img src="assets/cover.png" alt="Always-on Claude Code Agent" />
</p>

Claude Code is a session you start and end. **A hermit is one that never ends.** It wires the native primitives (`/loop`, `CronCreate`, channels, Monitor, auto-memory, native Tasks) into an always-on agent that runs on its own schedule, survives restarts, and learns from each session. It messages you first when something needs you and wakes the model only then, so idle time is effectively free.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local

# Boot Claude Code and run the setup wizard
/claude-code-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

**One Claude subscription, multiple hermits** — each with its own memory, cost history, and routines.

---

## What you get

Markdown and Node on Claude Code's own primitives — no server, no proprietary runtime, the whole thing greppable. You already have these primitives; hermit is the wiring that makes them survive restarts, stay cheap while idle, and run unattended, plus a learning loop with no native equivalent. Everything is yours to shape: channels (Discord/Telegram), MCP servers, routines, watches, the heartbeat checklist, even its name and voice — ask it to change something, or edit the plain config and markdown yourself.

- **`/loop`** pays the model every tick. Hermit gates it behind a filesystem-only precheck — an idle **heartbeat** sweeps your checklist for **zero tokens**.
- **`CronCreate`** jobs expire in 7 days and fire in the machine's timezone. Hermit's **routines** self-rearm daily and run on your wall clock, registered and managed by `/hermit-routines`.
- **Monitor** streams die with the session. Hermit's **`/watch`** auto-starts from config (or plain language) and routes findings to your notifications. Silent when quiet.
- **Channels** let you DM a session. Hermit's agent **acts** on it — *"accept PROP-014"*, *"status"* — and **pings you first** when something needs a yes/no.
- **Auto-memory** just accumulates. Hermit **distills** `raw/` → `compiled/` and re-injects it within a context budget at session start.
- **Native Tasks** vanish at session end. Hermit snapshots them so the plan survives archives.
- **Deny patterns + sandbox** fail closed uniformly. Hermit **profile-gates** them — the unattended agent is locked down harder than the one you're watching.

**Sessions self-manage.** Daemons auto-archive at 12h idle and at midnight when you're away, so evidence reaches the learning loop without a manual close.

**It reaches you first.** Notifications default to a native push (headless-friendly), or a Discord/Telegram DM you can reply to if you've paired a channel.

**Cost scales with events, not time.** Nothing wakes the model until something happens, so an idle hermit is effectively free.

---

## It learns, you approve

A hermit watches what keeps going wrong across sessions, proposes a fix, and asks you yes or no. It won't propose the same thing twice.

At natural pauses — session end, idle ticks, scheduled cadence — it reflects. Most reflections never reach the model: a precheck script gates whether any phase (compute, resolution check, cost spike, digest, newborn) is actually due. When one is, two subagents vet the candidate before it reaches you:

- **`reflection-judge`** confirms the cited evidence actually exists in the session reports, so a proposal can't certify itself.
- **`proposal-triage`** deduplicates against open proposals, cross-checks your `MEMORY.md` and `OPERATOR.md`, and applies a three-condition bar.

Survivors land as a proposal you can act on from anywhere — including a DM:

```
/claude-code-hermit:proposal-list                  # see what it found
/claude-code-hermit:proposal-act accept PROP-003    # or just reply "accept PROP-003"
```

What it proposes: improvements, routines, new capabilities (skills, agents, heartbeat checks), guardrails (OPERATOR.md guidance you confirm), and bugs. You're the acceptance gate for every change. Raw session journals distill into compiled artifacts that reload next session — the [raw/compiled pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) Karpathy described for his wiki-LLM.

---

## Observable

Four on-demand skills, pullable from the Claude app, your terminal, or a DM:

- **`/hermit-brain`** — open loops, fragile zones, and key learnings from recent sessions
- **`/hermit-evolution`** — cost trends and how the hermit's behavior is shifting over time
- **`/hermit-health`** — alert state, channel availability, and heartbeat status
- **`/recall <query>`** — full-text search over session reports, compiled artifacts, and proposals ("what did I decide about X", "when did we last touch Y")

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.150+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+. Linux, macOS, and Windows via WSL2 — see [FAQ](docs/faq.md).

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
```

### 2. Initialize

```
claude /claude-code-hermit:hatch
```

The wizard sets up your agent's identity, scans your folder, generates `OPERATOR.md`, and offers Quick (4 questions) or Advanced (full wizard).

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). Want stronger isolation? Run [`/docker-security`](docs/docker-security.md) for opt-in LAN containment + DNS allowlist + resource bounds.

See [Always-On Setup](docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## Cost & local-first

You run on your own Claude subscription — no daily caps, no per-runtime-hour billing — and every token is logged where you can see it.

- **Per-call** token usage logged to `.claude/cost-log.jsonl` (model, input/output/cache split, USD estimate, and what triggered the turn — heartbeat, routine, or interactive).
- **Per-session** running total in `.status.json`; carried into archived session reports as frontmatter `cost_usd`.
- **Per-day** rollup in `cost-summary.md`, regenerated on every cost-tracker tick.
- **Morning brief** (when scheduled as a routine) reads `cost-summary.md` and includes yesterday's spend.

Because idle always-on cost is effectively zero, one Claude subscription can run several hermits at once.

---

## Pre-built Hermits

Domain plugins you stack on top of any hermit you've hatched.

- [**`dev-hermit`**](../claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](../claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, Python CLI.
- [**`fitness-hermit`**](../claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.

Many operators run several hermits in parallel — one per domain. Each one is a `/hatch` away. They share nothing but the protocol; their memory, cost history, and routines are independent, and a single Claude subscription covers them all. See [Creating Your Own Hermit](docs/creating-your-own-hermit.md).

---

## Documentation

- [Always-On Operations](docs/always-on-ops.md)
- [Always-On Setup](docs/always-on.md)
- [Architecture](docs/architecture.md)
- [Config Reference](docs/config-reference.md)
- [Creating Your Own Hermit](docs/creating-your-own-hermit.md)
- [Docker Security](docs/docker-security.md)
- [FAQ](docs/faq.md)
- [Getting Started](docs/how-to-use.md)
- [Plugin Hermit Storage](docs/plugin-hermit-storage.md)
- [Recommended Plugins](docs/recommended-plugins.md)
- [Security](docs/security.md)
- [Skills Reference](docs/skills.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Upgrading](docs/upgrading.md)

---

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Inspiration for autonomous agent ergonomics
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](../../LICENSE)
