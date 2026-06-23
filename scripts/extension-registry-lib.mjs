import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPO_ROOT = process.cwd();
export const EXTENSIONS_ROOT = path.join(REPO_ROOT, 'extensions');

const VALID_CAPABILITIES = new Set([
  'manifest-bundle',
  'loopback-sidecar'
]);

const WEBUI_READ_ENDPOINTS = new Map([
  ['sessions', /\/api\/sessions(?=$|[/?#'"`])/],
  ['session', /\/api\/session(?!\/draft)(?=$|[/?#'"`])/],
  ['approval/pending', /\/api\/approval\/pending(?=$|[/?#'"`])/],
  ['clarify/pending', /\/api\/clarify\/pending(?=$|[/?#'"`])/]
]);

const WEBUI_WRITE_ENDPOINTS = new Map([
  ['session/draft', /\/api\/session\/draft(?=$|[/?#'"`])/],
  ['approval/respond', /\/api\/approval\/respond(?=$|[/?#'"`])/],
  ['clarify/respond', /\/api\/clarify\/respond(?=$|[/?#'"`])/]
]);

const SHARED_STORAGE_KEYS = [
  'hermes-session-viewed-counts',
  'hermes-session-completion-unread',
  'hermes-webui-session'
];

const OWNED_STORAGE_KEYS = [
  'hermes-pet-navigation-last-id',
  'hermes-pet-action-last-id'
];

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function repoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

export function discoverEntries() {
  if (!existsSync(EXTENSIONS_ROOT)) return [];
  return readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => {
      const root = path.join(EXTENSIONS_ROOT, item.name);
      const extensionJsonPath = path.join(root, 'extension.json');
      return existsSync(extensionJsonPath)
        ? { idFromDir: item.name, root, extensionJsonPath }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idFromDir.localeCompare(b.idFromDir));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLowerHyphenId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || ''));
}

function isSafeLocalPath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return false;
  if (normalized.includes('\0')) return false;
  return normalized === value;
}

function localFile(entryRoot, rel) {
  return path.join(entryRoot, rel.split('/').join(path.sep));
}

function collectFiles(dir, prefix = '') {
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const target = path.join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...collectFiles(target, rel));
    } else if (item.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function assertArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  return value;
}

function assertBoolean(value, label, errors) {
  if (typeof value !== 'boolean') errors.push(`${label} must be a boolean`);
}

function assertString(value, label, errors) {
  if (!isNonEmptyString(value)) errors.push(`${label} must be a non-empty string`);
}

function validateAssets(entry, errors) {
  if (!isPlainObject(entry.assets)) {
    errors.push('assets must be an object');
    return { scripts: [], stylesheets: [] };
  }
  const scripts = assertArray(entry.assets.scripts, 'assets.scripts', errors);
  const stylesheets = assertArray(entry.assets.stylesheets, 'assets.stylesheets', errors);
  for (const rel of [...scripts, ...stylesheets]) {
    if (!isSafeLocalPath(rel)) {
      errors.push(`asset path is not safe/local: ${rel}`);
      continue;
    }
    const target = localFile(entry.__root, rel);
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`asset file missing: ${rel}`);
    }
  }
  for (const script of scripts) {
    if (!/\.(?:cjs|js|mjs)$/.test(script)) continue;
    const check = spawnSync(process.execPath, ['--check', localFile(entry.__root, script)], {
      encoding: 'utf8',
      timeout: 30000
    });
    if (check.status !== 0) {
      errors.push(`JavaScript syntax check failed for ${script}: ${check.stderr || check.stdout}`);
    }
  }
  return { scripts, stylesheets };
}

function validateRuntimeManifest(entry, assets, errors) {
  const manifestPath = path.join(entry.__root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    errors.push('manifest.json is required until the registry Action derives it');
    return;
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
    return;
  }
  const extensions = assertArray(manifest.extensions, 'manifest.extensions', errors);
  if (extensions.length !== 1) {
    errors.push('manifest.extensions must contain exactly one entry');
    return;
  }
  const runtime = extensions[0];
  if (!isPlainObject(runtime)) {
    errors.push('manifest.extensions[0] must be an object');
    return;
  }
  if (runtime.id !== entry.id) errors.push(`manifest id ${runtime.id || '<missing>'} must match extension id ${entry.id}`);
  const runtimeScripts = assertArray(runtime.scripts || [], 'manifest scripts', errors);
  const runtimeStylesheets = assertArray(runtime.stylesheets || [], 'manifest stylesheets', errors);
  if (JSON.stringify(runtimeScripts) !== JSON.stringify(assets.scripts)) {
    errors.push('manifest scripts must match extension.json assets.scripts');
  }
  if (JSON.stringify(runtimeStylesheets) !== JSON.stringify(assets.stylesheets)) {
    errors.push('manifest stylesheets must match extension.json assets.stylesheets');
  }
}

function validatePermissions(entry, scriptText, errors) {
  const permissions = entry.permissions;
  if (!isPlainObject(permissions)) {
    errors.push('permissions must be an object');
    return;
  }
  const webuiApi = isPlainObject(permissions.webui_api) ? permissions.webui_api : {};
  const declaredReads = new Set(assertArray(webuiApi.read || [], 'permissions.webui_api.read', errors));
  const declaredWrites = new Set(assertArray(webuiApi.write || [], 'permissions.webui_api.write', errors));

  for (const [endpoint, pattern] of WEBUI_READ_ENDPOINTS) {
    if (pattern.test(scriptText) && !declaredReads.has(endpoint)) {
      errors.push(`permissions.webui_api.read must include ${endpoint}`);
    }
  }
  for (const [endpoint, pattern] of WEBUI_WRITE_ENDPOINTS) {
    if (pattern.test(scriptText) && !declaredWrites.has(endpoint)) {
      errors.push(`permissions.webui_api.write must include ${endpoint}`);
    }
  }

  if (/(window\.loadSession|switchPanel|window\.location\.assign|hermes-webui-session)/.test(scriptText)) {
    if (permissions.webui_navigation !== true) errors.push('permissions.webui_navigation must be true when adapter navigates WebUI');
  }
  assertBoolean(permissions.webui_navigation, 'permissions.webui_navigation', errors);

  if (/\/api\/pet\/(?:navigation|actions)/.test(scriptText)) {
    if (!isPlainObject(permissions.sidecar_commands) || permissions.sidecar_commands.from_loopback !== true) {
      errors.push('permissions.sidecar_commands.from_loopback must be true when polling sidecar commands');
    }
  }

  if (!isPlainObject(permissions.dom)) {
    errors.push('permissions.dom must be an object');
  } else {
    assertBoolean(permissions.dom.owned, 'permissions.dom.owned', errors);
    assertBoolean(permissions.dom.mutates_core_views, 'permissions.dom.mutates_core_views', errors);
    if (permissions.dom.owned === false && /(document\.createElement|appendChild|innerHTML)/.test(scriptText)) {
      errors.push('permissions.dom.owned is false but scripts appear to create/mutate DOM');
    }
  }

  if (!isPlainObject(permissions.storage)) {
    errors.push('permissions.storage must be an object');
  } else {
    const owned = new Set(assertArray(permissions.storage.owned || [], 'permissions.storage.owned', errors));
    const shared = new Set(assertArray(permissions.storage.shared_webui_keys || [], 'permissions.storage.shared_webui_keys', errors));
    for (const key of OWNED_STORAGE_KEYS) {
      if (scriptText.includes(key) && !owned.has(key)) errors.push(`permissions.storage.owned must include ${key}`);
    }
    for (const key of SHARED_STORAGE_KEYS) {
      if (scriptText.includes(key) && !shared.has(key)) errors.push(`permissions.storage.shared_webui_keys must include ${key}`);
    }
  }

  assertBoolean(permissions.loopback_sidecar, 'permissions.loopback_sidecar', errors);
  assertBoolean(permissions.native_host, 'permissions.native_host', errors);
  assertBoolean(permissions.network_external, 'permissions.network_external', errors);

  if (!isPlainObject(permissions.filesystem)) {
    errors.push('permissions.filesystem must be an object');
  } else {
    assertBoolean(permissions.filesystem.arbitrary, 'permissions.filesystem.arbitrary', errors);
    assertBoolean(permissions.filesystem.serves_bundled_assets, 'permissions.filesystem.serves_bundled_assets', errors);
  }

  const externalFetch = /fetch\(\s*['"]https?:\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])(?=$|[:/?#'"`]))/;
  if (permissions.network_external === false && externalFetch.test(scriptText)) {
    errors.push('permissions.network_external is false but scripts appear to fetch an external origin');
  }
  if (/\b(eval|Function)\s*\(/.test(scriptText)) {
    errors.push('scripts must not use eval() or Function()');
  }
}

function validateLifecycle(entry, errors) {
  if (!isPlainObject(entry.lifecycle)) {
    errors.push('lifecycle must be an object');
    return;
  }
  assertBoolean(entry.lifecycle.webui_restart_required, 'lifecycle.webui_restart_required', errors);
  assertBoolean(entry.lifecycle.sidecar_start_required, 'lifecycle.sidecar_start_required', errors);
  assertBoolean(entry.lifecycle.native_host_start_required, 'lifecycle.native_host_start_required', errors);
  const autostart = entry.lifecycle.native_host_autostart;
  if (!['extension_owned', 'webui_owned', 'none'].includes(autostart)) {
    errors.push('lifecycle.native_host_autostart must be extension_owned, webui_owned, or none');
  }
}

function validateSidecar(entry, errors) {
  const hasCapability = Array.isArray(entry.capabilities) && entry.capabilities.includes('loopback-sidecar');
  if (!hasCapability) return;
  if (!isPlainObject(entry.sidecar)) {
    errors.push('sidecar block is required when loopback-sidecar capability is declared');
    return;
  }
  if (entry.sidecar.type !== 'loopback') errors.push('sidecar.type must be loopback');
  try {
    const origin = new URL(entry.sidecar.origin);
    if (!['http:', 'https:'].includes(origin.protocol)) errors.push('sidecar.origin must be http(s)');
    if (!['127.0.0.1', 'localhost', '::1'].includes(origin.hostname)) {
      errors.push('sidecar.origin must be loopback');
    }
  } catch (_) {
    errors.push('sidecar.origin must be a valid URL');
  }
  if (!isNonEmptyString(entry.sidecar.health_path) || !entry.sidecar.health_path.startsWith('/')) {
    errors.push('sidecar.health_path must be an absolute path');
  }
}

function validateCapabilities(entry, errors) {
  const capabilities = assertArray(entry.capabilities, 'capabilities', errors);
  for (const capability of capabilities) {
    if (!VALID_CAPABILITIES.has(capability)) {
      errors.push(`capability is not currently shipped/allowed: ${capability}`);
    }
  }
}

export function validateEntry(discovered) {
  const errors = [];
  let entry;
  try {
    entry = readJson(discovered.extensionJsonPath);
  } catch (error) {
    return {
      id: discovered.idFromDir,
      root: discovered.root,
      errors: [`extension.json is not valid JSON: ${error.message}`]
    };
  }

  entry.__root = discovered.root;
  assertString(entry.id, 'id', errors);
  assertString(entry.name, 'name', errors);
  assertString(entry.description, 'description', errors);
  assertString(entry.author, 'author', errors);
  if (!isSemver(entry.version)) errors.push('version must be semver-like, for example 0.1.0');
  if (!isLowerHyphenId(entry.id)) errors.push('id must be lowercase-hyphen');
  if (entry.id !== discovered.idFromDir) errors.push(`id must match directory name ${discovered.idFromDir}`);
  if (!existsSync(path.join(discovered.root, 'README.md'))) errors.push('README.md is required');
  if (!Array.isArray(entry.screenshots)) errors.push('screenshots must be an array');

  const assets = validateAssets(entry, errors);
  validateRuntimeManifest(entry, assets, errors);
  validateCapabilities(entry, errors);
  validateLifecycle(entry, errors);
  validateSidecar(entry, errors);

  const scriptText = assets.scripts
    .map((rel) => (existsSync(localFile(discovered.root, rel)) ? readFileSync(localFile(discovered.root, rel), 'utf8') : ''))
    .join('\n');
  validatePermissions(entry, scriptText, errors);

  delete entry.__root;
  return { id: entry.id || discovered.idFromDir, root: discovered.root, entry, errors };
}

export function validateAllEntries() {
  const discovered = discoverEntries();
  const seen = new Set();
  const results = discovered.map((item) => {
    const result = validateEntry(item);
    if (seen.has(result.id)) result.errors.push(`duplicate extension id: ${result.id}`);
    seen.add(result.id);
    return result;
  });
  return { discovered, results };
}

export function buildRegistry({ publishedAt = new Date().toISOString() } = {}) {
  const { results } = validateAllEntries();
  const failures = results.filter((result) => result.errors.length);
  if (failures.length) {
    const message = failures
      .map((result) => `${result.id}\n${result.errors.map((error) => `  - ${error}`).join('\n')}`)
      .join('\n');
    throw new Error(`Cannot generate registry from invalid entries:\n${message}`);
  }

  return {
    version: 1,
    generated_at: publishedAt,
    extensions: results
      .map((result) => {
        const entryDir = repoRelative(result.root);
        const fileHashes = collectFiles(result.root).map((rel) => ({
          path: rel,
          sha256: sha256File(path.join(result.root, rel.split('/').join(path.sep)))
        }));
        return {
          ...result.entry,
          entry_path: `${entryDir}/extension.json`,
          runtime_manifest_path: `${entryDir}/manifest.json`,
          published_at: publishedAt,
          file_count: fileHashes.length,
          file_sha256: fileHashes
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}
