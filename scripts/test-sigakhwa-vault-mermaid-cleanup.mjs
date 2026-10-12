'use strict';
// Review fix 4: mermaid.render() temp containers (#d<id>) and mermaid 10's
// body-level error SVG must not leak, after success or failure. Uses a tiny
// fake DOM and a fake mermaid that behaves like mermaid 10 does with <body>;
// These tests use a local Mermaid double, not the real browser renderer.

import test from 'node:test';
import assert from 'node:assert';
import { loadVault, readExtension } from './sigakhwa-vault-fixture.mjs';

function makeDom() {
  function makeNode(id) {
    return {
      id: id || '',
      parent: null,
      children: [],
      html: [],
      set textContent(_v) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.html = []; },
      get textContent() { return ''; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      remove() {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
      },
      contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
      insertAdjacentHTML(_where, html) { this.html.push(html); }
    };
  }
  const body = makeNode('');
  const document = {
    body,
    readyState: 'loading',            // keeps install() from running
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      const queue = body.children.slice();
      while (queue.length) {
        const n = queue.shift();
        if (n.id === id) return n;
        queue.push(...n.children);
      }
      return null;
    },
    createElement() { throw new Error('not needed'); }
  };
  return { document, body, makeNode };
}

function fakeMermaid(dom, mode) {
  const calls = [];
  return {
    calls,
    render(id, code) {
      calls.push({ id, code });
      // mermaid 10: temp container #d<id> holding the svg #<id>, in <body>
      const temp = dom.makeNode('d' + id);
      temp.appendChild(dom.makeNode(id));
      dom.body.appendChild(temp);
      if (mode === 'fail') {
        // and on a parse error, an error SVG left directly in <body>
        dom.body.appendChild(dom.makeNode(id));
        return Promise.reject(new Error('Parse error on line 2'));
      }
      if (mode === 'throw') throw new Error('sync parse error');
      return Promise.resolve({ svg: '<svg id="' + id + '"></svg>' });
    }
  };
}

function settle() { return new Promise((resolve) => setTimeout(resolve, 10)); }

function bodyIds(dom) { return dom.body.children.map((c) => c.id); }

for (const mode of ['ok', 'fail', 'throw']) {
  test('mermaid render (' + mode + ') leaves nothing behind in <body>', async () => {
    const dom = makeDom();
    const unrelated = dom.body.appendChild(dom.makeNode('drawer'));     // must survive
    const win = {};
    win.mermaid = fakeMermaid(dom, mode);
    const { vault } = loadVault({ window: win, document: dom.document });
    const host = dom.body.appendChild(dom.makeNode('host'));

    vault.renderSnapshotInto(host, { contentType: 'mermaid', content: '```mermaid\nflowchart TD\n  A --> B\n```' });
    await settle();

    assert.strictEqual(win.mermaid.calls.length, 1);
    assert.match(win.mermaid.calls[0].id, /^sgkv-mermaid-/);
    assert.strictEqual(win.mermaid.calls[0].code, 'flowchart TD\n  A --> B');
    assert.deepStrictEqual(bodyIds(dom), ['drawer', 'host'], 'only pre-existing nodes remain');
    assert.ok(unrelated.parent === dom.body);
    if (mode === 'ok') {
      assert.deepStrictEqual(host.html, ['<svg id="' + win.mermaid.calls[0].id + '"></svg>']);
    } else {
      assert.strictEqual(host.html.length, 1);
      assert.ok(host.html[0].startsWith('<pre><code>flowchart TD'), 'falls back to the escaped code block');
    }
  });
}

test('a finishing render never removes the temp nodes of a render still in flight', async () => {
  const dom = makeDom();
  const win = {};
  let releaseSlow;
  win.mermaid = {
    render(id) {
      const temp = dom.makeNode('d' + id);
      dom.body.appendChild(temp);
      if (!releaseSlow) {
        return new Promise((resolve) => { releaseSlow = () => resolve({ svg: '<svg></svg>' }); });
      }
      return Promise.resolve({ svg: '<svg></svg>' });
    }
  };
  const { vault } = loadVault({ window: win, document: dom.document });
  const hostA = dom.body.appendChild(dom.makeNode('hostA'));
  const hostB = dom.body.appendChild(dom.makeNode('hostB'));

  vault.renderSnapshotInto(hostA, { contentType: 'mermaid', content: 'flowchart TD' });   // slow
  vault.renderSnapshotInto(hostB, { contentType: 'mermaid', content: 'flowchart LR' });   // fast
  await settle();
  const slowTemps = dom.body.children.filter((c) => c.id.indexOf('dsgkv-mermaid-') === 0);
  assert.strictEqual(slowTemps.length, 1, 'the slow render keeps its temp container while running');

  releaseSlow();
  await settle();
  assert.deepStrictEqual(bodyIds(dom), ['hostA', 'hostB']);
});

test('without a global mermaid the code block is shown and nothing is created', () => {
  const dom = makeDom();
  const { vault } = loadVault({ window: {}, document: dom.document });
  const host = dom.body.appendChild(dom.makeNode('host'));
  vault.renderSnapshotInto(host, { contentType: 'mermaid', content: '```mermaid\nflowchart TD\n<b>x</b>\n```' });
  assert.deepStrictEqual(host.html, ['<pre><code>flowchart TD\n&lt;b&gt;x&lt;/b&gt;</code></pre>']);
  assert.deepStrictEqual(bodyIds(dom), ['host']);
});
