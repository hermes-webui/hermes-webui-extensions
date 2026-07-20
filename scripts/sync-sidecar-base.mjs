#!/usr/bin/env node
// Enforce that every vendored copy of the canonical sidecar scaffold is
// byte-identical to the reference in examples/sidecar-scaffold/. A sidecar's
// trust boundary is only as good as the scaffold it runs, so drift is a build
// failure, not a warning.
//
//   node scripts/sync-sidecar-base.mjs --check   (CI: fail on any drift)
//   node scripts/sync-sidecar-base.mjs --write    (local: copy canonical -> all)
//
// Canonical files: sidecar_base.py and sidecar.py (the entrypoint). Targets are
// discovered from extension.json sidecar.runtime metadata, never from the files
// being enforced.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScaffoldSync } from './sidecar-contract-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--write') ? 'write' : 'check';
const result = checkScaffoldSync(REPO, { write: mode === 'write' });
for (const failure of result.failures) console.error(failure);

if (result.failures.length) {
  console.error(`\n${result.failures.length} sidecar scaffold/manifest violation(s).`);
  process.exit(1);
}

if (mode === 'write') console.log(`synced ${result.synced} protected scaffold file(s).`);
else console.log(
  `sidecar scaffold in sync across ${result.vendoredCount} vendored sidecar(s); `
  + `${result.externalCount} external runtime(s) require no Python scaffold.`
);
