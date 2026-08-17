#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionSource = readFileSync(
  path.join(repoRoot, 'extensions/mobile-haptics/assets/mobile-haptics.js'),
  'utf8'
);

function createHarness({
  registerMode = 'valid',
  settingValue = true,
  settingWriteAccepted = true,
  vibrateSupported = true,
} = {}) {
  const registrations = [];
  const subscriptions = [];
  const vibrateCalls = [];
  const settingGets = [];
  const settingSets = [];
  const warnings = [];
  const infos = [];
  const timers = [];
  const documentLookups = [];
  let setting = settingValue;

  const settings = {
    supported: true,
    get(key) {
      settingGets.push(key);
      return key === 'enabled' ? setting : undefined;
    },
    set(key, value) {
      settingSets.push([key, value]);
      if (!settingWriteAccepted) {
        return { ok: false, values: { enabled: setting }, errors: { storage: 'unavailable' } };
      }
      if (key === 'enabled') setting = value;
      return { ok: true, values: { enabled: setting }, errors: {} };
    },
  };

  const events = {
    on(type, handler) {
      subscriptions.push({ type, handler });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = subscriptions.findIndex(
          (subscription) => subscription.type === type && subscription.handler === handler
        );
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
  };

  const handle = {
    id: 'mobile-haptics',
    settings,
    events,
  };

  const hermesExt = {
    register(id) {
      registrations.push(id);
      return registerMode === 'null' ? null : handle;
    },
  };

  const document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) {
      documentLookups.push(id);
      return null;
    },
  };

  const navigator = vibrateSupported
    ? { vibrate(pattern) { vibrateCalls.push(Array.from(pattern)); } }
    : {};
  const console = {
    warn(message) { warnings.push(String(message)); },
    info(message) { infos.push(String(message)); },
    error(message) { warnings.push(String(message)); },
    log() {},
  };
  const window = { document, navigator };
  if (registerMode !== 'missing') window.hermesExt = hermesExt;

  const context = {
    window,
    document,
    navigator,
    console,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timers.length;
    },
    clearTimeout() {},
  };
  vm.createContext(context);

  function runScript() {
    vm.runInContext(extensionSource, context, { filename: 'mobile-haptics.js' });
  }

  function emit(type = 'turn:complete') {
    const event = {
      type,
      sessionId: 'session-test',
      streamId: 'stream-test',
      timestamp: 1700000000,
      endedAt: 1700000001,
      status: 'completed',
    };
    for (const subscription of [...subscriptions]) {
      if (subscription.type === type) subscription.handler(event);
    }
  }

  runScript();
  return {
    context,
    window,
    registrations,
    subscriptions,
    vibrateCalls,
    settingGets,
    settingSets,
    warnings,
    infos,
    timers,
    documentLookups,
    runScript,
    emit,
  };
}

function assertScopedRegistration(harness) {
  assert.deepEqual(harness.registrations, ['mobile-haptics'],
    'the extension must register its exact manifest ID');
  assert.deepEqual(harness.subscriptions.map(({ type }) => type), ['turn:complete'],
    'the extension must subscribe only to turn:complete');
}

// E0/B1 should work without any Core-owned DOM surface, retry timer, or
// legacy settings object. This is the primary regression guard for the move
// away from #btnSend polling.
{
  const harness = createHarness();
  assertScopedRegistration(harness);
  assert.deepEqual(harness.documentLookups, [], 'the extension must not look up #btnSend');
  assert.deepEqual(harness.timers, [], 'the extension must not install a retry timer');
}

// A normal completed turn produces exactly one short vibration.
{
  const harness = createHarness();
  harness.emit('turn:complete');
  assert.deepEqual(harness.vibrateCalls, [[18]],
    'turn:complete should vibrate once with the short completion pattern');
}

// Settings are read and written through the scoped handle only.
{
  const harness = createHarness({ settingValue: false });
  harness.emit('turn:complete');
  assert.deepEqual(harness.vibrateCalls, [], 'disabled settings must suppress vibration');
  const controls = harness.window.HermesMobileHapticsExtension;
  assert.ok(controls, 'the extension control surface should still be exposed');
  assert.strictEqual(controls.setEnabled(true), true,
    'setEnabled must report a successful scoped settings write');
  assert.deepEqual(harness.settingSets, [['enabled', true]],
    'setEnabled must write through the scoped settings handle');
  assert.equal(controls.isEnabled(), true, 'isEnabled should read the scoped setting');
  harness.emit('turn:complete');
  assert.deepEqual(harness.vibrateCalls, [[18]],
    'an enabled setting should allow the next completed turn to vibrate');
  assert.ok(harness.settingGets.includes('enabled'),
    'isEnabled should read the enabled key from scoped settings');
}

// A rejected Core settings write must be reported to the caller and must not
// change the value observed by a later read.
{
  const harness = createHarness({ settingValue: true, settingWriteAccepted: false });
  const controls = harness.window.HermesMobileHapticsExtension;
  assert.equal(controls.setEnabled(false), false,
    'setEnabled must report a rejected scoped settings write');
  assert.equal(controls.isEnabled(), true,
    'a rejected settings write must leave the prior enabled value unchanged');
  assert.deepEqual(harness.settingSets, [['enabled', false]],
    'the rejected write must still target the scoped enabled key');
}

// Unsupported platforms are a no-op and must not throw.
{
  const harness = createHarness({ vibrateSupported: false });
  const controls = harness.window.HermesMobileHapticsExtension;
  assert.ok(controls, 'the control surface should exist on unsupported platforms');
  assert.equal(controls.supported, false, 'unsupported navigator should be reported');
  assert.doesNotThrow(() => {
    harness.emit('turn:complete');
    assert.equal(controls.test(), false);
  });
  assert.deepEqual(harness.vibrateCalls, [], 'unsupported navigator must not vibrate');
}

// An unavailable registration capability fails closed: no event listener,
// no vibration, and an actionable warning. Exercise both missing and null
// registration results because old Core builds may expose either shape.
for (const registerMode of ['null', 'missing']) {
  const harness = createHarness({ registerMode });
  assert.deepEqual(harness.subscriptions, [],
    `${registerMode} registration must not subscribe to lifecycle events`);
  harness.emit('turn:complete');
  assert.deepEqual(harness.vibrateCalls, [],
    `${registerMode} registration must not vibrate`);
  assert.ok(harness.warnings.some((message) => /register|scoped|unavailable/i.test(message)),
    `${registerMode} registration must emit a clear warning`);
}

// The load guard must make repeated asset execution idempotent.
{
  const harness = createHarness();
  harness.runScript();
  assert.deepEqual(harness.registrations, ['mobile-haptics'],
    'repeated execution must not register the extension twice');
  assert.deepEqual(harness.subscriptions.map(({ type }) => type), ['turn:complete'],
    'repeated execution must not subscribe twice');
}

console.log('ok - mobile-haptics E0/B1 lifecycle contract passed');
