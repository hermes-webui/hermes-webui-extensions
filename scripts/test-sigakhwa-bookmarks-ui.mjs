import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { FILES, fakeSidecar } from './sigakhwa-bookmarks-test-helpers.mjs';

const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 30));

async function boot({ lang = '', rejected = false, sidecar = fakeSidecar({ healthy: false }), localRows = [] } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="messages-shell"><button id="jumpToSessionStartBtn">Start</button><button id="hwxMessagePinsHeaderBtn">Pins</button></div></body></html>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.document.documentElement.lang = lang;
  w.S = { session: { session_id: 's1', title: 'Conversation' }, messages: [], activeProfile: 'default' };
  w.fetch = sidecar.fetch;
  if (localRows.length) w.localStorage.setItem('hermes-viz-store:bookmarks', JSON.stringify({ v: 1, items: localRows }));
  const state = { action: null, registrations: [], unregistrations: 0, eventBindings: 0 };
  w.hermesExt = { register: () => ({ messages: {
    registerAction: action => { state.action = action; state.registrations.push(action); return rejected ? false : () => { state.unregistrations++; }; },
    invalidateActions() {},
  }, events: { on() { state.eventBindings++; } } }) };
  const shell = w.document.querySelector('.messages-shell');
  shell.getBoundingClientRect = () => ({ right: 1000 });
  w.document.getElementById('jumpToSessionStartBtn').getBoundingClientRect = () => ({ left: 920, width: 60 });
  w.document.getElementById('hwxMessagePinsHeaderBtn').getBoundingClientRect = () => ({ left: 850, width: 60 });
  for (const script of ['store', 'ext']) w.eval(fs.readFileSync(FILES[script], 'utf8'));
  await flush();
  w.SigakhwaBookmarks.open();
  await flush();
  return { w, state, doc: w.document, sidecar };
}

test('English is the default; Korean original text is preserved and next render follows language', async () => {
  const { w, doc, state } = await boot();
  assert.equal(state.action.label, 'Bookmark');
  assert.equal(doc.querySelector('.svb-title').textContent, 'Bookmarks · Contents');
  assert.equal(doc.querySelector('[data-tab="toc"]').textContent, 'Contents');
  assert.equal(w.SigakhwaBookmarks.defaultName(''), 'Bookmark');
  doc.documentElement.lang = 'ko-KR';
  await w.SigakhwaBookmarks.refresh();
  assert.equal(doc.querySelector('.svb-title').textContent, '북마크 · 목차');
  assert.equal(doc.querySelector('[data-tab="toc"]').textContent, '목차');
  assert.equal(w.SigakhwaBookmarks.defaultName(''), '북마크');
  assert.equal(doc.querySelector('.svb-sync-badge').textContent, '이 기기에만 저장됨');
  assert.equal(doc.querySelector('.svb-empty').textContent, '저장된 북마크가 없습니다. 메시지 하단의 북마크 버튼으로 저장하세요.');
});

test('toolbar sits left of message-pins and Core Start buttons', async () => {
  const { doc, w } = await boot();
  assert.equal(doc.getElementById('svbToggleBtn').style.right, '158px');
  const pins = doc.getElementById('hwxMessagePinsHeaderBtn');
  pins.style.display = 'none';
  w.dispatchEvent(new w.Event('resize'));
  assert.equal(doc.getElementById('svbToggleBtn').style.right, '88px');
});

test('action budget rejection is visible in the panel', async () => {
  const { doc } = await boot({ rejected: true });
  assert.match(doc.querySelector('.svb-error').textContent, /action could not be registered/);
});

test('failed requests replace the synced badge and retry restores it', async () => {
  const options = {};
  const sidecar = fakeSidecar(options);
  const { w, doc } = await boot({ sidecar });
  assert.equal(doc.querySelector('.svb-sync-badge').textContent, 'Synced');
  options.listStatus = 502;
  await w.SigakhwaBookmarks.refresh();
  assert.equal(doc.querySelector('.svb-sync-badge').textContent, 'Sync unavailable');
  assert.equal(doc.querySelector('.svb-sync-badge').classList.contains('svb-sync-badge--on'), false);
  doc.documentElement.lang = 'ko';
  await w.SigakhwaBookmarks.refresh();
  assert.equal(doc.querySelector('.svb-sync-badge').textContent, '동기화 안 됨(재시도 중)');
  options.listStatus = null;
  await w.SigakhwaBookmarks.refresh();
  assert.equal(doc.querySelector('.svb-sync-badge').textContent, '동기화됨');
});

