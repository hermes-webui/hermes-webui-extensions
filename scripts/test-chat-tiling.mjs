#!/usr/bin/env node
// Chat Tiling — single-live-session contract tests
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createFreshDom() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>
      <header class="app-titlebar">
        <button id="btnTitlebarNewChat">New chat</button>
        <button id="btnReload">Reload</button>
      </header>
      <main class="main">
        <div id="messages"><div id="msgInner"></div></div>
      </main>
      <textarea id="msg">initial-composer-value</textarea>
      <select id="modelSelect"><option value="gpt4">GPT-4</option><option value="claude">Claude</option></select>
    </body></html>`,
    { url: 'http://localhost' }
  );
  const { window } = dom;
  const { document } = window;

  window.S = { session: null, messages: [], busy: false, activeStreamId: null };
  window.HermesExtensionSettings = { settingsForExtension: () => ({ get: (k) => k === 'auto_tile' ? true : undefined }) };

  const cancelCalls = [];
  const cancelResolvers = [];
  const loadSessionResolvers = [];
  let handlerRegistration = null;

  window.cancelSessionStream = (opts) => {
    cancelCalls.push(opts);
    return new Promise((res) => {
      cancelResolvers.push({ res, opts });
      // Auto-resolve as true after 10ms (default success)
      setTimeout(() => {
        if (cancelResolvers.find(r => r.res === res)) {
          res(true);
        }
      }, 10);
    });
  };
  window.registerHermesSessionOpenHandler = (fn) => { handlerRegistration = fn; };
  window.renderMessages = () => {};
  window.loadSession = (sid, opts) => new Promise((res, rej) => {
    loadSessionResolvers.push({ sid, opts, res, rej });
    // Simulate Core updating S.session after load
    setTimeout(() => {
      if (window.S) {
        window.S.session = { session_id: sid, title: sid.toUpperCase(), messages: window.S.messages };
      }
    }, 5);
  });
  window.renderTranscript = (target, msgs) => {
    if (target && msgs) {
      target.innerHTML = msgs.map(m => `<div class="msg">${typeof m === 'string' ? m : (m.content || '')}</div>`).join('');
    }
  };
  window.CSS = { escape: s => s };
  window.autoResize = () => {};
  window.syncTopbar = () => {};
  window.syncModelChip = () => {};
  window.showToast = () => {};
  window.clearInflightState = () => {};
  window.INFLIGHT = {};

  // Replace jsdom's MutationObserver with a controllable polyfill so
  // panel-gating (S18) and any observer-driven paths fire deterministically.
  // The polyfill records live instances (window.__mutationObservers) so tests
  // can trigger attribute-change callbacks explicitly.
  window.__mutationObservers = [];
  window.MutationObserver = class MutationObserver {
    constructor(cb) { this._cb = cb; this._target = null; this._opts = null; window.__mutationObservers.push(this); }
    observe(target, opts) { this._target = target; this._opts = opts || {}; }
    disconnect() { this._target = null; }
    _trigger() { if (this._target) this._cb([], this); }
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.S = window.S;
  if (window.MutationObserver) globalThis.MutationObserver = window.MutationObserver;
  globalThis.cancelSessionStream = window.cancelSessionStream;
  globalThis.INFLIGHT = window.INFLIGHT;
  globalThis.clearInflightState = window.clearInflightState;

  const code = readFileSync(path.join(repoRoot, 'extensions/chat-tiling/assets/tiling.js'), 'utf8');
  eval(code);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return { window, document, cancelCalls, cancelResolvers, loadSessionResolvers, handlerRegistration, S: window.S };
}

const settle = () => sleep(100);
const setSession = (h, sid, title, msgs) => { h.S.session = { session_id: sid, title, messages: msgs }; h.S.messages = msgs; };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n' + name); }

async function main() {

  // ═══════ S1: Activation creates tiles from current session ═══════
  section('S1: Activation creates tiles from current session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 2, '2 tiles created');
    assert(tiles[0].querySelector('.ext-tile-title').textContent === 'Session A', 'first tile shows session A');
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner && msgInner.closest('.ext-tile') === tiles[0], 'msgInner on focused tile');
  }

  // ═══════ S2: Focus switching saves and restores atomically ═══════
  section('S2: Focus switching saves and restores atomically');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    h.document.getElementById('msg').value = 'draft-b';
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(h.document.getElementById('msg').value === '', 'A has empty composer (no bleed from B)');
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    assert(h.document.getElementById('msg').value === 'draft-b', 'B restores its own draft');
  }

  // ═══════ S3: Rapid A→B where stale A rejects after B ═══════
  section('S3: Rapid A→B where stale A rejects after B');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    // Do NOT reassign the resolver array (that detaches it from the harness
    // closure and the stale rejection never runs). Capture references instead.
    const resolvers = h.loadSessionResolvers;
    const startLen = resolvers.length;
    h.window.focusTileExt(parseInt(tileA.dataset.tileId)); // schedules loadSession for A
    await settle();
    h.window.focusTileExt(parseInt(tileB.dataset.tileId)); // schedules loadSession for B
    await settle();
    const rA = resolvers[startLen];
    const rB = resolvers[startLen + 1];
    assert(!!rA && !!rB, 'both loadSession calls captured resolvers');
    // Resolve the LATEST (B) first — B owns S.
    setSession(h, 'sid-B', 'Session B', ['b-resolved']);
    rB.res();
    await settle();
    // Now reject the STALE A resolver: it must NOT clobber B's ownership.
    rA.rej(new Error('stale'));
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'B owns S after stale A rejects');
    const tileBInner = tileB.querySelector('.ext-tile-msg-inner');
    assert(!tileBInner.textContent.includes('a-msg') && !tileBInner.textContent.includes('a-resolved'), 'stale A rejection did not clobber B tile content');
  }

  // ═══════ S4: Full-grid navigation replaces focused tile ═══════
  section('S4: Full-grid navigation replaces focused tile');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    // C replaces the focused tile instead of being cancelled
    const r = h.handlerRegistration('sid-C', null, { preload: true });
    assert(!(r && r.cancel === true), 'full-grid preload replaces focused tile (no cancel)');
    setSession(h, 'sid-C', 'Session C', ['c']);
    h.handlerRegistration('sid-C', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 2, 'still 2 tiles after replace');
    // Focused tile now shows session C
    const focused = h.document.querySelector('.ext-tile--focused');
    assert(focused.querySelector('.ext-tile-title').textContent === 'Session C', 'focused tile shows C');
  }

  // ═══════ S5: Failed cancellation preserves tile ═══════
  section('S5: Failed cancellation preserves tile');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    h.S.busy = true; h.S.activeStreamId = 'stream-A';
    await sleep(700);
    // Override cancel to return false
    h.window.cancelSessionStream = () => Promise.resolve(false);
    globalThis.cancelSessionStream = h.window.cancelSessionStream;
    const result = await h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    assert(result === false, 'close returns false when cancel refused');
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 2, 'tile A preserved on cancel refusal');
  }

  // ═══════ S6: Timed-out preload releases its slot ═══════
  section('S6: Timed-out preload releases its slot');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    // Shorten the preload timeout for this test (60ms).
    h.window.HermesExtensionSettings = {
      settingsForExtension: () => ({
        get: (k) => k === 'auto_tile' ? true : (k === 'preload_timeout_ms' ? 60 : undefined)
      })
    };
    // B preload reserves slot 2, then times out (no loaded event).
    const rb = h.handlerRegistration('sid-B', null, { preload: true });
    assert(!(rb && rb.cancel === true), 'B preload reserved a slot');
    await sleep(250); // > 60ms → timeout fires, reservation released
    // C must be able to reuse the released slot ({}), not get {cancel:true}.
    const rc = h.handlerRegistration('sid-C', null, { preload: true });
    assert(!(rc && rc.cancel === true), 'C reuses the slot released by timed-out B (not cancel)');
    setSession(h, 'sid-C', 'Session C', ['c']);
    h.handlerRegistration('sid-C', h.S.session, { loaded: true });
    await settle();
    // Now the grid is full again (A + C): D replaces focused tile.
    const rd = h.handlerRegistration('sid-D', null, { preload: true });
    assert(!(rd && rd.cancel === true), 'D replaces focused tile when grid full again');
  }

  // ═══════ S7: Hide/close restores focused session with its draft ═══════
  section('S7: Hide/close restores focused session with its draft');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    h.document.getElementById('msg').value = 'draft-b';
    await h.window.hideGridExt();
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'restored B');
    assert(h.document.getElementById('msg').value === 'draft-b', 'restored B\'s draft (not A\'s)');
  }

  // ═══════ S8: Active transcript has a scroll owner ═══════
  section('S8: Active transcript has a scroll owner');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', []);
    h.window.showGridExt(2, 1);
    await settle();
    const longMsgs = Array.from({ length: 100 }, (_, i) => ({ content: `msg-${i}` }));
    h.S.messages = longMsgs;
    h.window.renderMessages();
    await settle();
    const tile = h.document.querySelector('.ext-tile');
    const msgInner = tile.querySelector('.ext-tile-msg-inner');
    assert(msgInner.id === 'msgInner', 'active tile owns live msgInner');
    // The injected stylesheet must give the ACTIVE transcript the scroll owner
    // (a replacement scroller), since tiling disables Core's #messages scroller.
    const cssText = h.document.getElementById('ext-tile-css').textContent;
    const rule = /\.ext-tile-msg-inner\[id="msgInner"\]\s*\{[^}]*overflow-y\s*:\s*auto/i.test(cssText);
    assert(rule, 'scroll-owner rule exists for the active transcript');
    // A long transcript must be rendered inside that scrollable container
    // (Core renders into #msgInner, which is the active tile's msg-inner).
    h.window.renderTranscript(msgInner, longMsgs);
    assert(msgInner.querySelectorAll('.msg').length === 100, '100 messages rendered inside active transcript');
  }

  // ═══════ S9: Non-focused tile is read-only snapshot ═══════
  section('S9: Non-focused tile is read-only snapshot');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    const msgInnerA = tileA.querySelector('.ext-tile-msg-inner');
    assert(msgInnerA.id !== 'msgInner', 'non-focused tile A does not own msgInner');
    const msgInnerB = tileB.querySelector('.ext-tile-msg-inner');
    assert(msgInnerB.id === 'msgInner', 'focused tile B owns msgInner');
  }

  // ═══════ S10: Composer text does not leak between tiles ═══════
  section('S10: Composer text does not leak between tiles');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const composer = h.document.getElementById('msg');
    composer.value = 'draft-a';
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    composer.value = ''; // Core sets B's (empty) draft before loaded
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    assert(composer.value === '', 'B has empty composer (no leak from A)');
    composer.value = 'draft-b';
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(composer.value === 'draft-a', 'A restores its own draft (no bleed from B)');
  }

  // ═══════ S11: Double-close busy tile preserves sibling ═══════
  section('S11: Double-close busy tile preserves sibling');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    h.S.busy = true; h.S.activeStreamId = 'stream-A';
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    // Cancel auto-resolves after 10ms
    const p1 = h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    const p2 = h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    await Promise.all([p1, p2]);
    await settle();
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 1, 'only 1 tile remains');
    assert(parseInt(remaining[0].dataset.tileId) === parseInt(tileB.dataset.tileId), 'sibling B preserved');
  }

  // ═══════ S12: Toolbar exists (activation test) ═══════
  section('S12: Toolbar exists and anchors into current Core .app-titlebar');
  {
    const h = createFreshDom();
    const tb = h.document.getElementById('ext-tiling-toolbar');
    assert(!!tb, 'toolbar exists');
    const inTitlebar = !!tb && tb.closest('.app-titlebar') !== null;
    assert(inTitlebar, 'toolbar is anchored inside .app-titlebar (current Core host hook)');
    assert(!!h.document.getElementById('msgInner'), 'msgInner on Core container');
    const labels = Array.from(tb.querySelectorAll('.ext-toolbar-btn')).map(b => b.getAttribute('aria-label'));
    assert(labels.includes('Split in 2'), 'toolbar renders aria-label "Split in 2"');
    assert(labels.includes('Split in 4'), 'toolbar renders aria-label "Split in 4"');
    assert(labels.includes('Split in 6'), 'toolbar renders aria-label "Split in 6"');
    assert(labels.includes('Close tiling'), 'toolbar renders aria-label "Close tiling"');
  }

  // ═══════ S18: Toolbar is panel-gated (chat only) and fail-closed ═══════
  section('S18: Toolbar is panel-gated (chat only) and fail-closed');
  {
    const h = createFreshDom();
    const tb = h.document.getElementById('ext-tiling-toolbar');
    assert(!!tb && tb.classList.contains('ext-tiling-toolbar--visible'), 'toolbar visible on chat panel (no showing-* class)');
    const fireObservers = () => (h.window.__mutationObservers || []).forEach(o => o._trigger());
    // Switch to a non-chat panel — Core adds showing-<name> to main.main.
    const main = h.document.querySelector('main.main');
    main.classList.add('showing-tasks');
    fireObservers();
    await settle();
    assert(tb.classList.contains('ext-tiling-toolbar--panel-hidden'), 'toolbar hidden on tasks panel');
    main.classList.remove('showing-tasks');
    fireObservers();
    await settle();
    assert(!tb.classList.contains('ext-tiling-toolbar--panel-hidden'), 'toolbar visible again on chat panel');
  }
  {
    // Fail-closed: no .app-titlebar / #topbar → no crash, extension still inits.
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head></head><body>
        <main class="main"><div id="messages"><div id="msgInner"></div></div></main>
        <textarea id="msg"></textarea>
        <select id="modelSelect"><option value="gpt4">GPT-4</option></select>
      </body></html>`,
      { url: 'http://localhost' }
    );
    const { window } = dom; const { document } = window;
    window.S = { session: null, messages: [], busy: false, activeStreamId: null };
    window.HermesExtensionSettings = { settingsForExtension: () => ({ get: () => true }) };
    window.registerHermesSessionOpenHandler = () => {};
    window.renderMessages = () => {};
    window.loadSession = () => new Promise(r => r());
    window.renderTranscript = () => {};
    window.CSS = { escape: s => s };
    window.autoResize = () => {};
    window.syncTopbar = () => {};
    window.syncModelChip = () => {};
    window.showToast = () => {};
    window.clearInflightState = () => {};
    window.INFLIGHT = {};
    globalThis.window = window; globalThis.document = document; globalThis.S = window.S;
    const code = readFileSync(path.join(repoRoot, 'extensions/chat-tiling/assets/tiling.js'), 'utf8');
    eval(code);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    assert(!document.getElementById('ext-tiling-toolbar'), 'no toolbar when host hook is absent (fail closed)');
    assert(!!document.getElementById('ext-tile-grid'), 'grid still inits without a toolbar hook');
  }

  // ═══════ S13: Preload→loaded does not overwrite A's live surface/draft ═══════
  section('S13: Preload→loaded does not overwrite A live surface/draft');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    // A is focused and owns the live surface; give A a draft.
    const composer = h.document.getElementById('msg');
    composer.value = 'draft-a';
    // Core order: preload(B) fires BEFORE S mutates to B.
    h.handlerRegistration('sid-B', null, { preload: true });
    await settle();
    // Now Core mutates S to B, sets B's (empty) draft in the composer, and
    // fires loaded(B).
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    composer.value = ''; // Core sets B's empty draft
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    const bodyA = tileA.querySelector('.ext-tile-msg-inner').textContent;
    const bodyB = tileB.querySelector('.ext-tile-msg-inner').textContent;
    assert(tileA.querySelector('.ext-tile-title').textContent === 'Session A', 'tile A title stays Session A');
    assert(bodyA.includes('a-msg') && !bodyA.includes('b-msg'), 'tile A body shows A, not B');
    assert(bodyB.includes('b-msg'), 'tile B body shows B');
    assert(composer.value === '', 'B focused with empty draft after load (A draft preserved in tile A)');
    // Refocus A: it must restore A's draft, not B's.
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    assert(composer.value === 'draft-a', 'refocusing A restores A draft (not B draft)');
    // Refocus B: it must restore B's (empty) draft, not A's.
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    assert(composer.value === '', 'refocusing B restores empty B draft (not A draft)');
  }

  // ═══════ S14: Exit with empty focused draft does not mix sessions ═══════
  section('S14: Exit with empty focused draft does not mix sessions');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    // A has a draft in the composer before B loads.
    const composer = h.document.getElementById('msg');
    composer.value = 'draft-a';
    // Load B with an EMPTY draft (Core sets B's empty draft in the composer).
    h.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    composer.value = ''; // Core sets B's empty draft
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    // B's focused draft is empty — exiting tiling must restore B + empty draft,
    // NOT fall back to the pre-grid A draft.
    await h.window.hideGridExt();
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'restored B session');
    assert(h.document.getElementById('msg').value === '', 'empty B draft restored as empty (not A draft)');
  }

  // ═══════ S15: Late loaded(B) after slot reused by C is ignored ═══════
  section('S15: Late loaded(B) after slot reuse by C is ignored');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    // Shorten the preload timeout for this test (60ms).
    h.window.HermesExtensionSettings = {
      settingsForExtension: () => ({
        get: (k) => k === 'auto_tile' ? true : (k === 'preload_timeout_ms' ? 60 : undefined)
      })
    };
    // 1. B preload reserves slot 2, then times out (no loaded event).
    const rb = h.handlerRegistration('sid-B', null, { preload: true });
    assert(!(rb && rb.cancel === true), 'B preload reserved a slot');
    await sleep(250); // > 60ms → B's timeout fires, slot released
    // 2. C preload reuses the released slot — reservation now belongs to C.
    const rc = h.handlerRegistration('sid-C', null, { preload: true });
    assert(!(rc && rc.cancel === true), 'C reuses the slot released by timed-out B');
    // 3. Late loaded(B) arrives while C is still pending. It must be ignored:
    //    no tile may adopt sid-B, and C's reservation must stay intact.
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tilesAfterLateB = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(!tilesAfterLateB.some(t => t.querySelector('.ext-tile-title').textContent === 'Session B'),
      'late loaded(B) does not hijack the tile reserved for C');
    const tile2 = tilesAfterLateB[1];
    assert(tile2.querySelector('.ext-tile-title').textContent !== 'Session B', 'tile 2 still has no B sid/title');
    // 4. loaded(C) must still land C in the reserved tile.
    setSession(h, 'sid-C', 'Session C', ['c-msg']);
    h.handlerRegistration('sid-C', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 2, 'two tiles remain after C loads');
    const tileC = tiles[1];
    assert(tileC.querySelector('.ext-tile-title').textContent === 'Session C', 'tile 2 title is Session C');
    assert(tileC.querySelector('.ext-tile-msg-inner').textContent.includes('c-msg'), 'tile 2 body shows C messages');
    assert(h.S.session.session_id === 'sid-C', 'C owns the active session');
  }

  // ═══════ S16: Late loaded(B) takes an unreserved fallback tile without
  // clearing C's pending reservation (3-slot grid) ═══════
  section('S16: Fallback loaded(B) preserves the pending reservation for C');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(3, 1);
    await settle();
    h.window.HermesExtensionSettings = {
      settingsForExtension: () => ({
        get: (k) => k === 'auto_tile' ? true : (k === 'preload_timeout_ms' ? 60 : undefined)
      })
    };
    // B preload reserves slot 2, times out, C re-reserves slot 2. Tile 3 is
    // empty and unreserved.
    h.handlerRegistration('sid-B', null, { preload: true });
    await sleep(250);
    const rc = h.handlerRegistration('sid-C', null, { preload: true });
    assert(!(rc && rc.cancel === true), 'C reserved slot 2 after B timed out');
    // Late loaded(B): must land in the unreserved tile 3 (fallback), NOT
    // hijack C's reserved slot 2, and must NOT clear C's pending reservation.
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tilesAfterB = Array.from(h.document.querySelectorAll('.ext-tile'));
    const t2 = tilesAfterB[1], t3 = tilesAfterB[2];
    assert(t2.querySelector('.ext-tile-title').textContent !== 'Session B', 'tile 2 not hijacked by late B');
    assert(t3.querySelector('.ext-tile-title').textContent === 'Session B', 'tile 3 takes B via fallback');
    // loaded(C) must still land C on the reserved slot 2.
    setSession(h, 'sid-C', 'Session C', ['c-msg']);
    h.handlerRegistration('sid-C', h.S.session, { loaded: true });
    await settle();
    const tilesFinal = Array.from(h.document.querySelectorAll('.ext-tile'));
    const f2 = tilesFinal[1], f3 = tilesFinal[2];
    assert(f2.querySelector('.ext-tile-title').textContent === 'Session C', 'C lands on reserved slot 2');
    assert(f2.querySelector('.ext-tile-msg-inner').textContent.includes('c-msg'), 'slot 2 body shows C');
    assert(f3.querySelector('.ext-tile-title').textContent === 'Session B', 'B stays on tile 3');
  }

  // ═══════ S17: Concurrent pending reservations — preload(B) → preload(C) →
  // loaded(C) → loaded(B). B must not be orphaned with _pending=true and no
  // timer (the singleton pendingTile/pendingTimer bug). ═══════
  section('S17: Concurrent pending reservations do not orphan a slot');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(3, 1);
    await settle();
    h.window.HermesExtensionSettings = {
      settingsForExtension: () => ({
        get: (k) => k === 'auto_tile' ? true : (k === 'preload_timeout_ms' ? 60 : undefined)
      })
    };
    // 1. B preload reserves slot 2.
    const rb = h.handlerRegistration('sid-B', null, { preload: true });
    assert(!(rb && rb.cancel === true), 'B preload reserved a slot');
    // 2. C preload reserves slot 3 (B's timer must NOT be cleared by C).
    const rc = h.handlerRegistration('sid-C', null, { preload: true });
    assert(!(rc && rc.cancel === true), 'C preload reserved a slot');
    // 3. C loads first — consumes C's reservation, C lands on tile 3.
    setSession(h, 'sid-C', 'Session C', ['c-msg']);
    h.handlerRegistration('sid-C', h.S.session, { loaded: true });
    await settle();
    let tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 3, 'three tiles remain after C loads');
    assert(tiles[2].querySelector('.ext-tile-title').textContent === 'Session C', 'C landed on tile 3');
    // 4. B's loaded event arrives — B must land on tile 2 (its own reservation),
    //    NOT be orphaned. The singleton bug would leave tile 2 _pending=true
    //    forever because C's preload cleared B's timer.
    setSession(h, 'sid-B', 'Session B', ['b-msg']);
    h.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 3, 'three tiles remain after B loads');
    assert(tiles[1].querySelector('.ext-tile-title').textContent === 'Session B', 'B landed on tile 2 (not orphaned)');
    assert(tiles[1].querySelector('.ext-tile-msg-inner').textContent.includes('b-msg'), 'tile 2 body shows B');
    assert(tiles[2].querySelector('.ext-tile-title').textContent === 'Session C', 'C still on tile 3');
    assert(tiles[2].querySelector('.ext-tile-msg-inner').textContent.includes('c-msg'), 'tile 3 body still shows C');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
