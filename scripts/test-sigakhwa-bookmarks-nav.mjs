'use strict';
// node --test — HermesVizNav v1 against a fake core (S, loadSession, renderMessages, api, document).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, tick, plain } from './sigakhwa-bookmarks-test-helpers.mjs';
const deepEqual = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

function classList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle(c, on) { if (on) set.add(c); else set.delete(c); }, _set: set };
}

function makeRow(sessionIdx, role, rawIdx) {
  const row = {
    sessionIdx, role, rawIdx,
    id: role === 'user' ? 'msg-user-' + rawIdx : undefined,
    dataset: { sessionMsgIdx: String(sessionIdx), msgIdx: String(rawIdx), role },
    classList: classList(),
    scrolls: [],
    offsetWidth: 10,
    getBoundingClientRect() { return { top: 100, bottom: 140, left: 0, right: 500, width: 500, height: 40 }; },
    scrollIntoView(opts) { this.scrolls.push(opts || true); },
    closest(sel) { return sel === '[data-msg-idx]' ? this : null; },
  };
  return row;
}

// Fake core: S + the handful of globals the nav module reads lazily.
function makeWorld(opts) {
  const o = opts || {};
  const S = { session: o.session === undefined ? { session_id: 'sess-1', message_count: 10 } : o.session, messages: o.messages || [], busy: !!o.busy, activeStreamId: o.activeStreamId || null, activeProfile: o.activeProfile || 'default', activeProfileIsDefault: o.activeProfileIsDefault !== false };
  const rows = []; // rows in the DOM
  const inner = {
    querySelectorAll(sel) {
      const m = /^\[data-session-msg-idx="(\d+)"\]$/.exec(sel);
      return m ? rows.filter((r) => r.sessionIdx === Number(m[1])) : [];
    },
    querySelector(sel) {
      const m = /^\[data-session-msg-idx="(\d+)"\]$/.exec(sel);
      if (!m) return null;
      return rows.find((r) => r.sessionIdx === Number(m[1])) || null;
    },
  };
  const document = {
    getElementById(id) {
      if (id === 'msgInner') return inner;
      if (id === 'messages') return container;
      return rows.find((r) => r.id === id) || null;
    },
    querySelector: inner.querySelector,
  };
  const container = { scrollTop: 0, scrollHeight: 20000, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 50, bottom: 850, width: 500, height: 800 }) };
  const calls = { loadSession: [], render: [], api: [], switchProfile: [], ensureAll: 0, windowSize: null };
  const win = {
    S, document, innerHeight: 900,
    loadSession: o.loadSession || (async (sid, lopts) => { calls.loadSession.push([sid, lopts]); if (!o.loadSessionFails) { S.session = { session_id: sid, message_count: 10 }; S.messages = o.messagesAfterLoad || [{ role: 'user' }]; } }),
    renderMessages: (ropts) => { calls.render.push(ropts); if (o.onRender) o.onRender(rows); },
    _messageRawIdxForSessionIndex: (idx) => idx - (win._oldestIdx || 0),
    _currentMessageRenderWindowSize: () => 30,
    _messageRenderableMessageCount: () => (S.messages || []).length,
    _messageRenderWindowSize: 30,
    _messagesTruncated: !!o.truncated,
    _oldestIdx: o.oldestIdx || 0,
  };
  if (o.switchProfile !== false) {
    win._switchProfileForSessionLoad = async (p) => { calls.switchProfile.push(p); if (!o.switchFails) S.activeProfile = p; };
  }
  if (o.ensureAll !== false) {
    win._ensureAllMessagesLoaded = async () => { calls.ensureAll++; win._messagesTruncated = false; if (o.onEnsureAll) o.onEnsureAll(rows); };
  }
  if (o.api) win.api = (path, aopts) => { calls.api.push([path, aopts]); return o.api(path); };
  const ctx = loadScripts(['nav'], win);
  return { S, rows, calls, win, ctx, nav: ctx.window.HermesVizNav, makeRow };
}

test('module shape + currentTarget', () => {
  const w = makeWorld({ activeProfile: 'work' });
  assert.equal(w.nav.version, 1);
  deepEqual(w.nav.currentTarget(), { sessionId: 'sess-1', profile: 'work' });
  w.S.session = null;
  assert.equal(w.nav.currentTarget(), null);
  assert.ok(Object.isFrozen(w.nav));
});