test('quota and item size failures explain the separate limits', async () => {
  const { w, state, doc } = await boot();
  for (const [code, text] of [['quota', /1,000 items \/ 2 MiB/], ['too_large', /256 KiB/]]) {
    const pending = state.action.onInvoke({ sessionId: 's1', messageIndex: 0, role: 'user', text: 'Bookmark text' });
    w.SigakhwaBookmarks.store.put = () => Promise.reject(Object.assign(new Error(code), { code }));
    doc.querySelector('.svb-dialog .svb-btn--primary').click();
    await flush();
    assert.match(doc.querySelector('.svb-dialog-error').textContent, text);
    doc.querySelector('.svb-dialog .svb-btn').click();
    await pending;
  }
});

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`review 2, 7, 13: late pins creation and Start movement have zero overlap at ${width}x${height}`, async () => {
    const { w, doc } = await boot();
    Object.defineProperty(w, 'innerWidth', { value: width });
    Object.defineProperty(w, 'innerHeight', { value: height });
    const shell = doc.querySelector('.messages-shell');
    const shellTop = width === 390 ? 47 : 39;
    const rect = (left, top, rw, rh) => ({ left, top, right: left + rw, bottom: top + rh, width: rw, height: rh });
    shell.getBoundingClientRect = () => rect(0, shellTop, width, height - shellTop);
    const start = doc.getElementById('jumpToSessionStartBtn');
    let startTop = shellTop + 16;
    start.style.display = 'none';
    start.getBoundingClientRect = () => rect(width - 100, startTop, 60, 32);
    doc.getElementById('hwxMessagePinsHeaderBtn').remove();
    const toggle = doc.getElementById('svbToggleBtn');
    toggle.getBoundingClientRect = () => rect(width - parseFloat(toggle.style.right) - 34, shellTop + parseFloat(toggle.style.top), 34, 32);
    await flush();
    const pins = doc.createElement('button');
    pins.id = 'hwxMessagePinsHeaderBtn';
    let pinsLeft = width - 53, pinsTop = shellTop + 16;
    pins.getBoundingClientRect = () => rect(pinsLeft, pinsTop, 32, 32);
    shell.appendChild(pins);
    function overlap(a, b) {
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    }
    await flush();
    assert.equal(overlap(toggle.getBoundingClientRect(), pins.getBoundingClientRect()), 0);
    const pinsObserver = new w.MutationObserver(() => {
      pinsLeft = width - 133; pinsTop = startTop + 6;
      pins.style.right = '101px';
    });
    pinsObserver.observe(start, { attributes: true, attributeFilter: ['style'] });
    startTop += 8;
    start.style.display = 'block';
    await flush();
    await flush();
    assert.equal(overlap(toggle.getBoundingClientRect(), pins.getBoundingClientRect()), 0);
    assert.equal(overlap(toggle.getBoundingClientRect(), start.getBoundingClientRect()), 0);
    assert.equal(toggle.getBoundingClientRect().top, startTop);
    assert.equal(parseFloat(doc.getElementById('svbPanel').style.getPropertyValue('--svb-panel-top')), toggle.getBoundingClientRect().bottom + 8);
    pinsLeft -= 40; pins.className = 'moved';
    await flush();
    assert.equal(overlap(toggle.getBoundingClientRect(), pins.getBoundingClientRect()), 0);
    pinsObserver.disconnect();
  });
}

