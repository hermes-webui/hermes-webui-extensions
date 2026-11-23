import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadVault } from './sigakhwa-vault-fixture.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const source = '## Result\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
const context = { sessionId: 's', messageIndex: 0, role: 'assistant' };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

function setup() {
  const dom = new JSDOM('<html lang="en"><head></head><body><button id="star"></button><div class="messages-shell"><button id="scrollToBottomBtn" style="display:none"></button></div><div id="composerWrap"></div></body></html>', { url: 'https://webui.test/' });
  const win = dom.window;
  const doc = win.document;
  const css = doc.createElement('style');
  css.textContent = fs.readFileSync(new URL('../extensions/sigakhwa-vault/assets/sigakhwa-vault.css', import.meta.url), 'utf8');
  doc.head.append(css);
  const mutations = [];
  const resizes = [];
  const store = { list: async () => [], subscribe() { return () => {}; } };
  win.HermesVizStore = { version: 1, open: () => store };
  const labels = [];
  win.hermesExt = { register() { return { messages: { registerAction(action) {
    labels.push(action.label);
    doc.getElementById('star').setAttribute('aria-label', action.label);
    return () => {};
  } } }; } };
  const { vault } = loadVault({ window: win, document: doc,
    state: { session: { session_id: 's' }, messages: [{ role: 'assistant', content: source }] }, offset: 0,
    fetch: async () => ({ ok: true, json: async () => ({ session: { title: 'Title', messages: [{ role: 'assistant', content: source }] } }) }),
    MutationObserver: class {
      constructor(cb) { this.observer = new win.MutationObserver(cb); }
      observe(target, options) { mutations.push({ target, options }); this.observer.observe(target, options); }
      disconnect() { this.observer.disconnect(); }
    },
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; this.targets = []; resizes.push(this); }
      observe(node) { this.targets.push(node); }
      disconnect() { this.targets = []; }
    }
  });
  vault._install();
  return { dom, win, doc, vault, store, labels, mutations, resizes };
}

for (const [width, height, shellRect, composerRect] of [
  [390, 844, rect(0, 50, 390, 573), rect(0, 573, 390, 810)],
  [1440, 900, rect(240, 50, 1060, 630), rect(240, 630, 1060, 900)],
  [768, 1024, rect(0, 50, 768, 824), rect(0, 824, 768, 1024)]
]) {
  test(`FAB/panel stay inside chat and above growing composer at ${width}x${height}`, async () => {
    const f = setup(); const { doc, win, vault } = f;
    try {
      Object.defineProperty(win, 'innerWidth', { value: width });
      Object.defineProperty(win, 'innerHeight', { value: height });
      const shell = doc.querySelector('.messages-shell');
      const composer = doc.getElementById('composerWrap');
      shell.getBoundingClientRect = () => shellRect;
      composer.getBoundingClientRect = () => composerRect;
      const fab = doc.getElementById('sgkvFab');
      fab.getBoundingClientRect = () => {
        const right = width - parseFloat(fab.style.right);
        const bottom = height - parseFloat(fab.style.bottom);
        return rect(right - 80, bottom - 37, right, bottom);
      };
      vault.positionFab(); vault.openPanel(); await tick();
      const panel = doc.getElementById('sgkvPanel');
      assert.ok(fab.getBoundingClientRect().bottom < composerRect.top);
      assert.ok(fab.getBoundingClientRect().right < shellRect.right);
      assert.equal(height - parseFloat(panel.style.bottom), fab.getBoundingClientRect().top - 8);
      const panelRight = width - parseFloat(panel.style.right);
      assert.ok(panelRight <= shellRect.right);
      assert.ok(panelRight - Math.min(360, parseFloat(panel.style.maxWidth)) >= shellRect.left);
      assert.ok(height - parseFloat(panel.style.bottom) - parseFloat(panel.style.maxHeight) >= 16);
      assert.notEqual(win.getComputedStyle(fab).display, 'none');
      assert.equal(fab.getAttribute('aria-controls'), 'sgkvPanel');
      fab.click(); assert.equal(panel.hidden, true);
      // Core End button remains accessible beneath the FAB when scrolled up.
      const end = doc.getElementById('scrollToBottomBtn');
      end.style.display = 'block'; end.getBoundingClientRect = () => rect(shellRect.right - 44, composerRect.top - 52, shellRect.right - 12, composerRect.top - 20);
      vault.positionFab();
      assert.equal(fab.getBoundingClientRect().bottom, end.getBoundingClientRect().top - 8);
      let clicked = 0; end.addEventListener('click', () => clicked++); end.click();
      assert.equal(clicked, 1); assert.equal(panel.hidden, true);
      composer.getBoundingClientRect = () => rect(composerRect.left, composerRect.top - 50, composerRect.right, composerRect.bottom);
      f.resizes[0].cb(); assert.ok(fab.getBoundingClientRect().bottom < composerRect.top - 50);
    } finally { f.dom.window.close(); }
  });
}

