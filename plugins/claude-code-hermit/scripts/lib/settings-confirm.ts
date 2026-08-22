// Confirmation-nonce bridge for the two execution-adjacent settings keys.
//
// The maintainer tier (lib/channel-auth.ts isMaintainerController) lets the
// operator's maintainer chat write the security tier of settings from wherever
// they are. `permission_mode` and `env` are the exception: a flip to
// bypassPermissions, or a free-form dict that reaches the session's
// environment, is arbitrary-code-execution-adjacent in a way escalation and
// docker.packages are not. For those two the chat's authority alone is not
// enough — the hermit posts a short token to the maintainer chat and the
// operator echoes it back in a second message.
//
// What that buys: a *passive* compromise of the maintainer chat (someone who
// can read it — a leaked export, an over-shared channel, a stale device) can no
// longer authorize execution. Only someone who can also *post* as an allowed
// sender in that chat can complete the round trip. It converts a read
// compromise into an active one, which is a materially higher bar and a noisy
// one — the operator sees the token they never asked for.
//
// What it does not buy: this inherits the gate's standing assumption that the
// transcript is truthful about turn provenance. The echo is matched against the
// harness-written envelope body of the turn's opening prompt, so the model
// cannot satisfy it by putting the token in its own tool call — but a writer
// who can forge transcript entries defeats the whole gate, nonce included.
// That boundary is documented in docs/security.md and is not narrowed here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './md-write';

/** A confirmation the operator has been asked for but has not yet echoed. */
export interface PendingConfirm {
  token: string;
  /** Dotted config path this token unlocks — a token is never target-portable. */
  target: string;
  sourceKey: string;
  chatId: string;
  userId: string | null;
  /** ms epoch. */
  created: number;
}

/** Long enough that guessing is hopeless, short enough to retype on a phone. */
const TOKEN_LENGTH = 6;
/** No 0/O/1/I/L — these get read aloud, retyped, and autocorrected. */
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

function confirmPath(dir: string): string {
  return path.join(dir, 'state', 'settings-confirm.json');
}

export function newToken(): string {
  const bytes = crypto.randomBytes(TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out;
}

/**
 * The live pending confirmation, or null when there is none — absent, malformed
 * and expired all collapse to "nothing is pending", so every failure of this
 * store denies rather than unlocking.
 */
export function readPending(dir: string, now: number = Date.now()): PendingConfirm | null {
  try {
    const rec = JSON.parse(fs.readFileSync(confirmPath(dir), 'utf8'));
    if (!rec || typeof rec.token !== 'string' || typeof rec.target !== 'string') return null;
    // Every field the consumer compares against the live envelope is checked
    // before the cast: a schema-drifted record with an `undefined` chatId would
    // otherwise reach an equality test written to expect a string.
    if (typeof rec.sourceKey !== 'string' || typeof rec.chatId !== 'string') return null;
    if (rec.userId !== null && typeof rec.userId !== 'string') return null;
    if (typeof rec.created !== 'number' || now - rec.created > CONFIRM_TTL_MS) return null;
    return rec as PendingConfirm;
  } catch {
    return null;
  }
}

/** Single pending confirmation at a time: a new ask supersedes an older one. */
export function writePending(dir: string, rec: PendingConfirm): void {
  const p = confirmPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(rec, null, 2) + '\n');
}

export function clearPending(dir: string): void {
  try {
    fs.unlinkSync(confirmPath(dir));
  } catch {
    // Already gone — consuming a token twice must not throw on the second pass.
  }
}

/**
 * Does this message body carry `token` as a standalone word?
 *
 * Bounded by word edges so a token can't be matched inside a longer string the
 * operator happened to paste, and case-insensitive because phone keyboards
 * capitalize. The body is the harness-written envelope text, never the model's
 * own tool command — see the header.
 *
 * The token is regex-escaped rather than trusted to TOKEN_ALPHABET: this reads
 * back a token from disk, and a corrupted record carrying `.*` would otherwise
 * compile into a match-anything pattern and void the confirmation entirely.
 */
export function bodyEchoesToken(body: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`, 'i').test(body);
}
