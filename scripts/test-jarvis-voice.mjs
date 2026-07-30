#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const input = { value: '', dispatchEvent() {} };
const longTimers = [];
const sandbox = {
  console,
  setTimeout(fn, ms) {
    // Only the multi-second connect/setup deadline is held for manual firing;
    // sub-5s timers (the completion-poll backoff) run automatically so the poll
    // loop can advance under test.
    const timer = { fn, cleared: false };
    if (ms >= 5000) longTimers.push(timer);
    else queueMicrotask(() => { if (!timer.cleared) fn(); });
    return timer;
  },
  clearTimeout(timer) { if (timer) timer.cleared = true; },
  Event: class Event { constructor(type) { this.type = type; } },
  Blob: class Blob {},
  btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
};

// ---- minimal rendered DOM ------------------------------------------------
// Enough of a document for render() to build the real panel and for events to
// BUBBLE. Bubbling is the point: the toggle and the card are siblings, so a
// listener scoped to the card never sees a keydown that starts on the toggle.
// A stub that dispatched straight to the target would hide that entirely.
const domNodes = {};

function makeEl(tag = 'div') {
  const handlers = {};
  const children = [];
  const attrs = {};
  const el = {
    tagName: tag,
    id: '',
    hidden: false,
    dataset: {},
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    focused: false,
    parent: null,
    _handlers: handlers,
    _query: {},
    get childElementCount() { return children.length; },
    get firstElementChild() { return children[0] || null; },
    get lastElementChild() { return children[children.length - 1] || null; },
    appendChild(child) { child.parent = el; children.push(child); return child; },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    setAttribute(key, value) { attrs[key] = String(value); },
    getAttribute(key) { return key in attrs ? attrs[key] : null; },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    focus() { el.focused = true; },
    querySelector(selector) { return el._query[selector] || null; },
  };
  return el;
}

function dispatchEvent(target, type, payload = {}) {
  const event = { type, target, ...payload };
  let node = target;
  while (node) {
    for (const fn of (node._handlers[type] || []).slice()) fn(event);
    node = node.parent;
  }
}

let panelBuilt = false;
sandbox.document = {
  readyState: 'complete',
  addEventListener() {},
  getElementById(id) { return id === 'msg' ? input : null; },
  // Only `.msg-edit-area` is queried on the document, and no edit is ever active.
  querySelector() { return null; },
  body: { appendChild(node) { domNodes.attached = node; return node; } },
  createElement(tag) {
    if (panelBuilt) return makeEl(tag);
    panelBuilt = true;
    const panel = makeEl('div');
    const button = makeEl('button');
    const card = makeEl('div');
    const status = makeEl('span');
    const logEl = makeEl('div');
    const talk = makeEl('button');
    const stop = makeEl('button');
    const disconnectButton = makeEl('button');
    // Mirrors the real template: button and card are SIBLINGS under the panel;
    // status, log and the action buttons live inside the card.
    button.parent = panel;
    card.parent = panel;
    for (const child of [status, logEl, talk, stop, disconnectButton]) child.parent = card;
    card.hidden = true;
    panel._query = {
      '#jarvisVoiceButton': button,
      '#jarvisVoiceCard': card,
      '#jarvisVoiceStatus': status,
      '#jarvisVoiceLog': logEl,
      '[data-jarvis="talk"]': talk,
      '[data-jarvis="stop"]': stop,
      '[data-jarvis="disconnect"]': disconnectButton,
    };
    Object.assign(domNodes, { panel, button, card, status, log: logEl, talk, stop, disconnect: disconnectButton });
    return panel;
  },
};
sandbox.window = sandbox;

