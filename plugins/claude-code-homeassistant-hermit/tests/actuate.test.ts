// Unit tests for src/actuate.ts (resolveService) and CLI-level tests for
// `ha actuate` via main() in-process (no subprocess, no live HA).

import { afterEach, expect, test } from 'bun:test';

import { AppConfig } from '../src/config';
import { main } from '../src/cli';
import { resolveService } from '../src/actuate';
import { captureOutput, cleanupTmp, makeHaConfig, makeHaRoot } from './helpers';

afterEach(cleanupTmp);

// --- Unit: resolveService ---

test('resolveService: light on → turn_on', () => {
  const r = resolveService('light.living_room', 'on');
  expect(r.ok).toBe(true);
  if (r.ok)
    expect(r.call).toEqual({
      domain: 'light',
      service: 'turn_on',
      data: { entity_id: 'light.living_room' },
    });
});

test('resolveService: light off → turn_off', () => {
  const r = resolveService('light.living_room', 'off');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.call.service).toBe('turn_off');
});

test('resolveService: light set → turn_on with brightness_pct', () => {
  const r = resolveService('light.living_room', 'set', 75);
  expect(r.ok).toBe(true);
  if (r.ok)
    expect(r.call).toEqual({
      domain: 'light',
      service: 'turn_on',
      data: { entity_id: 'light.living_room', brightness_pct: 75 },
    });
});

test('resolveService: light set without level → error', () => {
  const r = resolveService('light.living_room', 'set');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('--level');
});

test('resolveService: switch on/off', () => {
  const on = resolveService('switch.coffee', 'on');
  const off = resolveService('switch.coffee', 'off');
  expect(on.ok).toBe(true);
  if (on.ok) expect(on.call.service).toBe('turn_on');
  expect(off.ok).toBe(true);
  if (off.ok) expect(off.call.service).toBe('turn_off');
});

test('resolveService: fan set → turn_on with percentage', () => {
  const r = resolveService('fan.bedroom', 'set', 50);
  expect(r.ok).toBe(true);
  if (r.ok)
    expect(r.call).toEqual({
      domain: 'fan',
      service: 'turn_on',
      data: { entity_id: 'fan.bedroom', percentage: 50 },
    });
});

test('resolveService: cover open → open_cover', () => {
  const r = resolveService('cover.garage_door', 'open');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.call.service).toBe('open_cover');
});

test('resolveService: cover close → close_cover', () => {
  const r = resolveService('cover.garage_door', 'close');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.call.service).toBe('close_cover');
});

test('resolveService: cover set → set_cover_position with position', () => {
  const r = resolveService('cover.garage_door', 'set', 50);
  expect(r.ok).toBe(true);
  if (r.ok)
    expect(r.call).toEqual({
      domain: 'cover',
      service: 'set_cover_position',
      data: { entity_id: 'cover.garage_door', position: 50 },
    });
});

test('resolveService: lock / unlock', () => {
  const lock = resolveService('lock.front_door', 'lock');
  const unlock = resolveService('lock.front_door', 'unlock');
  expect(lock.ok).toBe(true);
  if (lock.ok) expect(lock.call.service).toBe('lock');
  expect(unlock.ok).toBe(true);
  if (unlock.ok) expect(unlock.call.service).toBe('unlock');
});

test('resolveService: script → blocked (route to a proposal)', () => {
  const r = resolveService('script.bom_dia', 'on');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('proposal');
});

test('resolveService: unsupported domain → error', () => {
  const r = resolveService('climate.ac', 'on');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("unsupported domain 'climate'");
});

test('resolveService: unsupported verb for domain → error', () => {
  // "open" is for covers; light has no open verb
  const r = resolveService('light.living_room', 'open');
  expect(r.ok).toBe(false);
});

// --- CLI: ha actuate (in-process, no subprocess, no live HA) ---

type PostRecord = { path: string; body: unknown };

