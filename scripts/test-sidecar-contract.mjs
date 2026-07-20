#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkScaffoldSync,
  checkSidecarUsage
} from './sidecar-contract-lib.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-sidecar-contract-'));
const canonical = path.join(root, 'examples', 'sidecar-scaffold');
const extensions = path.join(root, 'extensions');

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeEntry(id, sidecar) {
  const entryRoot = path.join(extensions, id);
  mkdirSync(entryRoot, { recursive: true });
  writeJson(path.join(entryRoot, 'extension.json'), {
    id,
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar
  });
  return entryRoot;
}

try {
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, 'sidecar_base.py'), '# canonical base\n', 'utf8');
  writeFileSync(path.join(canonical, 'sidecar.py'), '# canonical entrypoint\n', 'utf8');

  const externalRoot = writeEntry('external-sidecar', {
    type: 'loopback',
    origin: 'http://127.0.0.1:17787',
    health_path: '/health',
    proxy_auth: 'legacy',
    runtime: {
      kind: 'external',
      repository: 'https://github.com/example/external-sidecar'
    }
  });
  writeEntry('external-token-sidecar', {
    type: 'loopback',
    origin: 'http://127.0.0.1:17788',
    health_path: '/health',
    proxy_auth: 'token-v1',
    runtime: {
      kind: 'external',
      repository: 'https://github.com/example/node-sidecar'
    }
  });

  let result = checkScaffoldSync(root);
  assert.deepEqual(result.failures, [], 'external runtime must not be forced to vendor the Python scaffold');
  assert.equal(result.vendoredCount, 0);
  assert.equal(result.externalCount, 2);

  const rogueDir = path.join(externalRoot, 'nested', 'runtime');
  mkdirSync(rogueDir, { recursive: true });
  const roguePy = path.join(rogueDir, 'rogue.py');
  writeFileSync(roguePy, 'from http.server import ThreadingHTTPServer\nThreadingHTTPServer(("127.0.0.1", 1), object)\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/rogue.py')),
    'a rogue server anywhere under an extension entry must be discovered without sidecar_base.py');
  rmSync(roguePy);

  const rogueJs = path.join(rogueDir, 'rogue.mjs');
  writeFileSync(rogueJs, 'http.createServer(handler).listen(17787);\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/rogue.mjs')),
    'external runtimes must be scanned without assuming Python');
  rmSync(rogueJs);

  const aliasedNode = path.join(rogueDir, 'aliased.mjs');
  writeFileSync(aliasedNode,
    'import {\n  createServer as serve\n} from "node:http";\nserve(handler).listen(17787);\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/aliased.mjs')),
    'aliased Node server constructors must not escape the source scan');
  writeFileSync(aliasedNode,
    'import { Server } from "node:http";\nnew Server(handler).listen(17787);\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/aliased.mjs')),
    'named Node Server constructors must not escape the source scan');
  writeFileSync(aliasedNode,
    'import http, { createServer as serve } from "node:http";\nserve(handler).listen(17787);\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/aliased.mjs')),
    'mixed Node server imports must not escape the source scan');
  rmSync(aliasedNode);

  const aliasedPython = path.join(rogueDir, 'aliased.py');
  writeFileSync(aliasedPython,
    'from http.server import (\n    ThreadingHTTPServer as S,\n)\nS(("127.0.0.1", 17787), object)\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/aliased.py')),
    'aliased Python server constructors must not escape the source scan');
  rmSync(aliasedPython);

  const rogueGo = path.join(rogueDir, 'rogue.go');
  writeFileSync(rogueGo,
    'package main\nimport "net/http"\nfunc main() { server := &http.Server{}; server.ListenAndServe() }\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('nested/runtime/rogue.go')),
    'standard Go http.Server method forms must not escape the source scan');
  rmSync(rogueGo);
  assert.deepEqual(checkSidecarUsage(root).failures, []);

  const hiddenRoot = path.join(extensions, 'hidden-sidecar');
  mkdirSync(path.join(hiddenRoot, 'sidecar'), { recursive: true });
  writeJson(path.join(hiddenRoot, 'extension.json'), {
    id: 'hidden-sidecar',
    capabilities: ['manifest-bundle'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17789', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    }
  });
  writeFileSync(path.join(hiddenRoot, 'sidecar', 'sidecar_base.py'),
    'from http.server import ThreadingHTTPServer\nThreadingHTTPServer(("127.0.0.1", 1), object)\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('hidden-sidecar/sidecar/sidecar_base.py')),
    'runtime metadata without the loopback-sidecar capability must not gain a scanner exemption');
  rmSync(hiddenRoot, { recursive: true, force: true });

  const vendoredRoot = writeEntry('vendored-sidecar', {
    type: 'loopback',
    origin: 'http://127.0.0.1:17790',
    health_path: '/health',
    proxy_auth: 'token-v1',
    runtime: {
      kind: 'vendored',
      path: 'sidecar'
    }
  });
  const sidecarDir = path.join(vendoredRoot, 'sidecar');
  mkdirSync(sidecarDir, { recursive: true });

  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.includes('sidecar_base.py')));
  assert(result.failures.some((failure) => failure.includes('sidecar.py')));
  assert(result.failures.some((failure) => failure.includes('sidecar.json')));
  assert(result.failures.some((failure) => failure.includes('routes_impl.py')));

  writeFileSync(path.join(sidecarDir, 'sidecar_base.py'), '# canonical base\n', 'utf8');
  writeFileSync(path.join(sidecarDir, 'sidecar.py'), '# canonical entrypoint\n', 'utf8');
  const routesImpl = path.join(sidecarDir, 'routes_impl.py');
  mkdirSync(routesImpl);
  writeFileSync(path.join(routesImpl, 'placeholder.txt'), 'not a Python module\n', 'utf8');
  writeJson(path.join(sidecarDir, 'sidecar.json'), {
    id: 'vendored-sidecar',
    port: 17790,
    proxy_auth: 'token-v1'
  });

  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.includes('routes_impl.py must be a regular file')),
    'a directory must not satisfy the required routes_impl.py contract');
  rmSync(routesImpl, { recursive: true, force: true });
  for (const invalidRoutes of [
    '# no route hook\n',
    'DOC = """\ndef register(app):\n    pass\n"""\n',
    'if False:\n    def register(app):\n        pass\n',
    'async def register(app):\n    pass\n',
    'def register(app):\n    pass\n',
    'def register(app):\n    ...\n',
    'def register(app):\n    """placeholder"""\n',
    'def register(app, required):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\n',
    'def register(app):\n    app.route("GET", "/test")\n',
    'def register(app):\n    False and app.route("GET", "/test")\n',
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\nregister = None\n',
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\nregister, other = None, None\n',
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\nfrom replacement import register\n',
    'def register(app):\n    @app.route("GET", "/one")\n    def one(req):\n        return app.json({"ok": True})\ndef register(app):\n    @app.route("GET", "/two")\n    def two(req):\n        return app.json({"ok": True})\n',
    'raise RuntimeError("unreachable")\ndef register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\n',
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\nraise RuntimeError("module import fails")\n',
    'def register(app):\n    if True:\n        return\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\n'
  ]) {
    writeFileSync(routesImpl, invalidRoutes, 'utf8');
    result = checkScaffoldSync(root);
    assert(result.failures.some((failure) => failure.includes('must define top-level synchronous register(app)')),
      'routes_impl.py must provide a usable top-level synchronous register hook');
  }
  writeFileSync(routesImpl,
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\n',
    'utf8');

  result = checkScaffoldSync(root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.vendoredCount, 1);
  assert.equal(result.externalCount, 2);

  writeFileSync(routesImpl,
    'def handler(req):\n    return {"ok": True}\ndef register(app):\n    app.route("GET", "/test")(handler)\n',
    'utf8');
  assert.deepEqual(checkScaffoldSync(root).failures, [],
    'an equivalent direct decorator application must register a route');
  writeFileSync(routesImpl,
    'def register(app):\n    @app.route("GET", "/test")\n    def test(req):\n        return app.json({"ok": True})\n',
    'utf8');

  for (const collision of ['sidecar_base', 'routes_impl.cpython-312-x86_64-linux-gnu.so', 'sidecar_base.pyc']) {
    const collisionPath = path.join(sidecarDir, collision);
    if (collision === 'sidecar_base') {
      mkdirSync(collisionPath);
      writeFileSync(path.join(collisionPath, '__init__.py'), '# import shadow\n', 'utf8');
    } else {
      writeFileSync(collisionPath, 'compiled import shadow\n', 'utf8');
    }
    result = checkScaffoldSync(root);
    assert(result.failures.some((failure) => failure.includes('shadows a canonical Python module')),
      `package/compiled collision must not shadow the byte-compared scaffold: ${collision}`);
    rmSync(collisionPath, { recursive: true, force: true });
  }

  const vendoredMetadataPath = path.join(vendoredRoot, 'extension.json');
  const vendoredMetadata = JSON.parse(readFileSync(vendoredMetadataPath, 'utf8'));
  const linkedRuntime = path.join(vendoredRoot, 'linked-sidecar');
  symlinkSync(sidecarDir, linkedRuntime, 'dir');
  vendoredMetadata.sidecar.runtime.path = 'linked-sidecar';
  writeJson(vendoredMetadataPath, vendoredMetadata);
  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.includes('runtime path must not contain symlinks')),
    'vendored runtime directories must be real artifact-contained directories');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.includes('runtime path must not contain symlinks')),
    'the standalone usage gate must reject symlinked vendored runtimes too');
  vendoredMetadata.sidecar.runtime.path = 'sidecar';
  writeJson(vendoredMetadataPath, vendoredMetadata);
  rmSync(linkedRuntime);
  vendoredMetadata.sidecar.health_path = '/ready';
  writeJson(vendoredMetadataPath, vendoredMetadata);
  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.includes('health_path must be /health')));
  vendoredMetadata.sidecar.health_path = '/health';
  writeJson(vendoredMetadataPath, vendoredMetadata);

  writeJson(path.join(sidecarDir, 'sidecar.json'), {
    id: 'vendored-sidecar',
    port: 17790,
    proxy_auth: 'legacy'
  });
  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.includes('proxy_auth must match extension.json')));

  writeJson(path.join(sidecarDir, 'sidecar.json'), {
    id: 'vendored-sidecar',
    port: 17790,
    proxy_auth: 'token-v1'
  });
  writeFileSync(path.join(sidecarDir, 'sidecar_base.py'), '# drifted base\n', 'utf8');
  result = checkScaffoldSync(root);
  assert(result.failures.some((failure) => failure.startsWith('DRIFT')));

  writeFileSync(path.join(sidecarDir, 'sidecar_base.py'), '# canonical base\n', 'utf8');
  writeFileSync(path.join(sidecarDir, 'sidecar_base.py'), '# harmless but noncanonical\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('DRIFT')),
    'the usage gate must not exempt a noncanonical sidecar_base.py by pathname alone');
  writeFileSync(path.join(sidecarDir, 'sidecar_base.py'), '# canonical base\n', 'utf8');

  const unitDir = path.join(vendoredRoot, 'packaging');
  const unitPath = path.join(unitDir, 'sidecar.service');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, '[Service]\nType=simple\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('MISSING ExecStart')),
    'vendored service units without ExecStart must fail even outside runtime.path');
  writeFileSync(unitPath, '[Service]\nExecStart=/usr/bin/python3 -S rogue.py sidecar.py\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'mentioning sidecar.py as an argument to another script must not pass');
  writeFileSync(unitPath, '[Service]\nExecStart=/usr/bin/python3 -S sidecar.py\n', 'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'a basename-only entrypoint without canonical WorkingDirectory must not pass');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'systemd must not search PATH for a bare direct sidecar.py executable');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=%h/.hermes/webui/extensions/vendored-sidecar/sidecar/sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'direct shebang execution must not reintroduce unverified PATH and site startup');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S /tmp/other/sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'an unrelated absolute sidecar.py must not pass');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/env PATH=/tmp python3 -S sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'an env wrapper must not redirect the Python interpreter through attacker-controlled PATH');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/tmp/python3 -S sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'a Python-looking executable outside the canonical interpreter path must not pass');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S -mrogue sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'attached Python -m module execution must not masquerade as sidecar.py');
  for (const deceptiveFlags of [
    '-V sidecar.py',
    '-Bcprint(1) sidecar.py',
    '-- -u sidecar.py',
    '-- -- sidecar.py'
  ]) {
    writeFileSync(unitPath,
      `[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S ${deceptiveFlags}\n`,
      'utf8');
    result = checkSidecarUsage(root);
    assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
      `Python flags must not bypass the canonical entrypoint check: ${deceptiveFlags}`);
  }
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S sidecar.py ; /usr/bin/python3 -m http.server 17790\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'tokens after sidecar.py must not bypass complete entrypoint validation');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStartPre=/usr/bin/python3 -S /tmp/evil.py\nExecStart=/usr/bin/python3 -S -u sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('DISALLOWED ExecStartPre')),
    'auxiliary systemd Exec directives must not run outside the canonical entrypoint');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=/tmp/untrusted\nExecStart=/usr/bin/python3 -S sidecar.py\n[Unit]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'directives outside [Service] must not mask the working directory systemd executes');
  writeFileSync(unitPath,
    '[Service]\nworkingdirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'case-insensitive directive matching must not validate options systemd ignores');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nRootDirectory=/tmp/untrusted\nExecStart=/usr/bin/python3 -S sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('DISALLOWED RootDirectory')),
    'execution-context-changing service directives must fail closed');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nEnvironment=PATH=/tmp\nExecStart=/usr/bin/python3 -S sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('DISALLOWED Environment')),
    'service environment must not redirect interpreter or import resolution');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -u sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('BAD ExecStart')),
    'the canonical service must disable site startup with -S');
  writeFileSync(unitPath,
    '[Service]\nWorkingDirectory=%h/.hermes/webui/extensions/vendored-sidecar/sidecar\nExecStart=/usr/bin/python3 -S -u sidecar.py\n',
    'utf8');
  const containerPath = path.join(unitDir, 'sidecar.container');
  writeFileSync(containerPath,
    '[Container]\nWorkingDir=/opt/extensions/vendored-sidecar/sidecar\nExec=python3 sidecar.py\n',
    'utf8');
  result = checkSidecarUsage(root);
  assert(result.failures.some((failure) => failure.startsWith('UNSUPPORTED CONTAINER')),
    'vendored Python sidecars must not rely on an unverified container entrypoint');
  rmSync(containerPath);
  assert.deepEqual(checkSidecarUsage(root).failures, []);

  console.log('sidecar contract self-tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
