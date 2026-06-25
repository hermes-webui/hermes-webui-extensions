#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRegistryWithArtifacts, repoRelative, validateAllEntries } from './extension-registry-lib.mjs';

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.svg',
  '.txt',
  '.yaml',
  '.yml'
]);

const SECRET_PATTERNS = [
  { label: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
  { label: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

const JS_DANGER_PATTERNS = [
  { label: 'eval/Function execution', pattern: /\b(?:eval|Function)\s*\(/ },
  { label: 'string-eval timer', pattern: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/ },
  { label: 'external dynamic import', pattern: /\bimport\s*\(\s*['"`]https?:\/\// },
  { label: 'document.cookie access', pattern: /\bdocument\.cookie\b/ },
  { label: 'process.env access', pattern: /\bprocess\.env\b/ },
  { label: 'Node child_process access', pattern: /\b(?:child_process|node:child_process)\b/ },
  { label: 'Node filesystem access', pattern: /\b(?:require\s*\(\s*['"`]fs['"`]\s*\)|from\s+['"`]node:fs['"`]|from\s+['"`]fs['"`])/ },
  { label: 'Deno command execution', pattern: /\bDeno\.(?:Command|run)\b/ },
  { label: 'Bun command execution', pattern: /\bBun\.(?:spawn|spawnSync)\b/ },
  { label: 'remote script element loader', pattern: /createElement\s*\(\s*['"`]script['"`]\s*\)[\s\S]{0,500}\.src\s*=\s*['"`]https?:\/\// }
];

const SAFE_LITERAL_URLS = new Set([
  'http://www.w3.org/2000/svg'
]);

function isAllowedNetworkLiteral(value) {
  if (SAFE_LITERAL_URLS.has(value)) return true;
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function isSafeRelativePath(value) {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('\0');
}

function collectEntryFiles(dir, prefix = '') {
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const target = path.join(dir, item.name);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      files.push({ rel, path: target, symlink: true });
    } else if (item.isDirectory()) {
      files.push(...collectEntryFiles(target, rel));
    } else if (item.isFile()) {
      files.push({ rel, path: target, symlink: false });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function scanTextFile(file, text, errors) {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`${repoRelative(file.path)} contains possible secret: ${label}`);
  }
}

function scanJavaScriptFile(entry, file, text, errors) {
  for (const { label, pattern } of JS_DANGER_PATTERNS) {
    if (pattern.test(text)) errors.push(`${repoRelative(file.path)} uses blocked high-risk JavaScript pattern: ${label}`);
  }

  const permissions = entry.permissions || {};
  const networkExternal = permissions.network_external === true;
  const urls = [...text.matchAll(/['"`](https?:\/\/[^'"`\s)]+)['"`]/g)].map((match) => match[1]);
  for (const url of urls) {
    if (!isAllowedNetworkLiteral(url) && !networkExternal) {
      errors.push(`${repoRelative(file.path)} contains external URL literal while permissions.network_external is false: ${url}`);
    }
  }

  if (/localStorage\.setItem\s*\(/.test(text)) {
    const owned = new Set(permissions.storage?.owned || []);
    if (owned.size === 0) errors.push(`${repoRelative(file.path)} writes localStorage without declaring owned storage keys`);
  }
}

function scanEntry(result) {
  const errors = [];
  const files = collectEntryFiles(result.root);
  if (!files.length) errors.push(`${result.id} has no files`);

  for (const file of files) {
    if (file.symlink) {
      errors.push(`${repoRelative(file.path)} is a symlink; extension entries must contain regular files`);
      continue;
    }
    if (!isSafeRelativePath(file.rel)) errors.push(`${repoRelative(file.path)} has an unsafe relative path`);
    if (!isTextFile(file.path)) continue;
    const text = readFileSync(file.path, 'utf8');
    scanTextFile(file, text, errors);
    if (/\.(?:cjs|js|mjs)$/i.test(file.path)) scanJavaScriptFile(result.entry, file, text, errors);
  }

  return errors;
}

function scanArtifacts(errors) {
  const { registry, artifacts } = buildRegistryWithArtifacts({
    publishedAt: '2026-01-01T00:00:00.000Z'
  });
  if (!artifacts.length) errors.push('registry build produced no extension artifacts');

  for (const entry of registry.extensions) {
    const artifact = artifacts.find((item) => item.id === entry.id);
    if (!artifact) {
      errors.push(`${entry.id} has no generated artifact`);
      continue;
    }
    if (!entry.download || !entry.sha256 || !entry.artifact_size) {
      errors.push(`${entry.id} registry entry is missing download, sha256, or artifact_size`);
    }
    if (entry.sha256 !== artifact.sha256) errors.push(`${entry.id} registry sha256 does not match generated artifact`);
    if (entry.artifact_size !== artifact.size) errors.push(`${entry.id} registry artifact_size does not match generated artifact`);
    if (!artifact.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      errors.push(`${entry.id} artifact does not look like a zip archive`);
    }
  }
}

const { discovered, results } = validateAllEntries();
const errors = [];

if (discovered.length === 0) {
  errors.push('No extension entries discovered; refusing to pass safety scan with an empty registry');
}

for (const result of results) {
  if (result.errors.length) {
    errors.push(`${result.id} is not valid; run validate-extensions first`);
    continue;
  }
  errors.push(...scanEntry(result));
}

if (!errors.length) scanArtifacts(errors);

if (errors.length) {
  console.error('extension safety scan failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`safety scan passed for ${results.length} extension entr${results.length === 1 ? 'y' : 'ies'}`);
