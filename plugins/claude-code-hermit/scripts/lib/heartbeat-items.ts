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
