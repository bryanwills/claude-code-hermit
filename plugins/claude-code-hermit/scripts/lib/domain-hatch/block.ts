// CLAUDE-APPEND block sync for domain hatches.
//
// Boundary detection, the closing-marker/`---` fallback, foreign-block fencing
// and the duplicate-marker refusal all come from evolve-plan.ts. Nothing here
// re-derives them: hermit-evolve and hatch write the same marked block, so a
// second parser would eventually disagree with the first about where a block
// ends and one of them would corrupt it.
//
// The write rule, unified across the five domain hatches:
//   marker absent            -> append the template
//   marker present           -> skip; version-driven refresh is hermit-evolve's
//   rendered input differs   -> replace (dev, whose block is rendered per mode
//                               from an input hermit-evolve cannot observe)
//   ambiguous                -> refuse, never append a third copy
//
// Before this, dev and HA also refreshed on a stale stamped version while
// fitness, feed and forge skipped — two owners for one block, with only one of
// them tracking evolve's bounds handling.

import fs from 'node:fs';
import path from 'node:path';
import { markerOnward, extractSiblingMarker, isAmbiguousBlock } from '../../evolve-plan';
import { writeFileAtomic } from '../md-write';

export type BlockAction = 'append' | 'replace' | 'skip' | 'ambiguous' | 'no-template' | 'no-marker';

export interface BlockPlan {
  action: BlockAction;
  marker: string | null;
  targetFile: string;
  /** The block currently in the target, when one was found. */
  old_block?: string;
  /** What would be written. */
  new_block?: string;
}

export function templatePath(installPath: string): string {
  return path.join(installPath, 'state-templates', 'CLAUDE-APPEND.md');
}

function read(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// Other registered plugin names, so a block can never swallow a sibling's when
// it has no closing marker.
export function planBlock(
  installPath: string,
  pluginName: string,
  targetPath: string,
  foreignNames: string[],
  rendered?: string,
): BlockPlan {
  const tmplText = rendered ?? read(templatePath(installPath));
  if (tmplText === null) {
    return { action: 'no-template', marker: null, targetFile: targetPath };
  }

  const marker = extractSiblingMarker(tmplText, pluginName);
  if (marker === null) {
    return { action: 'no-marker', marker: null, targetFile: targetPath };
  }

  const targetText = read(targetPath);
  if (targetText === null) {
    // Missing target file is the append case — the caller's Edit creates it.
    return { action: 'append', marker, targetFile: targetPath, new_block: tmplText };
  }

  const targetBlock = markerOnward(targetText, marker, foreignNames);
  if (targetBlock === null) {
    return { action: 'append', marker, targetFile: targetPath, new_block: tmplText };
  }

  if (isAmbiguousBlock(targetText, marker, targetBlock)) {
    return { action: 'ambiguous', marker, targetFile: targetPath, old_block: targetBlock };
  }

  // Only a caller that supplied rendered content can ask for a replace: a
  // static template that is already present is hermit-evolve's to refresh.
  if (rendered === undefined) {
    return { action: 'skip', marker, targetFile: targetPath, old_block: targetBlock };
  }

  const tmplBlock = markerOnward(tmplText, marker, foreignNames) ?? tmplText;
  if (norm(targetBlock) === norm(tmplBlock)) {
    return { action: 'skip', marker, targetFile: targetPath, old_block: targetBlock };
  }
  return { action: 'replace', marker, targetFile: targetPath, old_block: targetBlock, new_block: tmplBlock };
}

function norm(s: string): string {
  return s.replace(/\s+$/, '');
}

export interface BlockResult extends BlockPlan {
  ok: boolean;
  written: boolean;
  message?: string;
}

// Apply the plan. Refuses on ambiguity and on a missing template rather than
// guessing — both are states where a wrong write is worse than no write.
export function applyBlock(plan: BlockPlan): BlockResult {
  if (plan.action === 'ambiguous') {
    return { ...plan, ok: false, written: false, message: `marker ${plan.marker} appears more than once in ${plan.targetFile}; refusing to replace` };
  }
  if (plan.action === 'no-template') {
    return { ...plan, ok: false, written: false, message: 'plugin ships no state-templates/CLAUDE-APPEND.md' };
  }
  if (plan.action === 'no-marker') {
    return { ...plan, ok: false, written: false, message: 'template carries no opening marker for this plugin' };
  }
  if (plan.action === 'skip') {
    return { ...plan, ok: true, written: false };
  }

  const existing = read(plan.targetFile) ?? '';
  let next: string;
  if (plan.action === 'append') {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    next = existing + sep + plan.new_block;
  } else {
    next = existing.replace(plan.old_block!, plan.new_block!);
  }
  writeFileAtomic(plan.targetFile, next.endsWith('\n') ? next : next + '\n');
  return { ...plan, ok: true, written: true };
}
