// Structural HA management over WebSocket — the supporting structure REST cannot
// reach: helpers, areas, entity/device registries. Wraps a WS command client and
// writes an audit report for each mutation (mirroring apply.ts's remove report).
//
// The safety gate (ha_safety_mode) is applied by the CLI *before* a connection is
// opened, so this module assumes the gate has already passed — it only validates
// inputs and executes. Read functions return WsReadResult; mutations return
// WsMutationResult. Validation problems (unknown helper type, bad JSON) come back
// as ok:false results; only transport/HA failures throw HomeAssistantError, which
// the CLI's per-command catch already handles.

import { currentSessionId, slugify, standardMetadata, writeMarkdownArtifact } from './artifacts';
import { HomeAssistantError } from './ha-api';

/** Minimal WS surface (HomeAssistantWsClient satisfies it; tests inject a fake). */
export interface WsCommandClient {
  command(type: string, payload?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export const HELPER_TYPES = [
  'input_boolean',
  'input_number',
  'input_text',
  'input_select',
  'input_datetime',
  'timer',
  'counter',
  'schedule',
] as const;
export type HelperType = (typeof HELPER_TYPES)[number];

export interface WsReadResult {
  ok: boolean;
  data: unknown;
  message: string;
}

export interface WsMutationResult {
  ok: boolean;
  data: unknown;
  message: string;
  reportPath: string | null;
}

function isHelperType(value: string): value is HelperType {
  return (HELPER_TYPES as readonly string[]).includes(value);
}

/**
 * Execute a (pre-gated) mutation and write its audit report. HA failures are
 * caught and reported (ok: false) so a report always lands, like removeConfig.
 */
async function runMutation(
  root: string,
  client: WsCommandClient,
  label: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<WsMutationResult> {
  let ok: boolean;
  let data: unknown = null;
  let message: string;
  try {
    data = await client.command(type, payload);
    ok = true;
    message = 'ok';
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    ok = false;
    message = exc.message;
  }

  const reportPath = writeMutationReport(root, label, type, payload, ok, message);
  return { ok, data, message, reportPath };
}

function writeMutationReport(
  root: string,
  label: string,
  type: string,
  payload: Record<string, unknown>,
  ok: boolean,
  message: string,
): string {
  const metadata = standardMetadata('ws-mutation', `WS Mutation Report — ${label}`, {
    session: currentSessionId(root),
    tags: ['ha-ws', `ha-${label}`],
    extra: { ws_type: type, payload, ok, message },
  });
  const body = [
    `# WS Mutation Report for \`${label}\``,
    '',
    `- ok: ${ok}`,
    `- ws_type: ${type}`,
    `- payload: ${JSON.stringify(payload)}`,
    '',
    `Message: ${message}`,
  ].join('\n');
  return writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    `audit-ha-ws-${slugify(label)}`,
    metadata,
    body,
    'audit-ha-ws-latest.md',
  );
}

// --- Helpers -------------------------------------------------------------

export async function listHelpers(client: WsCommandClient, type?: string): Promise<WsReadResult> {
  if (type !== undefined && !isHelperType(type)) {
    return { ok: false, data: null, message: unknownHelperType(type) };
  }
  const types = type ? [type as HelperType] : [...HELPER_TYPES];
  // Fan out concurrently — the WS client correlates responses by id, so all
  // list commands can be in flight at once (≈1×RTT instead of 8×).
  const results = await Promise.all(
    types.map((t) => client.command(`${t}/list`).then((r) => [t, r] as const)),
  );
  return { ok: true, data: Object.fromEntries(results), message: 'ok' };
}

export async function createHelper(
  root: string,
  client: WsCommandClient,
  type: string,
  json: string,
): Promise<WsMutationResult> {
  if (!isHelperType(type)) return invalidPayload(unknownHelperType(type));
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalidPayload('helper JSON must be a JSON object');
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return invalidPayload('helper JSON is not valid JSON');
  }
  return runMutation(root, client, `create-${type}`, `${type}/create`, payload);
}

export async function deleteHelper(
  root: string,
  client: WsCommandClient,
  type: string,
  id: string,
): Promise<WsMutationResult> {
  if (!isHelperType(type)) return invalidPayload(unknownHelperType(type));
  return runMutation(root, client, `delete-${type}`, `${type}/delete`, { [`${type}_id`]: id });
}

// --- Areas ---------------------------------------------------------------

export async function listAreas(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/area_registry/list'), message: 'ok' };
}

export async function createArea(
  root: string,
  client: WsCommandClient,
  name: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'create-area', 'config/area_registry/create', { name });
}

export async function deleteArea(
  root: string,
  client: WsCommandClient,
  areaId: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'delete-area', 'config/area_registry/delete', { area_id: areaId });
}

// --- Entity registry -----------------------------------------------------

export async function listEntities(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/entity_registry/list'), message: 'ok' };
}

/** Generic entity_registry/update: rename, set area, or enable/disable. */
export async function updateEntity(
  root: string,
  client: WsCommandClient,
  entityId: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, label, 'config/entity_registry/update', {
    entity_id: entityId,
    ...fields,
  });
}

// --- Device registry -----------------------------------------------------

export async function listDevices(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/device_registry/list'), message: 'ok' };
}

export async function updateDevice(
  root: string,
  client: WsCommandClient,
  deviceId: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, label, 'config/device_registry/update', {
    device_id: deviceId,
    ...fields,
  });
}

// --- shared error shapes -------------------------------------------------

function unknownHelperType(type: string): string {
  return `Unknown helper type '${type}'. Choose from: ${HELPER_TYPES.join(', ')}.`;
}

function invalidPayload(message: string): WsMutationResult {
  return { ok: false, data: null, message, reportPath: null };
}
