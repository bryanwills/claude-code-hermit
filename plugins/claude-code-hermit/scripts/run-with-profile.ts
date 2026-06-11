// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/run-with-flags.js — MIT License
// Changes: Renamed env var from ECC_HOOK_PROFILE to AGENT_HOOK_PROFILE,
//          stripped ECC-specific disabled-hooks logic, kept core profile-gating pattern.

import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Profile-gated hook execution wrapper.
 *
 * Usage: bun run-with-profile.ts <requiredProfiles> <scriptPath>
 *
 * requiredProfiles: comma-separated list of profiles that enable this hook
 *                   e.g. "standard,strict" means the hook runs on standard OR strict
 *
 * AGENT_HOOK_PROFILE env var controls the active profile:
 *   - "minimal"  — cost tracking only
 *   - "standard" — cost tracking + compact suggestions + session evaluation (default)
 *   - "strict"   — all of standard + additional safety hooks from hermits
 */

const VALID_PROFILES = new Set(['minimal', 'standard', 'strict']);

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: bun run-with-profile.ts <requiredProfiles> <scriptPath>');
    process.exit(1);
  }

  const [requiredProfilesCsv, scriptPath] = args as [string, string];
  const requiredProfiles = new Set(requiredProfilesCsv.split(',').map(p => p.trim()));
  const activeProfile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();

  // Validate active profile
  if (!VALID_PROFILES.has(activeProfile)) {
    console.error(`Invalid AGENT_HOOK_PROFILE: "${activeProfile}". Valid: ${[...VALID_PROFILES].join(', ')}`);
    process.exit(0); // Don't block on invalid profile — just skip
  }

  // Check if active profile matches any required profile
  if (!requiredProfiles.has(activeProfile)) {
    // Profile doesn't match — exit silently
    process.exit(0);
  }

  // Profile matches — execute the target script
  // Prevent path traversal
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
  const resolved = path.resolve(pluginRoot, scriptPath);
  if (!resolved.startsWith(pluginRoot)) {
    console.error('Path traversal detected — blocking execution');
    process.exit(2);
  }

  // Pipe stdin through to the target script
  // process.execPath = whatever runtime is executing this hook (bun in production,
  // either runtime in tests) — never hardcode, or the inner script escapes the flip.
  const result = spawnSync(process.execPath, [resolved], {
    stdio: 'inherit',
    timeout: 30000,
    env: process.env,
  });

  process.exit(result.status !== null ? result.status : 1);
}

main();
