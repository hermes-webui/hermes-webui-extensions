#!/usr/bin/env node
// Behavior tests for the `user-avatar` extension. Runs the real asset in a node:vm
// sandbox with a fake DOM (same approach as test-mobile-haptics.mjs) and drives it
// through a faithful mirror of Core's Configure invocation contract
// (HermesExtensionSettings._invokeConfigure: one frozen {opener, restoreFocus}
// options object, settle-once pending state, fail path).
//
// Covered boundaries: disabled by default; attribute/custom-property-only
// decoration with NO child nodes injected into user rows; Configure open/close/
// Escape/backdrop/focus-trap and single settlement; scoped-storage authority and
// legacy-key migration; the media caps (type, bytes, dimensions, pixels) and the
// absence of any raw synchronous image setter; storage-failure reporting; and a
// teardown that no queued callback can undo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(
  path.join(repoRoot, 'extensions/user-avatar/assets/user-avatar.js'),
  'utf8'
);

const PANEL_ID = 'hwx-uav-panel';
const LEGACY_IMAGE_KEY = 'hermes-ext-user-avatar';
const PNG = 'data:image/png;base64,AAAABBBBCCCC==';
const PNG2 = 'data:image/png;base64,DDDDEEEEFFFF==';
const GIF = 'data:image/gif;base64,AAAABBBBCCCC==';

class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(k, v) { this.props.set(k, String(v)); }
  removeProperty(k) { this.props.delete(k); }
  getPropertyValue(k) { return this.props.get(k) || ''; }
}

