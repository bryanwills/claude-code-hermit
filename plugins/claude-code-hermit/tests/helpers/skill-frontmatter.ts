// Frontmatter reads that lib/frontmatter.ts cannot do.
//
// Its key grammar is /^(\w[\w_]*)\s*:\s*(.*)/ — `\w` has no hyphen, so a
// hyphenated key like `disable-model-invocation` is silently skipped rather
// than returned false. Any check built on that parser would read every skill as
// unflagged and pass vacuously, so the match lives here instead and is shared by
// every test that needs it.

/** The YAML frontmatter block, or '' when the file has none. */
export function frontmatterBlock(body: string): string {
  if (!body.startsWith('---')) return '';
  const end = body.indexOf('\n---', 3);
  return end === -1 ? '' : body.slice(4, end);
}

/**
 * True when the skill carries `disable-model-invocation: true` in its
 * frontmatter. Scoped to the block on purpose: a whole-file substring scan would
 * also match a skill that merely mentions the flag in its prose.
 */
export function isModelInvocationDisabled(body: string): boolean {
  return /^disable-model-invocation:\s*true\s*$/m.test(frontmatterBlock(body));
}
