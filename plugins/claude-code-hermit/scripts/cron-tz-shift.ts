// Rewrite a 5-field cron expression from one IANA timezone to the machine's local timezone.
// Usage: bun cron-tz-shift.ts "<cron-expr>" "<from-tz>"
// Stdout: shifted cron (or original on unsupported/fail-open paths)
// Stderr: WARN: <reason>  (when passing through unchanged due to unsupported pattern)
// Exit 0 always except: malformed cron that fails validateCronSchedule, or unparseable HERMIT_CRON_TZ_SHIFT_NOW
//
// The shift logic itself lives in lib/cron-shift.ts; this file is its CLI.

import { validateCronSchedule } from './validate-config';
import { shiftCron, wallMinutes } from './lib/cron-shift';

function resolveMachineTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return null; }
}

function main() {
  const [,, cronExpr, fromTz] = process.argv;

  if (!cronExpr) {
    process.stderr.write('Usage: bun cron-tz-shift.ts "<cron-expr>" "<from-tz>"\n');
    process.exit(1);
  }

  let ref: Date;
  if (process.env.HERMIT_CRON_TZ_SHIFT_NOW) {
    ref = new Date(process.env.HERMIT_CRON_TZ_SHIFT_NOW);
    if (isNaN(ref.getTime())) {
      process.stderr.write(`Error: HERMIT_CRON_TZ_SHIFT_NOW is not a valid ISO 8601 date: "${process.env.HERMIT_CRON_TZ_SHIFT_NOW}"\n`);
      process.exit(1);
    }
  } else {
    ref = new Date();
  }

  const validErr = validateCronSchedule(cronExpr);
  if (validErr) {
    process.stderr.write(`Error: invalid cron expression: ${validErr}\n`);
    process.exit(1);
  }

  const machineTz = resolveMachineTz();
  if (!machineTz) {
    process.stdout.write(cronExpr + '\n');
    process.stderr.write('WARN: could not resolve machine timezone\n');
    return;
  }

  const { result, warn } = shiftCron(cronExpr, fromTz || '', machineTz, ref);
  process.stdout.write(result + '\n');
  if (warn) process.stderr.write(`WARN: ${warn}\n`);
}

if (import.meta.main) {
  main();
}
