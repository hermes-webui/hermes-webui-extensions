#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(
  path.join(repoRoot, 'extensions/message-pins/assets/message-pins.js'), 'utf8'
);

// This is intentionally a source-level guard: the extension has no DOM test
// harness, but these invariants prevent the exact observer/layout feedback loop
// reported in #59 without adding a browser dependency to the repository.
assert.match(source, /function scheduleSync\(records\)/,
  'the observer must receive MutationRecords to limit work to affected rows');
assert.match(source, /target\.closest\('\.hwx-pin-btn'\)/,
  'extension-owned pin-button mutations must be ignored');
assert.match(source, /function setPinButtonState\(btn, pinned\)/,
  'pin state updates must be centralized');
assert.match(source, /if \(btn\.dataset\.hwxPinState === state\) return;/,
  'unchanged pin state must not rewrite the SVG');
assert.doesNotMatch(source, /function isRealMessageRow\(row\)[\s\S]*?row\.getBoundingClientRect\(\)/,
  'row eligibility must not force layout during observer sync');
assert.match(source, /const candidates = rows \|\| container\.querySelectorAll\('\[data-msg-idx\]'\);/,
  'full scans are allowed only for initial/manual decoration, not observer sync');
assert.doesNotMatch(source, /try \{ onMutations\(\); \} catch \(_\) \{\}/,
  'observer sync must pass its affected-row set into onMutations');

console.log('ok - message-pins observer sync regression guard passed');
