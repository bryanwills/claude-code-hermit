---
name: docker-customize
description: Route a request to install a tool, binary, package, env var, persistent directory, or side service in the hermit Docker container to the first channel that can carry it. Apt packages go through docker.packages; boot-time shell work goes in docker-entrypoint.hermit-local.sh; compose and Dockerfile only when nothing else fits. Activates on messages like "install gog in the container", "add an apt package", "download a binary into the container", "set a container env var", "add a volume or port to compose".
---

# Docker Customize

Land a container change in the first channel that can carry it, in the order below. Files sit on the project bind mount, so this skill runs from inside the container or on the host. Rebuild and restart are host-only: name `.claude-code-hermit/bin/hermit-docker update` (rebuild) or `.claude-code-hermit/bin/hermit-docker restart` (restart) for the operator; do not run either from inside the container.

## 1. Apt package

If the need is an Ubuntu apt package, invoke `/claude-code-hermit:hermit-settings docker` via the Skill tool. It owns `docker.packages`, and that list is the durable home: it survives every upgrade because it lives in `config.json`.

`docker.packages` reaches `Dockerfile.hermit` when the templates are rendered — at `/docker-setup`, and again at each `hermit-evolve`, which re-renders from the current config and merges the result. A rebuild on its own does not re-render, so `.claude-code-hermit/bin/hermit-docker update` right after the config edit builds the old package list.

If the operator needs the tool before the next evolve, do not hand-edit `Dockerfile.hermit` for it: record it in `docker.packages` and install it for this session through channel 2, which applies on a restart.

## 2. Boot-time shell

If a shell can do it at boot, put it in `<project-root>/docker-entrypoint.hermit-local.sh`. Persist files under `.claude.local/` (bind-mounted, gitignored). Upgrades never touch the sidecar.

The managed entrypoint sources the sidecar twice, with `HERMIT_ENTRY_PHASE` naming which:

- `pre-boot`: channel dirs exist, env resolved, before plugins install. Env, directories, downloads, `pip` / `npm -g`, pre-session checks.
- `pre-launch`: immediately before `hermit-start`. Side services, last-second overrides.

It inherits `set -euo pipefail`. Guard optional commands with `|| true`. Anchor every path to `${PROJECT_DIR}`, which the managed entrypoint exports: the sidecar is sourced into that shell, so a bare relative path lands in the wrong tree as soon as an earlier block has `cd`'d, and it cannot be replayed from a session with a different cwd. Create the file with `#!/usr/bin/env bash` if absent (it is sourced, so no `chmod +x`). Append; never overwrite existing content. Run `bash -n` on the file after writing it. Run the same commands once now so they take effect this session.

Applies on `.claude-code-hermit/bin/hermit-docker restart`. No rebuild.

Shape of an appended block:

```bash
# --- operator: <what> ---
if [ "$HERMIT_ENTRY_PHASE" = pre-boot ]; then
  mkdir -p "${PROJECT_DIR}/.claude.local/<name>"
  curl -fsSL <url> -o "${PROJECT_DIR}/.claude.local/<name>/<bin>" || true
  chmod +x "${PROJECT_DIR}/.claude.local/<name>/<bin>" || true
  export PATH="${PROJECT_DIR}/.claude.local/<name>:${PATH}"
fi
```

## 3. Compose or Dockerfile only

If only `docker-compose.hermit.yml` or `Dockerfile.hermit` can carry it (volumes, ports, capabilities, base image), edit as one contiguous block with a leading comment. Validate a compose edit with `docker compose -f docker-compose.hermit.yml config -q` before handing it back: the host wrapper refuses every `up` and `build` on a file that does not parse.

`hermit-evolve` reconciles the file against the baseline `docker-setup` recorded: with a baseline and an upstream move it merges 3-way and parks your previous copy at `.claude-code-hermit/state/<name>.<timestamp>.bak`; with no baseline, or with no upstream move, it leaves the file alone and writes no backup. Re-check the block after every evolve.
