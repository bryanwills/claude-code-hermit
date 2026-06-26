// Friendly-name -> entity_id resolution over the normalized snapshot's
// `entity_index`. Pure and dependency-free.
//
// The model handles verb / intent / parameter parsing and typo correction; this
// module does ONE thing: map a natural-language target phrase (e.g. "luz da
// sala") to a concrete entity_id (e.g. "light.luz_da_sala"), which the safety
// gate requires. "Never guess" is enforced by the tie-break in resolveEntity:
// an auto-match is returned only for an unambiguous superset/exact hit; anything
// weaker (partial overlap, or a tie at the top tier) returns candidates for the
// caller to disambiguate. No fuzzy / edit-distance matching by design.

// Portuguese articles/prepositions that carry no device-identifying signal.
// Kept deliberately small — every word here is a word that can't appear in a
// device name.
const PT_STOPWORDS = new Set(['a', 'o', 'as', 'os', 'da', 'do', 'de', 'na', 'no', 'e']);

/** Lowercase, strip accents (NFD + combining marks), split on non-alphanumerics,
 *  drop stopwords. Mirrors the `\p{L}\p{N}` class used by `slugify`. */
export function normalizePhrase(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !PT_STOPWORDS.has(t));
}

/** Score a query against a candidate name's tokens.
 *   3 = exact   (identical token sets)
 *   2 = superset (every query token present; name carries extra tokens)
 *   1 = partial (some but not all query tokens present)
 *   0 = no overlap */
function scoreWithSets(q: Set<string>, n: Set<string>): { score: number; present: number } {
  if (q.size === 0) return { score: 0, present: 0 };
  let present = 0;
  for (const t of q) if (n.has(t)) present += 1;
  if (present === 0) return { score: 0, present: 0 };
  const score = present < q.size ? 1 : q.size === n.size ? 3 : 2;
  return { score, present };
}

export function scoreEntity(queryTokens: string[], nameTokens: string[]): number {
  return scoreWithSets(new Set(queryTokens), new Set(nameTokens)).score;
}

export interface ResolveOptions {
  domain?: string | null;
  includeScripts?: boolean;
}

export interface Candidate {
  entity_id: string;
  friendly_name: string | null;
  state: string | null;
}

export type ResolveResult =
  | { match: string }
  | { candidates: Candidate[]; truncated?: boolean }
  | { none: true; reason?: string };

const CANDIDATE_CAP = 5;

/** Resolve a phrase to an entity_id against a snapshot `entity_index`. */
export function resolveEntity(
  index: Record<string, Record<string, unknown>>,
  phrase: string,
  opts: ResolveOptions = {},
): ResolveResult {
  const queryTokens = normalizePhrase(phrase);
  if (queryTokens.length === 0) return { none: true };

  const domain = opts.domain ?? null;
  // An explicit `--domain script` request implies the operator wants scripts —
  // otherwise the domain filter and the script guard contradict each other and
  // every query returns none.
  const includeScripts = (opts.includeScripts ?? false) || domain === 'script';

  const querySet = new Set(queryTokens);
  const scored: Array<Candidate & { score: number; present: number }> = [];
  for (const [entityId, state] of Object.entries(index)) {
    // Skip malformed snapshot entries instead of dereferencing a non-object.
    if (!state || typeof state !== 'object') continue;
    const entDomain = entityId.split('.', 1)[0]!;
    if (domain && entDomain !== domain) continue;
    if (!includeScripts && entDomain === 'script') continue;

    const attrs = (state['attributes'] ?? {}) as Record<string, unknown>;
    const friendly = typeof attrs['friendly_name'] === 'string' ? attrs['friendly_name'] : null;
    // Match on friendly_name; fall back to the object_id (underscores -> spaces)
    // so entities without a friendly_name are still addressable.
    const nameSource = friendly ?? entityId.slice(entDomain.length + 1).replace(/_/g, ' ');
    const nameSet = new Set(normalizePhrase(nameSource));
    // present (query tokens matched) is a finer rank signal than the coarse tier,
    // used to keep the strongest partial overlap from being truncated out.
    const { score, present } = scoreWithSets(querySet, nameSet);
    if (score > 0) {
      const st = state['state'];
      scored.push({
        entity_id: entityId,
        friendly_name: friendly,
        state: typeof st === 'string' ? st : null,
        score,
        present,
      });
    }
  }

  if (scored.length === 0) return { none: true };

  scored.sort(
    (a, b) => b.score - a.score || b.present - a.present || a.entity_id.localeCompare(b.entity_id),
  );
  const topScore = scored[0]!.score;
  const topHits = scored.filter((c) => c.score === topScore);
  // The top tier is superset-or-exact (every query token present); partial overlap
  // (score 1) never auto-matches.
  const isAutoTier = topScore >= 2;

  // Auto-match only when a single entity sits at that tier.
  if (isAutoTier && topHits.length === 1) {
    return { match: topHits[0]!.entity_id };
  }

  const pool = isAutoTier ? topHits : scored;
  const candidates: Candidate[] = pool
    .slice(0, CANDIDATE_CAP)
    .map(({ entity_id, friendly_name, state }) => ({ entity_id, friendly_name, state }));
  // Signal truncation so the caller can prompt the operator to narrow the phrase
  // instead of silently hiding the entity they meant.
  return pool.length > CANDIDATE_CAP ? { candidates, truncated: true } : { candidates };
}
