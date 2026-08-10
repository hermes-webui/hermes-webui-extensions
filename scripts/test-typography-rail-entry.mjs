import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vm from 'node:vm';

const source = await readFile(new URL('../extensions/typography/assets/typography.js', import.meta.url), 'utf8');

const RAIL_ID = 'hwx-type-rail-button';

function makeElement(tagName, className = '') {
  const detach = (child) => {
    const parent = child.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
  };
  const element = {
    tagName: tagName.toUpperCase(),
    className,
    children: [],
    parentNode: null,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    appendChild(child) {
      detach(child);
      this.children.push(child);
      child.parentNode = this;
      child.isConnected = true;
      return child;
    },
    insertBefore(child, reference) {
      if (child === reference) return child;
      if (!this.children.includes(reference)) return this.appendChild(child);
      detach(child);
      this.children.splice(this.children.indexOf(reference), 0, child);
      child.parentNode = this;
      child.isConnected = true;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
      this.isConnected = false;
    },
    addEventListener() {},
    setAttribute(name, value) { this[name] = value; },
    classList: {
      toggle() {},
      contains(name) { return element.className.split(/\s+/).includes(name); },
    },
    querySelector(selector) {
      if (selector !== '.rail-spacer') return null;
      return this.children.find((child) => child.className.split(/\s+/).includes('rail-spacer')) || null;
    },
  };
  return element;
}

function run() {
  const body = makeElement('body');
  const rail = makeElement('nav');
  const nativeTabs = ['chat', 'settings'].map((panel) => {
    const tab = makeElement('button', 'rail-btn nav-tab');
    tab.dataset.panel = panel;
    return tab;
  });
  const spacer = makeElement('div', 'rail-spacer');
  nativeTabs.forEach((tab) => rail.appendChild(tab));
  rail.appendChild(spacer);
  body.appendChild(rail);
  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  };
  const document = {
    readyState: 'complete',
    body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    activeElement: makeElement('button'),
    getElementById: (id) => findById(body, id),
    querySelector: (selector) => selector === '.rail' ? rail : null,
    createElement: (tagName) => makeElement(tagName),
    addEventListener() {},
    removeEventListener() {},
  };
  const observers = [];
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    flush() {
      this.callback([], this);
    }
  }
  const context = {
    window: {},
    document,
    MutationObserver: TestMutationObserver,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => { throw new Error('unexpected retry timer'); },
    console,
  };
  vm.runInNewContext(source, context);
  return {
    context,
    rail,
    spacer,
    nativeTabs,
    observers,
    flushObservers: () => observers.forEach((observer) => observer.flush()),
    extension: context.window.HermesTypographyExtension,
  };
}

const result = run();
const button = result.rail.children.find((child) => child.id === RAIL_ID);
assert.ok(button, 'rail button is inserted');
assert.equal(result.rail.children.filter((child) => child.id === RAIL_ID).length, 1, 'one rail button is inserted');
assert.ok(result.rail.children.indexOf(button) < result.rail.children.indexOf(result.spacer), 'rail button precedes the spacer');
assert.equal(button.dataset.panel, undefined, 'Typography remains an extension action without a panel');
vm.runInNewContext(source, result.context);
assert.equal(result.rail.children.filter((child) => child.id === RAIL_ID).length, 1, 'duplicate initialization does not duplicate the rail button');
result.nativeTabs.forEach((tab) => result.rail.insertBefore(tab, result.spacer));
result.flushObservers();
const buttonIndex = result.rail.children.indexOf(button);
const spacerIndex = result.rail.children.indexOf(result.spacer);
assert.ok(result.nativeTabs.every((tab) => result.rail.children.indexOf(tab) < buttonIndex), 'Typography ends after all native panel buttons');
assert.equal(buttonIndex, spacerIndex - 1, 'Typography ends immediately before the spacer');
assert.equal(result.extension.version, '0.1.0');
assert.equal(Object.isFrozen(result.extension.presets), true, 'preset metadata is immutable');
assert.equal(Object.isFrozen(result.extension.presets[0]), true, 'preset entries are immutable');
assert.equal(result.extension.presets[0].conversation, 'same-ui');
assert.equal(result.extension.debug.isStableLocalSelection('local:font-123'), true);

console.log('typography rail-entry check passed');