class FakeEl {
  constructor(tag, doc) {
    this.tagName = (tag || 'div').toUpperCase();
    this.doc = doc || null;
    this.attrs = new Map();
    this.style = new FakeStyle();
    this.children = [];     // asserted to stay empty for user rows
    this.parent = null;
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.type = '';
    this.disabled = false;
    this.hidden = false;
    this.focusCount = 0;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this.listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  emit(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev)); }
  click() { this.emit('click', { target: this }); }
  focus() { this.focusCount += 1; if (this.doc) this.doc.activeElement = this; }
  descendants() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
    return out;
  }
  matches(selector) { return matchesSelector(this, selector); }
  contains(node) { return node === this || this.descendants().includes(node); }
  querySelectorAll(selector) {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    return this.descendants().filter((el) => parts.some((p) => matchesSelector(el, p)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getContext() {
    return { drawImage(...args) { canvasDraws.push(args); } };
  }
  toDataURL(type) { return type === 'image/jpeg' ? canvasJpeg : canvasPng; }
  get nodeType() { return 1; }
}

// Selector support limited to the forms the extension actually uses.
function matchesSelector(el, selector) {
  if (!el) return false;
  const classes = String(el.className || '').split(/\s+/).filter(Boolean);
  if (selector === '.msg-row[data-role="user"]') {
    return classes.includes('msg-row') && el.getAttribute('data-role') === 'user';
  }
  if (selector === '.msg-row[data-role="user"]:not([data-hwx-uav])') {
    return matchesSelector(el, '.msg-row[data-role="user"]') && !el.hasAttribute('data-hwx-uav');
  }
  if (selector === '[data-hwx-uav]') return el.hasAttribute('data-hwx-uav');
  if (selector === 'button') return el.tagName === 'BUTTON';
  if (selector === 'select') return el.tagName === 'SELECT';
  if (selector === 'input:not([type="file"])') return el.tagName === 'INPUT' && el.type !== 'file';
  if (selector.startsWith('.')) return classes.includes(selector.slice(1));
  return false;
}

let canvasDraws = [];
let canvasPng = PNG;
let canvasJpeg = PNG2;

function createHarness({
  settingsSupported = true,
  storageSupported = true,
  legacyImage = null,
  storageWritesFail = false,
  image = null,
  legacyScalars = null,
  settingsSchemaDefaults = null,
  settingsWritesFail = false,
  localWritesFail = false,
  scoped = null,
  overridesSupported = true,
  unsupportedSettings = false,
} = {}) {
  let failSettings = settingsWritesFail;
  let failLocal = localWritesFail;
  canvasDraws = [];
  canvasPng = PNG;
  canvasJpeg = PNG2;

  const store = new Map();               // raw localStorage
  const extStore = new Map();            // Core's scoped ext storage record
  const settingsBackend = new Map([['enabled', undefined], ['size', undefined], ['mobile', undefined]]);
  const intervals = new Map();
  const rafs = new Map();
  const observers = [];
  const clearedIntervals = [];
  const canceledRafs = [];
  let rafSeq = 0;
  let intervalSeq = 0;
  let configureHook = null;

  if (legacyImage) store.set(LEGACY_IMAGE_KEY, legacyImage);
  if (image) extStore.set('image', image);
  if (legacyScalars) for (const [k, v] of Object.entries(legacyScalars)) store.set(k, String(v));
  if (scoped) for (const [k, v] of Object.entries(scoped)) settingsBackend.set(k, v);

  const settings = settingsSupported ? {
    supported: !unsupportedSettings,
    // Real Core answers a SCHEMA DEFAULT for an unset key rather than undefined;
    // settingsSchemaDefaults models that so the migration path is exercised honestly.
    get(key) {
      const v = settingsBackend.get(key);
      if (v === undefined && settingsSchemaDefaults && key in settingsSchemaDefaults) {
        return settingsSchemaDefaults[key];
      }
      return v;
    },
    set(key, value) {
      if (failSettings) return { ok: false };
      settingsBackend.set(key, value); return { ok: true };
    },
    // Mirrors Core's overridesFromValues(): only values that differ from the
    // schema default count as an explicit user choice.
    get overrides() {
      if (!overridesSupported) return undefined;
      const out = {};
      for (const [k, v] of settingsBackend) {
        if (v === undefined) continue;
        if (settingsSchemaDefaults && k in settingsSchemaDefaults && settingsSchemaDefaults[k] === v) continue;
        out[k] = v;
      }
      return out;
    },
    // Mirrors Core's registerConfigureHandler(): returns an unregister disposer.
    registerConfigure(fn) {
      configureHook = fn;
      let active = true;
      return () => { if (!active) return false; active = false; if (configureHook === fn) configureHook = null; return true; };
    },
  } : undefined;

  // Mirrors Core's storageAccessor: a namespaced record, get/set/remove/clear,
  // set/remove returning false when the write cannot be persisted.
  const storage = storageSupported ? {
    getAll() { return Object.fromEntries(extStore); },
    get(name, dflt) { return extStore.has(name) ? extStore.get(name) : dflt; },
    set(name, value) { if (storageWritesFail) return false; extStore.set(name, value); return true; },
    remove(name) { if (storageWritesFail) return false; extStore.delete(name); return true; },
    clear() { extStore.clear(); return true; },
  } : undefined;

  const document = {
    readyState: 'complete',
    activeElement: null,
    addEventListener(t, fn) { (documentListeners[t] = documentListeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = documentListeners[t]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    getElementById(id) {
      if (id === 'messages') return messages;
      return root.descendants().find((el) => el.id === id) || null;
    },
    querySelector(sel) { return document.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return root.descendants().filter((el) => matchesSelector(el, sel)); },
    createElement(tag) { return new FakeEl(tag, document); },
  };
  const documentListeners = {};

  // A single tree so document-wide queries see rows AND the Configure panel.
  const root = new FakeEl('html', document);
  const rootEl = new FakeEl('html', document);
  const body = new FakeEl('body', document);
  const messages = new FakeEl('div', document);
  root.appendChild(body);
  body.appendChild(messages);
  document.documentElement = rootEl;
  document.body = body;

  function addUserRow() {
    const r = new FakeEl('div', document);
    r.className = 'msg-row';
    r.attrs.set('data-role', 'user');
    messages.appendChild(r);
    return r;
  }
  const userRows = [addUserRow(), addUserRow(), addUserRow()];

  const windowListeners = {};
  const window = {
    document,
    hermesExt: { register(id) { return { id, settings, storage }; } },
    addEventListener(t, fn) { (windowListeners[t] = windowListeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = windowListeners[t]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
  };

  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (failLocal) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }

  const fileReaders = [];
  class FileReader {
    readAsDataURL(file) { fileReaders.push({ reader: this, file }); }
  }
  const images = [];
  class Image {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; images.push(this); }
    set src(v) { this._src = v; }
    get src() { return this._src; }
  }

  const context = {
    window,
    document,
    localStorage,
    MutationObserver,
    FileReader,
    Image,
    console: { warn() {}, info() {}, log() {}, error() {} },
    requestAnimationFrame(cb) { rafSeq += 1; rafs.set(rafSeq, cb); return rafSeq; },
    cancelAnimationFrame(id) { canceledRafs.push(id); rafs.delete(id); },
    setInterval(fn, ms) { intervalSeq += 1; intervals.set(intervalSeq, { fn, ms }); return intervalSeq; },
    clearInterval(id) { clearedIntervals.push(id); intervals.delete(id); },
    setTimeout() { return 0; },
    clearTimeout() {},
    Promise,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'user-avatar.js' });

  return {
    context, window, document, documentListeners, rootEl, body, messages,
    userRows, addUserRow, store, extStore, settingsBackend,
    intervals, clearedIntervals, rafs, canceledRafs, observers, windowListeners,
    fileReaders, images,
    api: () => window.HermesUserAvatarExtension,
    configureHook: () => configureHook,
    failWrites: () => { failSettings = true; },
    panel: () => document.getElementById(PANEL_ID),
    flushRafs() {
      const queued = Array.from(rafs.entries());
      rafs.clear();
      queued.forEach(([, cb]) => cb());
    },
    fireKeydown(ev) { (documentListeners.keydown || []).slice().forEach((fn) => fn(ev)); },
  };
}

// Faithful mirror of Core's invokeConfigure (static/extension_settings.js):
// one frozen {opener, restoreFocus} argument, pending until the returned promise
// settles, settle-once, and opener focus restored by Core exactly once.
function coreConfigure(h) {
  const hook = h.configureHook();
  assert.equal(typeof hook, 'function', 'a Configure handler is registered');
  const opener = h.document.createElement('button');
  h.body.appendChild(opener);
  let pending = false;
  let settleCount = 0;
  let restoreFocusCalls = 0;
  let failures = 0;
  let handlerArg = null;

  function settle() {
    if (!pending) return false;
    pending = false;
    settleCount += 1;
    opener.focus();
    return true;
  }

  function invoke() {
    if (pending) return false;      // Core suppresses duplicate Configure while pending
    pending = true;
    let result;
    const options = Object.freeze({
      opener,
      restoreFocus() { restoreFocusCalls += 1; return settle(); },
    });
    handlerArg = options;
    try { result = hook(options); }
    catch (err) { failures += 1; settle(); return true; }
    const then = result && (typeof result === 'object' || typeof result === 'function')
      ? result.then : null;
    if (typeof then === 'function') {
      then.call(result, settle, () => { failures += 1; settle(); });
    }
    return true;
  }

  return {
    opener, invoke,
    get pending() { return pending; },
    get settleCount() { return settleCount; },
    get restoreFocusCalls() { return restoreFocusCalls; },
    get failures() { return failures; },
    get handlerArg() { return handlerArg; },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function noChildrenInjected(h) {
  return h.userRows.every((r) => r.children.length === 0);
}
function panelControl(h, cls) {
  const p = h.panel();
  return p ? p.querySelector('.' + cls) : null;
}

// ── disabled by default ─────────────────────────────────────────────────────
{
  const h = createHarness();
  assert.ok(h.api(), 'extension must expose window.HermesUserAvatarExtension');
  assert.equal(h.api().isEnabled(), false, 'must be disabled by default');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null,
    'root must not carry data-hwx-uav-on when disabled');
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')),
    'no user row may be marked when disabled');
  assert.ok(noChildrenInjected(h), 'must never inject child nodes into user rows');
}

// ── enabling decorates via attributes + custom properties only ──────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), '1', 'enabling sets the root flag');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '32px',
    'default (medium) size maps to 32px');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), 'hide',
    'default narrow-screen mode is hide');
  assert.ok(h.userRows.every((r) => r.getAttribute('data-hwx-uav') === '1'),
    'every visible user row is marked when enabled');
  assert.ok(noChildrenInjected(h), 'decoration must not inject child nodes');
}

