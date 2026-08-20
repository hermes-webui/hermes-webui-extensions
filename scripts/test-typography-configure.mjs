import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vm from 'node:vm';

const source = await readFile(new URL('../extensions/typography/assets/typography.js', import.meta.url), 'utf8');

const EXTENSION_ID = 'typography';
const PANEL_ID = 'hwx-type-panel';
const RAIL_ID = 'hwx-type-rail-button';

function makeHarness({ configure = true, rail = true, register = true, configureResult = () => true } = {}) {
  const focusCalls = [];
  const timers = [];
  const registrations = [];
  const configureHandlers = [];
  let document;

  function findDescendant(node, predicate) {
    for (const child of node.children || []) {
      if (predicate(child)) return child;
      const nested = findDescendant(child, predicate);
      if (nested) return nested;
    }
    return null;
  }

  function matches(node, selector) {
    if (selector === '.rail-spacer') return node.className.split(/\s+/).includes('rail-spacer');
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    if (/^[a-z]+$/i.test(selector)) return node.tagName === selector.toUpperCase();
    return false;
  }

  function makeElement(tagName, className = '') {
    const listeners = new Map();
    const queryCache = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      id: '',
      className,
      children: [],
      parentNode: null,
      isConnected: false,
      hidden: false,
      disabled: false,
      value: '',
      textContent: '',
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      classList: {
        toggle() {},
        contains(name) { return element.className.split(/\s+/).includes(name); },
      },
      get firstChild() { return this.children[0] || null; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
        this.children.push(child);
        child.parentNode = this;
        child.isConnected = this.isConnected;
        return child;
      },
      append(...children) {
        children.forEach((child) => this.appendChild(child));
      },
      insertBefore(child, reference) {
        if (!this.children.includes(reference)) return this.appendChild(child);
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
        this.children.splice(this.children.indexOf(reference), 0, child);
        child.parentNode = this;
        child.isConnected = this.isConnected;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((item) => item !== child);
        child.parentNode = null;
        child.isConnected = false;
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        this.isConnected = false;
      },
      addEventListener(type, listener) {
        const entries = listeners.get(type) || [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      removeEventListener(type, listener) {
        listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
      },
      dispatchEvent(event) {
        for (const listener of [...(listeners.get(event.type) || [])]) listener.call(this, event);
      },
      click() { this.dispatchEvent({ type: 'click', target: this }); },
      focus() {
        focusCalls.push(this);
        document.activeElement = this;
      },
      getClientRects() { return this.isConnected ? [{}] : []; },
      getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; },
      setAttribute(name, value) { this[name] = String(value); },
      getAttribute(name) { return this[name] ?? null; },
      querySelector(selector) {
        const nested = findDescendant(this, (child) => matches(child, selector));
        if (nested) return nested;
        if (!this.__queryFallback) return null;
        if (!queryCache.has(selector)) {
          const tag = selector === 'select' ? 'select' : 'div';
          const fallback = makeElement(tag);
          if (selector.startsWith('#')) fallback.id = selector.slice(1).split(/\s/, 1)[0];
          if (selector.startsWith('.')) fallback.className = selector.slice(1);
          fallback.isConnected = this.isConnected;
          queryCache.set(selector, fallback);
        }
        return queryCache.get(selector);
      },
      querySelectorAll(selector) {
        const match = this.querySelector(selector);
        return match ? [match] : [];
      },
    };
    return element;
  }

  const body = makeElement('body');
  body.isConnected = true;
  const head = makeElement('head');
  head.isConnected = true;
  const documentElement = makeElement('html');
  documentElement.isConnected = true;
  const railNode = makeElement('nav', 'rail');
  railNode.isConnected = true;
  const spacer = makeElement('div', 'rail-spacer');
  railNode.appendChild(spacer);
  if (rail) body.appendChild(railNode);

  const documentListeners = new Map();
  document = {
    readyState: 'complete',
    body,
    head,
    documentElement,
    activeElement: makeElement('button'),
    fonts: { add() {}, delete() {} },
    getElementById(id) {
      return findDescendant(body, (node) => node.id === id);
    },
    querySelector(selector) {
      if (selector === '.rail') return rail ? railNode : null;
      return findDescendant(body, (node) => matches(node, selector));
    },
    createElement(tagName) {
      const element = makeElement(tagName);
      // The editor is built dynamically; unresolved selectors in this tiny
      // harness are stable stand-ins for the corresponding controls.
      element.__queryFallback = true;
      return element;
    },
    addEventListener(type, listener) {
      const entries = documentListeners.get(type) || [];
      entries.push(listener);
      documentListeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      documentListeners.set(type, (documentListeners.get(type) || []).filter((entry) => entry !== listener));
    },
  };

  const settings = {
    storageForExtension() {
      return { supported: true, get() { return undefined; }, set() { return true; } };
    },
  };
  if (configure) {
    settings.registerConfigure = (handler) => {
      const result = typeof configureResult === 'function' ? configureResult() : configureResult;
      if (result !== null) configureHandlers.push(handler);
      return result;
    };
  }
  const handle = { id: EXTENSION_ID, settings };
  const window = {
    innerWidth: 1440,
    innerHeight: 1000,
    indexedDB: undefined,
    localStorage: { getItem() { return null; }, setItem() {} },
    hermesExt: {
      register(id) {
        registrations.push(id);
        return id === EXTENSION_ID ? handle : null;
      },
    },
  };
  if (!register) delete window.hermesExt;

  const context = {
    window,
    document,
    localStorage: window.localStorage,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    console,
  };
  vm.runInNewContext(source, context, { filename: 'typography.js' });

  return {
    context,
    window,
    document,
    body,
    railNode,
    focusCalls,
    timers,
    registrations,
    configureHandlers,
    extension: window.HermesTypographyExtension,
  };
}

