#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRegistryWithArtifacts, validateEntry } from './extension-registry-lib.mjs';

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
  let errors = validationErrors("fetch('/api/sessions/123');\n");
  assert(errors.includes('permissions.webui_api.read must include sessions'));

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
  assert(errors.includes('vendored sidecar runtime path must not contain symlinks: sidecar'));

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

  const repoRoot = path.resolve(scriptsDir, '..');

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
