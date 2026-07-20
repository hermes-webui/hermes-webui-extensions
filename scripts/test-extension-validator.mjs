#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildExtensionArtifact, buildRegistryWithArtifacts, validateAllEntries, validateEntry
} from './extension-registry-lib.mjs';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-extension-validator-'));
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mergeDeep(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function validationResult(scriptText, extensionOverrides = {}, runtimeOverrides = {}, setup = null) {
  const id = `validator-case-${Math.random().toString(36).slice(2, 8)}`;
  const root = path.join(tmpRoot, id);
  const asset = 'assets/adapter.js';
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Validator fixture\n', { encoding: 'utf8', flag: 'w' });
  writeFileSync(path.join(root, 'assets/adapter.js'), scriptText, { encoding: 'utf8', flag: 'w' });
  const extensionJson = mergeDeep({
    id,
    name: 'Validator Fixture',
    description: 'Temporary validator test fixture.',
    version: '0.0.1',
    author: 'test',
    assets: {
      scripts: [asset],
      stylesheets: []
    },
    capabilities: ['manifest-bundle'],
    lifecycle: {
      webui_restart_required: false,
      sidecar_start_required: false,
      native_host_start_required: false,
      native_host_autostart: 'none'
    },
    screenshots: [],
    permissions: {
      webui_api: {
        read: [],
        write: []
      },
      webui_navigation: false,
      dom: {
        owned: true,
        mutates_core_views: false
      },
      storage: {
        owned: [],
        shared_webui_keys: []
      },
      loopback_sidecar: false,
      native_host: false,
      filesystem: {
        arbitrary: false,
        serves_bundled_assets: true
      },
      network_external: false
    }
  }, extensionOverrides);
  const runtime = mergeDeep({
    id,
    name: 'Validator Fixture',
    scripts: [asset],
    stylesheets: [],
    ...(extensionJson.sidecar ? { sidecar: structuredClone(extensionJson.sidecar) } : {})
  }, runtimeOverrides);
  if (runtime.sidecar) delete runtime.sidecar.runtime;
  writeJson(path.join(root, 'manifest.json'), { extensions: [runtime] });
  writeJson(path.join(root, 'extension.json'), extensionJson);
  if (setup) setup({ id, root, extensionJson, runtime });
  return validateEntry({
    idFromDir: id,
    root,
    extensionJsonPath: path.join(root, 'extension.json')
  });
}

function validationErrors(scriptText, extensionOverrides = {}, runtimeOverrides = {}, setup = null) {
  return validationResult(scriptText, extensionOverrides, runtimeOverrides, setup).errors;
}

try {
  const linkedRootRepo = path.join(tmpRoot, 'linked-root-repo');
  const linkedRootTarget = path.join(tmpRoot, 'linked-root-target');
  mkdirSync(path.join(linkedRootRepo, 'extensions'), { recursive: true });
  mkdirSync(linkedRootTarget, { recursive: true });
  writeFileSync(path.join(linkedRootTarget, 'extension.json'), '{ deliberately invalid json', 'utf8');
  symlinkSync(linkedRootTarget, path.join(linkedRootRepo, 'extensions', 'linked-entry'), 'dir');
  const linkedRootResults = validateAllEntries({ repoRoot: linkedRootRepo }).results;
  assert.equal(linkedRootResults.length, 1,
    'discovery must report, not silently omit, a symlinked extension root');
  assert.deepEqual(linkedRootResults[0].errors,
    ['extension root must be a real directory, not a symlink']);

  const nullMetadataRepo = path.join(tmpRoot, 'null-metadata-repo');
  const nullMetadataRoot = path.join(nullMetadataRepo, 'extensions', 'null-entry');
  mkdirSync(nullMetadataRoot, { recursive: true });
  writeFileSync(path.join(nullMetadataRoot, 'extension.json'), 'null\n', 'utf8');
  const nullResults = validateAllEntries({ repoRoot: nullMetadataRepo }).results;
  assert.equal(nullResults.length, 1);
  assert.deepEqual(nullResults[0].errors, ['extension.json must contain a JSON object']);

  const danglingMetadataRepo = path.join(tmpRoot, 'dangling-metadata-repo');
  const danglingMetadataRoot = path.join(danglingMetadataRepo, 'extensions', 'dangling-entry');
  mkdirSync(danglingMetadataRoot, { recursive: true });
  symlinkSync('missing-extension.json', path.join(danglingMetadataRoot, 'extension.json'), 'file');
  const danglingResults = validateAllEntries({ repoRoot: danglingMetadataRepo }).results;
  assert.equal(danglingResults.length, 1,
    'discovery must not omit an extension whose metadata path is a dangling symlink');
  assert(danglingResults[0].errors.includes('extension.json must be a real regular file, not a symlink'));

  let errors = validationErrors("fetch('/api/sessions/123');\n");
  assert(errors.includes('permissions.webui_api.read must include sessions'));

  const linkedAssetTarget = path.join(tmpRoot, 'linked-asset-target.js');
  writeFileSync(linkedAssetTarget, 'this is deliberately invalid JavaScript {{\n', 'utf8');
  errors = validationErrors('', {}, {}, ({ root }) => {
    const asset = path.join(root, 'assets', 'adapter.js');
    rmSync(asset);
    symlinkSync(linkedAssetTarget, asset, 'file');
  });
  assert(errors.includes('extension tree must not contain symlinks: assets/adapter.js'),
    'validation must reject declared assets that artifact collection would omit');
  assert(!errors.some((error) => error.startsWith('JavaScript syntax check failed')),
    'validation must fail before reading or parsing a symlink target outside the extension tree');

  const unicodeAsset = 'assets/café.js';
  const unicodeResult = validationResult('', {
    assets: { scripts: [unicodeAsset], stylesheets: [] }
  }, {
    scripts: [unicodeAsset], stylesheets: []
  }, ({ root }) => {
    writeFileSync(path.join(root, unicodeAsset), 'console.log("unicode asset");\n', 'utf8');
  });
  assert.deepEqual(unicodeResult.errors, []);
  const unicodeArtifact = buildExtensionArtifact(unicodeResult);
  const unicodeZip = path.join(tmpRoot, 'unicode-artifact.zip');
  writeFileSync(unicodeZip, unicodeArtifact.buffer);
  const listed = spawnSync('python3', [
    '-c',
    'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist(), ensure_ascii=False))',
    unicodeZip
  ], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert(JSON.parse(listed.stdout).includes(`${unicodeResult.id}/${unicodeAsset}`),
    'ZIP artifacts must mark UTF-8 member names so consumers decode them losslessly');

  errors = validationErrors("fetch('/api/session/draft');\n");
  assert(errors.includes('permissions.webui_api.write must include session/draft'));
  assert(!errors.includes('permissions.webui_api.read must include session'));

  errors = validationErrors("fetch('/api/approval/pending-old');\n");
  assert(!errors.includes('permissions.webui_api.read must include approval/pending'));

  errors = validationErrors("fetch('/api/clarify/pending?session_id=123');\n");
  assert(errors.includes('permissions.webui_api.read must include clarify/pending'));

  errors = validationErrors("fetch('https://example.com/data');\n");
  assert(errors.includes('permissions.network_external is false but scripts appear to fetch an external origin'));

  errors = validationErrors("fetch('http://127.0.0.1:17787/health');\n");
  assert(!errors.includes('permissions.network_external is false but scripts appear to fetch an external origin'));

  errors = validationErrors("fetch('http://localhost/health');\n");
  assert(!errors.includes('permissions.network_external is false but scripts appear to fetch an external origin'));

  errors = validationErrors("fetch('http://[::1]:17787/health');\n");
  assert(!errors.includes('permissions.network_external is false but scripts appear to fetch an external origin'));

  errors = validationErrors('', {
    permissions: {
      storage: {
        owned: ['validator-case-settings'],
        shared_webui_keys: []
      }
    },
    settings_schema: [
      { key: 'enabled', type: 'boolean', label: 'Enabled', default: true }
    ]
  });
  assert(errors.includes('settings_schema requires permissions.storage.owned to be true'));

  errors = validationErrors('', {
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    }
  });
  assert(errors.includes('sidecar block requires the loopback-sidecar capability'));

  errors = validationErrors('', {}, {
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'legacy'
    }
  });
  assert(errors.includes('manifest sidecar block requires loopback-sidecar metadata in extension.json'));

  const externalLegacy = validationResult('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback',
      origin: 'http://127.0.0.1:17787',
      health_path: '/health',
      proxy_auth: 'legacy',
      runtime: {
        kind: 'external',
        repository: 'https://github.com/example/sidecar'
      }
    },
    lifecycle: { sidecar_start_required: true },
    permissions: { loopback_sidecar: true }
  });
  assert.deepEqual(externalLegacy.errors, []);
  assert(externalLegacy.warnings.includes('external sidecar runtime is explicitly legacy (proxy_auth: legacy)'));

  const externalToken = validationResult('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback',
      origin: 'http://127.0.0.1:17788',
      health_path: '/health',
      proxy_auth: 'token-v1',
      runtime: {
        kind: 'external',
        repository: 'https://github.com/example/node-sidecar'
      }
    },
    permissions: { loopback_sidecar: true }
  });
  assert.deepEqual(externalToken.errors, []);
  assert.deepEqual(externalToken.warnings, []);

  for (const origin of [
    'http://127.0.0.1:17788/admin',
    'http://127.0.0.1:17788?mode=debug',
    'http://user@127.0.0.1:17788',
    'http://2130706433:17788',
    'http://0x7f000001:17788',
    'http://%31%32%37.0.0.1:17788'
  ]) {
    errors = validationErrors('', {
      capabilities: ['manifest-bundle', 'loopback-sidecar'],
      sidecar: {
        type: 'loopback',
        origin,
        health_path: '/health',
        proxy_auth: 'legacy',
        runtime: { kind: 'external', repository: 'https://github.com/example/sidecar' }
      },
      lifecycle: { sidecar_start_required: true },
      permissions: { loopback_sidecar: true }
    });
    assert(
      errors.includes('sidecar.origin must be a loopback HTTP(S) origin without path, query, fragment, or userinfo'),
      `core-incompatible sidecar origin must fail validation: ${origin}`
    );
  }

  for (const healthPath of ['/health?token=abc', '/health%3Ftoken=abc', '//health', '/health/../admin']) {
    errors = validationErrors('', {
      capabilities: ['manifest-bundle', 'loopback-sidecar'],
      sidecar: {
        type: 'loopback',
        origin: 'http://127.0.0.1:17788',
        health_path: healthPath,
        proxy_auth: 'legacy',
        runtime: { kind: 'external', repository: 'https://github.com/example/sidecar' }
      },
      lifecycle: { sidecar_start_required: true },
      permissions: { loopback_sidecar: true }
    });
    assert(
      errors.includes('sidecar.health_path must be a safe absolute path without query or fragment'),
      `core-incompatible sidecar health path must fail validation: ${healthPath}`
    );
  }

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'token-vI',
      runtime: { kind: 'external', repository: 'https://github.com/example/sidecar' }
    },
    permissions: { loopback_sidecar: true }
  });
  assert(errors.includes('sidecar.proxy_auth must be legacy or token-v1'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'legacy'
    },
    permissions: { loopback_sidecar: true }
  });
  assert(errors.includes('sidecar.runtime is required when loopback-sidecar capability is declared'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'legacy', runtime: { kind: 'external' }
    },
    permissions: { loopback_sidecar: true }
  });
  assert(errors.includes('sidecar.runtime.repository is required for an external runtime'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored' }
    },
    permissions: { loopback_sidecar: true }
  });
  assert(errors.includes('sidecar.runtime.path is required for a vendored runtime'));

  const realRuntime = path.join(tmpRoot, 'real-vendored-runtime');
  mkdirSync(realRuntime);
  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17790', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    },
    permissions: { loopback_sidecar: true }
  }, {}, ({ root }) => symlinkSync(realRuntime, path.join(root, 'sidecar'), 'dir'));
  assert(errors.includes('extension tree must not contain symlinks: sidecar'));

  const externalRuntimeFile = path.join(tmpRoot, 'external-runtime-helper.py');
  writeFileSync(externalRuntimeFile, '# outside packaged runtime\n', 'utf8');
  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17790', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    },
    permissions: { loopback_sidecar: true }
  }, {}, ({ root }) => {
    const runtime = path.join(root, 'sidecar');
    mkdirSync(runtime);
    symlinkSync(externalRuntimeFile, path.join(runtime, 'linked-helper.py'), 'file');
  });
  assert(errors.includes('extension tree must not contain symlinks: sidecar/linked-helper.py'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'https://127.0.0.1:17790', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    }
  });
  assert(errors.includes('vendored sidecar.origin must use http://127.0.0.1 with an explicit port'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://localhost:17790', health_path: '/health',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    }
  });
  assert(errors.includes('vendored sidecar.origin must use http://127.0.0.1 with an explicit port'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17790', health_path: '/ready',
      proxy_auth: 'token-v1', runtime: { kind: 'vendored', path: 'sidecar' }
    }
  });
  assert(errors.includes('vendored sidecar.health_path must be /health'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'token-v1',
      runtime: { kind: 'external', repository: 'https://github.com/example/sidecar' }
    },
    permissions: { loopback_sidecar: true }
  }, {
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'legacy'
    }
  });
  assert(errors.includes('manifest sidecar.proxy_auth must match extension.json sidecar.proxy_auth'));

  errors = validationErrors('', {
    capabilities: ['manifest-bundle', 'loopback-sidecar'],
    sidecar: {
      type: 'loopback', origin: 'http://127.0.0.1:17787', health_path: '/health',
      proxy_auth: 'legacy',
      runtime: { kind: 'external', repository: 'https://github.com/example/sidecar' }
    },
    permissions: { loopback_sidecar: true }
  }, { sidecar: null });
  assert(errors.includes('manifest sidecar block is required when loopback-sidecar capability is declared'));

  const first = buildRegistryWithArtifacts({
    publishedAt: '2026-01-01T00:00:00.000Z',
    artifactBaseUrl: 'https://example.test/extensions/'
  });
  const second = buildRegistryWithArtifacts({
    publishedAt: '2026-01-01T00:00:00.000Z',
    artifactBaseUrl: 'https://example.test/extensions/'
  });
  assert(first.registry.extensions.length >= 1);
  assert.equal(first.artifacts.length, first.registry.extensions.length);
  assert.equal(second.artifacts.length, first.artifacts.length);
  for (const entry of first.registry.extensions) {
    const artifact = first.artifacts.find((item) => item.id === entry.id);
    const secondArtifact = second.artifacts.find((item) => item.id === entry.id);
    assert(artifact, `${entry.id} artifact is present`);
    assert(secondArtifact, `${entry.id} second artifact is present`);
    assert.equal(entry.download, `https://example.test/extensions/artifacts/${entry.id}-${entry.version}.zip`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(artifact.name, `${entry.id}-${entry.version}.zip`);
    assert.equal(artifact.sha256, entry.sha256);
    assert.equal(artifact.sha256, secondArtifact.sha256);
    assert(artifact.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
    assert(artifact.buffer.includes(Buffer.from(`${entry.id}/extension.json`)));
  }
  const desktopCompanion = first.registry.extensions.find((entry) => entry.id === 'desktop-companion');
  assert(desktopCompanion);
  assert.equal(desktopCompanion.post_install.requires_local_app, true);
  assert.match(desktopCompanion.post_install.summary, /npm run start:pet/);
  assert.equal(
    desktopCompanion.post_install.docs_url,
    'https://github.com/franksong2702/hermes-webui-desktop-companion#after-gallery-install'
  );
  const desktopArtifact = first.artifacts.find((item) => item.id === 'desktop-companion');
  assert(desktopArtifact.buffer.includes(Buffer.from('desktop-companion/assets/companion-adapter.js')));

  const mobileConversations = first.registry.extensions.find((entry) => entry.id === 'mobile-conversations');
  assert(mobileConversations);
  const mobileArtifact = first.artifacts.find((item) => item.id === 'mobile-conversations');
  assert(mobileArtifact.buffer.includes(Buffer.from('mobile-conversations/assets/mobile-conversations.js')));

  const invalidRepo = path.join(tmpRoot, 'empty-vendored-repo');
  const invalidEntryRoot = path.join(invalidRepo, 'extensions', 'broken-sidecar');
  const repoRoot = path.resolve(scriptsDir, '..');
  cpSync(
    path.join(repoRoot, 'examples', 'sidecar-scaffold'),
    path.join(invalidRepo, 'examples', 'sidecar-scaffold'),
    { recursive: true }
  );
  cpSync(
    path.join(repoRoot, 'extensions', 'assistant-avatar'),
    invalidEntryRoot,
    { recursive: true }
  );
  const invalidEntry = JSON.parse(readFileSync(path.join(invalidEntryRoot, 'extension.json'), 'utf8'));
  invalidEntry.id = 'broken-sidecar';
  invalidEntry.name = 'Broken Sidecar';
  invalidEntry.capabilities = [...new Set([...invalidEntry.capabilities, 'loopback-sidecar'])];
  invalidEntry.lifecycle.sidecar_start_required = true;
  invalidEntry.permissions.loopback_sidecar = true;
  invalidEntry.sidecar = {
    type: 'loopback',
    origin: 'http://127.0.0.1:17791',
    health_path: '/health',
    proxy_auth: 'token-v1',
    runtime: { kind: 'vendored', path: 'sidecar' }
  };
  writeJson(path.join(invalidEntryRoot, 'extension.json'), invalidEntry);
  const invalidManifest = JSON.parse(readFileSync(path.join(invalidEntryRoot, 'manifest.json'), 'utf8'));
  invalidManifest.extensions[0].id = invalidEntry.id;
  invalidManifest.extensions[0].name = invalidEntry.name;
  invalidManifest.extensions[0].sidecar = {
    type: invalidEntry.sidecar.type,
    origin: invalidEntry.sidecar.origin,
    health_path: invalidEntry.sidecar.health_path,
    proxy_auth: invalidEntry.sidecar.proxy_auth
  };
  writeJson(path.join(invalidEntryRoot, 'manifest.json'), invalidManifest);
  mkdirSync(path.join(invalidEntryRoot, 'sidecar'));
  assert.throws(
    () => buildRegistryWithArtifacts({
      repoRoot: invalidRepo,
      publishedAt: '2026-01-01T00:00:00.000Z'
    }),
    /vendored scaffold incomplete/,
    'registry generation must reject a declared vendored runtime without its scaffold'
  );

  const validateFromScripts = spawnSync(process.execPath, ['validate-extensions.mjs'], {
    cwd: scriptsDir,
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(validateFromScripts.status, 0, validateFromScripts.stderr || validateFromScripts.stdout);
  assert.match(validateFromScripts.stdout, /validated \d+ extension entr(?:y|ies)/);

  const safetyScanFromScripts = spawnSync(process.execPath, ['scan-extension-safety.mjs'], {
    cwd: scriptsDir,
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(safetyScanFromScripts.status, 0, safetyScanFromScripts.stderr || safetyScanFromScripts.stdout);
  assert.match(safetyScanFromScripts.stdout, /safety scan passed for \d+ extension entr(?:y|ies)/);

  // Regression: an entry that writes localStorage and declares storage.owned === true
  // (the boolean form core REQUIRES to enable settings_schema) must PASS the safety scan.
  // Before the fix the scan crashed with "boolean true is not iterable"; the key-array
  // form must still be accepted, and an undeclared write must still fail closed.
  const ownedTrueDir = path.join(repoRoot, 'extensions', 'scan-owned-true-case');
  try {
    mkdirSync(path.join(ownedTrueDir, 'assets'), { recursive: true });
    writeJson(path.join(ownedTrueDir, 'extension.json'), {
      id: 'scan-owned-true-case', name: 'Scan Case', description: 'temp test entry',
      version: '0.0.1', author: 'test',
      assets: { scripts: ['assets/x.js'], stylesheets: [] },
      capabilities: ['manifest-bundle'],
      lifecycle: { webui_restart_required: false, sidecar_start_required: false, native_host_start_required: false, native_host_autostart: 'none' },
      screenshots: [],
      permissions: {
        webui_api: { read: [], write: [] }, webui_navigation: false,
        dom: { owned: true, mutates_core_views: false },
        storage: { owned: true, shared_webui_keys: [] },   // boolean form — enables settings_schema
        loopback_sidecar: false, native_host: false,
        filesystem: { arbitrary: false, serves_bundled_assets: true },
        network_external: false
      },
      settings_schema: [{ key: 'enabled', type: 'boolean', label: 'Enabled', default: true }]
    });
    writeJson(path.join(ownedTrueDir, 'manifest.json'), {
      extensions: [{ id: 'scan-owned-true-case', name: 'Scan Case', description: 'temp test entry', scripts: ['assets/x.js'], stylesheets: [] }]
    });
    writeFileSync(path.join(ownedTrueDir, 'README.md'), '# Scan Case\n', 'utf8');
    writeFileSync(path.join(ownedTrueDir, 'assets', 'x.js'), "localStorage.setItem('k','v');\n", 'utf8');
    const scanOwnedTrue = spawnSync(process.execPath, ['scan-extension-safety.mjs'], {
      cwd: scriptsDir, encoding: 'utf8', timeout: 30000
    });
    assert.equal(scanOwnedTrue.status, 0,
      `storage.owned:true + localStorage write should pass the safety scan, got: ${scanOwnedTrue.stderr || scanOwnedTrue.stdout}`);
  } finally {
    rmSync(ownedTrueDir, { recursive: true, force: true });
  }

  function writeIframeClipboardCase({ id, readme }) {
    const dir = path.join(repoRoot, 'extensions', id);
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeJson(path.join(dir, 'extension.json'), {
      id, name: 'Scan Iframe Case', description: 'temp test entry',
      version: '0.0.1', author: 'test',
      assets: { scripts: ['assets/x.js'], stylesheets: [] },
      capabilities: ['manifest-bundle'],
      lifecycle: { webui_restart_required: false, sidecar_start_required: false, native_host_start_required: false, native_host_autostart: 'none' },
      screenshots: [],
      permissions: {
        webui_api: { read: [], write: [] }, webui_navigation: false,
        dom: { owned: true, mutates_core_views: false },
        storage: { owned: [], shared_webui_keys: [] },
        loopback_sidecar: true, native_host: false,
        filesystem: { arbitrary: false, serves_bundled_assets: true },
        network_external: false
      }
    });
    writeJson(path.join(dir, 'manifest.json'), {
      extensions: [{ id, name: 'Scan Iframe Case', description: 'temp test entry', scripts: ['assets/x.js'], stylesheets: [] }]
    });
    writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
    writeFileSync(path.join(dir, 'assets', 'x.js'),
      "const frame = document.createElement('iframe');\nframe.setAttribute('allow', 'clipboard-read; clipboard-write');\n",
      'utf8');
    return dir;
  }

  // Regression: iframe clipboard grants are user-visible browser capabilities.
  // A gallery entry that enables clipboard-read / clipboard-write on an iframe must
  // disclose that grant in its README trust section, otherwise one-click install
  // cannot present an honest permission story.
  let iframeCaseDir = writeIframeClipboardCase({
    id: 'scan-iframe-clipboard-case',
    readme: '# Scan Iframe Case\n\n## Trust Model\n\nUses a loopback iframe.\n'
  });
  try {
    const scanIframe = spawnSync(process.execPath, ['scan-extension-safety.mjs'], {
      cwd: scriptsDir, encoding: 'utf8', timeout: 30000
    });
    assert.notEqual(scanIframe.status, 0, 'iframe clipboard grant without README disclosure should fail the safety scan');
    assert.match(scanIframe.stderr, /iframe clipboard permission/i);
  } finally {
    rmSync(iframeCaseDir, { recursive: true, force: true });
  }

  // Positive fixture: the gate should not block iframe extensions that honestly
  // disclose the browser clipboard grant in the README trust model.
  iframeCaseDir = writeIframeClipboardCase({
    id: 'scan-iframe-clipboard-disclosed-case',
    readme: '# Scan Iframe Case\n\n## Trust Model\n\nUses a loopback iframe and grants clipboard-read / clipboard-write permission to the frame.\n'
  });
  try {
    const scanIframeDisclosed = spawnSync(process.execPath, ['scan-extension-safety.mjs'], {
      cwd: scriptsDir, encoding: 'utf8', timeout: 30000
    });
    assert.equal(scanIframeDisclosed.status, 0,
      `iframe clipboard grant with README disclosure should pass the safety scan, got: ${scanIframeDisclosed.stderr || scanIframeDisclosed.stdout}`);
  } finally {
    rmSync(iframeCaseDir, { recursive: true, force: true });
  }

  console.log('extension validator self-tests passed');
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
