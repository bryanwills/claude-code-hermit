import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const skill = readFileSync(resolve(import.meta.dir, '../skills/ha-apply-change/SKILL.md'), 'utf8');

// This checks the executable runbook's ordering, not live model compliance.
// validate-apply writes to HA, so its numbered step must follow confirmation.
test('HA apply instructions check policy and obtain approval before the write', () => {
  const steps = skill.split(/(?=^\d+\. \*\*)/m).filter(step => /^\d+\. \*\*/.test(step));
  const policy = steps.findIndex(step => step.includes('ha policy-check'));
  const approval = steps.findIndex(step => step.includes('Obtain explicit approval'));
  const write = steps.findIndex(step => step.includes('ha validate-apply'));

  expect(policy).toBeGreaterThanOrEqual(0);
  expect(approval).toBeGreaterThan(policy);
  expect(write).toBeGreaterThan(approval);
  expect(steps[approval]!).toContain('Declined or unanswered: stop');
  expect(steps[approval]!).toContain('changed content or targets require a new confirmation');
});