test('prepareSave preserves indentation, tabs, repeated and boundary whitespace; only CRLF is normalized', async () => {
  const text = '```python\nif ready:\n    run()\n```';
  const { vault } = loadVault({ fetch: async () => ({ ok: true, json: async () => ({ session: { messages: [{ role: 'assistant', content: text }] } }) }) });
  for (const expectedText of [text.replace('    run()', 'run()'), text.replace('    run()', '\trun()'), ' ' + text, text + '\n', text.replace('    run()', '  run()')]) {
    assert.equal((await vault.prepareSave({ ...context, expectedText })).reason, 'text_mismatch');
  }
  assert.equal((await vault.prepareSave({ ...context, expectedText: text.replace(/\n/g, '\r\n') })).ok, true);
});

test('saved Mermaid never invokes rendering for remote CSS, media, fonts or normal diagrams', () => {
  const f = setup(); let calls = 0;
  f.win.mermaid = { render() { calls++; throw Error('must not render'); } };
  try {
    const host = f.doc.createElement('div');
    for (const code of ['flowchart TD\nA --> B', 'flowchart TD\nA["<style>@font-face{font-family:x;src:url(https://evil.test/f)}</style>"]', 'flowchart TD\nA["<video poster=https://evil.test/p></video>"]', 'flowchart TD\nA["<span style=background:url(https://evil.test/i)>x</span>"]']) {
      f.vault.renderSnapshotInto(host, { contentType: 'mermaid', content: '```mermaid\n' + code + '\n```' });
      assert.equal(host.querySelector('svg,img,image,video,style,span'), null);
      assert.equal(host.querySelector('pre code').textContent, code);
    }
    assert.equal(calls, 0);
    assert.equal(f.doc.querySelector('[id^="sgkv-mermaid-"]'), null);
  } finally { f.dom.window.close(); }
});

test('save modal focuses, traps both Tab directions, has a name and restores focus', async () => {
  const f = setup();
  try {
    const star = f.doc.getElementById('star'); star.focus();
    const pending = f.vault.onInvokeSaveCard(context); await tick();
    const box = f.doc.querySelector('.sgkv-modal');
    assert.ok(box.contains(f.doc.activeElement));
    assert.equal(f.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Save to result vault');
    const first = box.querySelector('button');
    const buttons = [...box.querySelectorAll('.sgkv-modal-foot button')];
    first.focus(); first.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.doc.activeElement, buttons.at(-1));
    buttons.at(-1).dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.doc.activeElement, first);
    star.focus(); star.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.doc.activeElement, first);
    first.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await pending; assert.equal(f.doc.querySelector('.sgkv-modal'), null); assert.equal(f.doc.activeElement, star);
  } finally { f.dom.window.close(); }
});

