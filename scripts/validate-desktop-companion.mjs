import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve('extensions/desktop-companion');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

function assertFile(rel) {
  assert.ok(statSync(path.join(root, rel)).isFile(), `${rel} should exist`);
}

function assertIncludesAll(actual, expected, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} should include ${item}`);
  }
}

const entry = readJson('extension.json');
const manifest = readJson('manifest.json');
const runtime = manifest.extensions[0];

assert.equal(entry.id, 'desktop-companion');
assert.equal(runtime.id, entry.id);
assert.deepEqual(entry.capabilities, ['manifest-bundle', 'loopback-sidecar']);
assert.ok(!entry.capabilities.includes('sidecar-proxy'));
assert.deepEqual(entry.assets.stylesheets, []);
assert.deepEqual(runtime.stylesheets, []);
assertIncludesAll(entry.permissions.webui_api.read, ['sessions', 'session'], 'webui_api.read');
assertIncludesAll(
  entry.permissions.webui_api.write,
  ['session/draft', 'approval/respond', 'clarify/respond'],
  'webui_api.write'
);
assert.equal(entry.permissions.webui_navigation, true);
assert.deepEqual(entry.permissions.sidecar_commands, {
  from_loopback: true,
  can_switch_sessions: true,
  can_write_drafts: true,
  can_autosend: true,
  can_respond_approval: true,
  can_respond_clarify: true
});
assert.deepEqual(entry.permissions.dom, {
  owned: false,
  mutates_core_views: false
});
assertIncludesAll(
  entry.permissions.storage.owned,
  ['hermes-pet-navigation-last-id', 'hermes-pet-action-last-id'],
  'storage.owned'
);

for (const rel of [...entry.assets.scripts, ...entry.assets.stylesheets]) {
  assertFile(rel);
}
for (const rel of [...runtime.scripts, ...runtime.stylesheets]) {
  assertFile(rel);
}

const adapterPath = path.join(root, 'assets/companion-adapter.js');
const check = spawnSync(process.execPath, ['--check', adapterPath], {
  encoding: 'utf8'
});
assert.equal(check.status, 0, check.stderr || check.stdout);

const adapter = readFileSync(adapterPath, 'utf8');
assert.match(adapter, /fetch\('\/api\/sessions'/);
assert.match(adapter, /\/api\/session\?/);
assert.match(adapter, /\/api\/session\/draft/);
assert.match(adapter, /\/api\/approval\/respond/);
assert.match(adapter, /\/api\/clarify\/respond/);
assert.match(adapter, /\/api\/pet\/navigation/);
assert.match(adapter, /\/api\/pet\/actions/);
assert.match(adapter, /window\.loadSession/);
assert.match(adapter, /switchPanel/);
assert.match(adapter, /window\.location\.assign/);
assert.match(adapter, /sendFn\(\)/);
assert.match(adapter, /hermes-pet-navigation-last-id/);
assert.match(adapter, /hermes-pet-action-last-id/);
assert.match(adapter, /\/api\/webui\/snapshot/);
assert.match(adapter, /inPagePet:\s*false/);
assert.match(adapter, /canReceiveActions:\s*true/);
assert.doesNotMatch(adapter, /document\.createElement/);
assert.doesNotMatch(adapter, /hwc-/);
assert.doesNotMatch(adapter, /spritesheetUrl/);
assert.doesNotMatch(adapter, /\/extensions\/pets\//);

for (const id of ['keeper', 'shiba', 'courier']) {
  const pet = readJson(`pets/${id}/pet.json`);
  assert.equal(pet.id, id);
  assertFile(`pets/${id}/spritesheet.webp`);
  assert.ok(
    statSync(path.join(root, 'pets', id, 'spritesheet.webp')).size > 1024,
    `${id} spritesheet should be present`
  );
}

console.log('desktop-companion validation passed');
