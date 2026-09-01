# External control surface (MCP stdio)

Read-mostly adapter so an orchestrator (OpenClaw, another hermit, a script) can
discover, observe, and wake hermits on this box without reading
`.claude-code-hermit/` internals. Those files stay internal. This MCP server is
the only supported integration point.

v1 is stable and additive-only: new tools or fields may appear; existing field
names, types, and semantics will not change meaning.

## Spawn

The server is consumer-spawned over stdio. It never listens on a port. Stdout
is JSON-RPC frames only; logs go to stderr. The process writes nothing under
any hermit root.

Inventory is explicit. There is no auto-discovery of hosts or of hermit folders
on disk. Pass every project root you want visible:

```bash
.claude-code-hermit/bin/hermit-run mcp-server --roots /path/to/project,/path/to/other
```

`--roots` wins over `HERMIT_MCP_ROOTS` (comma-separated). Each root is
canonicalized (`realpath`) and must contain `.claude-code-hermit/`. Duplicates
are rejected at startup. Tool `root` arguments must match an inventory entry;
arbitrary paths come back as a tool error (`isError: true` in the result), not
a protocol error.

### Local

```bash
.claude-code-hermit/bin/hermit-run mcp-server --roots /home/you/project
```

### OpenClaw

```bash
openclaw mcp set hermit '{"command":"/home/you/project/.claude-code-hermit/bin/hermit-run","args":["mcp-server","--roots","/home/you/project"]}'
```

### Cross-host

ssh does not forward `HERMIT_MCP_ROOTS`. Pass `--roots` on the remote command:

```bash
ssh box /home/you/project/.claude-code-hermit/bin/hermit-run mcp-server --roots /home/you/project
```

### Container

```bash
docker exec -i <container> .claude-code-hermit/bin/hermit-run mcp-server --roots /workspace
```

Use the path the process inside the container sees. Cross-host auth is out of
scope for v1; ssh keys are the boundary.

## Fleet split

One server is the per-box primitive. It reports only the roots it was given.
Aggregating many boxes, many hermits, or many hosts is the orchestrator's job.

## Handshake

Newline-delimited JSON-RPC 2.0 over stdin/stdout. `initialize` echoes the
client's `protocolVersion` when supported, otherwise JSON-RPC error `-32022`
with `data: {supported, requested}`. `capabilities` is `{tools:{}}`.
`serverInfo.version` is this plugin's `.claude-plugin/plugin.json` version.

## Tools

Every successful tool result carries `structuredContent` (the JSON object)
plus `content: [{type:"text", text}]` as a JSON-string mirror of the same
object. Tool-originated errors use `isError: true` inside the result.

### `list_hermits`

No arguments. Returns the configured inventory only.

| Field | Meaning |
| --- | --- |
| `hermits[].root` | Canonical project root |
| `hermits[].name` | `config.agent_name`, or `null` |
| `hermits[].runtime_mode` | From `runtime.json`; `unknown` when missing. No docker probe. |
| `hermits[].liveness_age_secs` | Age of the freshest shared liveness file, or `null` |
| `hermits[].paused` | Binding pause flag |

### `get_status`

Argument: `root`. Runtime digest distinguishes `missing` vs `invalid` vs `ok`.
`.status.json` fields are returned verbatim (including that file's `updated`
timestamp) or `null` when absent. `paused` and `liveness_age_secs` as in
`list_hermits`. `resident` is the validated registry entry for
`runtime.session_pid` looked up in the per-root stamped `runtime.config_dir`
(never the server's own default config dir); absent enrichment is `null`, not
an error.

### `get_health`

Argument: `root`. Two facets, no composite verdict.

**`availability.state`**

| Value | When |
| --- | --- |
| `alive` | Liveness fresher than 600s, or a validated resident registry entry |
| `reported_down` | `shutdown_completed_at` is set and liveness is stale. "Reported": the stamp has unverified writers. |
| `unknown` | Everything else |

Stale or missing liveness is never `down`. Fresh proves alive; stale proves
nothing. Evidencing timestamps travel with the facet
(`liveness_age_secs`, `liveness_fresh_secs`, `shutdown_completed_at`,
`resident`).

**`diagnostics`** is `state/doctor-report.json` as-is: `ts`, age, per-status
counts, failing check ids. `null` when the file is absent. The server does
not read `watchdog-events.jsonl`.

### `get_brief`

Argument: `root`. Current `.status.json` facts, then:

1. `state/last-brief.json` (`kind`, `text`, `generated_at`) when present
2. else the latest `sessions/S-NNN-REPORT.md` (numeric `S-NNN` order: S-9 <
   S-10, not lexicographic), frontmatter plus body summary

The text/summary is capped at **16 KiB** with UTF-8-safe truncation and a
`truncated` flag. Never reads `state-summary.md`.

### `get_version`

Argument: `root`.

| Field | Source |
| --- | --- |
| `loaded` | This process's `.claude-plugin/plugin.json` version |
| `applied` | The hermit's `config._hermit_versions["claude-code-hermit"]`, or `null` |
| `required_bun_version` | `.claude-plugin/hermit-meta.json` |
| `min_claude_code_version` | `.claude-plugin/hermit-meta.json` |
| `contract_version` | `1` |

### `wake`

Argument: `root`. No `source` parameter; the payload is always
`HEARTBEAT_EVALUATE` posted to `runtime.json`'s stamped `inbox_socket`.

If the hermit is paused: `{delivery:"suppressed", reason:"paused"}` and no
socket write. Pause exists to prevent paid turns; wake does not bypass it.

Otherwise the response is
`{write_status:"flushed"|"unreachable", delivery:"unconfirmed"}`.
`flushed` means bytes reached the socket (or the docker relay exited 0).
`delivery` is always `unconfirmed` here: the receiving session can still drop,
hold, or ignore the turn. Never treat `flushed` as "the model ran".

`delivery` is the discriminator between the two shapes, and it is the only
field present in both. `write_status` is absent when suppressed: never read
its absence as a failed write. Wake does not echo pause state as its own
field — read `paused` from `get_status` or `list_hermits`.

When `runtime_mode` is `docker` and this process is not inside the container,
wake relays with
`docker compose -f docker-compose.hermit.yml exec -T hermit .claude-code-hermit/bin/hermit-run mcp-server --wake-local`
from the project root. Relay spawn failure, timeout, or nonzero exit is
`unreachable`. The in-container `--wake-local` path posts locally and does
not recurse.

## Out of scope (v1)

`send_message`, pause/resume, config mutation, lifecycle ops, HTTP transport,
cross-host auth, automatic host discovery, fleet-wide aggregation.
