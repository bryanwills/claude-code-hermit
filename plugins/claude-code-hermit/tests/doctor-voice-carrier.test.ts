import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkVoiceCarrier } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-voice-carrier-');
afterAll(cleanup);

type Fixture = { voiceFile?: boolean; local?: any; project?: any };

function scenario({ voiceFile, local, project }: Fixture) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  if (voiceFile) {
    fs.mkdirSync(path.join(dir, '.claude', 'output-styles'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'output-styles', 'hermit-voice.md'),
      '---\nname: hermit-voice\n---\n',
    );
  }
  const writeSettings = (name: string, value: any) =>
    fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify(value, null, 2));

  if (local !== undefined) writeSettings('settings.local.json', local);
  if (project !== undefined) writeSettings('settings.json', project);

  return checkVoiceCarrier(resolvePaths(path.join(dir, '.claude-code-hermit'), PLUGIN_ROOT));
}

// The voice only reaches the system prompt when BOTH halves line up: the style
// file exists AND the winning outputStyle names it. Either half alone is a
// silent no-voice state, which is the whole reason this check exists — boot
// deliberately never reclaims the key, so nothing else would say so.
describe('doctor voice-carrier check', () => {
  test('a hermit that never adopted the voice is healthy, not nagged', () => {
    const r = scenario({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('no hermit voice file');
  });

  test('file plus matching key reports the voice as active', () => {
    const r = scenario({ voiceFile: true, local: { outputStyle: 'hermit-voice' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('voice active');
  });

  test("an operator's own style is reported as inactive voice, not as an error to fix", () => {
    const r = scenario({ voiceFile: true, local: { outputStyle: 'Concise' } });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Concise');
    expect(r.detail).toContain("or leave it if that's intended");
  });

  test('a voice file with no key at all is flagged', () => {
    const r = scenario({ voiceFile: true, local: {} });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('no outputStyle key');
  });

  test('a key pointing at a missing voice file is flagged', () => {
    const r = scenario({ local: { outputStyle: 'hermit-voice' } });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('missing');
  });

  // The case a target-file-only check would miss entirely: the hermit's own
  // committed settings say hermit-voice and look correct, while a /config pick
  // in local scope silently outranks them.
  test('a local-scope override beats the hermit key in committed settings', () => {
    const r = scenario({
      voiceFile: true,
      project: { outputStyle: 'hermit-voice' },
      local: { outputStyle: 'Explanatory' },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Explanatory');
    expect(r.detail).toContain('.claude/settings.local.json');
  });

  test('project scope still wins when local sets no style', () => {
    const r = scenario({
      voiceFile: true,
      project: { outputStyle: 'hermit-voice' },
      local: { env: { FOO: 'bar' } },
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('.claude/settings.json');
  });

  test('an unparseable settings file does not throw the check', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{ broken');

    const r = checkVoiceCarrier(resolvePaths(path.join(dir, '.claude-code-hermit'), PLUGIN_ROOT));
    expect(r.status).toBe('ok');
  });
});