// Model core's REAL global shape, confirmed against a running WebUI:
//   typeof window.S -> "undefined",  typeof S -> "object"
//   typeof window.api -> "function", typeof api -> "function"
// `static/ui.js:8` declares `const S = {...}` at the top level of a classic
// script, which creates a global *lexical* binding: reachable as a bare `S`,
// absent from `window`. An extension that reaches for `window.S` gets undefined
// in the shipped app, so this harness must not hand it one — a sandbox where
// `window === globalThis` and `S` is a plain property tests a world that does not
// exist and hides exactly this bug class.
// `api` is deliberately modelled the stricter way (lexical only). The extension
// resolves it as a bare identifier, which is correct either way, and holding the
// harness to the tighter contract keeps a future `window.api` from creeping in.
const coreS = {
  session: { session_id: 's1' },
  messages: [],
  entries: [],
  busy: false,
  pendingFiles: [],
  toolCalls: [],
  activeStreamId: null,
};
// Cap the tool timeout under test. The shipped default is 180s and this harness
// fires poll timers immediately, so a correlation bug would otherwise spin for
// three minutes before the assertion failed.
sandbox.HermesExtensionSettings = {
  settingsForExtension: () => ({
    supported: true,
    get: (key) => (key === 'hermesTimeoutSeconds' ? 15 : undefined),
  }),
};
sandbox.__coreS = coreS;
sandbox.__apiImpl = async () => { throw new Error('api not stubbed'); };
const ctx = vm.createContext(sandbox);
vm.runInContext(
  'const S = __coreS;'
  + 'const api = (...args) => __apiImpl(...args);'
  + 'delete globalThis.__coreS;',
  ctx,
  { filename: 'core-ui.js' }
);
assert.equal(vm.runInContext('typeof S', ctx), 'object', 'core S must resolve as a bare global-lexical binding');
assert.equal(vm.runInContext('typeof window.S', ctx), 'undefined', 'core S must NOT be reachable through window');
assert.equal(vm.runInContext('typeof api', ctx), 'function', 'core api must resolve as a bare global-lexical binding');
assert.equal(vm.runInContext('typeof window.api', ctx), 'undefined', 'core api must NOT be reachable through window');

// Core loads permissions and settings for an INSTALLED extension out of
// <id>/manifest.json (api/extensions.py), never extension.json. Drift between the
// two means model/voice/timeout silently stay at their defaults in the shipped
// app, and the permission disclosure the user approves is the wrong one.
const extensionJson = JSON.parse(readFileSync(new URL('../extensions/jarvis-voice/extension.json', import.meta.url), 'utf8'));
const runtimeManifest = JSON.parse(readFileSync(new URL('../extensions/jarvis-voice/manifest.json', import.meta.url), 'utf8'));
const runtimeEntry = runtimeManifest.extensions.find((entry) => entry.id === 'jarvis-voice');
assert.ok(runtimeEntry, 'runtime manifest must carry a jarvis-voice entry');
assert.deepEqual(runtimeEntry.settings_schema, extensionJson.settings_schema, 'runtime manifest settings_schema must mirror extension.json');
assert.deepEqual(runtimeEntry.permissions, extensionJson.permissions, 'runtime manifest permissions must mirror extension.json');
assert.equal(runtimeEntry.permissions.storage.owned, true, 'runtime manifest must declare storage ownership');
// send() posts /api/chat/start, and its queued path posts /api/session/draft.
assert.deepEqual(extensionJson.permissions.webui_api.write, ['chat/start', 'session/draft']);

