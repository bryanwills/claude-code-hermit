// Detached permission-mode cycler for a trusted /permission-mode command submitted by the
// Stop hook. Claude Code has no slash command that sets a permission mode — the only
// mid-session control is the relative Shift+Tab cycle — so reaching a specific mode means
// pressing it and reading the status bar until the session lands there.
//
// Detached for the same reason confirm-harness-switch.ts is: the pane cannot re-render
// while the Stop hook is still running, so every read here has to happen after it returns.

import { clearPendingCommand, writeSwitchVerify, readPendingCommand } from './lib/harness-command';
import { capturePane, paneModeLine, sendKey, tmuxSessionAlive } from './lib/tmux';

const [sessionName, target, hermitRoot] = process.argv.slice(2);
if (!sessionName || !target || !hermitRoot) {
  process.exit(2);
}

// One press per mode in the cycle, plus one to re-read after the last press. Bounded so a
// status bar this build renders differently cannot spin the pane forever.
const MAX_PRESSES = 6;
const SETTLE_MS = 250;

const pending = readPendingCommand(hermitRoot);
const by = pending?.by ?? 'channel';

/** Whether a keystroke has landed — and with it, whether the request is still retryable. */
let cleared = false;

/**
 * Leave the prompt path what it needs to report the outcome.
 *
 * `arg` is always the mode that was ASKED for, never the one the session ended up in:
 * harness-verify.ts re-reads the pane and compares it against this, so recording the
 * landed mode would compare that mode against itself and report every stuck switch as a
 * success. And nothing is recorded at all until a keystroke has actually landed — before
 * that the pending marker is still there for the next turn to retry, and announcing a
 * failure for a request that is about to be tried again would be wrong twice over.
 */
function finish(landed: string | null): never {
  if (cleared || landed === target) {
    writeSwitchVerify(hermitRoot, {
      command: '/permission-mode',
      arg: target,
      by,
      delivered_at: new Date().toISOString(),
    });
  }
  process.exit(landed === target ? 0 : 1);
}

for (let press = 0; press < MAX_PRESSES; press++) {
  const pane = capturePane(sessionName);
  if (pane === null) {
    if (!tmuxSessionAlive(sessionName)) finish(null);
    await Bun.sleep(SETTLE_MS);
    continue;
  }

  const current = paneModeLine(pane);
  // Unreadable mid-cycle means something is covering the status bar — a dialog, most
  // likely. Stop rather than press blind: the operator asked for a specific mode, and
  // guessing from here could land anywhere, including somewhere more permissive.
  if (!current) finish(null);
  if (current === target) finish(current);

  if (!sendKey(sessionName, 'BTab')) finish(current);

  // Only now is the request definitely being acted on. Clearing here rather than before
  // the first press is what makes a helper that dies early retryable: the marker survives
  // and the next Stop hook tries again.
  if (!cleared) {
    clearPendingCommand(hermitRoot);
    cleared = true;
  }

  await Bun.sleep(SETTLE_MS);
}

finish(paneModeLine(capturePane(sessionName) ?? '') ?? null);