test('no_core when core S / loadSession are missing; never throws at load', async () => {
  const ctx = loadScripts(['nav'], { document: {} });
  assert.equal(ctx.window.HermesVizNav.version, 1);
  const r = await ctx.window.HermesVizNav.goTo({ sessionId: 's', messageIndex: 1, role: 'user' });
  deepEqual(r, { ok: false, reason: 'no_core' });
});

test('argument validation reasons', async () => {
  const w = makeWorld();
  deepEqual(await w.nav.goTo(null), { ok: false, reason: 'session_not_found' });
  deepEqual(await w.nav.goTo({ sessionId: '', messageIndex: 1, role: 'user' }), { ok: false, reason: 'session_not_found' });
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: -1, role: 'user' }), { ok: false, reason: 'row_not_found' });
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 1.5, role: 'user' }), { ok: false, reason: 'row_not_found' });
});

test('same session, row in DOM → scroll + flash, no reload', async () => {
  const w = makeWorld({ messages: [{ role: 'user' }, { role: 'assistant' }] });
  const row = makeRow(1, 'assistant', 1);
  w.rows.push(row);
  const r = await w.nav.goTo({ profile: 'default', sessionId: 'sess-1', messageIndex: 1, role: 'assistant' });
  deepEqual(r, { ok: true });
  assert.equal(row.scrolls.length, 1);
  deepEqual(row.scrolls[0], { block: 'start', behavior: 'smooth' });
  assert.ok(row.classList.contains('hermes-viz-jump-flash'));
  assert.ok(row.classList.contains('outline-jump-flash'));
  assert.equal(w.calls.loadSession.length, 0);
  assert.equal(w.calls.render.length, 0);
  await tick(1300);
  assert.ok(!row.classList.contains('hermes-viz-jump-flash'), 'flash class removed');
});

test('user row fallback by msg-user-<rawIdx> honours _oldestIdx offset', async () => {
  const w = makeWorld({ oldestIdx: 5, messages: new Array(10).fill({ role: 'user' }) });
  const row = makeRow(7, 'user', 2); // sessionIdx 7 = oldest 5 + raw 2
  row.dataset = {}; // simulate a row that only has the id, not data-session-msg-idx
  row.sessionIdx = -1;
  w.rows.push(row);
  const r = await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 7, role: 'user' });
  deepEqual(r, { ok: true });
  assert.equal(row.scrolls.length, 1);
});

test('row outside the virtual window → expand render window + renderMessages, then scroll', async () => {
  const w = makeWorld({
    messages: new Array(80).fill({ role: 'assistant' }),
    onRender(rows) { rows.push(makeRow(3, 'assistant', 3)); },
  });
  const r = await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 3, role: 'assistant' });
  deepEqual(r, { ok: true });
  assert.equal(w.calls.render.length, 1);
  deepEqual(w.calls.render[0], { preserveScroll: true });
  assert.equal(w.ctx._messageRenderWindowSize, 80, 'window expanded to cover every renderable row');
  assert.equal(w.calls.ensureAll, 0, 'not truncated → no full fetch');
});

test('truncated transcript → core _ensureAllMessagesLoaded() is preferred', async () => {
  const w = makeWorld({ truncated: true, messages: [{ role: 'user' }], onEnsureAll(rows) { rows.push(makeRow(0, 'user', 0)); } });
  const r = await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' });
  deepEqual(r, { ok: true });
  assert.equal(w.calls.ensureAll, 1);
  assert.equal(w.calls.render.length, 1);
});

test('missing transcript helper fails without changing Core messages', async () => {
  const w = makeWorld({ truncated: true, ensureAll: false, messages: [{ role: 'user' }] });
  const before = w.S.messages;
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 2, role: 'assistant' }), { ok: false, reason: 'row_not_found' });
  assert.equal(w.S.messages, before);
  assert.equal(w.calls.api.length, 0);
});

test('row still missing after full reload → row_not_found', async () => {
  const w = makeWorld({ messages: [{ role: 'user' }] });
  const r = await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 99, role: 'assistant' });
  deepEqual(r, { ok: false, reason: 'row_not_found' });
});

