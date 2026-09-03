#!/usr/bin/env bun

// Structural lint for skills/hermit-scribe/SKILL.md + agents/issue-sanitizer.md —
// grep-level checks, no runtime skill execution. Regression coverage for #949:
// the sanitizer redacts `proposal={id}` as operator-project detail, which is
// exactly the anchor `file-issue.ts --check` matches on, so the footer must be
// appended after sanitization, never before it. Also pins the sanitizer's
// inline-only input contract, added so an off-contract dispatch (e.g. a file
// path instead of an inline draft) fails loud instead of fabricating.

import { readFileSync } from "node:fs";
import path from "node:path";

const SKILL = path.join(import.meta.dir, "..", "skills", "hermit-scribe", "SKILL.md");
const SANITIZER = path.join(import.meta.dir, "..", "agents", "issue-sanitizer.md");

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assertTrue(actual: boolean, label: string) {
  if (!actual) throw new Error(`${label}: expected true`);
}

function region(text: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = text.search(startPattern);
  if (start === -1) throw new Error(`region start not found: ${startPattern}`);
  const rest = text.slice(start);
  const endInRest = rest.search(endPattern);
  return endInRest === -1 ? rest : rest.slice(0, endInRest);
}

const skillText = readFileSync(SKILL, "utf8");
const sanitizerText = readFileSync(SANITIZER, "utf8");

const step1 = region(skillText, /^\*\*Step 1: resolve content\.\*\*/m, /^\*\*Step 1b:/m);
const step3 = region(skillText, /^\*\*Step 3: sanitize\.\*\*/m, /^\*\*Step 4: operator preview\.\*\*/m);
const filingFlow = region(skillText, /^## How to file$/m, /^## How to comment$/m);
const step4 = region(skillText, /^\*\*Step 4: operator preview\.\*\*/m, /^\*\*Step 5: write title and body to temp files\.\*\*/m);

test("footer is not constructed in Step 1 (would expose proposal={id} to the sanitizer)", () => {
  assertTrue(!step1.includes("Filed via hermit-scribe"), "Step 1 region carries no footer template");
});

test("footer is appended after sanitization in Step 3", () => {
  assertTrue(step3.includes("Filed via hermit-scribe"), "Step 3 region carries the footer template");
});

test("issue-sanitizer has an inline-only input contract with a refusal output", () => {
  assertTrue(sanitizerText.includes("TITLE: (refused)"), "refusal literal present");
});

// ── issue-template detection ────────────────────────────────────────────────
// Detection hits the GitHub API against the target repo (file-issue.ts
// --templates), not a local filesystem glob — the local repo isn't guaranteed
// to be the HERMIT_GH_REPO target. Guards against reverting to that heuristic.

test("issue-template detection calls file-issue.ts --templates, not a local glob", () => {
  assertTrue(filingFlow.includes('file-issue.ts" --templates'), "invokes the --templates script mode");
  assertTrue(!filingFlow.includes("Glob '.github"), "does not fall back to a local-filesystem glob of .github/");
});

test("operator preview surfaces detected issue templates", () => {
  assertTrue(/ISSUE_TEMPLATE/.test(step4), "preview instructions reference detected templates");
});

test("template filenames are excluded from the sanitizer's input channel", () => {
  assertTrue(
    filingFlow.includes("never passed to the Step 3 sanitizer"),
    "documents the bypass reasoning",
  );
});

// ── --check match predicate ─────────────────────────────────────────────────
// file-issue.ts:124 has no exported helper for this — it's an inline
// `body.includes("proposal=" + proposalId)`. Assert the predicate directly
// rather than adding an export just to satisfy this test.

function matchesProposal(body: string, proposalId: string): boolean {
  return body.includes(`proposal=${proposalId}`);
}

test("a body carrying the proposal anchor satisfies --check's match predicate", () => {
  assertTrue(
    matchesProposal("---\n*Filed via hermit-scribe · proposal=PROP-168-x*", "PROP-168-x"),
    "anchored body matches",
  );
});

test("a sanitizer-redacted body does not satisfy --check's match predicate", () => {
  assertTrue(
    !matchesProposal("---\n*Filed via hermit-scribe · proposal=<redacted>*", "PROP-168-x"),
    "redacted body does not match",
  );
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
