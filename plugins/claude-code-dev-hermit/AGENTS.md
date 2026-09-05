# Dev Hermit

A language-agnostic development safety and workflow layer. The operator can use any implementation agent; this plugin's safety contract lives in its hooks and rendered project instructions.

- `state-templates/CLAUDE-APPEND.md` is the single source for standard and safety modes. `scripts/render-append.ts` strips mode annotations; safety mode must not acquire standard-only implementation or quality/test workflow requirements. Update both golden fixtures in `tests/fixtures/` deliberately when rendered behavior changes.
- Hatch sends the selected rendering to core's `domain-hatch sync-block --rendered-stdin`. Core evolve defers this mode-dependent block; re-running Dev hatch refreshes it. Do not have evolve copy the raw annotated template.
- `git-push-guard.ts` enforces only the strict `AGENT_HOOK_PROFILE`. Hatch defaults to strict and must never silently downgrade an existing strict installation. Keep the protected-branch and explicit-refspec distinctions in [Git safety](docs/GIT-SAFETY.md).
- `worktree-boundary-guard.ts` is independent of the profile and inert outside linked worktrees. Its live-state carve-out must not become a general escape into the main checkout.
- Session checks use core's `state/runtime.json`, not cosmetic status text in SHELL.md. Preserve the operator's own commit/test/PR sequence; the standard-mode workflow is a fallback.
- The complete test runner covers structural checks and `scripts/*.test.ts`, including renderer and hook tests. See [workflow](docs/WORKFLOW.md) for the end-to-end contract.
