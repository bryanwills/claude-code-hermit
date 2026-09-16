import { expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir } from './workdir';
import { runScript, PLUGIN_ROOT } from './run';

export function taskFixture() {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.claude-code-hermit');
  const put = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  put('config.json', {});
  put('state/runtime.json', {});
  const run = (verb: string, args: string[] = [], stdin = '') => runScript('task.ts', { cwd: wd.dir, env: { AGENT_DIR: dir }, args: [verb, dir, ...args], stdin });
  const ok = async (verb: string, args: string[] = [], stdin = '') => {
    const r = await run(verb, args, stdin);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout);
  };
  const open = (args: string[] = []) => ok('open', [...(args.includes('--title') ? [] : ['--title', 'Review result']), ...(args.includes('--requester') ? [] : ['--requester', 'discord:u1']), ...(args.includes('--done') ? [] : ['--done', 'Result verified']), ...args]);
  return { ...wd, dir, put, run, ok, open, text: (id: string) => fs.readFileSync(path.join(dir, 'tasks', `${id}.md`), 'utf8') };
}
export async function taskLib(): Promise<any> {
  const file = path.join(PLUGIN_ROOT, 'scripts/lib/tasks.ts');
  expect(fs.existsSync(file)).toBe(true);
  return import(file);
}