test('review 7, 8, 9, 11, 13: panel anchors, workspace offset, theme tokens and responsive motion rules', async () => {
  const { w, doc } = await boot();
  const toggle = doc.getElementById('svbToggleBtn');
  toggle.getBoundingClientRect = () => ({ top: 55, bottom: 87, right: 1000 });
  w.dispatchEvent(new w.Event('resize'));
  const panel = doc.getElementById('svbPanel');
  assert.equal(panel.style.getPropertyValue('--svb-panel-top'), '95px');
  assert.equal(panel.style.getPropertyValue('--svb-panel-right'), (w.innerWidth - 1000) + 'px');
  const css = fs.readFileSync(FILES.ext.replace(/\.js$/, '.css'), 'utf8');
  assert.match(css, /right: max\(var\(--svb-panel-right.*--outline-workspace-offset/);
  for (const token of ['success', 'warning', 'error']) assert.ok(css.includes(`var(--${token})`));
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /top: 10px/);
});

test('review 10: panel focus, roving arrow tabs, aria-controls, outside click and chat departure', async () => {
  const { w, doc } = await boot();
  const toggle = doc.getElementById('svbToggleBtn');
  w.SigakhwaBookmarks.close();
  toggle.focus(); toggle.click();
  const tabB = doc.getElementById('svbTabBookmarks'), tabT = doc.getElementById('svbTabToc');
  assert.equal(doc.activeElement, tabB);
  for (const tab of [tabB, tabT]) assert.equal(tab.getAttribute('aria-controls'), 'svbPanelBody');
  tabB.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement, tabT);
  assert.equal(tabB.tabIndex, -1); assert.equal(tabT.tabIndex, 0);
  assert.equal(doc.getElementById('svbPanelBody').getAttribute('aria-labelledby'), tabT.id);
  tabT.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(doc.activeElement, tabB);
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.getElementById('svbPanel').hidden, true);
  assert.equal(doc.activeElement, toggle);
  toggle.click(); doc.body.click();
  assert.equal(doc.getElementById('svbPanel').hidden, true);
  toggle.click();
  doc.querySelector('.messages-shell').style.display = 'none';
  await flush();
  assert.equal(doc.getElementById('svbPanel').hidden, true);
});

test('review 13: language switch unregisters and re-registers action without duplicate event handlers', async () => {
  const { doc, state } = await boot();
  doc.documentElement.lang = 'ko';
  await flush();
  assert.equal(state.action.label, '북마크');
  assert.equal(state.unregistrations, 1);
  doc.documentElement.lang = 'fr';
  await flush();
  assert.equal(state.action.label, 'Bookmark');
  assert.equal(state.unregistrations, 2);
  assert.equal(state.registrations.length, 3);
  assert.equal(state.eventBindings, 1);
});

test('review 4: code-point cutoff keeps emoji intact in default and saved names', async () => {
  const { w, doc, state } = await boot();
  assert.equal(w.SigakhwaBookmarks.defaultName('x'.repeat(39) + '😀'), 'x'.repeat(39) + '😀');
  assert.equal(w.SigakhwaBookmarks.defaultName('x'.repeat(39) + '😀after'), 'x'.repeat(39) + '😀…');
  const pending = state.action.onInvoke({ sessionId: 's1', messageIndex: 0, role: 'user', text: 'test' });
  doc.querySelector('.svb-dialog-input').value = 'x'.repeat(119) + '😀after';
  doc.querySelector('.svb-dialog .svb-btn--primary').click();
  await pending;
  const saved = (await w.SigakhwaBookmarks.store.list())[0];
  assert.equal(saved.name, 'x'.repeat(119) + '😀');
});

test('review 3: conflicting local version is visibly labelled in both languages', async () => {
  const sidecar = fakeSidecar();
  const row = { id: 'conflict', kind: 'bookmark', profile: 'default', sessionId: 's1', messageIndex: 0, role: 'user', name: 'local', namespace: 'bookmarks', createdAt: 1, updatedAt: 2, data: {} };
  await sidecar.fetch(sidecar.base + '/v1/bookmarks/items?offset=0');
  sidecar.state.ns.get('bookmarks').set(row.id, { ...row, name: 'server' });
  const { doc } = await boot({ sidecar, localRows: [row] });
  assert.equal(doc.querySelector('.svb-chip--local').textContent, 'Conflict · This device copy');
  assert.equal(doc.querySelectorAll('.svb-entry-row').length, 2);
  doc.documentElement.lang = 'ko';
  await flush();
  assert.equal(doc.querySelector('.svb-chip--local').textContent, '충돌 · 이 기기 사본');
});