const js = readFileSync(new URL('../extensions/jarvis-voice/assets/jarvis-voice.js', import.meta.url), 'utf8');
assert.match(js, /fetch\('\/api\/extensions\/jarvis-voice\/sidecar\/api\/token'/);
assert.equal(js.includes('sidecarUrl'), false);
assert.match(js, /Enable WebUI authentication under Settings → Password/);
// Core state is never a window property; reaching for one is the shipped bug.
assert.equal(/window\.S\b/.test(js), false, 'extension must not read core state via window.S');

// Markup and theming are static, so they are asserted against the source. These
// are deletion guards, not behavioural coverage: the panel's rendered DOM is not
// exercised here (the harness has no innerHTML-capable document).
assert.match(js, /aria-expanded="false"/);
assert.match(js, /aria-controls="jarvisVoiceCard"/);
assert.match(js, /role="region"/);
assert.match(js, /aria-expanded', String\(open\)/);
assert.match(js, /key !== 'Escape'/);
assert.match(js, /LOG_MAX_LINES/);
const css = readFileSync(new URL('../extensions/jarvis-voice/assets/jarvis-voice.css', import.meta.url), 'utf8');
assert.equal(css.includes('2147483000'), false, 'must not sit above core dialogs and approvals');
assert.match(css, /z-index:\s*1000\b/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /env\(safe-area-inset-bottom/);
assert.match(css, /background:\s*var\(--surface/);
assert.match(css, /color:\s*var\(--text/);
// Talk/Stop/Disconnect must clear the 44px touch floor on a finger-driven pointer.
assert.match(css, /@media \(pointer: coarse\)[^{]*\{\s*\.jarvis-actions button \{ min-height: 44px; \}/);
vm.runInContext(js, ctx, { filename: 'jarvis-voice.js' });
const jarvis = sandbox.HermesJarvisVoice;
assert.equal(typeof jarvis.runHermes, 'function');

let sendCalls = 0;
let sentText = '';
sandbox.send = async () => { sendCalls += 1; sentText = input.value; input.value = ''; };
sandbox.__apiImpl = async () => ({ session: { message_count: 0, messages: [] } });

coreS.session.pending_user_message = true;
assert.match(await jarvis.runHermes('busy'), /already running/);
assert.equal(sendCalls, 0);
coreS.session.pending_user_message = false;

input.value = 'draft';
assert.match(await jarvis.runHermes('draft'), /unsent composer draft/);
assert.equal(sendCalls, 0);
input.value = '';

coreS.pendingFiles = [{ name: 'x.txt' }];
assert.match(await jarvis.runHermes('file'), /pending attachments/);
assert.equal(sendCalls, 0);
coreS.pendingFiles = [];

coreS.session.is_read_only = true;
assert.match(await jarvis.runHermes('read only'), /Read-only/);
assert.equal(sendCalls, 0);
coreS.session.is_read_only = false;

sandbox.__apiImpl = async () => ({ session: { message_count: 1, active_stream_id: 'server-stream', messages: [] } });
assert.match(await jarvis.runHermes('server busy'), /already running/);
assert.equal(sendCalls, 0);
sandbox.__apiImpl = async () => ({ session: { message_count: 0, messages: [] } });

const realSend = sandbox.send;
sandbox.send = async () => {};
await assert.rejects(jarvis.runHermes('send noop'), /did not accept/);
assert.equal(input.value, '');
sandbox.send = async () => { throw new Error('send fail'); };
await assert.rejects(jarvis.runHermes('send reject'), /send fail/);
assert.equal(input.value, '');
sandbox.send = async () => { input.value += ' '; throw new Error('send modified'); };
await assert.rejects(jarvis.runHermes('send modified'), /send modified/);
// send() mutated the composer, so clearOwnPrompt must leave it alone — and what
// is left is the bare task plus that mutation, with nothing appended by us.
assert.equal(input.value, 'send modified ');
input.value = '';
sandbox.send = realSend;
input.value = '';

const realDispatch = input.dispatchEvent;
let lateBusySendCalls = 0;
input.dispatchEvent = () => { coreS.busy = true; };
sandbox.send = async () => { lateBusySendCalls += 1; };
sandbox.__apiImpl = async () => ({ session: { message_count: 0, messages: [] } });
assert.match(await jarvis.runHermes('late busy'), /already running/);
assert.equal(lateBusySendCalls, 0);
assert.equal(input.value, '');
coreS.busy = false;
input.dispatchEvent = realDispatch;
sandbox.send = realSend;

let release;
const slow = new Promise((resolve) => { release = resolve; });
sandbox.__apiImpl = async () => {
  if (sendCalls === 0) return { session: { message_count: 0, messages: [] } };
  await slow;
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'done' }] } };
};
const first = jarvis.runHermes('one');
const second = jarvis.runHermes('two');
assert.match(await second, /already handling/);
release();
assert.equal(await first, 'done');
assert.equal(sentText, 'one', 'core received the task verbatim');
assert.equal(sendCalls, 1);

sandbox.__apiImpl = async () => {
  coreS.session.session_id = 's2';
  return { session: { message_count: 2, messages: [] } };
};
assert.match(await jarvis.runHermes('switched'), /conversation changed/);
assert.equal(sendCalls, 1);
coreS.session.session_id = 's1';

delete coreS.session.message_count;
coreS.messages = [{ role: 'user', content: 'old user' }, { role: 'assistant', content: 'old assistant' }];
let reads = 0;
sandbox.__apiImpl = async () => {
  reads += 1;
  if (reads === 1) return { session: { message_count: 1000, messages: [{ role: 'assistant', content: 'old assistant' }] } };
  if (reads === 2) return { session: { message_count: 1001, messages: [{ role: 'assistant', content: 'old assistant' }] } };
  // _messages_offset is how core reports where a window sits in the display
  // coordinate space; correlation anchors on it now that nothing is appended
  // to the prompt.
  return {
    session: {
      message_count: 1002,
      _messages_offset: 1000,
      messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'long done' }],
    },
  };
};
// baseline(1000) -> poll(1001, not yet) -> poll(1002, advanced) -> one window read
assert.equal(await jarvis.runHermes('long history'), 'long done');
assert.equal(sendCalls, 2);
assert.equal(reads, 4);

// Completion polling must be metadata-only and must never request core's
// 500-message maximum: the old loop re-downloaded the whole transcript every
// 500 ms for the length of the agent run.
assert.equal(js.includes('msg_limit=500'), false, 'must not request core\'s max message window');
const seenPaths = [];
let pathReads = 0;
sandbox.__apiImpl = async (path) => {
  seenPaths.push(path);
  pathReads += 1;
  if (pathReads === 1) return { session: { message_count: 0, messages: [] } };
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'polled' }] } };
};
input.value = '';
assert.equal(await jarvis.runHermes('poll shape'), 'polled');
assert.equal(seenPaths.length, 3, seenPaths.join('\n'));
assert.match(seenPaths[0], /messages=0/);              // baseline: metadata only
assert.match(seenPaths[1], /messages=0/);              // completion check: metadata only
assert.match(seenPaths[2], /messages=1&msg_limit=40/); // exactly one bounded window
assert.equal(seenPaths.filter((p) => /messages=1/.test(p)).length, 1);

