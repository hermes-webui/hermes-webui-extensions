#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RUNNERS = new Set(['node', 'node-test', 'python']);
const TEST_FILE_RE = /^test-[^/]+\.(mjs|py)$/;
const INVENTORY_RELATIVE_PATH = 'scripts/behavior-tests.json';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class InventoryError extends Error {
  constructor(errors) {
    const messages = Array.isArray(errors) ? errors : [String(errors)];
    super(messages.join('\n'));
    this.name = 'InventoryError';
    this.errors = messages;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, expected, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown key ${JSON.stringify(key)}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${label} is missing key ${JSON.stringify(key)}`);
    }
  }
  return true;
}

function assertSafePath(root, relativePath, label, errors) {
  if (typeof relativePath !== 'string' || !relativePath) {
    errors.push(`${label} must be a non-empty relative path`);
    return null;
  }
  if (relativePath.includes('\0')) {
    errors.push(`${label} contains a NUL byte`);
    return null;
  }
  if (relativePath.includes('\\')) {
    errors.push(`${label} must use POSIX separators`);
    return null;
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    errors.push(`${label} must not be absolute`);
    return null;
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    errors.push(`${label} contains an invalid or traversal segment`);
    return null;
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath) {
    errors.push(`${label} is not normalized`);
    return null;
  }
  const absolutePath = path.resolve(root, ...parts);
  const relativeCheck = path.relative(root, absolutePath);
  if (!relativeCheck || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
    errors.push(`${label} escapes the repository root`);
    return null;
  }

  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      errors.push(`${label} does not exist: ${relativePath}`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`${label} must not traverse a symbolic link: ${relativePath}`);
      return null;
    }
  }
  const finalStat = lstatSync(absolutePath);
  if (!finalStat.isFile()) {
    errors.push(`${label} must name a regular file: ${relativePath}`);
    return null;
  }
  return absolutePath;
}

function discoverTopLevelTests(root) {
  const scriptsPath = path.join(root, 'scripts');
  let scriptsStat;
  try {
    scriptsStat = lstatSync(scriptsPath);
  } catch (error) {
    throw new InventoryError(`scripts directory is missing: ${scriptsPath}`);
  }
  if (scriptsStat.isSymbolicLink() || !scriptsStat.isDirectory()) {
    throw new InventoryError('scripts must be a real directory');
  }
  return readdirSync(scriptsPath, { withFileTypes: true })
    .filter((entry) => TEST_FILE_RE.test(entry.name))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
}

function inventoryPathFor(root, inventoryPath) {
  const candidate = inventoryPath || path.join(root, INVENTORY_RELATIVE_PATH);
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InventoryError('inventory path must be inside the repository root');
  }
  const errors = [];
  assertSafePath(root, relative.split(path.sep).join('/'), 'inventory path', errors);
  if (errors.length) throw new InventoryError(errors);
  return absolute;
}

function readInventory(inventoryPath) {
  let raw;
  try {
    raw = readFileSync(inventoryPath, 'utf8');
  } catch (error) {
    throw new InventoryError(`cannot read inventory: ${inventoryPath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InventoryError(`inventory is not valid JSON: ${error.message}`);
  }
}

export function validateInventory({ repoRoot = REPO_ROOT, inventoryPath } = {}) {
  const root = path.resolve(repoRoot);
  const inventory = inventoryPathFor(root, inventoryPath);
  const raw = readInventory(inventory);
  const errors = [];

  if (exactKeys(raw, ['version', 'tests'], 'inventory', errors)) {
    if (raw.version !== 1 || !Number.isInteger(raw.version)) {
      errors.push('inventory.version must be the integer 1');
    }
    if (!Array.isArray(raw.tests)) errors.push('inventory.tests must be an array');
  }

  const tests = Array.isArray(raw?.tests) ? raw.tests : [];
  const normalizedTests = [];
  const seenPaths = new Set();
  tests.forEach((entry, index) => {
    const label = `inventory.tests[${index}]`;
    if (!exactKeys(entry, ['path', 'runner'], label, errors)) return;
    const relativePath = entry.path;
    const runner = entry.runner;
    if (typeof runner !== 'string' || !RUNNERS.has(runner)) {
      errors.push(`${label}.runner must be one of node, node-test, python`);
    }
    const safePath = assertSafePath(root, relativePath, `${label}.path`, errors);
    if (!safePath) return;
    const relativeParts = relativePath.split('/');
    if (relativeParts.length !== 2 || relativeParts[0] !== 'scripts' || !TEST_FILE_RE.test(relativeParts[1])) {
      errors.push(`${label}.path must name a top-level scripts/test-*.mjs or scripts/test-*.py file`);
    }
    const extension = path.posix.extname(relativePath);
    if (extension === '.py' && runner !== 'python') {
      errors.push(`${label}.runner python is required for .py files`);
    }
    if (extension === '.mjs' && runner === 'python') {
      errors.push(`${label}.runner python cannot execute .mjs files`);
    }
    if (seenPaths.has(relativePath)) {
      errors.push(`${label}.path is duplicated: ${relativePath}`);
    } else {
      seenPaths.add(relativePath);
    }
    normalizedTests.push({ path: relativePath, runner, absolutePath: safePath });
  });

  let discovered = [];
  try {
    discovered = discoverTopLevelTests(root);
  } catch (error) {
    errors.push(...(error instanceof InventoryError ? error.errors : [error.message]));
  }
  const listedPaths = new Set(normalizedTests.map((entry) => entry.path));
  for (const discoveredPath of discovered) {
    if (!listedPaths.has(discoveredPath)) {
      errors.push(`top-level test is missing from inventory: ${discoveredPath}`);
    }
  }
  for (const listedPath of listedPaths) {
    if (!discovered.includes(listedPath)) {
      errors.push(`inventory path is not a discovered top-level test: ${listedPath}`);
    }
  }

  if (errors.length) throw new InventoryError(errors);
  return {
    repoRoot: root,
    inventoryPath: inventory,
    tests: normalizedTests,
    discovered,
  };
}

function commandFor(entry) {
  if (entry.runner === 'python') return { command: 'python3', args: [entry.path] };
  if (entry.runner === 'node-test') return { command: process.execPath, args: ['--test', entry.path] };
  return { command: process.execPath, args: [entry.path] };
}

export function executeInventory(validated, { stdio = 'inherit', log = console.log } = {}) {
  let passed = 0;
  for (const entry of validated.tests) {
    const { command, args } = commandFor(entry);
    log(`[behavior-tests] RUN ${entry.path} (${entry.runner})`);
    const result = spawnSync(command, args, {
      cwd: validated.repoRoot,
      shell: false,
      stdio,
    });
    if (result.error) {
      log(`[behavior-tests] FAIL ${entry.path}: ${result.error.message}`);
      log(`[behavior-tests] summary: ${passed}/${validated.tests.length} suites passed`);
      return { ok: false, passed, failed: 1, total: validated.tests.length, failedPath: entry.path };
    }
    if (result.status !== 0) {
      const status = result.status === null ? `signal ${result.signal || 'unknown'}` : `exit ${result.status}`;
      log(`[behavior-tests] FAIL ${entry.path}: ${status}`);
      log(`[behavior-tests] summary: ${passed}/${validated.tests.length} suites passed`);
      return { ok: false, passed, failed: 1, total: validated.tests.length, failedPath: entry.path };
    }
    passed += 1;
  }
  log(`[behavior-tests] summary: ${passed}/${validated.tests.length} suites passed`);
  return { ok: true, passed, failed: 0, total: validated.tests.length };
}

export function runInventory(options = {}) {
  const { checkOnly = false, ...validationOptions } = options;
  const validated = validateInventory(validationOptions);
  if (checkOnly) return { ok: true, checked: true, total: validated.tests.length, validated };
  const result = executeInventory(validated, options);
  return { ...result, validated };
}

function usage() {
  console.error('Usage: node scripts/run-behavior-tests.mjs [--check]');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== '--check')) {
    usage();
    return 2;
  }
  const checkOnly = argv.includes('--check');
  try {
    const result = runInventory({ checkOnly });
    if (checkOnly) {
      console.log(`[behavior-tests] inventory valid: ${result.total} suites`);
      return 0;
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[behavior-tests] inventory validation failed:\n${error.message}`);
    return 1;
  }
}

if (isMainModule()) process.exitCode = main();