function runActuate(root: string, argv: string[]): { run: Promise<{ code: number; out: string }>; posts: PostRecord[] } {
  const cfg = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  const posts: PostRecord[] = [];
  const run = captureOutput(() =>
    main(argv, {
      loadConfig: () => cfg,
      createClient: async () => ({
        baseUrlSource: 'single',
        get: async () => ({}),
        post: async (path: string, payload?: unknown) => { posts.push({ path, body: payload }); return {}; },
        delete: async () => ({}),
        callService: async (domain: string, service: string, data: unknown) => {
          posts.push({ path: `/api/services/${domain}/${service}`, body: data });
          return {};
        },
        getStates: async () => [],
        getHistory: async () => ({}),
      }),
    }),
  );
  return { run, posts };
}

test('CLI actuate: allow → POST to correct service path', async () => {
  const root = makeHaRoot();
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'light.living_room', 'on']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'ok', entity_id: 'light.living_room', service: 'light.turn_on' });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe('/api/services/light/turn_on');
  expect(posts[0]!.body).toMatchObject({ entity_id: 'light.living_room' });
});

test('CLI actuate: cover set --level → set_cover_position with position', async () => {
  const root = makeHaRoot();
  // Use a non-security-keyworded cover so strict mode allows it.
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'cover.sala_blinds', 'set', '--level', '50']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'ok', service: 'cover.set_cover_position' });
  expect(posts[0]!.body).toMatchObject({ entity_id: 'cover.sala_blinds', position: 50 });
});

test('CLI actuate: strict + sensitive entity → blocked, no POST', async () => {
  const root = makeHaRoot(); // no config = strict mode
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'lock.front_door', 'lock']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'blocked', entity_id: 'lock.front_door' });
  expect(posts).toHaveLength(0);
});

test('CLI actuate: ask mode + sensitive (no --confirmed) → needs_confirmation, no POST', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'lock.front_door', 'lock']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'needs_confirmation', entity_id: 'lock.front_door', verb: 'lock' });
  expect(posts).toHaveLength(0);
});

test('CLI actuate: ask mode + sensitive with level (no --confirmed) → needs_confirmation carries level', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'cover.garage_door', 'set', '--level', '50']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'needs_confirmation', level: 50 });
  expect(posts).toHaveLength(0);
});

test('CLI actuate: ask mode + --confirmed → POST lock/unlock service', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'lock.front_door', 'unlock', '--confirmed']);
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'ok', entity_id: 'lock.front_door', service: 'lock.unlock' });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe('/api/services/lock/unlock');
});

test('CLI actuate: script → error (resolveService rejects scripts), no POST', async () => {
  const root = makeHaRoot();
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'script.bom_dia', 'on']);
  const { code, out } = await run;
  expect(code).toBe(2);
  expect(JSON.parse(out)).toMatchObject({ status: 'error' });
  expect(posts).toHaveLength(0);
});

test('CLI actuate: malformed entity_id → error, exit 2', async () => {
  const root = makeHaRoot();
  const { run, posts } = runActuate(root, ['ha', 'actuate', 'notanentity', 'on']);
  const { code, out } = await run;
  expect(code).toBe(2);
  expect(JSON.parse(out)).toMatchObject({ status: 'error' });
  expect(posts).toHaveLength(0);
});

test('CLI actuate: non-actuating paths (strict sensitive) never create a client', async () => {
  const root = makeHaRoot();
  let clientCreated = false;
  const cfg = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  const { code } = await captureOutput(() =>
    main(['ha', 'actuate', 'lock.front_door', 'lock'], {
      loadConfig: () => cfg,
      createClient: async () => {
        clientCreated = true;
        throw new Error('should not reach client');
      },
    }),
  );
  expect(code).toBe(0);
  expect(clientCreated).toBe(false);
});

test('CLI actuate: needs_confirmation path never creates a client', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  let clientCreated = false;
  const cfg = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  const { code } = await captureOutput(() =>
    main(['ha', 'actuate', 'lock.front_door', 'lock'], {
      loadConfig: () => cfg,
      createClient: async () => {
        clientCreated = true;
        throw new Error('should not reach client');
      },
    }),
  );
  expect(code).toBe(0);
  expect(clientCreated).toBe(false);
});

// --- CLI: ha actuate-area (in-process, no subprocess, no live HA) ---