// A tool-heavy turn adds far more rows than the minimum window. Core returns the
// LAST N renderable rows, so a fixed small window drops our marker, correlation
// finds nothing, and a task that FINISHED reads as unfinished until the tool
// timeout. Size the window from the observed growth instead.
function bigTurnStub(rowCount, { reportTruncated = true, honourLimit = true } = {}) {
  const limits = [];
  let metaReads = 0;
  return {
    limits,
    impl: async (path) => {
      if (/messages=0/.test(path)) {
        metaReads += 1;
        return { session: { message_count: metaReads === 1 ? 100 : 100 + rowCount, messages: [] } };
      }
      // Built lazily: sentText is only the CURRENT request's text after send()
      // has run.
      const full = [{ role: 'user', content: sentText }];
      for (let i = 0; i < rowCount - 2; i += 1) full.push({ role: 'assistant', content: `step ${i}` });
      full.push({ role: 'assistant', content: 'big turn done' });
      const limit = Number((path.match(/msg_limit=(\d+)/) || [])[1] || 0);
      limits.push(limit);
      // honourLimit:false models message_count under-reporting the turn — the
      // sized window comes back short, but the widened maximum is honoured.
      const effective = honourLimit || limit >= REPLY_MAX ? limit : Math.min(limit, REPLY_MIN);
      const windowRows = full.slice(Math.max(0, full.length - effective));
      return {
        session: {
          message_count: 100 + rowCount,
          // Where this window sits in the display coordinate space: 100 pre-existing
          // rows, then however much of the new turn the window omitted.
          _messages_offset: 100 + (full.length - windowRows.length),
          messages: windowRows,
          _messages_truncated: reportTruncated && windowRows.length < full.length,
        },
      };
    },
  };
}
const REPLY_MIN = 40;
const REPLY_MAX = 500;

const bigTurn = bigTurnStub(60);
sandbox.__apiImpl = bigTurn.impl;
input.value = '';
assert.equal(await jarvis.runHermes('big turn'), 'big turn done');
assert.ok(bigTurn.limits[0] >= 60, `window must cover the 60 new rows, asked for ${bigTurn.limits[0]}`);
assert.ok(bigTurn.limits[0] <= 500, 'window must stay within core\'s maximum');

// Belt: if message_count under-reports the turn (display vs raw rows) the sized
// window can still miss the marker. Widen once instead of timing out.
const undercount = bigTurnStub(60, { honourLimit: false });
sandbox.__apiImpl = undercount.impl;
input.value = '';
assert.equal(await jarvis.runHermes('undercounted turn'), 'big turn done');
assert.deepEqual(undercount.limits, [64, 500], 'must widen to the maximum exactly once');

// A later user turn must close ours: its assistant reply can never be returned
// as this request's result.
let laterTurnReads = 0;
input.value = '';
sandbox.__apiImpl = async () => {
  laterTurnReads += 1;
  if (laterTurnReads === 1) return { session: { message_count: 0, messages: [] } };
  return {
    session: {
      message_count: 4,
      messages: [
        { role: 'user', content: sentText },
        { role: 'assistant', content: 'ours' },
        { role: 'user', content: 'a different question typed by the user' },
        { role: 'assistant', content: 'answer to the other question' },
      ],
    },
  };
};
assert.equal(await jarvis.runHermes('correlated'), 'ours');

let releaseFetch;
let webSockets = 0;
let mediaCalls = 0;
let fetchCalls = 0;
sandbox.fetch = async () => new Promise((resolve) => {
  fetchCalls += 1;
  releaseFetch = () => resolve({ ok: true, json: async () => ({ token: 'token' }) });
});
sandbox.WebSocket = class WebSocket {
  constructor() { webSockets += 1; this.readyState = 1; }
  close() {}
  send() {}
};
sandbox.WebSocket.OPEN = 1;
sandbox.navigator = { mediaDevices: { getUserMedia: async () => {
  mediaCalls += 1;
  return { getTracks: () => [{ stop() {} }] };
} } };
const micStart = jarvis.startMic();
const micStartAgain = jarvis.startMic();
jarvis.disconnect();
releaseFetch();
await assert.rejects(micStart, /cancelled/);
await assert.rejects(micStartAgain, /cancelled/);
assert.equal(fetchCalls, 1);
assert.equal(webSockets, 0);
assert.equal(mediaCalls, 0);

