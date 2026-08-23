// Pins bun to a target version in a deployed Dockerfile.hermit, converging the
// pre-1.2.0 npm install shape onto the canonical ARG + native-installer block.
//
// Usage: bun docker-bun-pin.ts <hermit-state-dir> <bun-version> <plugin-version>
//   (run from the project root — Dockerfile.hermit is resolved against CWD)
//
// Verdicts (stdout, one line, exit 0):
//   SKIP|absent                  no Dockerfile.hermit
//   OK|already-pinned            ARG BUN_VERSION already at target
//   OK|repinned <old>-><new>     ARG BUN_VERSION line moved to target
//   OK|converged                 legacy `npm install -g bun` replaced by the block
//   DEFER|unrecognized bun install shape   file untouched, caller defers
//
// Deploys exist on every template shape since v1.0.0, so the classification is
// the contract — a migration step that assumed one shape is what stranded most
// of the fleet on the 1.2.45 upgrade. Exit is non-zero only for caller error.
//
// The inserted block is READ from the shipped template, never inlined here:
// the template is the single source of truth for what a pinned bun install
// looks like, and a copy here would silently rot the next time it changes.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './lib/hash';
import { pinStateDirOrExit } from './lib/cc-compat';

const MANIFEST_KEY = 'docker/Dockerfile.hermit.template';
const TEMPLATE = path.resolve(
  import.meta.dir,
  '..',
  'state-templates',
  'docker',
  'Dockerfile.hermit.template',
);

function die(msg: string): never {
  console.error(`docker-bun-pin: ${msg}`);
  process.exit(1);
}

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const [stateDirArg, bunVersion, pluginVersion] = process.argv.slice(2);
if (!stateDirArg || !bunVersion || !pluginVersion) {
  die('usage: bun docker-bun-pin.ts <hermit-state-dir> <bun-version> <plugin-version>');
}
// Same pin as manifest-seed.ts: the state dir is not caller-chosen, and this
// script is reached through a wildcarded grant that covers every argument.
const stateDir = pinStateDirOrExit(stateDirArg, 'docker-bun-pin');

// The ENV/RUN half of the canonical install, lifted from the shipped template:
// everything from the `# Bun is the hermit runtime` comment through the
// installer RUN line. The ARG is emitted separately so the insert is
// self-contained wherever it lands.
function canonicalInstallBlock(): string {
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(TEMPLATE, 'utf8');
  } catch (err: any) {
    die(`cannot read the shipped Dockerfile template: ${err.message}`);
  }
  const lines = tmpl.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# Bun is the hermit runtime'));
  const end = lines.findIndex((l) => l.startsWith('RUN curl -fsSL https://bun.sh/install'));
  if (start === -1 || end === -1 || end < start) {
    die('shipped Dockerfile template no longer carries the bun install block — refusing to guess');
  }
  return lines.slice(start, end + 1).join('\n');
}

// Read and validate up front, so a corrupt manifest fails the run before the
// Dockerfile is touched. Absent manifest = docker-setup never ran; there is no
// baseline to keep, and one must not be invented.
function readManifest(): { path: string; data: any } | null {
  const manifestPath = path.join(stateDir, 'state', 'template-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  let existing: any;
  try {
    existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e: any) {
    die(`existing template-manifest.json is not valid JSON: ${e.message} — refusing to overwrite`);
  }
  if (!isPlainObject(existing) || !isPlainObject(existing.files)) {
    die('existing template-manifest.json: missing or invalid `files` object — refusing to overwrite');
  }
  return { path: manifestPath, data: existing };
}

// Re-records the pristine baseline so evolve-plan's drift classifier stops
// flagging Dockerfile.hermit.template. Only for a verdict that leaves the
// deployment matching the shipped template: recording it after a DEFER would
// clear the drift signal on a hermit whose bun was never pinned.
function writeBaseline(manifest: { path: string; data: any } | null): void {
  if (!manifest) return;
  manifest.data.files[MANIFEST_KEY] = {
    sha256: sha256(fs.readFileSync(TEMPLATE)),
    plugin_version: pluginVersion,
  };
  const tmp = manifest.path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest.data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifest.path);
}

function commit(dockerfile: string, contents: string, verdict: string): never {
  fs.writeFileSync(dockerfile, contents, 'utf8');
  writeBaseline(manifest);
  console.log(verdict);
  process.exit(0);
}

const dockerfile = path.resolve('Dockerfile.hermit');
if (!fs.existsSync(dockerfile)) {
  console.log('SKIP|absent');
  process.exit(0);
}

const original = fs.readFileSync(dockerfile, 'utf8');
const lines = original.split('\n');

// Validated before touching the Dockerfile: a caller-error exit must leave the
// deployed file exactly as it was.
const manifest = readManifest();

const argIdx = lines.findIndex((l) => /^ARG BUN_VERSION=/.test(l));
if (argIdx !== -1) {
  const current = lines[argIdx].slice('ARG BUN_VERSION='.length).trim();
  if (current === bunVersion) {
    writeBaseline(manifest);
    console.log('OK|already-pinned');
    process.exit(0);
  }
  lines[argIdx] = `ARG BUN_VERSION=${bunVersion}`;
  commit(dockerfile, lines.join('\n'), `OK|repinned ${current}->${bunVersion}`);
}

// Legacy shape: bun rides along in the npm globals line. Also matches a
// hand-applied `bun@1.4.0` pin, which converges rather than being re-nagged.
const npmIdx = lines.findIndex((l) => /^RUN npm install -g bun(@\S+)? /.test(l));
if (npmIdx !== -1) {
  lines[npmIdx] = lines[npmIdx].replace(/^(RUN npm install -g )bun(@\S+)? /, '$1');
  lines.splice(npmIdx + 1, 0, '', `ARG BUN_VERSION=${bunVersion}`, canonicalInstallBlock());
  commit(dockerfile, lines.join('\n'), 'OK|converged');
}

console.log('DEFER|unrecognized bun install shape');
process.exit(0);
