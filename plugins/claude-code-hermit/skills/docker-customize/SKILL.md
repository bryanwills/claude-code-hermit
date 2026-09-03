---
name: docker-customize
description: Route a request to install a tool, binary, package, env var, persistent directory, or side service in the hermit Docker container to the first channel that can carry it. Apt packages go in the Dockerfile's project-package layer; boot-time shell work goes in docker-entrypoint.hermit-local.sh; compose and Dockerfile only when nothing else fits. Activates on messages like "install gog in the container", "add an apt package", "download a binary into the container", "set a container env var", "add a volume or port to compose".
---

# Docker Customize

Land a container change in the first channel that can carry it, in the order below. Files sit on the project bind mount, so this skill runs from inside the container or on the host. Rebuild and restart are host-only: name the command for the operator, do not run it from inside the container.

## 1. Apt package

The container runs as `USER claude` with `cap_drop: ALL` and `no-new-privileges`, so nothing installs a package at runtime. It has to be in the image.

Add it to the project-package layer of `Dockerfile.hermit`:

```dockerfile
# Project-specific packages
RUN apt-get update && apt-get install -y --no-install-recommends \
      <pkg> <pkg> && \
    rm -rf /var/lib/apt/lists/*
```

When that layer is absent, add it between the `gh` install layer and the `# Match host UID` comment. Then rebuild on the host: `.claude-code-hermit/bin/hermit-docker update`.

Two things to tell the operator. Editing `Dockerfile.hermit` marks it customized, so `hermit-evolve` keeps their version and stops applying upstream changes to that file: re-check it after an upgrade. And `docker.packages` in `config.json` is read only when the templates are rendered, so setting it installs nothing on its own.

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
