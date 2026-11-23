import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadVault } from './sigakhwa-vault-fixture.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const source = '## Result\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart TD\nA --> B\n```';
const context = { sessionId: 's', messageIndex: 0, role: 'assistant' };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

function setup() {
  const dom = new JSDOM('<html lang="en"><head></head><body><div id="approvalCard" class="visible"></div><button data-extension-id="sigakhwa-vault" data-extension-action-id="save-card" id="star"></button><div class="messages-shell"><button id="scrollToBottomBtn" hidden></button><button id="outlineToggleBtn" hidden></button></div><div id="composerWrap"><textarea id="msg"></textarea></div><div id="appDialogOverlay" style="display:none"><div role="dialog"><button id="coreConfirm">Confirm</button></div></div></body></html>', { url: 'https://webui.test/' });
  const win = dom.window, doc = win.document;
  const css = doc.createElement('style');
  css.textContent = fs.readFileSync(new URL('../extensions/sigakhwa-vault/assets/sigakhwa-vault.css', import.meta.url), 'utf8');
  doc.head.append(css);
  let approvals = 0, action;
  // Core boot.js approval shortcut, registered BEFORE the extension.
  doc.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const card = doc.getElementById('approvalCard');
      const tag = (doc.activeElement || {}).tagName || '';
      if (card?.classList.contains('visible') && !['TEXTAREA', 'INPUT', 'SELECT'].includes(tag)) {
        e.preventDefault(); approvals++;
      }
    }
  });
  let items = [];
  const store = {
    list: async () => items,
    get: async id => items.find(c => c.id === id),
    put: async card => { items.push(card); return card; },
    patch: async (id, patch) => Object.assign(items.find(c => c.id === id), patch),
    remove: async id => { items = items.filter(c => c.id !== id); },
    subscribe() { return () => {}; }
  };
  win.HermesVizStore = { version: 1, open: () => store };
  win.hermesExt = { register() { return { messages: { registerAction(a) { action = a; return () => {}; } } }; } };
  const { vault } = loadVault({ window: win, document: doc,
    state: { session: { session_id: 's' }, messages: [{ role: 'assistant', content: source }] }, offset: 0,
    fetch: async () => ({ ok: true, json: async () => ({ session: { title: 'Title', messages: [{ role: 'assistant', content: source }] } }) })
  });
  vault._install();
  const key = (node, value, extra = {}) => {
    const e = new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
    node.dispatchEvent(e); return e;
  };
  const release = value => doc.activeElement.dispatchEvent(new win.KeyboardEvent('keyup', { key: value, bubbles: true }));
  const press = (node, value = 'Enter') => {
    node.focus(); const e = key(node, value);
    // jsdom does not implement native keyboard click synthesis.
    if (!e.defaultPrevented && node.tagName === 'BUTTON') node.click();
    return e;
  };
  const repeat = value => key(doc.activeElement, value, { repeat: true });
  const button = label => [...doc.querySelectorAll('.sgkv-modal button')].find(b => b.textContent === label);
  async function saveDialog() { action.onInvoke(context); await tick(); }
  async function addCard(type = 'mermaid') {
    const part = vault.extractParts(source).find(p => p.type === type);
    const card = { ...await vault.buildCard({ ...context, profile: 'default', name: 'Saved card', part, fullContent: source }), id: 'c', createdAt: 1 };
    items = [card]; vault.openPanel(); await vault.refresh(); return card;
  }
  async function viewer() {
    const opener = doc.querySelector('.sgkv-card-open'); opener.focus(); opener.click(); await tick();
  }
  return { dom, win, doc, vault, store, key, press, release, repeat, button, saveDialog, addCard, viewer, approvals: () => approvals };
}

for (const value of ['Enter', ' ', 'Spacebar']) {
  test(`approval is never called for FAB, panel/modal buttons, inputs and radios: ${JSON.stringify(value)}`, async () => {
    const f = setup();
    try {
      const { doc, press, repeat, release } = f;
      press(doc.getElementById('sgkvFab'), value);
      assert.equal(repeat(value).defaultPrevented, true); release(value);
      for (const node of doc.querySelectorAll('#sgkvPanel button')) {
        node.focus(); f.key(node, value); repeat(value); release(value);
      }
      await f.saveDialog();
      for (const node of doc.querySelectorAll('.sgkv-modal button, .sgkv-modal input')) {
        node.focus(); f.key(node, value); repeat(value); release(value);
      }
      press(f.button('Cancel'), value); repeat(value);
      assert.ok(doc.activeElement !== doc.body); release(value);
      await f.addCard(); await f.viewer();
      press(f.button('Rename'), value); repeat(value); release(value);
      const input = doc.querySelector('.sgkv-input');
      input.value = 'Renamed';
      if (value === 'Enter') {
        assert.equal(press(input, value).defaultPrevented, true);
        repeat(value); release(value); await tick();
        assert.equal((await f.store.get('c')).name, 'Renamed');
      } else {
        press(input, value); repeat(value); release(value);
        press(f.button('Confirm'), value); repeat(value); release(value); await tick();
      }
      assert.equal(f.approvals(), 0);
    } finally { f.dom.window.close(); }
  });
}

