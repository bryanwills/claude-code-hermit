// Pure predicate shared by lib/heartbeat/precheck.ts and its coherence test.
// Extracted so both reference one definition.
//
// Does a HEARTBEAT.md checklist item represent the default proposal-scan item?
// Matches the shipped default ("Review `proposals/` for any with `status:
// proposed` …"): it references proposals AND the `proposed` status it scans for.
// A custom item that merely mentions proposals without that status keyword falls
// through to the generic alert-based rule (unchanged, conservative).
//
// Residual (documented, not eliminated): a compound custom item that DOES contain
// both `proposals/` and `proposed` plus an unrelated clause is classified here and
// can reach 'clean' on an empty queue, skipping the unrelated clause's LLM eval.
// The robust fix is a structural marker in the template, but `hermit-evolve` does
// not migrate operator-edited HEARTBEAT.md, so prose-matching is retained to keep
// the optimization working for existing installs. The coherence test in
// heartbeat-default-scan.test.ts pins the shipped template against this predicate
// so a template reword can't silently reintroduce the wasted-dispatch bug.
export function isProposalScanItem(itemText: string): boolean {
  return /proposals?[\/\s]/i.test(itemText) && /\bproposed\b/i.test(itemText);
}

// Does a HEARTBEAT.md checklist item represent the default credential-expiry item?
// Matches the shipped default ("Read `state/doctor-report.json` → the
// `credential-expiry` check …"): it references doctor-report.json AND the
// credential-expiry check it reads. A custom item that merely mentions one
// without the other falls through to the generic alert-based rule (unchanged,
// conservative).
//
// Residual (documented, not eliminated): a compound custom item that DOES contain
// both `doctor-report.json` and `credential-expiry` plus an unrelated clause is
// classified here and can reach 'clean' on a healthy report, skipping the
// unrelated clause's LLM eval. Same residual as isProposalScanItem: prose-matching
// is retained because hermit-evolve does not migrate operator-edited HEARTBEAT.md.
export function isCredentialExpiryItem(itemText: string): boolean {
  return /doctor-report\.json/i.test(itemText) && /credential-expiry/i.test(itemText);
}

// Normalises a HEARTBEAT.md checklist item to its dedup key.
// Key format mirrors the eval reference's taxonomy: 'checklist:<first-8-chars-normalized>'.
// Shared by the precheck's item loop and the self-evaluation pass, which must agree
// on the key or an item's counters land under a name no alert ever uses.
export function normalizeItemKey(itemText: string): string | null {
  const text = itemText
    .replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return text ? `checklist:${text}` : null;
}

// A HEARTBEAT.md file's checklist item lines, trimmed. Shared for the same reason
// as the key normaliser: the precheck's item loop and the self-evaluation pass have
// to agree on what counts as an item, or an item accrues counters under a name no
// alert ever fires.
export function parseChecklistItems(content: string): string[] {
  return content.split('\n').map(l => l.trim()).filter(l => /^[-*+]\s/.test(l));
}
