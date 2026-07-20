#!/usr/bin/env node
// Close the "vendored-but-unused" hole: byte-identity of sidecar_base.py proves
// the scaffold is INTACT, not that it is USED. An extension could carry a
// pristine scaffold and still stand up its own unguarded HTTP server next to it
// (CI green, port wide open — exactly the failure class this whole boundary
// exists to prevent). This lint fails the build when a sidecar extension:
//   (1) instantiates its own HTTP server outside the canonical scaffold, or
//   (2) ships a .service unit whose ExecStart does not use the canonical pinned
//       interpreter + sidecar.py command, or a .container unit whose image
//       entrypoint cannot be proven by this lint.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSidecarUsage } from './sidecar-contract-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = checkSidecarUsage(REPO);
for (const failure of result.failures) console.error(failure);

if (result.failures.length) {
  console.error(`\n${result.failures.length} sidecar usage violation(s).`);
  process.exit(1);
}
console.log(`sidecar usage OK across ${result.scannedCount} extension entr${result.scannedCount === 1 ? 'y' : 'ies'}.`);
