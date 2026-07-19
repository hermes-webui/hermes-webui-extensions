#!/usr/bin/env node
// Close the "vendored-but-unused" hole: byte-identity of sidecar_base.py proves
// the scaffold is INTACT, not that it is USED. An extension could carry a
// pristine scaffold and still stand up its own unguarded HTTP server next to it
// (CI green, port wide open — exactly the failure class this whole boundary
// exists to prevent). This lint fails the build when a sidecar extension:
//   (1) instantiates its own HTTP server outside the canonical scaffold, or
//   (2) ships a .service/.container unit whose ExecStart does not run sidecar.py.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ROOT = path.join(REPO, 'extensions');

// Any of these instantiated in a sidecar .py that ISN'T the canonical scaffold
// means a competing server / bypassed auth.
const SERVER_PATTERNS = [
  /\bThreadingHTTPServer\s*\(/,
  /\bHTTPServer\s*\(/,
  /\bmake_server\s*\(/,           // wsgiref
  /\bsocketserver\.\w*Server\s*\(/,
  /\bapp\.run\s*\(/,               // flask/bottle style
  /\buvicorn\.run\s*\(/,
];
// sidecar_base.py is the ONE place a server may be created.
const ALLOWED_SERVER_FILE = 'sidecar_base.py';

function walkPy(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkPy(p));
    else if (name.endsWith('.py')) out.push(p);
  }
  return out;
}

let failures = 0;
const sidecarDirs = existsSync(EXT_ROOT)
  ? readdirSync(EXT_ROOT)
      .map((id) => path.join(EXT_ROOT, id, 'sidecar'))
      .filter((d) => existsSync(path.join(d, 'sidecar_base.py')))
  : [];

for (const dir of sidecarDirs) {
  // (1) no rogue servers outside the scaffold
  for (const py of walkPy(dir)) {
    if (path.basename(py) === ALLOWED_SERVER_FILE) continue;
    const src = readFileSync(py, 'utf8');
    for (const pat of SERVER_PATTERNS) {
      if (pat.test(src)) {
        console.error(
          `ROGUE SERVER  ${path.relative(REPO, py)} matches ${pat} — sidecars must serve ` +
          `only through the canonical sidecar_base.py (its deny-by-default token guard).`
        );
        failures++;
      }
    }
  }
  // (2) every service/container unit must ExecStart the scaffold entrypoint
  for (const unit of walkPy(dir).length ? readdirSync(dir) : []) {
    if (!/\.(service|container)$/.test(unit)) continue;
    const src = readFileSync(path.join(dir, unit), 'utf8');
    const exec = (src.match(/ExecStart=.*/) || [''])[0];
    if (exec && !/sidecar\.py(\s|$)/.test(exec)) {
      console.error(
        `BAD ExecStart  ${path.relative(REPO, path.join(dir, unit))} — must run sidecar.py ` +
        `(the byte-compared canonical entrypoint), got: ${exec}`
      );
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} sidecar usage violation(s).`);
  process.exit(1);
}
console.log(`sidecar usage OK across ${sidecarDirs.length} sidecar extension(s).`);