sandbox.fetch = async () => ({ ok: true, json: async () => ({ token: 'token' }) });
sandbox.WebSocket = class WebSocket { constructor() { throw new Error('ctor boom'); } };
await assert.rejects(jarvis.connect(), /ctor boom/);

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const sockets = [];
sandbox.fetch = async () => ({ ok: true, json: async () => ({ token: 'token' }) });
sandbox.WebSocket = class WebSocket {
  constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
  close() { this.readyState = 3; }
  send(message) { this.sent.push(message); }
};
sandbox.WebSocket.OPEN = 1;
let timeoutClosed = false;
const timeoutPending = jarvis.connect();
await flush();
const timeoutSocket = sockets.at(-1);
timeoutSocket.close = () => { timeoutClosed = true; timeoutSocket.readyState = 3; };
timeoutSocket.onopen();
longTimers.at(-1).fn();
await assert.rejects(timeoutPending, /timed out/);
assert.equal(timeoutClosed, true);

async function openJarvis() {
  const pending = jarvis.connect();
  await flush();
  const ws = sockets.at(-1);
  ws.onopen();
  await flush();
  ws.onmessage({ data: JSON.stringify({ setupComplete: true }) });
  await pending;
  return ws;
}
const oldSocket = await openJarvis();
jarvis.disconnect();
const newSocket = await openJarvis();

let resumeCalls = 0;
let workletNode;
let stopResolve;
let stoppedTrack = false;
const delayedStream = new Promise((resolve) => { stopResolve = () => resolve({ getTracks: () => [{ stop() { stoppedTrack = true; } }] }); });
sandbox.URL = { createObjectURL: () => 'blob:jarvis', revokeObjectURL() {} };
sandbox.AudioContext = class AudioContext {
  constructor() {
    this.state = 'suspended';
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  async resume() { resumeCalls += 1; this.state = 'running'; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() {}
};
sandbox.AudioWorkletNode = class AudioWorkletNode {
  constructor() { this.port = {}; workletNode = this; }
  connect() {}
  disconnect() {}
};
sandbox.navigator = { mediaDevices: { getUserMedia: async () => delayedStream } };
const stoppedMic = jarvis.startMic();
await flush();
jarvis.stopMic();
stopResolve();
await assert.rejects(stoppedMic, /cancelled/);
assert.equal(stoppedTrack, true);

sandbox.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
await jarvis.startMic();
assert.equal(resumeCalls, 1);
workletNode.port.onmessage({ data: new Int16Array([1, -1]).buffer });
assert.equal(newSocket.sent.some((message) => message.includes('audio/pcm;rate=16000')), true);
jarvis.stopMic();
assert.equal(newSocket.sent.some((message) => message.includes('audioStreamEnd')), true);

oldSocket.onclose();
await jarvis.connect();
assert.equal(sockets.length, 3);

let normalToolReads = 0;
input.value = '';
sandbox.__apiImpl = async () => {
  normalToolReads += 1;
  if (normalToolReads === 1) return { session: { message_count: 0, messages: [] } };
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'normal tool done' }] } };
};
await newSocket.onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: 'c0', name: 'run_hermes', args: { task: 'normal tool task' } }] } }) });
assert.equal(newSocket.sent.some((message) => message.includes('toolResponse') && message.includes('c0') && message.includes('normal tool done')), true);

let releaseTool;
const toolDone = new Promise((resolve) => { releaseTool = resolve; });
let toolReads = 0;
input.value = '';
coreS.session.session_id = 's1';
sandbox.__apiImpl = async () => {
  toolReads += 1;
  if (toolReads === 1) return { session: { message_count: 0, messages: [] } };
  await toolDone;
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'tool done' }] } };
};
newSocket.onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'run_hermes', args: { task: 'tool task' } }] } }) });
await flush();
jarvis.disconnect();
const newestSocket = await openJarvis();
releaseTool();
await flush();
assert.equal(newestSocket.sent.some((message) => message.includes('toolResponse')), false);

// ---- playback: Stop must actually stop -----------------------------------
const started = [];
let playbackCtx = null;
let resumeGate = null; // when set, resume() parks on it
sandbox.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
sandbox.AudioContext = class PlaybackContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
    playbackCtx = this;
  }
  async resume() {
    if (resumeGate) await resumeGate;
    this.state = 'running';
  }
  createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { return { buffer: null, connect() {}, start(at) { started.push(at); }, stop() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() {}
};

const audioChunk = Buffer.from(new Int16Array([1000, -1000]).buffer).toString('base64');
const audioMessage = JSON.stringify({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: audioChunk } }] } },
});

