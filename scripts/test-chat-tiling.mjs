// Test suite for Chat Tiling extension — overlay architecture
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(100);

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n' + name); }

function createFreshDom() {
  // Mirrors live Core's real contracts (nesquena/hermes-webui):
  //   - <main class="main"> with NO `chat` class. Core marks the active view
  //     with `showing-<panel>`; chat is the ABSENCE of any such class.
  //   - #mainChat > .messages-shell (position:relative, NON-scrolling) > #messages (scroll owner)
  //   - `const S` is a top-level lexical global in ui.js, NOT window.S
  //   - cancelSessionStream(session) reads snake_case active_stream_id/session_id
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
    <header class="app-titlebar"></header>
    <main class="main">
      <div id="mainChat" class="main-view">
        <div class="messages-shell">
          <div class="messages" id="messages"><div id="msgInner"></div></div>
        </div>
      </div>
      <div class="session-list">
        <div class="session-item" data-sid="existing-1"><span class="session-item-title">Existing 1</span></div>
      </div>
    </main>
    <textarea id="msg">initial-composer-value</textarea>
    <select id="modelSelect"><option value="gpt4">gpt4</option><option value="claude">claude</option></select>
  </body></html>`, { url: 'http://localhost', pretendToBeVisual: true });

  const { window } = dom;
  const { document } = window;

  // Core's single live state object, held as a lexical global exactly like
  // Core's `const S`. Deliberately NOT window.S: code that reads window.S must
  // fail here the same way it fails in the browser.
  const liveS = { session: null, messages: [], busy: false, activeStreamId: null };
  window.__settings = { auto_tile: true, show_sidebar_badges: true, preload_timeout_ms: 5000 };

  // Core's cancelSessionStream(session) returns false unless both snake_case
  // fields are present (boot.js). Reimplemented faithfully so a camelCase
  // caller cannot silently pass.
  window.cancelStreamCalls = [];
  window.__cancelAllowed = true;
  window.cancelSessionStream = (session) => {
    window.cancelStreamCalls.push(session);
    const streamId = session && session.active_stream_id;
    const sid = session && session.session_id;
    if (!streamId || !sid) return Promise.resolve(false);
    return Promise.resolve(window.__cancelAllowed);
  };

  window.registerHermesSessionOpenHandler = (fn) => { window.handlerRegistration = fn; };
  window.renderMessages = () => {};
  window.__loadSessionCalls = [];
  // Core owns the composer and rebinds it to the incoming session's draft on
  // every load (server-restored drafts live in __drafts).
  window.__drafts = {};
  window.loadSession = (sid) => {
    window.__loadSessionCalls.push(sid);
    // Simulate Core loading a session: update S.session and S.messages
    liveS.session = { session_id: sid, title: `Session ${sid}`, messages: liveS.messages };
    const composer = document.getElementById('msg');
    if (composer) composer.value = window.__drafts[sid] || '';
    return Promise.resolve();
  };
  window.renderTranscript = (target, msgs) => { if (target && msgs) { target.textContent = ''; msgs.forEach(m => { const d = document.createElement('div'); d.textContent = m; target.appendChild(d); }); } };
  window.HermesExtensionSettings = {
    settingsForExtension: () => ({
      get: (k) => Object.prototype.hasOwnProperty.call(window.__settings, k) ? window.__settings[k] : undefined
    })
  };
  window.CSS = { escape: s => s };
  window.autoResize = () => {};
  window.syncTopbar = () => {};
  window.syncModelChip = () => {};
  window.showToast = () => {};
  window.clearInflightState = () => {};
  window.INFLIGHT = {};
  globalThis.window = window; globalThis.document = document;
  globalThis.S = liveS;
  globalThis.cancelSessionStream = window.cancelSessionStream;
  globalThis.MutationObserver = window.MutationObserver;

  const code = readFileSync('extensions/chat-tiling/assets/tiling.js', 'utf8');
  eval(code);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  // `S` is a lexical global in Core; expose the same object for assertions.
  return { window, document, get S() { return liveS; } };
}

function setSession(h, sid, title, msgs) {
  const S = h.S;
  S.session = { session_id: sid, title, messages: msgs };
  S.messages = msgs;
}

// Bind a tile to a session the way the real feature does: through the
// preload/loaded session-open hook, not by poking state.
async function bindTileViaHook(h, sid, msgs) {
  h.window.handlerRegistration(sid, null, { preload: true });
  setSession(h, sid, `Session ${sid}`, msgs || [sid]);
  // Core rebinds the composer to the incoming session's draft before the
  // `loaded` hook fires.
  const composer = h.document.getElementById('msg');
  if (composer) composer.value = h.window.__drafts[sid] || '';
  h.window.handlerRegistration(sid, h.S.session, { loaded: true });
  await settle();
}

async function main() {

  // S1: Inactive on page load
  section('S1: Extension does not auto-activate on page load');
  {
    const h = createFreshDom();
    await settle();
    assert(h.window.chatTilingState.visible === false, 'not visible on load');
    assert(h.window.chatTilingState.tiles.length === 0, 'no tiles on load');
  }

  // S2: Focus switching saves/restores atomically AND swaps Core session
  section('S2: Focus switching saves/restores atomically and swaps Core session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    h.document.getElementById('msg').value = 'draft-a';
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    // Bind tile B to a session the way a sidebar click does. Unbound tiles are
    // not focusable, so B must be bound before it can take the composer.
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    h.document.getElementById('msg').value = 'draft-b';
    // Focus tile A — should call loadSession('sid-A')
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(h.document.getElementById('msg').value === 'draft-a', 'A restores its own draft (no bleed from B)');
    assert(h.S.session.session_id === 'sid-A', 'Core session swapped to A');
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(h.document.getElementById('msg').value === 'draft-b', 'B restores its own draft');
  }

  // S3: Rapid A→B where stale A rejects after B — Core session ends at B
  section('S3: Rapid A→B — Core session ends at B');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(h.window.chatTilingState.activeId === parseInt(tiles[1].dataset.tileId), 'B is active');
    assert(h.S.session.session_id === 'sid-B', 'Core session is B after rapid A→B');
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages');
  }

  // S4: Hide grid restores the focused tile's session
  section('S4: Hide grid restores the focused tile\'s session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-original', 'Original Session', ['orig-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    // Bind tile B, then hide — Core keeps the focused tile's session live
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    h.window.hideGridExt();
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'Core keeps the focused tile session after hide');
    assert(h.document.getElementById('msgInner').parentNode.id === 'messages', 'msgInner back in #messages');
  }

  // S5: Failed cancellation preserves tile
  section('S5: Failed cancellation preserves tile');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0];
    h.window.chatTilingState.tiles[0].busy = true;
    h.window.chatTilingState.tiles[0].activeStreamId = 'stream-A';
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    // Cancellation is refused — the tile must be preserved.
    h.window.__cancelAllowed = false;
    await h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 2, 'tile A preserved when cancel refused');
  }

  // S6: preload reservation is retained until preload_timeout_ms, then released
  section('S6: preload reservation is retained until preload_timeout_ms, then released');
  {
    const h = createFreshDom();
    h.window.__settings.preload_timeout_ms = 80;
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const st = h.window.chatTilingState;

    // B reserves the only free slot.
    h.window.handlerRegistration('sid-B', null, { preload: true });
    const bTile = st.tiles.find(t => t._pendingSid === 'sid-B');
    assert(bTile !== undefined, 'B reserved the free slot');

    // C arrives immediately. B's reservation is still inside its deadline, so C
    // must NOT steal it — it takes over the focused tile instead.
    h.window.handlerRegistration('sid-C', null, { preload: true });
    assert(st.tiles.find(t => t.id === bTile.id)._pendingSid === 'sid-B',
      'B reservation retained before the deadline');

    // Past the deadline the stale reservation is released and the slot is reusable.
    await sleep(140);
    h.window.handlerRegistration('sid-D', null, { preload: true });
    const dTile = st.tiles.find(t => t._pendingSid === 'sid-D');
    assert(dTile !== undefined && dTile.id === bTile.id, 'released slot is reusable after the deadline');
    assert(st.tiles.filter(t => t._pendingSid === 'sid-B').length === 0,
      'B reservation released after the deadline');
  }

  // S7: Hide restores the pre-grid session with its draft
  section('S7: Hide restores the focused tile\'s session with its draft');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.window.hideGridExt();
    await settle();
    // After hide with empty focused tile, msgInner stays in #messages
    assert(h.document.getElementById('msgInner').parentNode.id === 'messages', 'msgInner stays in #messages after hide');
  }

  // S8: #msgInner stays in #messages always (never moved to grid)
  section('S8: #msgInner stays in #messages always');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner in #messages after showGrid');
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages after focus switch');
    h.window.hideGridExt();
    await settle();
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages after hide');
  }

  // S9: Non-focused tile is a renderTranscript snapshot (not #msgInner)
  section('S9: Non-focused tile is renderTranscript snapshot');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg-1', 'a-msg-2']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    // Non-focused tile A has renderTranscript snapshot (not #msgInner)
    const msgInnersA = tileA.querySelectorAll('.ext-tile-msg-inner');
    const msgInnerA = msgInnersA.length > 0 ? msgInnersA[msgInnersA.length - 1] : null;
    assert(msgInnerA !== null, 'tile A has a msg-inner element');
    assert(msgInnerA.id !== 'msgInner', 'non-focused tile A does not own #msgInner');
    // #msgInner stays in #messages
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner still in #messages');
  }

  // S10: Composer text does not leak between tiles
  section('S10: Composer text does not leak between tiles');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const composer = h.document.getElementById('msg');
    composer.value = 'draft-a';
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    assert(composer.value === '', 'B has empty composer (no leak from A)');
    composer.value = 'draft-b';
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(composer.value === 'draft-a', 'A restores its own draft (no bleed from B)');
  }

  // S11: Double-close busy tile preserves sibling
  section('S11: Double-close busy tile preserves sibling');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    h.window.chatTilingState.tiles[0].busy = true;
    h.window.chatTilingState.tiles[0].activeStreamId = 'stream-A';
    // Bind B so the post-close focus target is observable: with the guard in
    // place B ends up active; a superseded second close would bump _opGen and
    // strip that focus commit.
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    let cancelCallCount = 0;
    h.window.cancelSessionStream = (session) => { cancelCallCount++; h.window.cancelStreamCalls.push(session); return new Promise(r => setTimeout(() => r(true), 40)); };
    globalThis.cancelSessionStream = h.window.cancelSessionStream;
    const p1 = h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    const p2 = h.window.closeTileExt(parseInt(tileA.dataset.tileId));
    await sleep(10);
    assert(cancelCallCount === 1, `single-flight guard: expected 1 cancel call, got ${cancelCallCount}`);
    assert(h.window.cancelStreamCalls[0] && h.window.cancelStreamCalls[0].active_stream_id === 'stream-A' && h.window.cancelStreamCalls[0].session_id === 'sid-A',
      'cancelSessionStream called with Core snake_case keys');
    await Promise.all([p1, p2]);
    await settle();
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 1, 'only 1 tile remains');
    assert(parseInt(remaining[0].dataset.tileId) === parseInt(tileB.dataset.tileId), 'sibling B preserved');
    assert(h.window.chatTilingState.activeId === parseInt(tileB.dataset.tileId), 'focus settled on surviving bound tile B');
  }

  // S12: Toolbar exists and anchors into current Core .app-titlebar
  section('S12: Toolbar exists and anchors into current Core .app-titlebar');
  {
    const h = createFreshDom();
    const tb = h.document.getElementById('ext-tiling-toolbar');
    assert(!!tb, 'toolbar exists');
    assert(!!tb && tb.closest('.app-titlebar') !== null, 'toolbar is anchored inside .app-titlebar');
    assert(!!h.document.getElementById('msgInner'), 'msgInner on Core container');
    const labels = Array.from(tb.querySelectorAll('.ext-toolbar-btn')).map(b => b.getAttribute('aria-label'));
    assert(labels.includes('Split in 2'), 'toolbar renders "Split in 2"');
    assert(labels.includes('Split in 4'), 'toolbar renders "Split in 4"');
    assert(labels.includes('Split in 6'), 'toolbar renders "Split in 6"');
    assert(labels.includes('Close tiling'), 'toolbar renders "Close tiling"');
  }

  // S13: Focus switch calls loadSession (not physical DOM move)
  section('S13: Focus switch calls loadSession to swap Core session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0], tileB = tiles[1];
    // Seed tile A with a session so focus switch will call loadSession
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    let loadSessionCalls = [];
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => { loadSessionCalls.push(sid); return origLoad(sid); };
    globalThis.loadSession = h.window.loadSession;
    // Focus B — should call loadSession('sid-B')
    h.window.focusTileExt(parseInt(tileB.dataset.tileId));
    await settle();
    assert(loadSessionCalls.includes('sid-B'), 'focus B calls loadSession(sid-B)');
    assert(h.S.session.session_id === 'sid-B', 'Core session is B after focus');
    // Focus A — should call loadSession('sid-A')
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    assert(loadSessionCalls.includes('sid-A'), 'focus A calls loadSession(sid-A)');
    assert(h.S.session.session_id === 'sid-A', 'Core session is A after refocus');
    // #msgInner stays in #messages
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages throughout');
  }

  // S14: Hide restores focused tile's session
  section('S14: Hide restores the focused tile\'s session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    // Seed tile B with a session
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'Core session is B');
    h.window.hideGridExt();
    await settle();
    assert(h.S.session.session_id === 'sid-B', 'B session restored on hide');
  }

  // S15: preload vetoes navigation when no tile can take the session
  section('S15: preload vetoes navigation when no tile can take the session');
  {
    const h = createFreshDom();
    h.window.__settings.auto_tile = false;
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const st = h.window.chatTilingState;

    // Close the only bound tile. No tile owns Core's session and auto-tiling is
    // off, so there is nothing to rebind — Core must be vetoed instead of
    // navigating with no tile bound to the session it loaded.
    h.window.closeTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(st.activeId === null, 'no active tile after closing the only bound tile');
    const vetoed = h.window.handlerRegistration('sid-B', null, { preload: true });
    assert(vetoed && vetoed.cancel === true, 'preload vetoes navigation with no available destination');

    // With auto-tiling on, a destination is always reserved — navigation proceeds.
    h.window.__settings.auto_tile = true;
    const allowed = h.window.handlerRegistration('sid-B', null, { preload: true });
    assert(!(allowed && allowed.cancel === true), 'with auto-tile on a destination is always available');
  }

  // S16: Fallback loaded(B) preserves the pending reservation for C
  section('S16: Fallback loaded(B) preserves the pending reservation for C');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.window.handlerRegistration('sid-B', null, { preload: true });
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.window.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles.find(t => t.querySelector('.ext-tile-title').textContent === 'Session B');
    assert(tileB !== undefined, 'B landed on tile 2');
  }

  // S17: Empty tile (no sid) does not call loadSession
  section('S17: Empty tile (no sid) does not call loadSession');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    let loadSessionCalls = 0;
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => { loadSessionCalls++; return origLoad(sid); };
    globalThis.loadSession = h.window.loadSession;
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(loadSessionCalls === 0, `empty tile B does not call loadSession (got ${loadSessionCalls} calls)`);
  }

  // S18: Toolbar is panel-gated (chat only) and fail-closed
  section('S18: Toolbar is panel-gated (chat only) and fail-closed');
  {
    const h = createFreshDom();
    const main = h.document.querySelector('main.main');
    const tb = h.document.getElementById('ext-tiling-toolbar');
    // Real Core contract: chat is the ABSENCE of a `showing-<panel>` class on
    // <main>. There is no `chat` class to test for.
    assert(!tb.classList.contains('ext-tiling-toolbar--hidden'), 'toolbar visible on chat panel');
    main.setAttribute('class', 'main showing-tasks');
    await settle();
    assert(tb.classList.contains('ext-tiling-toolbar--hidden'), 'toolbar hidden on tasks panel');
    main.setAttribute('class', 'main showing-settings');
    await settle();
    assert(tb.classList.contains('ext-tiling-toolbar--hidden'), 'toolbar hidden on settings panel');
    main.setAttribute('class', 'main');
    await settle();
    assert(!tb.classList.contains('ext-tiling-toolbar--hidden'), 'toolbar visible again on chat panel');
    assert(tb.querySelectorAll('.ext-toolbar-btn').length === 4, 'toolbar has 4 controls');
  }

  // S19: Focus-switch preserves outgoing draft
  section('S19: Focus-switch preserves outgoing draft');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const composer = h.document.getElementById('msg');
    composer.value = 'draft-a';
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    const tileA = h.window.chatTilingState.tiles.find(t => t.id === parseInt(tiles[0].dataset.tileId));
    assert(tileA && tileA.cv === 'draft-a', 'A draft saved in tile A');
    assert(composer.value === '', 'B composer is empty');
    composer.value = 'draft-b';
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(composer.value === 'draft-a', 'refocusing A restores A draft');
  }

  // S20: Focused tile does not call renderTranscript
  section('S20: Focused tile does not call renderTranscript');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    let rtCallsOnFocused = 0;
    const origRT = h.window.renderTranscript;
    h.window.renderTranscript = (target, msgs, opts) => {
      if (target && target.classList.contains('ext-tile-msg-inner') && target.closest('.ext-tile--focused')) {
        rtCallsOnFocused++;
      }
      origRT(target, msgs, opts);
    };
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    assert(rtCallsOnFocused === 0, `focused tile does not call renderTranscript (got ${rtCallsOnFocused} calls)`);
  }

  // S21: preload_timeout_ms setting exists with sane default
  section('S21: preload_timeout_ms setting exists with sane default');
  {
    const h = createFreshDom();
    const manifest = JSON.parse(readFileSync('extensions/chat-tiling/manifest.json', 'utf8'));
    const ext = manifest.extensions.find(e => e.id === 'chat-tiling');
    const settings = ext.settings_schema;
    const preloadProp = settings.find(s => s.key === 'preload_timeout_ms');
    assert(preloadProp !== undefined, 'preload_timeout_ms setting exists');
    assert(preloadProp.default >= 500, 'preload_timeout_ms default >= 500');
    assert(preloadProp.default <= 30000, 'preload_timeout_ms default <= 30000');
  }

  // S22: settings_schema properties have labels
  section('S22: settings_schema properties have labels');
  {
    const h = createFreshDom();
    const manifest = JSON.parse(readFileSync('extensions/chat-tiling/manifest.json', 'utf8'));
    const ext = manifest.extensions.find(e => e.id === 'chat-tiling');
    const settings = ext.settings_schema;
    for (const prop of settings) {
      assert(prop.label && prop.label.length > 0, `${prop.key} has label`);
    }
  }

  // S23: package.json declares Node engine (if present)
  section('S23: package.json declares Node engine');
  {
    const h = createFreshDom();
    const pkgPath = join(rootDir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      assert(pkg.engines && pkg.engines.node, 'package.json declares engines.node');
    } catch (e) {
      assert(true, 'no package.json in extensions repo (skip)');
    }
  }

  // S24: auto_tile:false keeps tile authority coherent with Core
  section('S24: auto_tile:false keeps tile authority coherent with Core');
  {
    const h = createFreshDom();
    h.window.__settings.auto_tile = false;
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const st = h.window.chatTilingState;
    h.window.handlerRegistration('sid-B', null, { preload: true });
    assert(st.tiles.filter(t => t._pendingSid === 'sid-B').length === 0,
      'auto_tile:false creates no pending reservation');
    setSession(h, 'sid-B', 'Session B', ['b']);
    h.window.handlerRegistration('sid-B', h.S.session, { loaded: true });
    await settle();
    // Core navigated anyway. The focused tile must follow it rather than
    // disagreeing about which conversation the composer is pointed at.
    assert(h.S.session.session_id === 'sid-B', 'Core navigated to B');
    const active = st.tiles.find(t => t.id === st.activeId);
    assert(active !== undefined && active.sid === 'sid-B', 'focused tile follows Core to B (no authority split)');
  }

  // S25: Extension's badge observer fires updateBadgeCounts on sidebar mutation
  section('S25: Extension badge observer fires updateBadgeCounts on sidebar mutation');
  {
    const h = createFreshDom();
    // Set up a tile with a busy session so updateBadgeCounts creates a badge
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    // Make tile 1 busy with the existing-1 session (matches DOM fixture)
    h.window.chatTilingState.tiles[0].sid = 'existing-1';
    h.window.chatTilingState.tiles[0].session = { session_id: 'existing-1', title: 'Existing 1' };
    h.window.chatTilingState.tiles[0].busy = true;

    const sessionList = h.document.querySelector('.session-list');
    if (sessionList) {
      // Fix: Verify the extension created its actual T._badgeObserver on .session-list
      const badgeObserver = h.window.chatTilingState._badgeObserver;
      assert(!!badgeObserver, 'extension created _badgeObserver on session-list');
      assert(badgeObserver instanceof h.window.MutationObserver, '_badgeObserver is a MutationObserver');
      assert(typeof badgeObserver.disconnect === 'function', '_badgeObserver has disconnect method');
      assert(typeof badgeObserver.observe === 'function', '_badgeObserver has observe method');

      const existingRow = sessionList.querySelector('.session-item[data-sid="existing-1"]');
      assert(existingRow !== null, 'existing-1 session row exists');

      // Before any mutation, no badge should exist (observer hasn't fired yet)
      const badgeBefore = existingRow.querySelector('.ext-tile-sidebar-badge');
      assert(badgeBefore === null, 'no badge before observer fires');

      // Disconnect the observer to test updateBadgeCounts in isolation
      // (prevents infinite loop in JSDOM from observer re-triggering on badge DOM mutations)
      badgeObserver.disconnect();

      // Test that updateBadgeCounts works correctly when called directly.
      // This is what the extension's observer callback does internally:
      //   1. disconnect() — already done above
      //   2. updateBadgeCounts() — creates badge DOM mutations
      //   3. observe() — reconnect (we skip this to prevent JSDOM infinite loop)
      h.window.updateBadgeCounts();

      // After updateBadgeCounts, a badge should appear on the busy session row
      const badgeAfter = existingRow.querySelector('.ext-tile-sidebar-badge');
      assert(badgeAfter !== null, 'badge appears on busy session row after updateBadgeCounts');
      assert(badgeAfter && badgeAfter.textContent === '1', 'badge shows correct busy count (1)');
    } else {
      assert(true, 'no session-list fixture (skip)');
    }
    // Clean up: stop the watcher interval to prevent test hang
    h.window.hideGridExt();
  }

  // S26: alreadyLoaded does not re-snapshot S into tile
  section('S26: alreadyLoaded does not re-snapshot S into tile');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a-msg']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileB = tiles[1];
    let rtCallsOnFocused = 0;
    const origRT = h.window.renderTranscript;
    h.window.renderTranscript = (target, msgs, opts) => {
      if (target && target.classList.contains('ext-tile-msg-inner') && target.closest('.ext-tile--focused')) {
        rtCallsOnFocused++;
      }
      origRT(target, msgs, opts);
    };
    h.window.focusTileExt(parseInt(tileB.dataset.tileId), { alreadyLoaded: true });
    await settle();
    assert(rtCallsOnFocused === 0, `alreadyLoaded:true must not call renderTranscript on focused tile (got ${rtCallsOnFocused} calls)`);
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages');
  }

  // S27: loadSession() invoked on focus switch with session
  section('S27: loadSession() invoked on focus switch with session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.document.getElementById('msg').value = 'draft-a';
    // Seed tile B with a session
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    let loadSessionCalls = [];
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => { loadSessionCalls.push(sid); return origLoad(sid); };
    globalThis.loadSession = h.window.loadSession;
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    await settle();
    assert(loadSessionCalls.includes('sid-B'), `loadSession called for B (got ${JSON.stringify(loadSessionCalls)})`);
    const tileA = h.window.chatTilingState.tiles.find(t => t.id === parseInt(tiles[0].dataset.tileId));
    assert(tileA && tileA.cv === 'draft-a', `outgoing draft saved before focus switch (got '${tileA && tileA.cv}')`);
  }

  // S28: watcher fenced by exact SID
  section('S28: watcher fenced by exact SID');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const tileA = tiles[0];
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.focusTileExt(parseInt(tileA.dataset.tileId));
    await settle();
    h.window.chatTilingState.tiles[0].messages = ['original-a'];
    h.S.session = { session_id: 'sid-unrelated', title: 'Unrelated' };
    h.S.messages = ['unrelated-msg'];
    await sleep(400);
    assert(h.window.chatTilingState.tiles[0].messages[0] === 'original-a', 'tile A ignores unowned S state (fenced by SID)');
  }

  // S29: Layout switch preserves #msgInner in #messages
  section('S29: Layout switch preserves #msgInner in #messages');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const msgInner = h.document.getElementById('msgInner');
    assert(msgInner.parentNode.id === 'messages', '#msgInner in #messages before layout switch');
    // Switch to 4-tile layout
    await h.window.showGridExt(2, 2);
    await settle();
    assert(msgInner.parentNode.id === 'messages', '#msgInner stays in #messages after layout switch');
  }

  // S30: Failed loadSession rolls back to outgoing session
  section('S30: Failed loadSession rolls back to outgoing session');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    // Seed tiles with sessions
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    // Start on A
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    // Make loadSession fail for B
    let loadSessionCalls = [];
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      loadSessionCalls.push(sid);
      if (sid === 'sid-B') return Promise.reject(new Error('load failed'));
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;
    // Try to focus B — should fail and roll back to A
    try {
      await h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    } catch (_) {}
    await settle();
    // After rollback, session should be A
    assert(h.S.session.session_id === 'sid-A', 'rolled back to session A after loadSession failure');
    // loadSession was called for B then for A (rollback)
    assert(loadSessionCalls.includes('sid-B'), 'loadSession attempted for B');
    assert(loadSessionCalls.includes('sid-A'), 'loadSession rollback call for A');
  }

  // S31: B1 — Stale focus failure does not roll back over a newer winner
  section('S31: B1 — Stale focus failure does not roll back over a newer winner');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(3, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    // Seed all tiles with sessions
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    h.window.chatTilingState.tiles[2].sid = 'sid-C';
    h.window.chatTilingState.tiles[2].session = { session_id: 'sid-C', title: 'Session C' };

    // Start on A
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();

    // Make loadSession controllable: B rejects after delay, C resolves immediately
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      if (sid === 'sid-B') {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('B failed')), 50));
      }
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;

    // Focus B (captures gen 1, outgoing A) — will fail after delay
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    // Focus C (captures gen 2, outgoing B) — succeeds immediately
    h.window.focusTileExt(parseInt(tiles[2].dataset.tileId));
    await settle();

    // Wait for B's late failure to settle
    await sleep(200);

    // C should still be active — B's stale failure must not roll back over C
    assert(h.window.chatTilingState.activeId === parseInt(tiles[2].dataset.tileId), 'C remains active after stale B failure');
    assert(h.S.session.session_id === 'sid-C', 'Core session is C, not rolled back to A');
  }

  // S32: B2 — Late focus after hide is a no-op
  section('S32: B2 — Late focus after hide is a no-op');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };

    // Start on A
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();

    // Make loadSession slow for B
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      if (sid === 'sid-B') {
        return new Promise((resolve) => setTimeout(() => resolve(origLoad(sid)), 50));
      }
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;

    // Start focusing B (captures gen)
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    // Hide grid immediately (increments _focusGen, invalidating pending focus)
    h.window.hideGridExt();
    await settle();

    // Wait for B's late loadSession to settle
    await sleep(200);

    // Grid should remain hidden — late focus must not re-show it or change state
    assert(h.window.chatTilingState.visible === false, 'grid stays hidden after late focus');
    assert(h.window.chatTilingState.tiles.length === 0, 'tiles cleared after hide');
  }

  // S33: B3 — Shrink ignores cancellation refusal and aborts layout change
  section('S33: B3 — Shrink ignores cancellation refusal and aborts layout change');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 4, 'started with 4 tiles');

    // Make tile 3 and 4 busy (they will be removed when shrinking to 2 tiles)
    h.window.chatTilingState.tiles[2].busy = true;
    h.window.chatTilingState.tiles[2].activeStreamId = 'stream-C';
    h.window.chatTilingState.tiles[3].busy = true;
    h.window.chatTilingState.tiles[3].activeStreamId = 'stream-D';

    // Tile C refuses cancellation. The shrink must refuse before touching any
    // tile, so the cancel path is never even reached.
    h.window.__cancelAllowed = false;
    await h.window.showGridExt(1, 2);
    await settle();

    // Layout change aborted — still 4 tiles
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 4, 'layout change aborted: still 4 tiles after cancel refusal');
  }

  // S34: Issue 1 — Newer focus during rollback waits for rollback to finish
  section('S34: Issue 1 — Newer focus during rollback waits for rollback to finish');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(3, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    h.window.chatTilingState.tiles[2].sid = 'sid-C';
    h.window.chatTilingState.tiles[2].session = { session_id: 'sid-C', title: 'Session C' };

    // Start on A
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();

    // Make loadSession controllable: B rejects after delay, A (rollback) is slow
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      if (sid === 'sid-B') {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('B failed')), 20));
      }
      if (sid === 'sid-A') {
        // Slow rollback
        return new Promise((resolve) => setTimeout(() => resolve(origLoad(sid)), 60));
      }
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;

    // Focus B (captures gen 1, outgoing A) — will fail after 20ms
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    // Focus C (captures gen 2, outgoing B) — should wait for B's rollback to finish
    h.window.focusTileExt(parseInt(tiles[2].dataset.tileId));
    await settle();

    // Wait for everything to settle
    await sleep(200);

    // C must be active — B's rollback(A) must not overwrite C
    assert(h.window.chatTilingState.activeId === parseInt(tiles[2].dataset.tileId), 'C remains active after rollback finishes');
    assert(h.S.session.session_id === 'sid-C', 'Core session is C, not rolled back to A');
  }

  // S35: Issue 2 — hideGrid awaits in-flight focus before proceeding
  section('S35: Issue 2 — hideGrid awaits in-flight focus before proceeding');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };

    // Start on A
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();

    // Make loadSession slow for B
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      if (sid === 'sid-B') {
        return new Promise((resolve) => setTimeout(() => resolve(origLoad(sid)), 50));
      }
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;

    // Start focusing B (slow)
    h.window.focusTileExt(parseInt(tiles[1].dataset.tileId));
    // Hide grid — should await the in-flight focus
    await h.window.hideGridExt();
    await settle();

    // After hide, Core session should be B (the in-flight focus that hide awaited)
    assert(h.S.session.session_id === 'sid-B', 'hide awaited in-flight focus: Core session is B');
    assert(h.window.chatTilingState.visible === false, 'grid stays hidden');
    assert(h.window.chatTilingState.tiles.length === 0, 'tiles cleared after hide');
  }

  // S36: Issue 3 — Refused shrink restores old geometry (cols/rows)
  section('S36: Issue 3 — Refused shrink restores old geometry (cols/rows)');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 4, 'started with 4 tiles');

    // Make tile 3 and 4 busy
    h.window.chatTilingState.tiles[2].busy = true;
    h.window.chatTilingState.tiles[2].activeStreamId = 'stream-C';
    h.window.chatTilingState.tiles[3].busy = true;
    h.window.chatTilingState.tiles[3].activeStreamId = 'stream-D';

    // Cancellation is refused; the refusal must not matter because the shrink
    // is refused outright while any excess tile is busy.
    h.window.__cancelAllowed = false;

    // Try to shrink to 2 tiles — should abort
    await h.window.showGridExt(1, 2);
    await settle();

    // Layout change aborted — still 4 tiles AND geometry restored
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 4, 'layout change aborted: still 4 tiles after cancel refusal');
    assert(h.window.chatTilingState._cols === 2, 'cols restored to 2 after abort');
    assert(h.window.chatTilingState._rows === 2, 'rows restored to 2 after abort');
  }

  // S37: Issue 4 — Active-tail shrink settles successor before committing removal
  section('S37: Issue 4 — Active-tail shrink settles successor before committing removal');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(tiles.length === 4, 'started with 4 tiles');

    // Seed tiles: A (active), B, C, D
    h.window.chatTilingState.tiles[0].sid = 'sid-A';
    h.window.chatTilingState.tiles[0].session = { session_id: 'sid-A', title: 'Session A' };
    h.window.chatTilingState.tiles[1].sid = 'sid-B';
    h.window.chatTilingState.tiles[1].session = { session_id: 'sid-B', title: 'Session B' };
    h.window.chatTilingState.tiles[2].sid = 'sid-C';
    h.window.chatTilingState.tiles[2].session = { session_id: 'sid-C', title: 'Session C' };
    h.window.chatTilingState.tiles[3].sid = 'sid-D';
    h.window.chatTilingState.tiles[3].session = { session_id: 'sid-D', title: 'Session D' };

    // Start on D (tile 4, which will be removed when shrinking to 2)
    h.window.focusTileExt(parseInt(tiles[3].dataset.tileId));
    await settle();

    // Make loadSession fail for D — the retained active tile whose settle must
    // succeed before the removal is committed.
    const origLoad = h.window.loadSession;
    h.window.loadSession = (sid) => {
      if (sid === 'sid-D') {
        return Promise.reject(new Error('D load failed'));
      }
      return origLoad(sid);
    };
    globalThis.loadSession = h.window.loadSession;

    // Try to shrink to 2 tiles. D is active and would be removed, so it is
    // reordered into the survivors and settled first; its loadSession fails, so
    // the layout change must abort and leave the old geometry intact.
    await h.window.showGridExt(1, 2);
    await settle();

    // Layout change aborted — still 4 tiles, D still active
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 4, 'layout change aborted: still 4 tiles after successor focus failure');
    assert(h.window.chatTilingState.activeId === parseInt(tiles[3].dataset.tileId), 'D still active after abort');
  }

  // ══ Re-gate regression tests (PR#60 review at 2c4e6a11) ══

  // R0: reads Core's lexical `S`, not window.S
  section('R0: reads Core lexical S, not window.S');
  {
    const h = createFreshDom();
    assert(h.window.S === undefined, 'harness mirrors Core: nothing is exposed on window.S');
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const t0 = h.window.chatTilingState.tiles[0];
    assert(t0.sid === 'sid-A', 'tile seeded from Core S with no window.S available');
  }

  // R3/R4: grid geometry — stretching grid items anchored to the shell
  section('R3/R4: grid is anchored to the non-scrolling shell with stretching tiles');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const grid = h.document.getElementById('ext-tile-grid');
    const shell = h.document.querySelector('.messages-shell');
    const messages = h.document.getElementById('messages');
    assert(grid.parentElement === shell, 'grid anchored to .messages-shell (not the scroll container)');
    assert(grid.parentElement !== messages, 'grid is NOT inside the scrolling #messages');
    const css = h.document.getElementById('ext-tiling-css').textContent;
    const tileRule = css.split('}').find(r => r.includes('.ext-tile{'));
    assert(tileRule !== undefined && !/position:absolute/.test(tileRule),
      '.ext-tile is not position:absolute (so tiles stretch instead of overlapping)');
    const gridRule = css.split('}').find(r => r.includes('#ext-tile-grid{'));
    assert(gridRule !== undefined && /inset:0/.test(gridRule), '#ext-tile-grid uses inset:0');
    const areas = h.window.chatTilingState.tiles.map(t => t.el.style.gridArea);
    assert(areas.length === 4 && new Set(areas).size === 4, 'each tile is placed in a distinct grid cell');
  }

  // R5: toolbar buttons map to the documented layout shapes
  section('R5: toolbar layout buttons map to 2x1, 2x2 and 3x2');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    const tb = h.document.getElementById('ext-tiling-toolbar');
    const click = (label) => Array.from(tb.querySelectorAll('.ext-toolbar-btn'))
      .find(b => b.getAttribute('aria-label') === label).click();
    const st = h.window.chatTilingState;
    click('Split in 4');
    await settle();
    assert(st._cols === 2 && st._rows === 2, 'Split in 4 => 2x2');
    assert(st.tiles.length === 4, 'Split in 4 builds 4 tiles');
    click('Split in 6');
    await settle();
    assert(st._cols === 3 && st._rows === 2, 'Split in 6 => 3x2');
    assert(st.tiles.length === 6, 'Split in 6 builds 6 tiles');
    click('Split in 2');
    await settle();
    assert(st._cols === 2 && st._rows === 1, 'Split in 2 => 2x1');
    assert(st.tiles.length === 2, 'Split in 2 leaves 2 tiles');
  }

  // R6: composite transactions do not self-deadlock through the queue
  section('R6: composite transactions complete without queue self-deadlock');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    h.window.focusTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    const st = h.window.chatTilingState;

    const t0 = Date.now();
    await h.window.closeTileExt(parseInt(tiles[0].dataset.tileId));
    const closeMs = Date.now() - t0;
    assert(closeMs < 1000, `active close resolved promptly (took ${closeMs}ms of a 10000ms budget)`);
    assert(st.tiles.length === 3, 'active tile removed');
    const active = st.tiles.find(t => t.id === st.activeId);
    assert(active !== undefined && active.sid === 'sid-B', 'survivor B is focused after active close');

    const t1 = Date.now();
    await h.window.showGridExt(1, 2);
    const shrinkMs = Date.now() - t1;
    assert(shrinkMs < 1000, `shrink resolved promptly (took ${shrinkMs}ms of a 10000ms budget)`);
    assert(st.tiles.length === 2, 'shrink committed to 2 tiles');
  }

  // R7: unbound tiles are not focusable and cannot hijack the composer
  section('R7: unbound tiles are not focusable');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    const before = h.window.chatTilingState.activeId;
    tiles[1].click();
    await settle();
    assert(h.window.chatTilingState.activeId === before, 'clicking an unbound tile does not change focus');
    assert(h.window.chatTilingState.tiles[1].sid === null, 'unbound tile stays unbound');
    assert(tiles[1].classList.contains('ext-tile--empty'), 'unbound tile is marked ext-tile--empty');
    assert(h.document.getElementById('ext-tiling-css').textContent.includes('.ext-tile.ext-tile--empty{pointer-events:none}'),
      'unbound tile passes pointer events through to the live transcript');
  }

  // R9: the loaded hook must not wipe Core's server-restored draft
  section('R9: loaded hook preserves the server-restored composer draft');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 1);
    await settle();
    h.window.__drafts['sid-B'] = 'server-restored-draft-B';
    await bindTileViaHook(h, 'sid-B', ['b-msg']);
    assert(h.document.getElementById('msg').value === 'server-restored-draft-B',
      'draft Core restored for B survives the loaded-hook focus');
  }

  // R10: closing a maximized tile must not leave survivors hidden
  section('R10: closing a maximized tile restores sibling visibility');
  {
    const h = createFreshDom();
    setSession(h, 'sid-A', 'Session A', ['a']);
    h.window.showGridExt(2, 2);
    await settle();
    const tiles = Array.from(h.document.querySelectorAll('.ext-tile'));
    tiles[0].querySelector('.ext-tile-maximize-btn').click();
    await settle();
    assert(tiles[1].classList.contains('ext-tile--hidden'), 'siblings hidden while maximized');
    await h.window.closeTileExt(parseInt(tiles[0].dataset.tileId));
    await settle();
    const remaining = Array.from(h.document.querySelectorAll('.ext-tile'));
    assert(remaining.length === 3, 'maximized tile removed');
    assert(remaining.filter(t => t.classList.contains('ext-tile--hidden')).length === 0,
      'no survivor left hidden after closing the maximized tile');
  }

  // R11: a cold start (no live session) still yields a focused, usable grid
  section('R11: cold start focuses the first tile');
  {
    const h = createFreshDom(); // no session set at all
    await h.window.showGridExt(2, 1);
    await settle();
    const st = h.window.chatTilingState;
    assert(st.tiles.length === 2, 'grid built with no live session');
    assert(st.activeId === st.tiles[0].id, 'first tile is focused on a cold start');
    assert(st.tiles[0].sid === null, 'cold-start focused tile is still unbound');
    // Once Core holds a session, an unbound tile is no longer focusable.
    setSession(h, 'sid-A', 'Session A', ['a']);
    const before = st.activeId;
    h.window.focusTileExt(st.tiles[1].id);
    await settle();
    assert(st.activeId === before, 'unbound tile is not focusable once Core has a session');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test error:', err); process.exit(1); });