// ── size + mobile settings map through ──────────────────────────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  h.settingsBackend.set('size', 'large');
  h.settingsBackend.set('mobile', 'compact');
  h.api().refresh();
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '44px', 'large -> 44px');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), 'compact', 'compact mobile mode applied');
  h.settingsBackend.set('size', 'gigantic');
  h.api().refresh();
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '32px', 'invalid size -> medium fallback');
}

// ── idempotency + disable returns the transcript to stock ───────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  h.api().refresh(); h.api().refresh();
  assert.ok(h.userRows.every((r) => r.getAttribute('data-hwx-uav') === '1'),
    'rows stay marked exactly once (attribute, not appended nodes)');
  assert.ok(noChildrenInjected(h), 'repeated apply must not inject child nodes');
  h.api().setEnabled(false);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null, 'disable clears the root flag');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '', 'disable clears the size var');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), null, 'disable clears the mobile attr');
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')), 'disable unmarks all rows');
}

// ── STORAGE AUTHORITY: the image lives in the scoped namespace ──────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  const res = h.api().clearImage();
  assert.equal(res.ok, true, 'clearing through scoped storage succeeds');
  assert.equal(h.store.has(LEGACY_IMAGE_KEY), false,
    'the raw localStorage key is never written when scoped storage exists');
}
{
  // Core's Settings -> "Clear extension storage" wipes the scoped IMAGE record.
  // The separate `enabled` setting is NOT storage, so it survives: the avatar
  // falls back to the neutral placeholder rather than disappearing.
  const h = createHarness({ image: PNG });
  h.api().setEnabled(true);
  assert.equal(h.api().getImage(), PNG, 'image is read back from scoped storage');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-img'), 'url("' + PNG + '")',
    'the scoped image is applied as a url() custom property');
  h.extStore.clear();                                  // == storage.clear() from Core
  h.api().refresh();
  assert.equal(h.api().getImage(), '', 'clearing extension storage removes the image');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-img'), 'none',
    'the image custom property is cleared after Core clears extension storage');
  assert.equal(h.api().isEnabled(), true,
    'the enabled setting survives a storage clear (placeholder remains, not stock)');
}
{
  // Legacy raw-key migration: moved into scoped storage, raw key deleted.
  const h = createHarness({ legacyImage: PNG });
  assert.equal(h.extStore.get('image'), PNG, 'a legacy raw-key image is migrated into scoped storage');
  assert.equal(h.store.has(LEGACY_IMAGE_KEY), false, 'the legacy raw key is removed after migration');
  assert.equal(h.api().getImage(), PNG, 'the migrated image is readable');
}
{
  // Migration must not destroy the legacy value if the scoped write is refused.
  const h = createHarness({ legacyImage: PNG, storageWritesFail: true });
  assert.equal(h.store.get(LEGACY_IMAGE_KEY), PNG,
    'a refused migration keeps the legacy key rather than losing the image');
}
{
  // No scoped storage (older core) -> the declared owned raw key is the fallback.
  const h = createHarness({ storageSupported: false });
  assert.equal(h.api().storageBackend, 'localStorage', 'reports the localStorage image fallback');
}

