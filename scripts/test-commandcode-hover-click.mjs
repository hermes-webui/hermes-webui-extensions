#!/usr/bin/env node
// Regression test for the commandcode-usage hover/click race.
//
// Entering the chip arms a HOVER_OPEN_DELAY (160ms) timer. Clicking before that
// timer fires opens the panel; the still-pending timer then re-enters
// openPanel() and takes the toggle branch, closing the panel the user just
// opened (the "panel flashes shut" bug). openPanel() must cancel pending hover
// timers first.
//
// Drives the REAL extension source in a vm sandbox against a minimal DOM that
// mirrors core's composer-footer subtree, the same idiom as this repo's other
// behavior tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'extensions/commandcode-usage/assets/commandcode-usage.js';
const source = readFileSync(path.join(repoRoot, SOURCE_PATH), 'utf8');

// ── minimal DOM ────────────────────────────────────────────────────────────
function makeNode(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    nextSibling: null,
    attrs: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    listeners: {},
    textContent: '',
    id: '',
    offsetWidth: 360,
    offsetHeight: 200,
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    },
    dispatch(type, event = {}) {
      for (const handler of [...(this.listeners[type] || [])]) {
        handler({ stopPropagation() {}, preventDefault() {}, target: this, ...event });
      }
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      this._relink();
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(child);
      else this.children.splice(i, 0, child);
      this._relink();
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
      this._relink();
      return child;
    },
    _relink() {
      this.children.forEach((c, i) => { c.nextSibling = this.children[i + 1] || null; });
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains && c.contains(other));
    },
    getBoundingClientRect: () => ({
      left: 100, top: 400, width: 120, height: 24, right: 220, bottom: 424,
    }),
    getClientRects: () => [{ width: 120, height: 24 }],
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
  };
}

function createHarness() {
  const timers = new Map();
  let nextTimerId = 1;

  // core's real composer subtree shape: .composer-footer > .composer-left > .composer-model-wrap
  const body = makeNode('body');
  const footer = makeNode('div'); footer.className = 'composer-footer';
  const left = makeNode('div'); left.className = 'composer-left';
  const modelWrap = makeNode('div'); modelWrap.className = 'composer-model-wrap';
  left.appendChild(modelWrap);
  footer.appendChild(left);
  body.appendChild(footer);

  const documentStub = {
    body,
    activeElement: null,
    readyState: 'complete',
    listeners: {},
    createElement: (tag) => makeNode(tag),
    querySelector(sel) {
      const s = String(sel);
      if (s.includes('composer-model-wrap')) return modelWrap;
      if (s.includes('composer-footer')) return footer;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    },
  };

  const windowStub = {
    innerWidth: 1280,
    innerHeight: 900,
    document: documentStub,
    setTimeout(fn, delay) { const id = nextTimerId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return nextTimerId++; },
    clearInterval() {},
    requestAnimationFrame(fn) { fn(0); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // Never resolves: keeps async loads from racing the synchronous assertions.
    fetch: () => new Promise(() => {}),
  };
  windowStub.window = windowStub;

  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    MutationObserver: MutationObserverStub,
    fetch: windowStub.fetch,
    navigator: { userAgent: 'node' },
    location: { origin: 'http://127.0.0.1:8787', href: 'http://127.0.0.1:8787/' },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // The extension is a self-executing IIFE: it mounts on load.
  vm.runInContext(source, sandbox, { filename: 'commandcode-usage.js' });

  const chip = left.children.find((c) => c.id === 'btnCommandCodeUsage');
  const panelCount = () => body.children.filter((c) => c.tagName === 'ASIDE').length;
  const flushTimers = () => {
    for (const [id, timer] of [...timers.entries()]) {
      timers.delete(id);
      timer.fn();
    }
  };
  return { chip, panelCount, timers, flushTimers };
}

// ── the test ───────────────────────────────────────────────────────────────
const h = createHarness();
assert.ok(h.chip, 'composer chip should mount beside .composer-model-wrap');
assert.equal(h.chip.getAttribute('aria-expanded'), 'false', 'chip starts collapsed (aria-expanded=false)');

// 1. Hover the chip: arms the delayed-open timer; nothing opens yet.
h.chip.dispatch('mouseenter');
assert.equal(h.panelCount(), 0, 'hover alone must not open the panel synchronously');
assert.ok(
  [...h.timers.values()].some((t) => t.delay === 160),
  'hover should arm the 160ms delayed-open timer'
);

// 2. Click BEFORE that timer fires: the panel opens.
h.chip.dispatch('click');
assert.equal(h.panelCount(), 1, 'clicking during the hover delay should open the panel');

// 3. Fire every pending timer, exactly as the browser would.
h.flushTimers();

// 4. THE REGRESSION: the panel must still be open. Without cancelHoverTimers()
//    at the top of openPanel(), the stale hover timer re-enters and toggles it shut.
assert.equal(
  h.panelCount(),
  1,
  'REGRESSION: the pending hover timer closed the panel the click just opened ' +
    '(openPanel must cancel hover timers before toggling)'
);

// 5. Sibling ordering (Fable finding): leaving the chip must disarm the timer.
//    Hover, move away, and the panel must never open on its own.
const h2 = createHarness();
assert.ok(h2.chip, 'composer chip should mount');
h2.chip.dispatch('mouseenter');
assert.ok(
  [...h2.timers.values()].some((t) => t.delay === 160),
  'hover should arm the delayed-open timer'
);
h2.chip.dispatch('mouseleave');
h2.flushTimers();
assert.equal(
  h2.panelCount(),
  0,
  'REGRESSION: a fly-over pinned the panel — mouseleave must cancel the pending hover timer'
);

// 6. The invariant behind both fixes: no hover timer survives a transition.
const h3 = createHarness();
h3.chip.dispatch('mouseenter');
h3.chip.dispatch('click');          // opens
assert.equal(h3.panelCount(), 1, 'click during hover delay opens the panel');
assert.equal(h3.chip.getAttribute('aria-expanded'), 'true', 'opening the panel flips aria-expanded to true');
h3.chip.dispatch('click');          // toggles closed
assert.equal(h3.panelCount(), 0, 'clicking the chip again closes the panel');
assert.equal(h3.chip.getAttribute('aria-expanded'), 'false', 'closing the panel flips aria-expanded back to false');
assert.equal(
  [...h3.timers.values()].filter((t) => t.delay === 160).length,
  0,
  'no pending hover-open timer may survive an open/close transition'
);

console.log('ok - hover-then-click does not flash the commandcode-usage panel shut');