// Baseline. This session followed a disconnect(), which stops playback — but that
// suppression must not survive into the new connection, or reconnected audio is
// silent forever. Without this assertion every check below passes vacuously.
await newestSocket.onmessage({ data: audioMessage });
assert.equal(started.length, 1, 'a reconnected session must play audio again');

// Stop landing while a chunk is parked on resume() must still produce silence.
let releaseResume;
resumeGate = new Promise((resolve) => { releaseResume = resolve; });
playbackCtx.state = 'suspended';
const parked = newestSocket.onmessage({ data: audioMessage });
await flush();
jarvis.stopPlayback();
releaseResume();
await parked;
resumeGate = null;
assert.equal(started.length, 1, 'Stop must cancel a chunk waiting on AudioContext.resume()');

// ...and later chunks of the same stopped turn stay silent too.
await newestSocket.onmessage({ data: audioMessage });
assert.equal(started.length, 1, 'later chunks of a stopped turn must stay silent');

// turnComplete is a turn boundary: audio flows again.
await newestSocket.onmessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
await newestSocket.onmessage({ data: audioMessage });
assert.equal(started.length, 2, 'audio must resume after a turn boundary');

// A Gemini interrupt discards what is queued but must NOT suppress the
// replacement audio that follows it immediately.
await newestSocket.onmessage({ data: JSON.stringify({ serverContent: { interrupted: true } }) });
await newestSocket.onmessage({ data: audioMessage });
assert.equal(started.length, 3, 'interrupted must not suppress the replacement audio');

// ---- stale socket must not reach the composer ----------------------------
// The ownership check at the top of onmessage is not enough: a Blob body still
// decoding when the user disconnects resumes afterwards and dispatches into the
// CURRENT session. runHermes() writes a prompt and calls core send(), so the
// damage is done long before the toolResponse ownership check.
let releaseBlob;
const staleFrame = JSON.stringify({
  toolCall: { functionCalls: [{ id: 'stale', name: 'run_hermes', args: { task: 'stale task' } }] },
});
class ParkedBlob {
  text() { return new Promise((resolve) => { releaseBlob = () => resolve(staleFrame); }); }
}
sandbox.Blob = ParkedBlob;
sandbox.__apiImpl = async () => ({ session: { message_count: 0, messages: [] } });
input.value = '';
const sendCallsBeforeStale = sendCalls;
const staleDispatch = newestSocket.onmessage({ data: new ParkedBlob() });
await flush();
jarvis.disconnect();
const afterReconnect = await openJarvis();
releaseBlob();
await staleDispatch;
await flush();
assert.equal(sendCalls, sendCallsBeforeStale, 'a socket superseded during Blob decode must not start a Hermes task');
assert.equal(input.value, '', 'a stale socket must not leave a prompt in the composer');
assert.equal(
  afterReconnect.sent.some((message) => message.includes('toolResponse')),
  false,
  'a stale frame must not answer on the new socket',
);

// ---- one provider frame must not launch unbounded work -------------------
// hermesToolRunning resets after each awaited call, so without a cap a single
// frame can run run_hermes end to end, repeatedly, across the authority
// boundary.
let boundedReads = 0;
sandbox.__apiImpl = async () => {
  boundedReads += 1;
  if (boundedReads === 1) return { session: { message_count: 0, messages: [] } };
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'bounded' }] } };
};
input.value = '';
const sendCallsBeforeBound = sendCalls;
await afterReconnect.onmessage({
  data: JSON.stringify({
    toolCall: {
      functionCalls: [
        { id: 'b1', name: 'run_hermes', args: { task: 'first' } },
        { id: 'b2', name: 'run_hermes', args: { task: 'second' } },
        { id: 'b3', name: 'run_hermes', args: { task: 'third' } },
      ],
    },
  }),
});
assert.equal(sendCalls, sendCallsBeforeBound + 1, 'at most one Hermes task may run per provider tool frame');
const boundedReply = afterReconnect.sent.filter((message) => message.includes('toolResponse')).at(-1);
assert.ok(boundedReply.includes('b1') && boundedReply.includes('bounded'), 'the first call still runs');
assert.ok(/b2[^]*at most/.test(boundedReply), 'extra calls are rejected explicitly, not silently dropped');

// Oversized and empty task text must be refused before it reaches the composer.
input.value = '';
const sendCallsBeforeText = sendCalls;
await afterReconnect.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'big', name: 'run_hermes', args: { task: 'x'.repeat(5000) } }] },
  }),
});
await afterReconnect.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'empty', name: 'run_hermes', args: { task: '   ' } }] },
  }),
});
assert.equal(sendCalls, sendCallsBeforeText, 'oversized and empty tasks must never reach core send()');
assert.equal(input.value, '', 'a refused task must not leave a prompt in the composer');