// ── MEDIA BOUNDS: one canonicalization path, no raw setter ──────────────────
{
  const h = createHarness();
  assert.equal(typeof h.api().setImage, 'undefined',
    'no raw synchronous setImage may exist — it would bypass every media bound');
  assert.equal(typeof h.api().setImageFile, 'function', 'the file path is the only writer');
}
function makeFile(type, size) { return { type, size: size === undefined ? 1024 : size }; }
async function runFile(h, file, { width = 64, height = 64, failRead = false, failDecode = false } = {}) {
  const p = h.api().setImageFile(file);
  await tick();
  const pending = h.fileReaders.pop();
  if (pending) {
    if (failRead) { pending.reader.onerror(); }
    else {
      pending.reader.result = 'data:image/png;base64,SOURCE==';
      pending.reader.onload();
      await tick();
      const im = h.images.pop();
      if (im) {
        if (failDecode) im.onerror();
        else { im.naturalWidth = width; im.naturalHeight = height; im.onload(); }
      }
    }
  }
  return p;
}
{
  const h = createHarness();
  assert.deepEqual((await runFile(h, makeFile('image/gif'))).ok, false,
    'GIF is rejected — issue #63 scopes this to PNG/JPEG/WebP');
  assert.match((await runFile(h, makeFile('image/gif'))).error, /PNG, JPEG, or WebP/,
    'the GIF rejection names the accepted formats');
  assert.equal((await runFile(h, makeFile('image/png', 9 * 1024 * 1024))).ok, false,
    'a source over 8 MB is rejected on bytes');
  assert.equal(canvasDraws.length, 0, 'no canvas work happens for a rejected source');
}
{
  const h = createHarness();
  const tooWide = await runFile(h, makeFile('image/png', 1024), { width: 4097, height: 10 });
  assert.equal(tooWide.ok, false, 'a decoded side over 4096px is rejected');
  assert.match(tooWide.error, /4096px \/ 16 megapixels/, 'the dimension error states the bound');
  assert.equal(canvasDraws.length, 0,
    'the dimension cap is enforced BEFORE any canvas work — a small file that decodes huge cannot exhaust memory');

  const tooManyPixels = await runFile(h, makeFile('image/png', 1024), { width: 4096, height: 4097 });
  assert.equal(tooManyPixels.ok, false, 'a decoded image over 16 megapixels is rejected');
  assert.equal(canvasDraws.length, 0, 'the pixel cap also precedes canvas work');

  const zero = await runFile(h, makeFile('image/png', 1024), { width: 0, height: 0 });
  assert.equal(zero.ok, false, 'an image with no dimensions is rejected');
}
{
  const h = createHarness();
  h.api().setEnabled(true);
  const ok = await runFile(h, makeFile('image/png', 1024), { width: 512, height: 256 });
  assert.equal(ok.ok, true, 'an in-bounds PNG is accepted');
  assert.equal(ok.image, PNG, 'the stored value is the canonicalized canvas output');
  assert.equal(canvasDraws.length, 1, 'exactly one draw for an accepted image');
  assert.equal(h.extStore.get('image'), PNG, 'the accepted image is published to scoped storage');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-img'), 'url("' + PNG + '")',
    'the accepted image is applied');
}
{
  // The canvas output itself is bounded: an oversized data-URL is refused.
  const h = createHarness();
  canvasPng = 'data:image/png;base64,' + 'A'.repeat(200 * 1024);
  canvasJpeg = 'data:image/png;base64,' + 'B'.repeat(200 * 1024);
  const res = await runFile(h, makeFile('image/png', 1024), { width: 512, height: 512 });
  assert.equal(res.ok, false, 'a canonicalized image that stays over the byte cap is refused');
  assert.equal(h.extStore.has('image'), false, 'nothing oversized reaches storage');
}
{
  // A syntactically valid but non-accepted data-URL never becomes storable.
  const h = createHarness();
  canvasPng = GIF; canvasJpeg = GIF;
  const res = await runFile(h, makeFile('image/png', 1024), { width: 64, height: 64 });
  assert.equal(res.ok, false, 'a GIF data-URL is not a storable canonical output');
}
{
  const h = createHarness();
  const readFail = await runFile(h, makeFile('image/png', 1024), { failRead: true });
  assert.equal(readFail.ok, false, 'a FileReader error resolves as a failure, never a hang');
  const decodeFail = await runFile(h, makeFile('image/png', 1024), { failDecode: true });
  assert.equal(decodeFail.ok, false, 'an undecodable image resolves as a failure');
}
{
  // Storage failure must be reported, and must preserve the previous image.
  const failing = createHarness({ image: PNG2, storageWritesFail: true });
  failing.api().setEnabled(true);
  const res = await runFile(failing, makeFile('image/png', 1024), { width: 64, height: 64 });
  assert.equal(res.ok, false, 'a refused publication is reported as a failure, not "Saved."');
  assert.match(res.error, /storage is full or unavailable/, 'the failure names the real cause');
  assert.equal(failing.api().getImage(), PNG2, 'the previous image survives a failed publication');
}

