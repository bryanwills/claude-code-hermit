import { assertStateDir, pinStateDirOrExit } from './lib/cc-compat';
import { listTasks, mutateTask, taskStandup, TASK_ID, type TaskFlags } from './lib/tasks';

async function main(): Promise<void> {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  // The shared helper exits 1; this command's contract uses 2 for invalid args.
  if (!dirArg || !assertStateDir(dirArg)) throw new Error('invalid-state-dir');
  const dir = pinStateDirOrExit(dirArg, 'task');
  const allowed: Record<string, string[]> = {
    open: ['title', 'requester', 'done', 'requester-name', 'origin-message-id', 'due', 'conversation', 'card', 'owner', 'approver', 'dedupe-key', 'claim'],
    note: ['actor', 'due', 'card', 'decision', 'approval', 'done', 'clear-waiting'],
    block: ['waiting-on', 'result-stdin', 'status-line', 'next'],
    close: ['by', 'actor', 'result-rev', 'reason-stdin', 'claim'], cancel: ['actor', 'reason-stdin'],
    list: ['open', 'all', 'conversation', 'requester', 'handle', 'id', 'dedupe-key', 'json'], standup: ['json', 'days'],
  };
  if (!allowed[verb]) throw new Error('invalid-verb');
  const id = ['note', 'block', 'close', 'cancel'].includes(verb) ? args.shift() : undefined;
  if (['note', 'block', 'close', 'cancel'].includes(verb) && (!id || !TASK_ID.test(id))) throw new Error('invalid-id');
  const booleans = new Set(['decision', 'clear-waiting', 'result-stdin', 'reason-stdin', 'open', 'all', 'json']);
  const flags: TaskFlags = {};
  while (args.length) {
    const token = args.shift()!;
    const name = token.slice(2);
    if (!token.startsWith('--') || !allowed[verb].includes(name)) throw new Error('invalid-flag');
    if (booleans.has(name)) { flags[name] = true; continue; }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`missing-${name}`);
    if (name === 'claim') {
      flags.claim ??= [];
      (flags.claim as string[]).push(value);
    }
    else if (name in flags) throw new Error('duplicate-flag');
    else flags[name] = value;
  }
  if (flags.id && !TASK_ID.test(String(flags.id))) throw new Error('invalid-id');
  let result: unknown;
  if (verb === 'list') result = listTasks(dir, flags);
  else if (verb === 'standup') {
    const days = flags.days === undefined ? 7 : Number(flags.days);
    if (!Number.isFinite(days) || days <= 0) throw new Error('invalid-days');
    result = taskStandup(dir, days);
  } else {
    const input = verb === 'note' || flags['result-stdin'] || flags['reason-stdin'] ? await Bun.stdin.text() : '';
    result = mutateTask(dir, verb, id, flags, input);
  }
  console.log(JSON.stringify(result));
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 2; });
