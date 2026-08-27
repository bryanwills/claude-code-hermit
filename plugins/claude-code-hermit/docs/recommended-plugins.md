# Recommended Plugins

How Hermit handles third-party plugins. Hermit ships no standing recommendations — this page covers the mechanism for the plugins *you* choose to install alongside it.

> **Disclaimer:** Hermit does not vet, audit, or take responsibility for any plugin — including official ones. Plugins run with the same permissions as Hermit. Operators who use `bypassPermissions` for fully unattended Docker operation grant plugins full unrestricted execution. You are responsible for evaluating any plugin you install. Review the plugin's source, understand what it does, and only install plugins you trust.

Nothing is pre-shipped or pre-configured. During `/docker-setup`, you're asked whether to mirror each plugin already installed on the host into the container. Only plugins you explicitly opt into are added to your config and installed on container boot. You can manage them anytime with `/hermit-settings docker`.

**Hermit recommends no plugins by default.** Earlier versions offered a set of official Anthropic plugins at hatch (a codebase-automation recommender, a CLAUDE.md auditor, a skill builder, a feature-development scaffold). Claude Code now covers the same ground natively: the built-in `Plan`/`Explore` agents handle codebase research, auto-memory captures session learnings without touching CLAUDE.md, `/doctor` proposes CLAUDE.md trims once a file grows unwieldy, and the model authors a new skill directly from a procedure brief. Every installed plugin's skill descriptions are also paid on every API call an always-on hermit makes, so the bar for a standing recommendation is high. If you want one of the retired plugins anyway, install it yourself and register its skill with `/hermit-settings scheduled-checks` — the mechanism below is unchanged.

---

## Third-Party Plugins

The entrypoint installs every enabled entry in `docker.recommended_plugins`, regardless of marketplace. This includes domain hermits (e.g. `claude-code-homeassistant-hermit`) and any other third-party plugin.

The safety gate is at **configuration time**: entries only land in `docker.recommended_plugins` when the operator explicitly confirms the mirrored plugin list during `/docker-setup` or `/hermit-settings docker`. The host-installed list is the vetted set — the operator already installed these plugins on the host before triggering docker-setup.

> **Reminder:** Plugins run with the same permissions as Hermit. If you use `bypassPermissions` for fully unattended Docker operation, this means full unrestricted execution. Only add plugins you trust.

### Trust model

1. **Preselection safelist.** During `/docker-setup`, only plugins from `claude-plugins-official` or any `gtapps/*` marketplace (hermit's own org) are preselected. Third-party and unknown-source plugins are shown deselected — the operator must explicitly opt in. This prevents careless click-through from auto-installing arbitrary code.

2. **No re-confirmation on rebuild.** Once an entry is in `config.json`, the entrypoint installs it on every fresh volume without prompting again. If a marketplace repo is compromised between the original install and a later rebuild, the container will silently pull the updated version. Review `docker.recommended_plugins` periodically with `/hermit-settings docker`, and remove entries you no longer trust.

3. **`org/repo` validation.** Marketplace sources written to `config.json` must match `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$`. Typos or junk values are rejected before landing in config.

### Adding a plugin after initial setup

Use `/hermit-settings docker` to add a plugin to `docker.recommended_plugins`:

```bash
add superpowers obra/superpowers-marketplace
```

Then restart the container to install it:

```bash
.claude-code-hermit/bin/hermit-docker restart
```

---

## Config Format

Each entry in `docker.recommended_plugins`:

| Field | Type | Description |
|-------|------|-------------|
| `plugin` | string | Plugin name (left side of `@` in `claude plugin list` output) |
| `marketplace` | string | Marketplace `org/repo`, passed to `claude plugin marketplace add` (e.g. `"anthropics/claude-plugins-official"`, `"obra/superpowers-marketplace"`). Canonical marketplace name is resolved at boot from `claude plugin marketplace list --json`. |
| `scope` | string | `"project"` or `"local"` |
| `enabled` | boolean | Install on boot when `true` |

See [Config Reference](config-reference.md#recommended_plugins-entry-schema) for defaults.

---

## Scheduled Checks (Automatic Invocation)

Hatch no longer seeds `scheduled_checks` for you — `config.json` starts with an empty list. Register any installed plugin's skill yourself with `/hermit-settings scheduled-checks`, either interval-triggered (runs during idle reflection) or session-triggered (runs at task completion):

```
add <id> <plugin> <skill> interval [days]
add <id> <plugin> <skill> session
```

**Interval checks** run during idle reflection. If a check is due (past its `interval_days`), reflect invokes the skill, evaluates the output, and routes actionable findings through the proposal pipeline. One check per reflect cycle.

**Session checks** run at completed task boundaries (before idle transition). All enabled session checks invoke once per task completion.

**Interval tuning:** 3+ consecutive empty runs → propose increasing interval. 3+ actionable findings in a single run → propose decreasing. Always through PROP-NNN.

**Managing checks:** `/hermit-settings scheduled-checks` to view, enable/disable, change intervals, or add checks for any installed plugin's skills. All checks are optional — disable or remove any time.

---

## Managing Plugins

| Task | How |
|------|-----|
| Enable during Docker setup | `/docker-setup` wizard step 7b |
| Enable/disable after setup | `/hermit-settings docker` |
| Check what's installed | `docker exec <container> claude plugin list` |
| Force reinstall | Remove the cache dir and restart: `.claude-code-hermit/bin/hermit-docker restart` |