function countById(root, id) {
  let count = 0;
  const visit = (node) => {
    if (node.id === id) count += 1;
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return count;
}

function makeElementForTest(harness, tagName) {
  const element = harness.document.createElement(tagName);
  element.isConnected = false;
  return element;
}

// E0 Configure registration is the only supported Core-owned entry point.
const modern = makeHarness({ configure: true, rail: true });
assert.deepEqual(modern.registrations, [EXTENSION_ID], 'Typography registers its exact manifest id once');
assert.equal(modern.configureHandlers.length, 1, 'Typography registers one Configure handler');
assert.equal(countById(modern.body, RAIL_ID), 0, 'Configure-capable Core receives no permanent rail button');
assert.equal(modern.timers.length, 0, 'Configure migration does not install a retry timer');

const noConfigureHook = makeHarness({ configure: false, rail: true });
assert.deepEqual(noConfigureHook.registrations, [EXTENSION_ID], 'E0 handle lookup remains scoped to Typography');
assert.equal(noConfigureHook.configureHandlers.length, 0, 'a Core without registerConfigure receives no handler');
assert.equal(countById(noConfigureHook.body, RAIL_ID), 0, 'missing Configure capability receives no rail fallback');
assert.equal(noConfigureHook.timers.length, 0, 'missing Configure capability receives no retry timer');

const rejectedConfigureHook = makeHarness({ configure: true, rail: true, configureResult: null });
assert.deepEqual(rejectedConfigureHook.registrations, [EXTENSION_ID]);
assert.equal(rejectedConfigureHook.configureHandlers.length, 0, 'a null Configure registration fails closed');
assert.equal(countById(rejectedConfigureHook.body, RAIL_ID), 0, 'a null Configure registration receives no rail fallback');
assert.equal(rejectedConfigureHook.timers.length, 0, 'a null Configure registration receives no retry timer');

// The Core invocation owns pending/focus. The handler keeps the promise open
// until the existing editor closes and does not call Core focus restoration.
const opener = makeElementForTest(modern, 'button');
modern.body.appendChild(opener);
modern.document.activeElement = opener;
let coreSettled = false;
let restoreFocusCalls = 0;
let corePending = false;
let pendingResult;
const invoke = () => {
  if (corePending) return false;
  corePending = true;
  pendingResult = modern.configureHandlers[0]({
    opener,
    restoreFocus() { restoreFocusCalls += 1; },
  });
  assert.equal(countById(modern.body, PANEL_ID), 1, 'Configure opens the existing Typography editor');
  Promise.resolve(pendingResult).then(() => {
    corePending = false;
    coreSettled = true;
    opener.focus();
  });
  return true;
};
assert.equal(invoke(), true, 'first Configure invocation is accepted');
assert.equal(invoke(), false, 'a second Configure invocation is suppressed by Core state');
const openerFocusBeforeClose = modern.focusCalls.filter((entry) => entry === opener).length;
modern.extension.close();
await pendingResult;
await Promise.resolve();
assert.equal(coreSettled, true, 'Configure handler settles only after editor close');
assert.equal(restoreFocusCalls, 0, 'extension does not call Core-owned restoreFocus');
assert.equal(modern.focusCalls.filter((entry) => entry === opener).length, openerFocusBeforeClose + 1,
  'Core restores Configure opener focus exactly once');
assert.equal(countById(modern.body, PANEL_ID), 0, 'Configure close removes the existing editor');

// Old Core has no authenticated capability surface: Typography fails closed,
// but its public programmatic editor API remains available and retains opener
// focus restoration semantics.
const legacy = makeHarness({ configure: false, rail: true, register: false });
assert.deepEqual(legacy.registrations, [], 'legacy Core receives no attempted capability registration');
assert.equal(countById(legacy.body, RAIL_ID), 0, 'legacy Core receives no rail fallback');
assert.equal(legacy.timers.length, 0, 'legacy Core receives no retry timer');
const programmaticOpener = makeElementForTest(legacy, 'button');
legacy.body.appendChild(programmaticOpener);
legacy.extension.open(programmaticOpener);
assert.equal(countById(legacy.body, PANEL_ID), 1, 'programmatic open remains available on legacy Core');
legacy.extension.close();
assert.equal(legacy.focusCalls.filter((entry) => entry === programmaticOpener).length, 1,
  'programmatic close retains opener focus restoration');

assert.equal(legacy.extension.version, '0.1.0');
assert.equal(Object.isFrozen(legacy.extension.presets), true, 'preset metadata is immutable');
assert.equal(Object.isFrozen(legacy.extension.presets[0]), true, 'preset entries are immutable');
assert.equal(legacy.extension.presets[0].conversation, 'same-ui');
assert.equal(legacy.extension.debug.isStableLocalSelection('local:font-123'), true);

console.log('typography Configure-entry check passed');