// ---- keyboard: Escape from the toggle, without tabbing in first ----------
const { panel, button, card, log: logEl } = domNodes;
assert.ok(panel && button && card, 'render() must have built the panel');
assert.equal(button.parent, panel, 'the toggle is a child of the panel');
assert.equal(card.parent, panel, 'the card is a SIBLING of the toggle, not its ancestor');

// Enter/Space on the toggle fires click and leaves focus on the toggle.
dispatchEvent(button, 'click', {});
assert.equal(card.hidden, false, 'the toggle opens the card');
assert.equal(button.getAttribute('aria-expanded'), 'true');
button.focused = false;

// Escape now, with focus still on the toggle — no tabbing into the card.
dispatchEvent(button, 'keydown', { key: 'Escape' });
assert.equal(card.hidden, true, 'Escape from the toggle must close the card');
assert.equal(button.getAttribute('aria-expanded'), 'false');
assert.equal(button.focused, true, 'focus must return to the toggle');

// Other keys must not close it.
dispatchEvent(button, 'click', {});
dispatchEvent(button, 'keydown', { key: 'a' });
assert.equal(card.hidden, false, 'only Escape closes the card');
dispatchEvent(button, 'keydown', { key: 'Escape' });

// ---- transcript stays bounded over a long session ------------------------
const longLine = 'y'.repeat(900);
await afterReconnect.onmessage({
  data: JSON.stringify({ serverContent: { outputTranscription: { text: longLine } } }),
});
assert.ok(logEl.childElementCount >= 1, 'transcript received the line');
assert.equal(logEl.lastElementChild.textContent.length, 500, 'an over-long line is truncated');
for (let i = 0; i < 260; i += 1) {
  await afterReconnect.onmessage({
    data: JSON.stringify({ serverContent: { outputTranscription: { text: `line ${i}` } } }),
  });
}
assert.equal(logEl.childElementCount, 200, 'transcript must stay capped at 200 lines');
assert.ok(
  logEl.firstElementChild.textContent.length <= 500,
  'each transcript line must stay bounded',
);

// ---- Disconnect during the in-flight session read ------------------------
// handleToolCall checks ownership before calling runHermes, but runHermes then
// awaits a session read. A Disconnect landing in that window leaves the session
// unchanged, so composerBlockReason() sees nothing wrong and the task is written
// to the composer and submitted anyway — after the user pulled the plug.
let releaseBaseline;
let lateReads = 0;
sandbox.__apiImpl = async () => {
  lateReads += 1;
  if (lateReads === 1) {
    await new Promise((resolve) => { releaseBaseline = resolve; });
    return { session: { message_count: 0, messages: [] } };
  }
  return {
    session: {
      message_count: 2,
      messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'late' }],
    },
  };
};
input.value = '';
const sendCallsBeforeLate = sendCalls;
const lateDispatch = afterReconnect.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'late', name: 'run_hermes', args: { task: 'late task' } }] },
  }),
});
await flush();
jarvis.disconnect();
releaseBaseline();
await lateDispatch;
await flush();
assert.equal(
  sendCalls,
  sendCallsBeforeLate,
  'Disconnect during the session read must stop the task before core send()',
);
assert.equal(input.value, '', 'a cancelled task must not leave a prompt in the composer');

// ---- Disconnect during the completion poll -------------------------------
// The task has already been submitted here, so it cannot be recalled. But the
// poll loop runs for up to the full tool timeout, so without a cancellation
// check Jarvis keeps hitting core every couple of seconds for three minutes,
// for a reply that nobody is left to receive.
const pollSocket = await openJarvis();
let pollReads = 0;
sandbox.__apiImpl = async () => {
  pollReads += 1;
  if (pollReads === 1) return { session: { message_count: 0, messages: [] } };
  if (pollReads === 4) jarvis.disconnect();
  if (pollReads > 8) throw new Error('polling continued long after disconnect');
  // Never completes: Hermes stays busy, so the loop has no reason of its own to stop.
  return { session: { message_count: 0, active_stream_id: 'running', messages: [] } };
};
input.value = '';
await pollSocket.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'poll', name: 'run_hermes', args: { task: 'poll task' } }] },
  }),
});
assert.ok(pollReads <= 6, `polling must stop at disconnect, saw ${pollReads} reads`);
assert.equal(
  pollSocket.sent.some((message) => message.includes('toolResponse')),
  false,
  'no reply may be sent to a socket the user disconnected',
);