test('delegated star survives replacement; per-key latch protects body and next control, resets on release/new press', async () => {
  const f = setup();
  try {
    let star = f.doc.getElementById('star');
    for (let i = 0; i < 2; i++) {
      star = star.cloneNode(true); f.doc.getElementById('star').replaceWith(star);
      f.press(star); star.remove();
      assert.equal(f.repeat('Enter').defaultPrevented, true);
      const fab = f.doc.getElementById('sgkvFab'); f.press(fab, ' ');
      assert.equal(f.repeat('Enter').defaultPrevented, true); // Space cannot release Enter.
      f.release(' '); f.release('Enter');
      if (i === 0) { star = star.cloneNode(true); f.doc.body.append(star); }
    }
    assert.equal(f.approvals(), 0);
    f.doc.getElementById('msg').focus(); f.key(f.doc.activeElement, 'Enter');
    // A fresh press must release a missing-keyup latch too.
    f.press(f.doc.getElementById('sgkvFab'));
    f.doc.getElementById('msg').focus(); f.key(f.doc.activeElement, 'Enter');
    const repeat = f.key(f.doc.getElementById('msg'), 'Enter', { repeat: true });
    assert.equal(repeat.defaultPrevented, false);
  } finally { f.dom.window.close(); }
});

test('Core overlay owns Tab/Escape and focus restoration; pre-consumed keys are untouched', async () => {
  const f = setup();
  try {
    const { doc, win } = f;
    await f.saveDialog();
    const box = doc.querySelector('.sgkv-modal');
    const overlay = doc.getElementById('appDialogOverlay');
    overlay.style.display = 'flex'; const core = doc.getElementById('coreConfirm'); core.focus();
    assert.equal(f.key(core, 'Tab').defaultPrevented, false); assert.equal(doc.activeElement, core);
    assert.equal(f.key(core, 'Escape').defaultPrevented, false); assert.equal(doc.querySelector('.sgkv-modal'), box);
    // Programmatic close behind Core must not restore focus to a vault opener.
    box.querySelector('button').click(); assert.equal(doc.activeElement, core);
    overlay.style.display = 'none'; await f.saveDialog();
    for (const value of ['Tab', 'Escape', 'Enter', ' ']) {
      const e = new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
      e.preventDefault(); const focus = doc.activeElement; focus.dispatchEvent(e);
      assert.equal(doc.activeElement, focus); assert.ok(doc.querySelector('.sgkv-modal'));
    }
    f.vault.openPanel(); overlay.style.display = 'flex'; core.focus();
    f.key(core, 'Escape'); assert.equal(doc.getElementById('sgkvPanel').hidden, false);
  } finally { f.dom.window.close(); }
});

test('panel Escape answers only its own focus or FAB, and yields prevented events', async () => {
  const f = setup();
  try {
    const { doc } = f; f.vault.openPanel();
    const msg = doc.getElementById('msg'); msg.focus();
    assert.equal(f.key(msg, 'Escape').defaultPrevented, false);
    assert.equal(doc.getElementById('sgkvPanel').hidden, false); assert.equal(doc.activeElement, msg);
    const close = doc.querySelector('#sgkvPanel button:last-child'); close.focus();
    f.key(close, 'Escape'); assert.equal(doc.getElementById('sgkvPanel').hidden, true);
    assert.equal(doc.activeElement.id, 'sgkvFab');
    f.vault.openPanel(); const e = new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault(); doc.activeElement.dispatchEvent(e); assert.equal(doc.getElementById('sgkvPanel').hidden, false);
    f.key(doc.getElementById('sgkvFab'), 'Escape'); assert.equal(doc.getElementById('sgkvPanel').hidden, true);
  } finally { f.dom.window.close(); }
});

test('FAB avoids larger End/outline offset and observes outline hidden changes', async () => {
  const f = setup();
  try {
    const { doc, win, vault } = f;
    Object.defineProperty(win, 'innerHeight', { value: 900 });
    doc.querySelector('.messages-shell').getBoundingClientRect = () => rect(0, 50, 1024, 750);
    doc.getElementById('composerWrap').getBoundingClientRect = () => rect(0, 750, 1024, 900);
    const end = doc.getElementById('scrollToBottomBtn'), outline = doc.getElementById('outlineToggleBtn');
    end.getBoundingClientRect = () => rect(960, 700, 992, 732);
    outline.getBoundingClientRect = () => rect(960, 640, 992, 672);
    end.hidden = false; outline.hidden = false; await tick();
    const fab = doc.getElementById('sgkvFab');
    assert.equal(parseFloat(fab.style.bottom), 900 - 640 + 8);
    outline.hidden = true; await tick(); assert.equal(parseFloat(fab.style.bottom), 900 - 700 + 8);
    end.getBoundingClientRect = () => rect(960, 610, 992, 642); outline.hidden = false;
    vault.positionFab(); assert.equal(parseFloat(fab.style.bottom), 900 - 610 + 8);
  } finally { f.dom.window.close(); }
});