// ── CONFIGURE: a refused settings write must not leave a lying control ──────
// On a Core WITH scoped settings the scoped store is the only store. A refusal
// there means the requested value is not in effect, so the control must revert,
// say so, and leave no raw localStorage copy behind that a later downgrade would
// pick up as if it had been saved.
{
  const h = createHarness({ settingsWritesFail: true, localWritesFail: false,
    settingsSchemaDefaults: { enabled: false, size: 'medium', mobile: 'hide' } });
  const core = coreConfigure(h);
  core.invoke();
  const box = h.panel().querySelector('input:not([type="file"])');
  const wasEnabled = h.api().isEnabled();
  box.checked = !wasEnabled;
  box.emit('change', {});
  assert.equal(box.checked, wasEnabled,
    'a refused write restores the checkbox to the authoritative value');
  assert.equal(h.api().isEnabled(), wasEnabled,
    'a refused write does not change the effective state');
  assert.equal(panelControl(h, 'hwx-uav-status').textContent,
    'Could not save that setting.',
    'a refused write reports the failure instead of silently doing nothing');
  // The select must also revert. Enable first (via the API, which bypasses the
  // panel) so a real size is applied and "unchanged" is a meaningful assertion
  // rather than trivially true against an unset custom property.
  const h2 = createHarness({ settingsSchemaDefaults: { enabled: false, size: 'medium', mobile: 'hide' } });
  const core2 = coreConfigure(h2);
  h2.api().setEnabled(true);
  core2.invoke();
  const appliedSize = h2.rootEl.style.getPropertyValue('--hwx-uav-size');
  assert.equal(appliedSize, '32px', 'medium is applied before the refused write');
  h2.failWrites();
  const sel = h2.panel().querySelectorAll('select')[0];
  sel.value = 'large';
  sel.emit('change', {});
  assert.equal(sel.value, 'medium',
    'a refused select write restores the select to the authoritative value');
  assert.equal(h2.rootEl.style.getPropertyValue('--hwx-uav-size'), '32px',
    'a refused select write does not apply the unsaved value');
  assert.equal(panelControl(h2, 'hwx-uav-status').textContent,
    'Could not save that setting.',
    'a refused select write reports the failure');
  // Same guard on the narrow-screen select.
  const selMobile = h2.panel().querySelectorAll('select')[1];
  selMobile.value = 'compact';
  selMobile.emit('change', {});
  assert.equal(selMobile.value, 'hide',
    'a refused narrow-screen write restores the select to the authoritative value');
  assert.equal(h2.rootEl.getAttribute('data-hwx-uav-mobile'), 'hide',
    'a refused narrow-screen write does not apply the unsaved value');
  assert.ok(['hermes-ext-user-avatar-enabled', 'hermes-ext-user-avatar-size',
    'hermes-ext-user-avatar-mobile'].every((k) => !h.store.has(k) && !h2.store.has(k)),
    'no refused value is persisted to a raw key a later downgrade could read');
}