test('other session → loadSession(sid, {skipLineageResolve:true}) then scroll', async () => {
  const w = makeWorld({ onRender(rows) { rows.push(makeRow(4, 'assistant', 4)); }, messagesAfterLoad: new Array(6).fill({ role: 'assistant' }) });
  const r = await w.nav.goTo({ profile: 'default', sessionId: 'sess-2', messageIndex: 4, role: 'assistant' });
  deepEqual(r, { ok: true });
  assert.equal(w.calls.loadSession.length, 1);
  assert.equal(w.calls.loadSession[0][0], 'sess-2');
  assert.equal(w.calls.loadSession[0][1].skipLineageResolve, true);
  assert.equal(w.calls.loadSession[0][1].skipContinuationResolve, true);
  assert.equal(w.S.session.session_id, 'sess-2');
});

test('loadSession that does not land on the target → session_not_found (also when it throws)', async () => {
  const w = makeWorld({ loadSessionFails: true });
  deepEqual(await w.nav.goTo({ sessionId: 'sess-2', messageIndex: 0, role: 'user' }), { ok: false, reason: 'session_not_found' });
  const w2 = makeWorld({ loadSession: async () => { throw new Error('404'); } });
  deepEqual(await w2.nav.goTo({ sessionId: 'sess-2', messageIndex: 0, role: 'user' }), { ok: false, reason: 'session_not_found' });
});

test('busy while a switch is needed → busy_switch_blocked and nothing is loaded', async () => {
  const w = makeWorld({ busy: true });
  deepEqual(await w.nav.goTo({ sessionId: 'sess-2', messageIndex: 0, role: 'user' }), { ok: false, reason: 'busy_switch_blocked' });
  assert.equal(w.calls.loadSession.length, 0);
  const w2 = makeWorld({ activeStreamId: 'stream-1', activeProfile: 'default' });
  deepEqual(await w2.nav.goTo({ profile: 'work', sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: false, reason: 'busy_switch_blocked' });
  assert.equal(w2.calls.switchProfile.length, 0);
  // busy but same session and the row is present → still fine
  const w3 = makeWorld({ busy: true });
  w3.rows.push(makeRow(0, 'user', 0));
  deepEqual(await w3.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: true });
  // busy, same session, row missing → do not reload the transcript mid-stream
  const w4 = makeWorld({ busy: true, messages: new Array(50).fill({ role: 'user' }) });
  deepEqual(await w4.nav.goTo({ sessionId: 'sess-1', messageIndex: 1, role: 'user' }), { ok: false, reason: 'busy_switch_blocked' });
  assert.equal(w4.calls.render.length, 0);
});

test('cross-profile: core _switchProfileForSessionLoad is used, then loadSession', async () => {
  const w = makeWorld({ activeProfile: 'default', onRender(rows) { rows.push(makeRow(0, 'user', 0)); } });
  const r = await w.nav.goTo({ profile: 'work', sessionId: 'sess-9', messageIndex: 0, role: 'user' });
  deepEqual(r, { ok: true });
  deepEqual(w.calls.switchProfile, ['work']);
  assert.equal(w.calls.loadSession[0][0], 'sess-9');
  assert.equal(w.S.activeProfile, 'work');
});

test('cross-profile without the core helper → profile_switch_required, loadSession not called', async () => {
  const w = makeWorld({ activeProfile: 'default', switchProfile: false });
  const r = await w.nav.goTo({ profile: 'work', sessionId: 'sess-9', messageIndex: 0, role: 'user' });
  deepEqual(r, { ok: false, reason: 'profile_switch_required' });
  assert.equal(w.calls.loadSession.length, 0);
  const w2 = makeWorld({ activeProfile: 'default', switchFails: true });
  deepEqual(await w2.nav.goTo({ profile: 'work', sessionId: 'sess-9', messageIndex: 0, role: 'user' }), { ok: false, reason: 'profile_switch_required' });
});

test('profile alias: "default" matches the active default-named profile (no switch)', async () => {
  const w = makeWorld({ activeProfile: 'john', activeProfileIsDefault: true });
  w.win._profileMatchesActiveProfile = (p, a) => p === a || (p === 'default' && w.S.activeProfileIsDefault);
  const ctx = loadScripts(['nav'], w.win);
  w.rows.push(makeRow(0, 'user', 0));
  const r = await ctx.window.HermesVizNav.goTo({ profile: 'default', sessionId: 'sess-1', messageIndex: 0, role: 'user' });
  deepEqual(r, { ok: true });
  assert.equal(w.calls.switchProfile.length, 0);
});


