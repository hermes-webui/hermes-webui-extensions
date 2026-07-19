#!/usr/bin/env node
// Enforce that every vendored copy of the canonical sidecar scaffold is
// byte-identical to the reference in examples/sidecar-scaffold/. A sidecar's
// trust boundary is only as good as the scaffold it runs, so drift is a build
// failure, not a warning.
//
//   node scripts/sync-sidecar-base.mjs --check   (CI: fail on any drift)
//   node scripts/sync-sidecar-base.mjs --write    (local: copy canonical -> all)
//
// Canonical files: sidecar_base.py and sidecar.py (the entrypoint). A sidecar
// extension is any extensions/<id>/sidecar/ dir that contains sidecar_base.py.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANON_DIR = path.join(REPO, 'examples', 'sidecar-scaffold');
const CANON_FILES = ['sidecar_base.py', 'sidecar.py'];

function findSidecarDirs() {
  const extRoot = path.join(REPO, 'extensions');
  if (!existsSync(extRoot)) return [];
  const dirs = [];
  for (const id of readdirSync(extRoot)) {
    const sc = path.join(extRoot, id, 'sidecar');
    if (existsSync(path.join(sc, 'sidecar_base.py'))) dirs.push(sc);
  }
  return dirs;
}

const mode = process.argv.includes('--write') ? 'write' : 'check';
const canon = Object.fromEntries(
  CANON_FILES.map((f) => [f, readFileSync(path.join(CANON_DIR, f))])
);
const targets = findSidecarDirs();
let drift = 0;

for (const dir of targets) {
  for (const f of CANON_FILES) {
    const dest = path.join(dir, f);
    const rel = path.relative(REPO, dest);
    if (mode === 'write') {
      writeFileSync(dest, canon[f]);
      console.log(`synced ${rel}`);
      continue;
    }
    if (!existsSync(dest)) {
      console.error(`MISSING  ${rel} (vendored scaffold incomplete)`);
      drift++;
      continue;
    }
    if (!readFileSync(dest).equals(canon[f])) {
      console.error(`DRIFT    ${rel} (differs from canonical examples/sidecar-scaffold/${f})`);
      drift++;
    }
  }
}

if (mode === 'check') {
  if (drift) {
    console.error(`\n${drift} sidecar scaffold file(s) drifted. Run: node scripts/sync-sidecar-base.mjs --write`);
    process.exit(1);
  }
  console.log(`sidecar scaffold in sync across ${targets.length} sidecar extension(s).`);
}
