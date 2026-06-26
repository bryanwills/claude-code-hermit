// Pure verb → HA REST service resolver for `ha actuate`.
// Domain-driven: derives the HA service from the entity_id prefix and verb.
// Returns a ResolveServiceResult the CLI uses without an HA client.
// Mirrors resolve.ts: no imports, no side effects, unit-testable in isolation.

export interface ServiceCall {
  domain: string;
  service: string;
  /** Full service-call body (includes entity_id and any level key). */
  data: Record<string, unknown>;
}

export type ResolveServiceResult =
  | { ok: true; call: ServiceCall }
  | { ok: false; reason: string };

/**
 * Resolve entity_id + verb (+ optional level) to a concrete HA REST service call.
 * Verb→service mapping covers the ha-command-router Verb Lexicon:
 *   light, switch, fan: on/off/set
 *   cover:             open/close/set (position)
 *   lock:              lock/unlock
 * script.* always returns {ok:false} — scripts route to a proposal, not actuation.
 * Any other domain or unsupported verb returns {ok:false} with a descriptive reason.
 */
export function resolveService(
  entityId: string,
  verb: string,
  level?: number | null,
): ResolveServiceResult {
  const domain = entityId.split('.', 1)[0]!.toLowerCase();

  if (domain === 'script') {
    return { ok: false, reason: 'script entities route to a proposal, not actuation' };
  }

  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan': {
      if (verb === 'on') return simple(domain, 'turn_on', entityId);
      if (verb === 'off') return simple(domain, 'turn_off', entityId);
      if (verb === 'set' && domain === 'light') return levelSet(domain, 'turn_on', entityId, level, 'brightness_pct');
      if (verb === 'set' && domain === 'fan') return levelSet(domain, 'turn_on', entityId, level, 'percentage');
      break;
    }
    case 'cover': {
      if (verb === 'open') return simple(domain, 'open_cover', entityId);
      if (verb === 'close') return simple(domain, 'close_cover', entityId);
      if (verb === 'set') return levelSet(domain, 'set_cover_position', entityId, level, 'position');
      break;
    }
    case 'lock': {
      if (verb === 'lock') return simple(domain, 'lock', entityId);
      if (verb === 'unlock') return simple(domain, 'unlock', entityId);
      break;
    }
    default: {
      return { ok: false, reason: `unsupported domain '${domain}'` };
    }
  }

  return { ok: false, reason: `verb '${verb}' is not supported for domain '${domain}'` };
}

function simple(domain: string, service: string, entityId: string): ResolveServiceResult {
  return { ok: true, call: { domain, service, data: { entity_id: entityId } } };
}

function levelSet(
  domain: string,
  service: string,
  entityId: string,
  level: number | null | undefined,
  key: string,
): ResolveServiceResult {
  if (level == null) return { ok: false, reason: `verb 'set' requires --level for ${domain}` };
  return { ok: true, call: { domain, service, data: { entity_id: entityId, [key]: level } } };
}