test('jump clears lexical Core bottom-follow state before scrolling', async () => {
  const w = makeWorld();
  // Top-level lexical bindings mirror classic Core scripts (not window properties).
  const vm = await import('node:vm');
  vm.runInContext('let _scrollPinned = true; let _messageUserUnpinned = false; let _nearBottomCount = 2;', w.ctx);
  let canceled = false;
  w.win._cancelBottomSettle = () => { canceled = true; };
  const row = makeRow(0, 'user', 0);
  row.scrollIntoView = opts => {
    assert.equal(canceled, true, 'queued bottom-settle work canceled before scrolling');
    assert.equal(vm.runInContext('_scrollPinned', w.ctx), false);
    assert.equal(vm.runInContext('_messageUserUnpinned', w.ctx), true);
    assert.equal(vm.runInContext('_nearBottomCount', w.ctx), 0);
    assert.equal(opts.block, 'start');
  };
  w.rows.push(row);
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: true });
});

test('nav rejects prototype names without scrolling and uses the newest build', async () => {
  const w = makeWorld();
  const row = makeRow(0, 'user', 0);
  w.rows.push(row);
  for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role }), { ok: false, reason: 'row_not_found' });
  }
  assert.equal(row.scrolls.length, 0);
  const build = w.nav.build;
  assert.ok(Number.isSafeInteger(build));
  w.win.HermesVizNav = { version: 1, build: build - 1 };
  loadScripts(['nav'], w.win);
  assert.equal(w.win.HermesVizNav.build, build);
  const newer = { version: 1, build: build + 1 };
  w.win.HermesVizNav = newer;
  loadScripts(['nav'], w.win);
  assert.equal(w.win.HermesVizNav, newer);
});

test('review 1: waits for deferred Core loading and cancels bottom settle before taking jump ownership', async () => {
  const w = makeWorld();
  const row = makeRow(3, 'assistant', 3);
  w.rows.push(row);
  let loaded = false, cancel = false, owner = false;
  w.win.loadSession = () => {
    w.S.session = { session_id: 'sess-2' };
    w.S.messages = [{ role: 'assistant' }];
    w.ctx._loadingSessionId = 'sess-2';
    setTimeout(() => { loaded = true; w.ctx._loadingSessionId = null; }, 300);
  };
  // Replace the lexical function too, as real Core functions live in that realm.
  w.ctx.loadSession = w.win.loadSession;
  w.win._cancelBottomSettle = () => { assert.equal(loaded, true); cancel = true; };
  w.win._beginMessageJumpScroll = container => { assert.equal(cancel, true); assert.equal(container, w.win.document.getElementById('messages')); owner = true; };
  row.scrollIntoView = () => { assert.equal(owner, true); };
  deepEqual(await w.nav.goTo({ sessionId: 'sess-2', messageIndex: 3, role: 'assistant' }), { ok: true });
});

test('review 1: jump owner survives streaming follow calls without direct flag writes', async () => {
  const w = makeWorld({ busy: true });
  const row = makeRow(0, 'user', 0);
  w.rows.push(row);
  const vm = await import('node:vm');
  vm.runInContext('let _scrollPinned = true; let _messageUserUnpinned = false; let _nearBottomCount = 2;', w.ctx);
  let owner = false, follows = 0;
  w.win._beginMessageJumpScroll = () => { owner = true; };
  row.scrollIntoView = () => {
    for (let i = 0; i < 2; i++) { if (!owner) follows++; }
    assert.equal(vm.runInContext('_nearBottomCount', w.ctx), 2, 'Core helper owns the pin state');
  };
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: true });
  assert.equal(follows, 0);
});

test('review 1: failed landing retries once and reports not_in_view', async () => {
  const w = makeWorld();
  const row = makeRow(0, 'user', 0);
  row.getBoundingClientRect = () => ({ top: -3000, bottom: -2960, height: 40, width: 500 });
  w.rows.push(row);
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: false, reason: 'not_in_view' });
  assert.equal(row.scrolls.length, 2);
  assert.equal(row.scrolls[1].behavior, 'auto');
});

test('review 1: retry can land and disappearing row returns row_not_found', async () => {
  const w = makeWorld();
  const row = makeRow(0, 'user', 0);
  let calls = 0;
  row.scrollIntoView = () => { calls++; };
  row.getBoundingClientRect = () => ({ top: calls > 1 ? 100 : -3000, bottom: calls > 1 ? 140 : -2960, height: 40, width: 500 });
  w.rows.push(row);
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: true });
  assert.equal(calls, 2);
  row.scrollIntoView = () => { w.rows.length = 0; };
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: false, reason: 'row_not_found' });
});