function runActuateArea(
  root: string,
  argv: string[],
  templateEntities: string[],
): { run: Promise<{ code: number; out: string }>; serviceCalls: PostRecord[] } {
  const cfg = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  const serviceCalls: PostRecord[] = [];
  const run = captureOutput(() =>
    main(argv, {
      loadConfig: () => cfg,
      createClient: async () => ({
        baseUrlSource: 'single',
        get: async () => ({}),
        post: async (path: string, _payload?: unknown) => {
          if (path === '/api/template') return templateEntities;
          return {};
        },
        delete: async () => ({}),
        callService: async (domain: string, service: string, data: unknown) => {
          serviceCalls.push({ path: `/api/services/${domain}/${service}`, body: data });
          return {};
        },
        getStates: async () => [],
        getHistory: async () => ({}),
      }),
    }),
  );
  return { run, serviceCalls };
}

test('CLI actuate-area: empty area → error, exit 2', async () => {
  const root = makeHaRoot();
  const { run, serviceCalls } = runActuateArea(root, ['ha', 'actuate-area', 'Kitchen', 'on'], []);
  const { code, out } = await run;
  expect(code).toBe(2);
  expect(JSON.parse(out)).toMatchObject({ status: 'error', message: expect.stringContaining("no entities found") });
  expect(serviceCalls).toHaveLength(0);
});

test('CLI actuate-area: non-actuatable domains only → error, exit 2', async () => {
  const root = makeHaRoot();
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Kitchen', 'on'],
    ['sensor.kitchen_temp', 'input_boolean.mode'],
  );
  const { code, out } = await run;
  expect(code).toBe(2);
  expect(JSON.parse(out)).toMatchObject({ status: 'error', message: expect.stringContaining("no entities in area 'Kitchen' support verb 'on'") });
  expect(serviceCalls).toHaveLength(0);
});

test('CLI actuate-area: all-allowed → ok, all actuated', async () => {
  const root = makeHaRoot();
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Kitchen', 'on'],
    ['light.kitchen_main', 'switch.coffee'],
  );
  const { code, out } = await run;
  expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.status).toBe('ok');
  expect(result.actuated).toHaveLength(2);
  expect(result.blocked).toHaveLength(0);
  expect(serviceCalls).toHaveLength(2);
});

test('CLI actuate-area: non-actuatable domain filtered out, rest actuated', async () => {
  const root = makeHaRoot();
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Kitchen', 'on'],
    ['light.kitchen', 'sensor.kitchen_temp', 'binary_sensor.motion'],
  );
  const { code, out } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'ok', actuated: ['light.kitchen'], blocked: [] });
  expect(serviceCalls).toHaveLength(1);
});

test('CLI actuate-area: strict blocks sensitive, rest actuated (partial)', async () => {
  const root = makeHaRoot(); // no config = strict
  // cover.garage_door: keywords 'garage'+'door' → sensitive → blocked in strict
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Outdoors', 'close'],
    ['cover.living_room', 'cover.garage_door'],
  );
  const { code, out } = await run;
  expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.status).toBe('partial');
  expect(result.actuated).toContain('cover.living_room');
  expect(result.blocked).toContain('cover.garage_door');
  expect(serviceCalls).toHaveLength(1);
  expect(serviceCalls[0]!.path).toBe('/api/services/cover/close_cover');
});

test('CLI actuate-area: ask mode + sensitive → needs_confirmation, no service call', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Garage', 'close'],
    ['cover.garage_door', 'cover.living_room'],
  );
  const { code, out } = await run;
  expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.status).toBe('needs_confirmation');
  expect(result.sensitive).toContain('cover.garage_door');
  expect(result.actuatable).toContain('cover.living_room');
  expect(serviceCalls).toHaveLength(0);
});

test('CLI actuate-area: ask mode + --confirmed → actuates all including sensitive', async () => {
  const root = makeHaRoot();
  makeHaConfig('ask', root);
  const { run, serviceCalls } = runActuateArea(
    root,
    ['ha', 'actuate-area', 'Garage', 'close', '--confirmed'],
    ['cover.garage_door', 'cover.living_room'],
  );
  const { code, out } = await run;
  expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.status).toBe('ok');
  expect(result.actuated).toHaveLength(2);
  expect(serviceCalls).toHaveLength(2);
});
