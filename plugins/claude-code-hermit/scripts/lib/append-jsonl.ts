// Shared validated-append primitive for JSONL event ledgers (proposal-metrics.jsonl,
// observations.jsonl, micro-proposals.json's metrics companion, etc). Every writer
// goes through here so the validate-then-append contract is defined once: the typed
// constructors in lib/observations.ts and lib/proposals/event.ts, and the gate and
// queue-micro verbs that build their own events.

import fs from 'node:fs';

/**
 * Validates `eventJson` is non-empty parseable JSON, then appends it (+ newline)
 * to `filePath`. Returns null on success, or an error message on failure (no write).
 * Error strings are surfaced verbatim as the `<reason>` in a caller's `ERROR|<reason>`.
 */
function appendJsonlLine(filePath: string, eventJson: string): string | null {
  if (!eventJson) return 'Error: event payload is empty';
  try {
    JSON.parse(eventJson);
  } catch (err: any) {
    return `Invalid JSON: ${err.message}`;
  }
  fs.appendFileSync(filePath, eventJson + '\n', 'utf-8');
  return null;
}

export { appendJsonlLine };
