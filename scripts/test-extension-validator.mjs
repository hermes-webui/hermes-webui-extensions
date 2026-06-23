#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateEntry } from './extension-registry-lib.mjs';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-extension-validator-'));

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validationErrors(scriptText) {
  const id = `validator-case-${Math.random().toString(36).slice(2, 8)}`;
  const root = path.join(tmpRoot, id);
  const asset = 'assets/adapter.js';
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Validator fixture\n', { encoding: 'utf8', flag: 'w' });
  writeFileSync(path.join(root, 'assets/adapter.js'), scriptText, { encoding: 'utf8', flag: 'w' });
  writeJson(path.join(root, 'manifest.json'), {
    extensions: [
      {
        id,
        name: 'Validator Fixture',
        scripts: [asset],
        stylesheets: []
      }
    ]
  });
  writeJson(path.join(root, 'extension.json'), {
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
  });
  return validateEntry({
    idFromDir: id,
    root,
    extensionJsonPath: path.join(root, 'extension.json')
  }).errors;
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

  console.log('extension validator self-tests passed');
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
