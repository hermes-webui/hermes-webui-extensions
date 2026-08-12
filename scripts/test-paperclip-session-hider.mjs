#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extensions/paperclip-session-hider/assets/paperclip-session-hider.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : !!force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
  contains(name) { return this.values.has(name); }
}

const fakeDocument = {
  readyState: 'loading',
  addEventListener() {},
  getElementById() { return null; },
  documentElement: { dataset: {} },
};

const context = {
  window: {},
  document: fakeDocument,
  localStorage: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  },
  URLSearchParams,
  Map,
  Set,
  Date,
  JSON,
  String,
  Array,
  Number,
  Object,
  Error,
  console,
  fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame(fn) { fn(); return 1; },
  clearTimeout() {},
  setTimeout(fn) { fn(); return 1; },
};
context.window = context;
vm.runInNewContext(source, context, { filename: 'paperclip-session-hider.js' });

const api = context.window.hermesExt.paperclipSessionHider;
assert.equal(typeof api.shouldHideSession, 'function');
assert.equal(typeof api.isToolSourceSession, 'function');

const generic = { session_id: 'a', title: 'Tool Session', session_source: 'tool', raw_source: 'tool' };
const named = { session_id: 'b', title: 'PATA-434 Final Merge Approval', session_source: 'tool', raw_source: 'tool' };
const webuiNamedTool = { session_id: 'c', title: 'Tool Session', session_source: 'webui', raw_source: 'webui' };
const cron = { session_id: 'd', title: 'Daily Infrastructure Cheatsheet', session_source: 'cron', raw_source: 'cron' };
const paperclipSource = { session_id: 'e', title: 'Tool', source_label: 'Paperclip' };

assert.equal(api.shouldHideSession(generic, { enabled: true, mode: 'generic-tool' }), true, 'generic tool source rows are hidden by default');
assert.equal(api.shouldHideSession(named, { enabled: true, mode: 'generic-tool' }), false, 'named approval/tool rows stay visible by default');
assert.equal(api.shouldHideSession(named, { enabled: true, mode: 'all-tool-source' }), true, 'all-tool mode hides named tool-origin rows');
assert.equal(api.shouldHideSession(webuiNamedTool, { enabled: true, mode: 'generic-tool' }), false, 'explicit WebUI metadata prevents title-only false positives');
assert.equal(api.shouldHideSession({ session_id: '20260710_080154_1fa39a', title: 'Tool Session' }, { enabled: true, mode: 'generic-tool' }), true, 'missing source metadata still uses generated-id fallback');
assert.equal(api.shouldHideSession({ session_id: '20260710_080154_1fa39a', title: 'Tool Session', source_label: 'WebUI' }, { enabled: true, mode: 'generic-tool' }), false, 'explicit non-tool source blocks generated-id fallback');
assert.equal(api.shouldHideSession(cron, { enabled: true, mode: 'all-tool-source' }), false, 'cron rows are never hidden');
assert.equal(api.shouldHideSession(null, { enabled: true, mode: 'generic-tool' }, 'Tool Session'), false, 'DOM fallback without a generated session id does not hide user rows');
assert.equal(api.shouldHideSession(null, { enabled: true, mode: 'generic-tool' }, 'Tool Session', '20260710_080154_1fa39a'), true, 'DOM fallback hides generic generated tool session ids while metadata is unavailable');
assert.equal(api.shouldHideSession(null, { enabled: true, mode: 'generic-tool' }, 'PATA-434 Final Merge Approval', '20260709_235243_5be8d5'), false, 'DOM fallback does not hide named sessions');
assert.equal(api.shouldHideSession(paperclipSource, { enabled: true, mode: 'generic-tool' }), true, 'Paperclip source label is treated as tool-origin');
assert.equal(api.shouldHideSession(generic, { enabled: false, mode: 'all-tool-source' }), false, 'disabled setting unhides rows');

const settingsApiCalls = [];
context.window.HermesExtensionSettings = {
  settingsForExtension(id) {
    assert.equal(id, 'paperclip-session-hider');
    return {
      supported: true,
      get(key) {
        settingsApiCalls.push(key);
        return key === 'enabled' ? false : 'all-tool-source';
      },
    };
  },
};
const loadedSettings = api.loadSettings();
assert.equal(loadedSettings.enabled, false, 'settings enabled flag is read through the documented .get(key) API');
assert.equal(loadedSettings.mode, 'all-tool-source', 'settings mode is read through the documented .get(key) API');
assert.deepEqual(settingsApiCalls, ['enabled', 'mode'], 'settings API reads both declared keys');
delete context.window.HermesExtensionSettings;

const row = {
  dataset: { sid: 'a' },
  classList: new FakeClassList(),
  attrs: {},
  titleText: 'Tool Session',
  querySelector(selector) {
    if (selector === '.session-title') return { textContent: this.titleText };
    return null;
  },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
};

assert.equal(api.isGenericToolTitle('  Tool   Session  '), true, 'title normalization is whitespace tolerant');
assert.equal(api.isGeneratedToolSessionId('20260710_080154_1fa39a'), true, 'generated tool session id fallback shape is recognized');
assert.equal(api.isGeneratedToolSessionId('ed941f8728f3'), false, 'normal WebUI hex ids are not treated as generated tool session ids');
assert.equal(api.isToolSourceSession({ source_tag: 'TOOL' }), true, 'source matching is case-insensitive');
assert.equal(api.isToolSourceSession({ source_label: 'WebUI' }), false, 'ordinary source label is not matched');

console.log('paperclip-session-hider tests passed');