test('card viewer restores its list opener; Escape closes modal before panel', async () => {
  const f = setup();
  try {
    const card = { ...await f.vault.buildCard({ ...context, profile: 'default', name: 'Saved card', part: { type: 'full', label: 'Whole answer', content: source }, fullContent: source }), id: 'c', createdAt: 1 };
    f.store.get = async () => card;
    f.vault.openPanel(); await tick();
    const row = f.vault.buildCardRow(card, true); f.doc.getElementById('sgkvList').append(row);
    const opener = row.querySelector('button'); opener.focus(); opener.click(); await tick();
    assert.ok(f.doc.querySelector('.sgkv-modal').contains(f.doc.activeElement));
    f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.doc.activeElement, opener); assert.equal(f.doc.getElementById('sgkvPanel').hidden, false);
    opener.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.doc.getElementById('sgkvPanel').hidden, true);
    assert.equal(f.doc.activeElement, f.doc.getElementById('sgkvFab'));
  } finally { f.dom.window.close(); }
});

test('geometry observers target only End attributes and shell/composer sizes; streaming does not force layout', async () => {
  const f = setup();
  try {
    for (const { target, options } of f.mutations) {
      assert.equal(options.subtree, undefined);
      if (target === f.doc.body) assert.deepEqual(options, { childList: true });
      else if (target === f.doc.documentElement) assert.deepEqual(options.attributeFilter, ['lang']);
      else { assert.equal(target.id, 'scrollToBottomBtn'); assert.deepEqual(options.attributeFilter, ['style', 'class', 'hidden']); }
    }
    assert.deepEqual(f.resizes[0].targets, [f.doc.querySelector('.messages-shell'), f.doc.getElementById('composerWrap')]);
    await tick(); let layouts = 0;
    const end = f.doc.getElementById('scrollToBottomBtn');
    end.getBoundingClientRect = () => { layouts++; return rect(900, 400, 932, 432); };
    const reply = f.doc.createElement('div'); f.doc.querySelector('.messages-shell').append(reply);
    for (let i = 0; i < 10; i++) { reply.textContent += 'stream'; reply.className = 'chunk-' + i; }
    await tick(); assert.equal(layouts, 0);
    end.style.display = 'block'; await tick(); assert.ok(layouts > 0);
  } finally { f.dom.window.close(); }
});

test('part picker announces Whole answer once and supports exclusive keyboard radio selection', async () => {
  const f = setup();
  try {
    const pending = f.vault.onInvokeSaveCard(context); await tick();
    const group = f.doc.querySelector('[role="radiogroup"]');
    assert.equal(group.getAttribute('aria-label'), 'Content to save');
    const radios = [...group.querySelectorAll('[role="radio"]')];
    assert.ok(radios.length > 1); assert.equal(radios[0].textContent, 'Whole answer');
    assert.equal(radios[0].getAttribute('aria-checked'), 'true');
    radios[0].focus(); radios[0].dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(f.doc.activeElement, radios[1]);
    assert.equal(radios[1].getAttribute('aria-checked'), 'true'); assert.equal(radios[0].tabIndex, -1);
    assert.equal(group.querySelectorAll('[aria-checked="true"]').length, 1); assert.equal(group.querySelector('[aria-pressed]'), null);
    f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pending;
  } finally { f.dom.window.close(); }
});

test('language changes immediately update FAB and registered star labels without refreshing the list', async () => {
  const f = setup();
  try {
    f.doc.documentElement.lang = 'ko-KR'; await tick();
    assert.equal(f.doc.getElementById('sgkvFab').firstChild.nodeValue, '보관함');
    assert.equal(f.doc.getElementById('star').getAttribute('aria-label'), '보관함에 저장');
    assert.equal(f.doc.getElementById('sgkvFab').title, '결과 보관함 열기');
    f.doc.documentElement.lang = 'fr'; await tick();
    assert.equal(f.doc.getElementById('sgkvFab').firstChild.nodeValue, 'Vault');
    assert.equal(f.doc.getElementById('star').getAttribute('aria-label'), 'Save to vault');
    assert.deepEqual(f.labels, ['Save to vault', '보관함에 저장', 'Save to vault']);
  } finally { f.dom.window.close(); }
});