// ── CONFIGURE: Core's real contract, settled exactly once ───────────────────
{
  const h = createHarness();
  const core = coreConfigure(h);
  assert.equal(core.invoke(), true, 'Core accepts the first Configure invocation');
  assert.equal(core.pending, true, 'Configure is pending while the panel is open');
  assert.ok(h.panel(), 'an extension-owned panel is opened');
  // The handler is called with Core's options object, NOT a DOM host.
  assert.equal(typeof core.handlerArg, 'object', 'the handler receives an options object');
  assert.equal(typeof core.handlerArg.contains, 'undefined',
    'the options object is not a DOM node — the handler must not treat it as a host');
  assert.equal(h.body.children.includes(h.panel()), true, 'the panel is mounted on body, not on the options object');
  const card = h.panel().querySelector('.hwx-uav-card');
  assert.equal(card.getAttribute('role'), 'dialog', 'the panel carries dialog semantics');
  assert.equal(card.getAttribute('aria-modal'), 'true', 'the dialog is modal');
  await tick();
  assert.equal(core.pending, true, 'the promise does not settle merely because a microtask ran');

  panelControl(h, 'hwx-uav-x').click();
  await tick();
  assert.equal(core.pending, false, 'closing via X settles the Configure promise');
  assert.equal(core.settleCount, 1, 'Configure settles exactly once');
  assert.equal(core.restoreFocusCalls, 0,
    'the extension does not call restoreFocus itself — Core restores opener focus on settlement');
  assert.equal(core.opener.focusCount, 1, 'Core restored opener focus exactly once');
  assert.equal(h.panel(), null, 'the panel is removed from the DOM on close');
  assert.equal((h.documentListeners.keydown || []).length, 0, 'the keydown trap is unbound on close');
}
{
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  h.fireKeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.equal(core.settleCount, 1, 'Escape closes and settles Configure');
  assert.equal(h.panel(), null, 'Escape removes the panel');
}
{
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  const overlay = h.panel();
  overlay.emit('click', { target: overlay });
  await tick();
  assert.equal(core.settleCount, 1, 'a backdrop click closes and settles Configure');
  // A click inside the card must NOT close it.
  const h2 = createHarness();
  const core2 = coreConfigure(h2);
  core2.invoke();
  const overlay2 = h2.panel();
  overlay2.emit('click', { target: overlay2.querySelector('.hwx-uav-card') });
  await tick();
  assert.equal(core2.pending, true, 'a click inside the card does not close the panel');
}
{
  // Focus trap: Tab from the last control wraps to the first, and back.
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  const panel = h.panel();
  const controls = panel.querySelectorAll('button, select, input:not([type="file"])');
  assert.ok(controls.length >= 4, 'the panel exposes its controls to the trap');
  assert.equal(h.document.activeElement, controls[0], 'opening focuses the first control');
  const file = panel.querySelector('.hwx-uav-file');
  assert.equal(controls.includes(file), false, 'the hidden file picker is excluded from the trap');

  const last = controls[controls.length - 1];
  last.focus();
  let prevented = 0;
  h.fireKeydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented += 1; } });
  assert.equal(h.document.activeElement, controls[0], 'Tab from the last control wraps to the first');
  h.fireKeydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
  assert.equal(h.document.activeElement, last, 'Shift+Tab from the first control wraps to the last');
  assert.equal(prevented, 2, 'the trap prevents the default Tab behavior at both edges');
  assert.equal(core.pending, true, 'trapping focus does not settle Configure');
}
{
  // Second open after a close reuses the same lifecycle cleanly.
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  panelControl(h, 'hwx-uav-x').click();
  await tick();
  assert.equal(core.invoke(), true, 'Configure can be invoked again after closing');
  assert.ok(h.panel(), 'the second invocation opens a fresh panel');
  panelControl(h, 'hwx-uav-x').click();
  await tick();
  assert.equal(core.settleCount, 2, 'each invocation settles exactly once');
  assert.equal(core.failures, 0, 'no Configure invocation fails');
}
{
  // A Configure invocation that cannot open must settle rather than hang.
  const h = createHarness();
  h.document.body = null;
  const core = coreConfigure(h);
  core.invoke();
  await tick();
  assert.equal(core.pending, false, 'a Configure that cannot mount settles immediately');
}
{
  // Panel edits reach the real settings/storage backends.
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  const box = h.panel().querySelector('input:not([type="file"])');
  box.checked = true;
  box.emit('change', {});
  assert.equal(h.api().isEnabled(), true, 'the panel toggle writes through to settings');
  const selects = h.panel().querySelectorAll('select');
  selects[0].value = 'large';
  selects[0].emit('change', {});
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '44px', 'the size select applies immediately');
  panelControl(h, 'hwx-uav-x').click();
  await tick();
}

