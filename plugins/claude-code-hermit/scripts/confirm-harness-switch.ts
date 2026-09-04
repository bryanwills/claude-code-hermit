// Detached verifier for a trusted /model or /effort command submitted by the Stop hook.
// Claude processes that command only after the hook returns, so confirmation cannot be
// observed synchronously inside stop-pipeline.ts.

import { HARNESS_CONFIRM_TIMEOUT_MS, isHarnessSwitchConfirmation } from './lib/harness-command';
import { capturePane, sendEnter, tmuxSessionAlive } from './lib/tmux';

const [sessionName, command] = process.argv.slice(2);
if (!sessionName || (command !== '/model' && command !== '/effort')) {
  process.exit(2);
}

const configuredTimeout = Number(process.env.HERMIT_HARNESS_CONFIRM_TIMEOUT_MS);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 250
  ? Math.min(configuredTimeout, HARNESS_CONFIRM_TIMEOUT_MS)
  : HARNESS_CONFIRM_TIMEOUT_MS;
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  await Bun.sleep(100);
  const pane = capturePane(sessionName);
  if (pane === null) {
    if (!tmuxSessionAlive(sessionName)) process.exit(1);
    continue;
  }
  if (isHarnessSwitchConfirmation(command, pane)) {
    process.exit(sendEnter(sessionName) ? 0 : 1);
  }
}

// A zero-turn session or a switch back to the cached model applies inline with no dialog, so none within the ceiling is a normal outcome.
process.exit(0);
