import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { FILES, fakeSidecar } from './sigakhwa-bookmarks-test-helpers.mjs';

const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 30));

async function boot({ lang = '', rejected = false, sidecar = fakeSidecar({ healthy: false }) } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="messages-shell"><button id="jumpToSessionStartBtn">Start</button><button id="hwxMessagePinsHeaderBtn">Pins</button></div></body></html>', { url: 'http://localhost', runScripts: 'outside-only' });
  const w = dom.window;
  windows.push(w);
  w.document.documentElement.lang = lang;
  w.S = { session: { session_id: 's1', title: 'Conversation' }, messages: [], activeProfile: 'default' };
  w.fetch = sidecar.fetch;
  const state = { action: null };
  w.hermesExt = { register: () => ({ messages: {
    registerAction: action => { state.action = action; return rejected ? false : () => {}; },
    invalidateActions() {},
  }, events: { on() {} } }) };
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