for (const composerTop of [280, 150]) {
  test(`844x390 panel anchors to shell top and hides FAB with composer at ${composerTop}`, async () => {
    const f = setup();
    try {
      const { doc, win, vault } = f;
      Object.defineProperty(win, 'innerWidth', { value: 844, configurable: true });
      Object.defineProperty(win, 'innerHeight', { value: 390, configurable: true });
      doc.querySelector('.messages-shell').getBoundingClientRect = () => rect(0, 50, 844, composerTop);
      doc.getElementById('composerWrap').getBoundingClientRect = () => rect(0, composerTop, 844, 390);
      const fab = doc.getElementById('sgkvFab');
      fab.getBoundingClientRect = () => { const bottom = win.innerHeight - parseFloat(fab.style.bottom); return rect(748, bottom - 37, 828, bottom); };
      fab.focus(); vault.openPanel(); await tick();
      const panel = doc.getElementById('sgkvPanel');
      assert.equal(panel.style.top, '58px'); assert.equal(panel.style.bottom, 'auto');
      assert.equal(parseFloat(panel.style.maxHeight), 316);
      assert.equal(win.getComputedStyle(fab).display, 'none'); assert.ok(panel.contains(doc.activeElement));
      f.key(doc.activeElement, 'Escape'); assert.equal(panel.hidden, true); assert.equal(fab.hidden, false);
      assert.equal(doc.activeElement, fab);
      Object.defineProperty(win, 'innerHeight', { value: 900, configurable: true });
      doc.querySelector('.messages-shell').getBoundingClientRect = () => rect(0, 50, 844, 750);
      doc.getElementById('composerWrap').getBoundingClientRect = () => rect(0, 750, 844, 900);
      vault.openPanel(); assert.equal(panel.style.top, ''); assert.equal(fab.hidden, false);
    } finally { f.dom.window.close(); }
  });
}

test('Delete and save return focus safely; typed badges are hidden and diagram/nav notices are bilingual', async () => {
  const f = setup();
  try {
    await f.saveDialog();
    assert.ok([...f.doc.querySelectorAll('.sgkv-choice .sgkv-badge')].every(b => b.getAttribute('aria-hidden') === 'true'));
    f.press(f.button('Save')); f.repeat('Enter'); f.release('Enter'); await tick(); await tick();
    assert.ok(f.doc.activeElement !== f.doc.body); assert.equal(f.approvals(), 0);
    await f.addCard(); await f.viewer();
    assert.match(f.doc.querySelector('.sgkv-modal-body').textContent, /Diagrams are shown as source code/);
    f.press(f.button('Delete')); f.repeat('Enter'); f.release('Enter');
    f.press(f.button('Delete')); f.repeat('Enter'); f.release('Enter'); await tick(); await tick();
    assert.equal(await f.store.get('c'), undefined); assert.equal(f.doc.activeElement.id, 'sgkvList');
    f.press(f.doc.activeElement); f.repeat('Enter'); f.release('Enter');
    assert.equal(f.approvals(), 0);
    assert.match(f.vault.t('session_changed'), /conversation changed/);
    f.doc.documentElement.lang = 'ko';
    assert.match(f.vault.t('session_changed'), /\ub300\ud654/);
    const note = '\ub3c4\uc2dd\uc740 \uc6d0\ubb38 \ucf54\ub4dc\ub85c \ubcf4\uc5ec \uc90d\ub2c8\ub2e4';
    assert.equal(f.vault.t(note), note);
  } finally { f.dom.window.close(); }
});


test('late deletion refresh does not steal focus from the composer', async () => {
  const f = setup();
  try {
    await f.addCard(); await f.viewer();
    let finish;
    const remove = f.store.remove;
    f.store.remove = id => new Promise(resolve => { finish = async () => { await remove(id); resolve(); }; });
    f.press(f.button('Delete')); f.release('Enter');
    f.press(f.button('Delete')); f.release('Enter'); await tick();
    const msg = f.doc.getElementById('msg'); msg.focus();
    await finish(); await tick(); await tick();
    assert.equal(f.doc.activeElement, msg);
    assert.equal(await f.store.get('c'), undefined);
  } finally { f.dom.window.close(); }
});

for (const lang of ['en', 'ko']) {
  test(`new nav session_changed refusal is shown in viewer (${lang})`, async () => {
    const f = setup();
    try {
      f.doc.documentElement.lang = lang;
      f.win.HermesVizNav = { version: 1, goTo: async () => ({ ok: false, reason: 'session_changed' }) };
      await f.addCard(); await f.viewer();
      const note = f.vault.t('session_changed');
      f.press(f.button(lang === 'en' ? 'Go to source' : '\uc6d0\ubb38\uc73c\ub85c \uc774\ub3d9')); f.release('Enter');
      for (let i = 0; i < 40 && !f.doc.querySelector('.sgkv-modal-body').textContent.includes(note); i++) await tick();
      assert.ok(f.doc.querySelector('.sgkv-modal-body').textContent.includes(note));
    } finally { f.dom.window.close(); }
  });
}