// ── TEARDOWN: nothing queued may re-apply state ─────────────────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  assert.ok(h.observers.length >= 1 && h.observers[0].connected, 'observer is connected while installed');
  assert.equal((h.windowListeners.storage || []).length, 1, 'a storage listener is registered');
  assert.equal(h.intervals.size, 1, 'a single reconcile interval is installed');

  // Queue a RAF the way a transcript mutation would, then tear down before it runs.
  h.observers[0].cb();
  assert.equal(h.rafs.size, 1, 'a transcript mutation schedules exactly one frame');

  h.api().teardown();
  assert.ok(h.observers.every((o) => !o.connected), 'teardown disconnects every observer');
  assert.equal((h.windowListeners.storage || []).length, 0, 'teardown removes the storage listener');
  assert.equal(h.intervals.size, 0, 'teardown clears the reconcile interval');
  assert.equal(h.canceledRafs.length, 1, 'teardown cancels the pending frame');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null, 'teardown clears decoration');
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')), 'teardown unmarks every row');

  // Even if a frame callback survived cancellation, it must be inert.
  h.flushRafs();
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')),
    'a frame callback that still runs after teardown must not re-mark rows');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null,
    'a post-teardown callback must not re-apply the root flag');

  // A surviving reconcile tick and a storage event are inert too.
  h.api().refresh();
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null, 'refresh after teardown re-applies nothing');

  // Repeated teardown is inert.
  h.api().teardown();
  assert.equal(h.canceledRafs.length, 1, 'a second teardown cancels nothing further');
}
{
  // Row recycling: a marked row whose role changed loses the marker.
  const h = createHarness();
  h.api().setEnabled(true);
  const recycled = h.userRows[0];
  assert.equal(recycled.getAttribute('data-hwx-uav'), '1', 'the row starts marked');
  recycled.attrs.set('data-role', 'assistant');
  h.api().refresh();
  assert.equal(recycled.hasAttribute('data-hwx-uav'), false,
    'a recycled row that is no longer a user turn is unmarked');
  assert.ok(h.userRows.slice(1).every((r) => r.getAttribute('data-hwx-uav') === '1'),
    'still-user rows keep their marker');
}
{
  // Teardown clears markers regardless of the role a node currently holds.
  const h = createHarness();
  h.api().setEnabled(true);
  const recycled = h.userRows[0];
  recycled.attrs.set('data-role', 'assistant');   // marked, but no longer a user row
  h.api().teardown();
  assert.equal(recycled.hasAttribute('data-hwx-uav'), false,
    'teardown removes the marker from every element, independent of role');
}
{
  // Teardown while Configure is open closes the panel and settles it.
  const h = createHarness();
  const core = coreConfigure(h);
  core.invoke();
  assert.ok(h.panel(), 'the panel is open before teardown');
  h.api().teardown();
  await tick();
  assert.equal(h.panel(), null, 'teardown removes the Configure panel');
  assert.equal(core.settleCount, 1, 'teardown settles the pending Configure exactly once');
  assert.equal((h.documentListeners.keydown || []).length, 0, 'teardown unbinds the keydown trap');
}
{
  // Teardown unregisters the Configure hook through Core's disposer, so Settings
  // can no longer reopen the modal or reinstall its keydown trap.
  const h = createHarness();
  const handler = h.configureHook();
  assert.equal(typeof handler, 'function', 'Configure is registered while installed');
  h.api().teardown();
  assert.equal(h.configureHook(), null, 'teardown calls Core\'s unregister for the Configure hook');
  // A handler reference Core captured earlier (or an older Core with no
  // unregister) must still be inert after teardown: it settles, opens nothing.
  let settled = false;
  await handler({ opener: null, restoreFocus() {} }).then(() => { settled = true; });
  assert.equal(settled, true, 'a post-teardown Configure invocation settles immediately');
  assert.equal(h.panel(), null, 'a post-teardown Configure invocation opens no modal');
  assert.equal((h.documentListeners.keydown || []).length, 0, 'and binds no keydown trap');
}

