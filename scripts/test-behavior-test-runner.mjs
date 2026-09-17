#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InventoryError, runInventory } from './run-behavior-tests.mjs';

const projects = [];
const linkedPaths = [];

function makeProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-behavior-runner-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  projects.push(root);
  return root;
}

function writeScript(root, relativePath, source) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf8');
  return filePath;
}

function writeInventory(root, tests) {
  writeFileSync(
    path.join(root, 'scripts', 'behavior-tests.json'),
    `${JSON.stringify({ version: 1, tests }, null, 2)}\n`,
    'utf8',
  );
}

function options(root) {
  return { repoRoot: root, stdio: 'ignore', log: () => {} };
}

function expectInventoryError(action, message) {
  assert.throws(action, (error) => {
    assert(error instanceof InventoryError, `expected InventoryError, got ${error}`);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function nodeWriter(sentinel, marker) {
  return `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(`${marker}\n`)});\n`;
}

function pythonWriter(sentinel, marker) {
  return `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).open("a", encoding="utf-8").write(${JSON.stringify(`${marker}\n`)})\n`;
}

try {
  // Red first: an unregistered top-level test is rejected and never executes.
  const unregisteredRoot = makeProject();
  const unregisteredSentinel = path.join(unregisteredRoot, 'unregistered-sentinel');
  writeScript(unregisteredRoot, 'scripts/test-unregistered.mjs', nodeWriter(unregisteredSentinel, 'unregistered'));
  writeInventory(unregisteredRoot, []);
  expectInventoryError(
    () => runInventory(options(unregisteredRoot)),
    /missing from inventory: scripts\/test-unregistered\.mjs/,
  );
  assert.equal(existsSync(unregisteredSentinel), false, 'unregistered test must not execute');
  console.log('[behavior-tests] red fixture rejected before execution');

  // Registering the same fixture makes the gate green and executes it once.
  writeInventory(unregisteredRoot, [{ path: 'scripts/test-unregistered.mjs', runner: 'node' }]);
  const registered = runInventory(options(unregisteredRoot));
  assert.equal(registered.ok, true);
  assert.equal(registered.passed, 1);
  assert.equal(readFileSync(unregisteredSentinel, 'utf8'), 'unregistered\n');
  console.log('[behavior-tests] green registration executed the fixture');

  // Every inventory error is found before a registered sentinel can execute.
  const missingRoot = makeProject();
  const missingSentinel = path.join(missingRoot, 'missing-sentinel');
  writeScript(missingRoot, 'scripts/test-first.mjs', nodeWriter(missingSentinel, 'first'));
  writeInventory(missingRoot, [
    { path: 'scripts/test-first.mjs', runner: 'node' },
    { path: 'scripts/test-missing.mjs', runner: 'node' },
  ]);
  expectInventoryError(() => runInventory(options(missingRoot)), /does not exist: scripts\/test-missing\.mjs/);
  assert.equal(existsSync(missingSentinel), false, 'missing inventory entry must block all execution');

  const invalidRunnerRoot = makeProject();
  const invalidRunnerSentinel = path.join(invalidRunnerRoot, 'invalid-runner-sentinel');
  writeScript(invalidRunnerRoot, 'scripts/test-first.mjs', nodeWriter(invalidRunnerSentinel, 'first'));
  writeScript(invalidRunnerRoot, 'scripts/test-second.mjs', nodeWriter(invalidRunnerSentinel, 'second'));
  writeInventory(invalidRunnerRoot, [
    { path: 'scripts/test-first.mjs', runner: 'invalid' },
    { path: 'scripts/test-second.mjs', runner: 'node' },
  ]);
  expectInventoryError(() => runInventory(options(invalidRunnerRoot)), /runner must be one of/);
  assert.equal(existsSync(invalidRunnerSentinel), false, 'invalid runner must block all execution');

  const traversalRoot = makeProject();
  const traversalSentinel = path.join(traversalRoot, 'traversal-sentinel');
  writeScript(traversalRoot, 'scripts/test-safe.mjs', nodeWriter(traversalSentinel, 'safe'));
  writeInventory(traversalRoot, [
    { path: 'scripts/test-safe.mjs', runner: 'node' },
    { path: 'scripts/../scripts/test-safe.mjs', runner: 'node' },
  ]);
  expectInventoryError(() => runInventory(options(traversalRoot)), /invalid or traversal segment/);
  assert.equal(existsSync(traversalSentinel), false, 'traversal path must block all execution');

  const duplicateRoot = makeProject();
  const duplicateSentinel = path.join(duplicateRoot, 'duplicate-sentinel');
  writeScript(duplicateRoot, 'scripts/test-duplicate.mjs', nodeWriter(duplicateSentinel, 'duplicate'));
  writeInventory(duplicateRoot, [
    { path: 'scripts/test-duplicate.mjs', runner: 'node' },
    { path: 'scripts/test-duplicate.mjs', runner: 'node' },
  ]);
  expectInventoryError(() => runInventory(options(duplicateRoot)), /path is duplicated/);
  assert.equal(existsSync(duplicateSentinel), false, 'duplicate path must block all execution');

  const symlinkRoot = makeProject();
  const symlinkSentinel = path.join(symlinkRoot, 'symlink-sentinel');
  writeScript(symlinkRoot, 'scripts/test-real.mjs', nodeWriter(symlinkSentinel, 'real'));
  symlinkSync('test-real.mjs', path.join(symlinkRoot, 'scripts', 'test-link.mjs'));
  writeInventory(symlinkRoot, [
    { path: 'scripts/test-real.mjs', runner: 'node' },
    { path: 'scripts/test-link.mjs', runner: 'node' },
  ]);
  expectInventoryError(() => runInventory(options(symlinkRoot)), /symbolic link/);
  assert.equal(existsSync(symlinkSentinel), false, 'symlink path must block all execution');

  const extraKeyRoot = makeProject();
  writeScript(extraKeyRoot, 'scripts/test-extra.mjs', '');
  writeFileSync(
    path.join(extraKeyRoot, 'scripts', 'behavior-tests.json'),
    '{"version":1,"tests":[{"path":"scripts/test-extra.mjs","runner":"node","extra":true}]}\n',
    'utf8',
  );
  expectInventoryError(() => runInventory(options(extraKeyRoot)), /unknown key/);

  const failureRoot = makeProject();
  const afterFailureSentinel = path.join(failureRoot, 'after-failure-sentinel');
  writeScript(failureRoot, 'scripts/test-failure.mjs', 'process.exitCode = 7;\n');
  writeScript(failureRoot, 'scripts/test-after-failure.mjs', nodeWriter(afterFailureSentinel, 'after'));
  writeScript(
    failureRoot,
    'scripts/run-behavior-tests.mjs',
    readFileSync(fileURLToPath(new URL('./run-behavior-tests.mjs', import.meta.url)), 'utf8'),
  );
  writeInventory(failureRoot, [
    { path: 'scripts/test-failure.mjs', runner: 'node' },
    { path: 'scripts/test-after-failure.mjs', runner: 'node' },
  ]);
  const failed = runInventory(options(failureRoot));
  assert.equal(failed.ok, false, 'a registered failing suite must make the gate nonzero');
  assert.equal(failed.failedPath, 'scripts/test-failure.mjs');
  assert.equal(failed.passed, 0);
  assert.equal(existsSync(afterFailureSentinel), false, 'execution must fail fast');
  const failedCli = spawnSync(process.execPath, ['scripts/run-behavior-tests.mjs'], {
    cwd: failureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(failedCli.status, 1, failedCli.stderr);
  assert.match(failedCli.stdout, /summary: 0\/2 suites passed/);
  assert.equal(existsSync(afterFailureSentinel), false, 'CLI failure must remain fail-fast');

  const versionRoot = makeProject();
  writeScript(versionRoot, 'scripts/test-version.mjs', '');
  writeFileSync(
    path.join(versionRoot, 'scripts', 'behavior-tests.json'),
    '{"version":2,"tests":[{"path":"scripts/test-version.mjs","runner":"node"}]}\n',
    'utf8',
  );
  expectInventoryError(() => runInventory(options(versionRoot)), /version must be the integer 1/);

  const schemaRoot = makeProject();
  writeScript(schemaRoot, 'scripts/test-schema.mjs', '');
  writeFileSync(
    path.join(schemaRoot, 'scripts', 'behavior-tests.json'),
    '{"version":1,"tests":{}}\n',
    'utf8',
  );
  expectInventoryError(() => runInventory(options(schemaRoot)), /tests must be an array/);

  const pythonSuffixRoot = makeProject();
  writeScript(pythonSuffixRoot, 'scripts/test-python.py', '');
  writeInventory(pythonSuffixRoot, [{ path: 'scripts/test-python.py', runner: 'node' }]);
  expectInventoryError(() => runInventory(options(pythonSuffixRoot)), /python is required for \.py/);

  const nodeSuffixRoot = makeProject();
  writeScript(nodeSuffixRoot, 'scripts/test-node.mjs', '');
  writeInventory(nodeSuffixRoot, [{ path: 'scripts/test-node.mjs', runner: 'python' }]);
  expectInventoryError(() => runInventory(options(nodeSuffixRoot)), /python cannot execute \.mjs/);

  const successRoot = makeProject();
  const successSentinel = path.join(successRoot, 'success-sentinel');
  writeScript(successRoot, 'scripts/test-node.mjs', nodeWriter(successSentinel, 'node'));
  writeScript(
    successRoot,
    'scripts/test-node-test.mjs',
    `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('node-test fixture', () => appendFileSync(${JSON.stringify(successSentinel)}, 'node-test\\n'));\n`,
  );
  writeScript(successRoot, 'scripts/test-python.py', pythonWriter(successSentinel, 'python'));
  writeInventory(successRoot, [
    { path: 'scripts/test-node.mjs', runner: 'node' },
    { path: 'scripts/test-node-test.mjs', runner: 'node-test' },
    { path: 'scripts/test-python.py', runner: 'python' },
  ]);
  const checked = runInventory({ ...options(successRoot), checkOnly: true });
  assert.equal(checked.ok, true);
  assert.equal(checked.checked, true);
  assert.equal(existsSync(successSentinel), false, '--check must not execute suites');
  const succeeded = runInventory(options(successRoot));
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.passed, 3);
  assert.deepEqual(
    new Set(readFileSync(successSentinel, 'utf8').trim().split('\n')),
    new Set(['node', 'node-test', 'python']),
  );

  // Entry-point checks must still run when /tmp or the repository is symlinked.
  const runnerPath = fileURLToPath(new URL('./run-behavior-tests.mjs', import.meta.url));
  const absoluteCheck = spawnSync(process.execPath, [runnerPath, '--check'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(absoluteCheck.status, 0, absoluteCheck.stderr);
  assert.match(absoluteCheck.stdout, /inventory valid: /);

  const linkedRepo = path.join(os.tmpdir(), `hermes-behavior-runner-linked-${process.pid}`);
  symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), linkedRepo, 'dir');
  linkedPaths.push(linkedRepo);
  const linkedCheck = spawnSync(process.execPath, [path.join(linkedRepo, 'scripts', 'run-behavior-tests.mjs'), '--check'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(linkedCheck.status, 0, linkedCheck.stderr);
  assert.match(linkedCheck.stdout, /inventory valid: /);

  console.log('[behavior-tests] runner self-test passed: validation, fail-fast, and node/node-test/python dispatch');
} finally {
  for (const project of projects) rmSync(project, { recursive: true, force: true });
  for (const linkedPath of linkedPaths) rmSync(linkedPath, { force: true });
}