test('review 5: skip hidden worklogs and zero-height matches; hidden-only targets fail', async () => {
  const w = makeWorld();
  const hidden = makeRow(0, 'assistant', 0);
  hidden.closest = () => hidden;
  const zero = makeRow(0, 'assistant', 0);
  zero.getBoundingClientRect = () => ({ width: 500, height: 0 });
  const visible = makeRow(0, 'assistant', 0);
  w.rows.push(hidden, zero, visible);
  assert.equal(w.nav._findRow(0, 'assistant'), visible);
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'assistant' }), { ok: true });
  assert.equal(hidden.scrolls.length, 0);
  w.rows.pop();
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'assistant' }), { ok: false, reason: 'row_not_found' });
});

test('review 6: virtual scroll mounts message 0 of 200 outside retained window', async () => {
  const w = makeWorld({ messages: new Array(200).fill({ role: 'assistant' }) });
  const container = w.win.document.getElementById('messages');
  container.scrollTop = 19000;
  w.win._getVisibleMessagesWithIdx = () => w.S.messages;
  w.win._messageVisibleIndexForRawIdx = idx => idx;
  w.win._messageVirtualScrollTopForVisibleIdx = (_rows, idx) => idx * 100;
  w.ctx.renderMessages = opts => {
    w.calls.render.push(opts);
    if (container.scrollTop === 0) w.rows.push(makeRow(0, 'assistant', 0));
  };
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'assistant' }), { ok: true });
  assert.equal(container.scrollTop, 0);
  assert.equal(w.calls.render.length, 2);
});

test('review 11: reduced motion uses instant scrolling and skips both flash classes', async () => {
  const w = makeWorld();
  w.win.matchMedia = () => ({ matches: true });
  const row = makeRow(0, 'user', 0);
  w.rows.push(row);
  deepEqual(await w.nav.goTo({ sessionId: 'sess-1', messageIndex: 0, role: 'user' }), { ok: true });
  assert.equal(row.scrolls[0].behavior, 'auto');
  assert.equal(row.classList.contains('hermes-viz-jump-flash'), false);
  assert.equal(row.classList.contains('outline-jump-flash'), false);
});

for (const change of ['session', 'profile', 'generation']) {
  for (const phase of ['settle', 'mount-settle', 'landing', 'loading']) {
    test(`round 3: ${change} change during ${phase} leaves the new conversation untouched`, async () => {
      const w = makeWorld({ truncated: phase === 'settle' });
      const container = w.win.document.getElementById('messages');
      w.win._loadSessionGeneration = 0;
      if (phase === 'landing') w.rows.push(makeRow(0, 'assistant', 0));
      w.win._getVisibleMessagesWithIdx = () => [{ role: 'assistant' }];
      w.win._messageVisibleIndexForRawIdx = () => 0;
      w.win._messageVirtualScrollTopForVisibleIdx = () => 0;
      const changeState = () => {
        if (change === 'session') w.S.session = { session_id: 'new-session' };
        if (change === 'profile') w.S.activeProfile = 'new-profile';
        if (change === 'generation') w.win._loadSessionGeneration++;
        w.calls.render.length = 0;
        container.scrollTop = 777;
        w.win._beginMessageJumpScroll = () => { assert.fail('stale jump took scroll ownership'); };
      };
      if (phase === 'loading') {
        w.ctx.loadSession = async sid => {
          w.S.session = { session_id: sid }; w.S.messages = [{ role: 'assistant' }];
          w.ctx._loadingSessionId = sid;
          setTimeout(changeState, 40);
          setTimeout(() => { w.ctx._loadingSessionId = null; }, 90);
        };
      } else if (phase === 'mount-settle') {
        let renders = 0;
        w.ctx.renderMessages = () => { w.calls.render.push({}); if (++renders === 2) setTimeout(changeState, 30); };
      } else setTimeout(changeState, 40);
      const result = await w.nav.goTo({ profile: 'default', sessionId: phase === 'loading' ? 'target' : 'sess-1', messageIndex: 0, role: 'assistant' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'session_changed');
      assert.equal(w.calls.render.length, 0);
      assert.equal(container.scrollTop, 777);
    });
  }
}