// ---- nothing may be appended to the user's prompt ------------------------
// A correlation marker in the prompt text is not cosmetic damage: core renders it
// as literal text in the message bubble AND derives the sidebar conversation
// title from it, so every voice task permanently defaces the transcript.
// Correlation must use core's own display coordinates instead.
assert.equal(
  /jarvis_request_id/.test(js),
  false,
  'the extension must not embed a correlation marker anywhere',
);
assert.equal(/<!--/.test(js), false, 'no HTML comment may be built into a prompt');

let markerReads = 0;
sandbox.__apiImpl = async () => {
  markerReads += 1;
  if (markerReads === 1) return { session: { message_count: 4, messages: [] } };
  return {
    session: {
      message_count: 6,
      _messages_offset: 4,
      messages: [
        { role: 'user', content: 'marker probe' },
        { role: 'assistant', content: 'clean reply' },
      ],
    },
  };
};
input.value = '';
const markerSocket = await openJarvis();
await markerSocket.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'm1', name: 'run_hermes', args: { task: 'marker probe' } }] },
  }),
});
// The text handed to core send() must be exactly the task, byte for byte.
assert.equal(sentText, 'marker probe', `prompt was decorated: ${JSON.stringify(sentText)}`);
const markerReply = markerSocket.sent.filter((m) => m.includes('toolResponse')).at(-1);
assert.ok(markerReply.includes('clean reply'), 'correlation must still find the reply');

// ...and the next-user-turn boundary must survive the mechanism change.
let boundaryReads = 0;
sandbox.__apiImpl = async () => {
  boundaryReads += 1;
  if (boundaryReads === 1) return { session: { message_count: 2, messages: [] } };
  return {
    session: {
      message_count: 6,
      _messages_offset: 2,
      messages: [
        { role: 'user', content: 'boundary probe' },
        { role: 'assistant', content: 'ours' },
        { role: 'user', content: 'a different question typed by the user' },
        { role: 'assistant', content: 'answer to the other question' },
      ],
    },
  };
};
input.value = '';
assert.equal(await jarvis.runHermes('boundary probe'), 'ours', 'a later turn must not leak its reply');

// An older identical message must not be mistaken for ours: only rows at or
// after the baseline count qualify.
let staleTextReads = 0;
sandbox.__apiImpl = async () => {
  staleTextReads += 1;
  if (staleTextReads === 1) return { session: { message_count: 2, messages: [] } };
  return {
    session: {
      message_count: 4,
      _messages_offset: 0,
      messages: [
        { role: 'user', content: 'repeat me' },
        { role: 'assistant', content: 'OLD answer from before the baseline' },
        { role: 'user', content: 'repeat me' },
        { role: 'assistant', content: 'NEW answer' },
      ],
    },
  };
};
input.value = '';
assert.equal(await jarvis.runHermes('repeat me'), 'NEW answer', 'must anchor on the row after the baseline');

// ---- an ambiguous anchor must never resolve to a guess -------------------
// Correlation anchors on "user row at or after the baseline whose text is
// exactly the task". If a second identical user row is also in range — the user
// typing the same thing, or message_count under-reporting so an earlier row
// falls inside the window — then first-match silently returns someone else's
// answer. Returning the wrong reply to the model is worse than not answering, so
// ambiguity must not resolve.
let ambiguousReads = 0;
sandbox.__apiImpl = async () => {
  ambiguousReads += 1;
  if (ambiguousReads === 1) return { session: { message_count: 2, messages: [] } };
  if (ambiguousReads > 6) throw new Error('gave up polling');
  return {
    session: {
      message_count: 6,
      _messages_offset: 2,
      messages: [
        { role: 'user', content: 'ambiguous task' },
        { role: 'assistant', content: 'reply A' },
        { role: 'user', content: 'ambiguous task' },
        { role: 'assistant', content: 'reply B' },
      ],
    },
  };
};
input.value = '';
await assert.rejects(
  jarvis.runHermes('ambiguous task'),
  /gave up polling|could not be matched/,
  'two identical candidate rows must not resolve to either reply',
);

// The unambiguous case must still resolve, so the guard is not just "never answer".
let unambiguousReads = 0;
sandbox.__apiImpl = async () => {
  unambiguousReads += 1;
  if (unambiguousReads === 1) return { session: { message_count: 2, messages: [] } };
  return {
    session: {
      message_count: 4,
      _messages_offset: 2,
      messages: [
        { role: 'user', content: 'unambiguous task' },
        { role: 'assistant', content: 'the one true reply' },
      ],
    },
  };
};
input.value = '';
assert.equal(await jarvis.runHermes('unambiguous task'), 'the one true reply');

console.log('ok jarvis voice runtime checks');
process.exit(0);