// ── one authoritative store: raw keys are never written beside scoped settings ──
// With scoped settings available, the raw `hermes-ext-user-avatar-*` keys are only
// an older-Core leftover: folded in once on load and then deleted, never mirrored.
const DEFAULTS = { enabled: false, size: 'medium', mobile: 'hide' };
const RAW = { enabled: 'hermes-ext-user-avatar-enabled', size: 'hermes-ext-user-avatar-size',
  mobile: 'hermes-ext-user-avatar-mobile' };
{
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS });
  h.api().setEnabled(true);
  assert.equal(h.store.has(RAW.enabled), false,
    'a scoped write does not create a raw shadow copy');
  assert.equal(h.settingsBackend.get('enabled'), true, 'the scoped store holds the choice');
}
{
  // Upgrade from an older Core: validated raw scalars are adopted, then deleted.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS,
    legacyScalars: { [RAW.enabled]: 'true', [RAW.size]: 'large', [RAW.mobile]: 'compact' } });
  assert.equal(h.api().isEnabled(), true, 'an older-Core "enabled" survives the upgrade');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '44px',
    'an older-Core size survives the upgrade and is applied on first load');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), 'compact',
    'an older-Core narrow-screen mode survives the upgrade');
  assert.deepEqual([h.settingsBackend.get('enabled'), h.settingsBackend.get('size'),
    h.settingsBackend.get('mobile')], [true, 'large', 'compact'], 'the values now live in scoped settings');
  assert.ok(Object.values(RAW).every((k) => !h.store.has(k)), 'every adopted raw key is deleted');
  // A later native Reset (Core clears the overrides) must not be undone by a raw key.
  ['enabled', 'size', 'mobile'].forEach((k) => h.settingsBackend.set(k, undefined));
  h.api().refresh();
  assert.equal(h.api().isEnabled(), false, 'a native Reset after the upgrade is not resurrected');
}
{
  // A non-default scoped value always wins over an older-Core raw value.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS, scoped: { size: 'small' },
    legacyScalars: { [RAW.size]: 'large' } });
  assert.equal(h.settingsBackend.get('size'), 'small', 'the non-default scoped size is kept');
  assert.equal(h.store.has(RAW.size), false, 'the superseded raw key is deleted, not kept around');
}
{
  // Disclosed limitation: Core records a default-equal value as "no override", so a
  // scoped value equal to the default reads as unset and the raw value wins once.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS, scoped: { size: 'medium' },
    legacyScalars: { [RAW.size]: 'large' } });
  assert.equal(h.settingsBackend.get('size'), 'large',
    'a default-equal scoped value is indistinguishable from unset (README discloses this)');
  assert.equal(h.store.has(RAW.size), false, 'and the raw key is consumed, so it happens once');
}
{
  // Junk raw values are dropped, not adopted.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS,
    legacyScalars: { [RAW.size]: 'gigantic', [RAW.enabled]: 'yes' } });
  assert.equal(h.settingsBackend.get('size'), undefined, 'an invalid raw size is not adopted');
  assert.equal(h.api().isEnabled(), false, 'an invalid raw enabled value is not adopted');
  assert.ok(!h.store.has(RAW.size) && !h.store.has(RAW.enabled), 'junk raw keys are deleted');
}
{
  // A refused adoption keeps the raw key so the value is retried, never lost.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS, settingsWritesFail: true,
    legacyScalars: { [RAW.enabled]: 'true' } });
  assert.equal(h.store.get(RAW.enabled), 'true', 'a refused migration keeps the raw key');
}
{
  // A Core without the overrides accessor cannot prove what is explicit, so the
  // raw keys are left untouched rather than guessed at or deleted.
  const h = createHarness({ settingsSchemaDefaults: DEFAULTS, overridesSupported: false,
    legacyScalars: { [RAW.size]: 'large' } });
  assert.equal(h.store.get(RAW.size), 'large', 'without overrides the raw key is preserved');
  assert.equal(h.settingsBackend.get('size'), undefined, 'without overrides nothing is adopted');
}
{
  // Older Core (no scoped settings): the raw keys ARE the store. A raw write that
  // throws leaves the effective state unchanged, and a working one is honored.
  const h = createHarness({ settingsSupported: false, storageSupported: false, localWritesFail: true });
  assert.equal(h.api().setEnabled(true), false,
    'a refused raw write leaves the avatar off on an older Core');
  const ok = createHarness({ settingsSupported: false, storageSupported: false });
  assert.equal(ok.api().setEnabled(true), true, 'a working raw write enables it on an older Core');
  assert.equal(ok.store.get(RAW.enabled), 'true', 'the older-Core raw key is the store');
  // A Core that registers Configure but reports settings unsupported routes the
  // panel through the raw fallback; a throwing raw write must revert and report.
  const h3 = createHarness({ storageSupported: false, localWritesFail: true, unsupportedSettings: true });
  assert.equal(h3.api().settingsBackend, 'localStorage', 'settings.supported=false uses the raw fallback');
  const core3 = coreConfigure(h3);
  core3.invoke();
  const box3 = h3.panel().querySelector('input:not([type="file"])');
  box3.checked = true;
  box3.emit('change', {});
  assert.equal(box3.checked, false, 'a throwing raw write reverts the Configure checkbox');
  assert.equal(panelControl(h3, 'hwx-uav-status').textContent, 'Could not save that setting.',
    'a throwing raw write is reported, not claimed as saved');
}

// ── graceful degrade: no hermesExt settings -> localStorage fallback works ──
{
  const h = createHarness({ settingsSupported: false, storageSupported: false });
  assert.equal(h.api().settingsBackend, 'localStorage', 'reports the localStorage settings fallback');
  h.api().setEnabled(true);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), '1',
    'enabling works through the localStorage fallback on older core');
  assert.equal(h.store.get('hermes-ext-user-avatar-enabled'), 'true',
    'fallback persists to the declared owned localStorage key');
}

console.log('test-user-avatar: all assertions passed');
