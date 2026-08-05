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
    style: { properties: {}, setProperty(key, value) { this.properties[key] = value; } },
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
// Document-level listeners are real behaviour now (outside-click and Escape
// dismissal), so the harness records and can dispatch them.
const documentHandlers = {};
function dispatchDocEvent(type, payload = {}) {
  const event = { type, defaultPrevented: false, ...payload };
  for (const fn of (documentHandlers[type] || []).slice()) fn(event);
}
sandbox.document = {
  readyState: 'complete',
  addEventListener(type, fn) { (documentHandlers[type] = documentHandlers[type] || []).push(fn); },
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
// Core's sanitizer drops an enum setting whose options are not {value,label}
// objects (docs/extension-entry.md), which silently removes the whole control
// from the settings panel.
for (const field of extensionJson.settings_schema) {
  if (field.type !== 'enum') continue;
  for (const option of field.options) {
    assert.ok(
      option && typeof option === 'object' && typeof option.value === 'string' && typeof option.label === 'string',
      `enum option ${JSON.stringify(option)} must be a {value,label} object or core drops the setting`,
    );
  }
}

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
// Capture is batched, so a sub-batch amount of speech is held rather than sent
// as its own socket frame.
const beforeTail = newSocket.sent.length;
workletNode.port.onmessage({ data: new Int16Array(400).buffer });
assert.equal(
  newSocket.sent.slice(beforeTail).some((m) => m.includes('audio/pcm;rate=16000')),
  false,
  'a sub-batch amount of audio should be buffered, not sent as its own frame',
);

// ...but stopping must FLUSH that tail, and flush it BEFORE end-of-stream.
// Otherwise up to a batch of speech is silently discarded and the speaker's last
// word is clipped: server-side VAD cannot recover audio it never received.
jarvis.stopMic();
const tail = newSocket.sent.slice(beforeTail);
const audioIndex = tail.findIndex((m) => m.includes('audio/pcm;rate=16000'));
const endIndex = tail.findIndex((m) => m.includes('audioStreamEnd'));
assert.ok(audioIndex >= 0, 'stopMic must flush the buffered tail instead of dropping it');
assert.ok(endIndex >= 0, 'stopMic must still signal end of stream');
assert.ok(audioIndex < endIndex, 'the tail must be sent BEFORE audioStreamEnd');

// A full batch still goes out immediately while listening.
await jarvis.startMic();
const beforeFull = newSocket.sent.length;
workletNode.port.onmessage({ data: new Int16Array(1600).buffer });
assert.equal(
  newSocket.sent.slice(beforeFull).some((m) => m.includes('audio/pcm;rate=16000')),
  true,
  'a full batch must be sent without waiting for stop',
);
jarvis.stopMic();

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

// ---- token failures must surface the reason, not just a number -----------
// Verified against a running WebUI: with consent granted and the proxy token
// injected, a sidecar with no credential answers 503 with
// {"error":"Gemini API key is not configured"}. Discarding that leaves the user
// staring at a bare status code for a one-line fix.
jarvis.disconnect(); // connect() short-circuits while a session is live
sandbox.fetch = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ error: 'Gemini API key is not configured' }),
});
await assert.rejects(
  jarvis.connect(),
  /Gemini API key is not configured/,
  'the sidecar error body must reach the user',
);

// A body-less failure still has to say something intelligible.
sandbox.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
await assert.rejects(jarvis.connect(), /502/);

// Consent / auth failures keep their specific guidance.
sandbox.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Extension sidecar proxy consent required' }) });
await assert.rejects(jarvis.connect(), /Settings → Extensions/);

// ---- worklet resampling, and main-thread batching ------------------------
// Batching lives on the MAIN thread, not in the worklet, so stopMic() can flush
// the tail synchronously (see the tail-flush assertions above). The worklet's job
// is only to downsample correctly and hand buffers over cheaply.
const workletSource = js.match(/const worklet = `([\s\S]*?)`;/)[1];
const captured = [];
const capturedSamples = [];
const workletCtx = {
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage: (buf) => {
        const pcm = new Int16Array(buf);
        captured.push(pcm.length);
        for (const v of pcm) capturedSamples.push(v);
      } };
    }
  },
  registerProcessor(name, cls) { workletCtx.__processor = cls; },
};
vm.runInNewContext(workletSource, workletCtx, { filename: 'jarvis-capture.worklet.js' });
assert.equal(typeof workletCtx.__processor, 'function', 'worklet must register a processor');
const processor = new workletCtx.__processor();
// 100 render quanta of 128 frames at 48kHz = 12800 frames = ~266ms of audio.
for (let i = 0; i < 100; i += 1) processor.process([[new Float32Array(128)]]);
assert.ok(captured.length >= 1, 'the worklet must emit something for 266ms of audio');
// 266ms of 48kHz input must come out as ~4260 samples of 16kHz mono PCM.
const totalSamples = captured.reduce((a, n) => a + n, 0);
assert.ok(
  totalSamples > 3000 && totalSamples < 4400,
  `expected roughly 4260 samples of 16kHz audio, got ${totalSamples}`,
);

// Now the batching, at the layer that owns it. Feeding the same 266ms through the
// main-thread handler must produce a handful of socket frames, not ~90 a second:
// live Gemini saw 874 outbound frames over a ten-second exchange before this.
// The token-failure cases above left a rejecting fetch behind; restore one.
sandbox.fetch = async () => ({ ok: true, json: async () => ({ token: 'token' }) });
const batchSocket = await openJarvis();
await jarvis.startMic();
const beforeBatch = batchSocket.sent.length;
for (const samples of captured) workletNode.port.onmessage({ data: new Int16Array(samples).buffer });
const frames = batchSocket.sent.slice(beforeBatch).filter((m) => m.includes('audio/pcm;rate=16000')).length;
assert.ok(frames >= 1, 'the batched audio must actually reach the socket');
assert.ok(frames <= 4, `266ms of audio must not become ${frames} socket frames`);
jarvis.stopMic();

// ---- the downsampler must not alias speech-band noise in -----------------
// 16kHz output means an 8kHz ceiling. Decimating 48kHz by picking every third
// sample applies no low-pass, so a 12kHz component folds to |12000-16000| =
// 4000Hz — straight into the middle of the speech band, at full amplitude, where
// it corrupts the very recognition this extension depends on.
function toneRms(freq) {
  const samples = [];
  const ctx = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (buf) => { for (const v of new Int16Array(buf)) samples.push(v); } };
      }
    },
    registerProcessor(name, cls) { ctx.__processor = cls; },
  };
  vm.runInNewContext(workletSource, ctx, { filename: 'jarvis-capture.worklet.js' });
  const proc = new ctx.__processor();
  let n = 0;
  for (let q = 0; q < 200; q += 1) {
    const quantum = new Float32Array(128);
    for (let i = 0; i < 128; i += 1, n += 1) quantum[i] = Math.sin(2 * Math.PI * freq * n / 48000);
    proc.process([[quantum]]);
  }
  // Drop the first few output samples: the very first window is partial.
  const body = samples.slice(4);
  return Math.sqrt(body.reduce((a, v) => a + v * v, 0) / body.length) / 32768;
}

const rms1k = toneRms(1000);
const rms12k = toneRms(12000);
// A 1kHz tone is well inside the passband and must survive essentially intact
// (full-scale sine RMS is ~0.707).
assert.ok(rms1k > 0.55, `1kHz speech content must pass through, RMS was ${rms1k.toFixed(3)}`);
// A 12kHz tone must be attenuated rather than folded in at full amplitude.
assert.ok(
  rms12k < 0.45,
  `12kHz must not alias into the speech band at full amplitude, RMS was ${rms12k.toFixed(3)}`,
);
assert.ok(
  rms12k < rms1k * 0.7,
  `above-Nyquist content must be attenuated relative to speech: 12kHz ${rms12k.toFixed(3)} vs 1kHz ${rms1k.toFixed(3)}`,
);

// ---- the resampler must be streaming-safe ---------------------------------
// The worklet sees audio in 128-sample quanta. Processing the same PCM chunked
// versus contiguous must be bit-identical: a partial window dropped or restarted
// at each quantum boundary corrupts the stream ~375 times a second, which no
// per-chunk count or tone-RMS oracle can see.
function resampleTone(sampleRate, freq, chunkSize, totalFrames) {
  const samples = [];
  const ctx = {
    sampleRate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (buf) => { for (const v of new Int16Array(buf)) samples.push(v); } };
      }
    },
    registerProcessor(name, cls) { ctx.__processor = cls; },
  };
  vm.runInNewContext(workletSource, ctx, { filename: 'jarvis-capture.worklet.js' });
  const proc = new ctx.__processor();
  let n = 0;
  for (let at = 0; at < totalFrames; at += chunkSize) {
    const len = Math.min(chunkSize, totalFrames - at);
    const quantum = new Float32Array(len);
    for (let i = 0; i < len; i += 1, n += 1) quantum[i] = Math.sin(2 * Math.PI * freq * n / sampleRate);
    proc.process([[quantum]]);
  }
  return samples;
}
for (const rate of [48000, 44100]) {
  for (const freq of [1000, 6000]) {
    const frames = 128 * 100;
    const chunked = resampleTone(rate, freq, 128, frames);
    const whole = resampleTone(rate, freq, frames, frames);
    assert.deepEqual(
      chunked,
      whole,
      `resampling must be chunk-invariant at ${rate}Hz input, ${freq}Hz tone`,
    );
    const expected = frames / (rate / 16000);
    assert.ok(
      Math.abs(chunked.length - expected) <= 2,
      `expected ~${Math.round(expected)} output samples at ${rate}Hz, got ${chunked.length}`,
    );
  }
}

// ---- an unexpected provider close must revoke task authority --------------
// disconnect() advances the generation, but a close the user never asked for
// took the same authority away: the socket is gone, so nothing started on its
// behalf may keep acting. Without revocation, work parked on an await resumes
// against a dead socket and still reaches core send().

// Close during Blob decode.
const closeSocket = await openJarvis();
let releaseBlobClose;
class CloseParkedBlob {
  text() { return new Promise((resolve) => { releaseBlobClose = () => resolve(staleFrame); }); }
}
sandbox.Blob = CloseParkedBlob;
sandbox.__apiImpl = async () => ({ session: { message_count: 0, messages: [] } });
input.value = '';
const sendCallsBeforeClose = sendCalls;
const closeDispatch = closeSocket.onmessage({ data: new CloseParkedBlob() });
await flush();
closeSocket.onclose();
releaseBlobClose();
await closeDispatch;
await flush();
assert.equal(sendCalls, sendCallsBeforeClose, 'a socket closed during Blob decode must not start a Hermes task');
assert.equal(input.value, '', 'a closed socket must not leave a prompt in the composer');
assert.equal(
  closeSocket.sent.some((message) => message.includes('toolResponse')),
  false,
  'no tool response may be sent for work revoked by a close',
);

// Close during the pre-send baseline read.
const closeReadSocket = await openJarvis();
let releaseCloseBaseline;
let closeReads = 0;
sandbox.__apiImpl = async () => {
  closeReads += 1;
  if (closeReads === 1) {
    await new Promise((resolve) => { releaseCloseBaseline = resolve; });
    return { session: { message_count: 0, messages: [] } };
  }
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'late' }] } };
};
input.value = '';
const sendCallsBeforeCloseRead = sendCalls;
const closeReadDispatch = closeReadSocket.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'cr', name: 'run_hermes', args: { task: 'close read task' } }] },
  }),
});
await flush();
closeReadSocket.onclose();
releaseCloseBaseline();
await closeReadDispatch;
await flush();
assert.equal(sendCalls, sendCallsBeforeCloseRead, 'close during the session read must stop the task before core send()');
assert.equal(input.value, '', 'a revoked task must not leave a prompt in the composer');

// Close during the completion poll.
const closePollSocket = await openJarvis();
let closePollReads = 0;
sandbox.__apiImpl = async () => {
  closePollReads += 1;
  if (closePollReads === 1) return { session: { message_count: 0, messages: [] } };
  if (closePollReads === 4) closePollSocket.onclose();
  if (closePollReads > 8) throw new Error('polling continued after the provider closed the socket');
  return { session: { message_count: 0, active_stream_id: 'running', messages: [] } };
};
input.value = '';
await closePollSocket.onmessage({
  data: JSON.stringify({
    toolCall: { functionCalls: [{ id: 'cp', name: 'run_hermes', args: { task: 'close poll task' } }] },
  }),
});
assert.ok(closePollReads <= 6, `polling must stop when the provider closes the socket, saw ${closePollReads} reads`);
assert.equal(
  closePollSocket.sent.some((message) => message.includes('toolResponse')),
  false,
  'no reply may be sent to a socket the provider closed',
);

// ---- provider frames must be bounded before parse/decode ------------------
// The provider controls every byte of a frame. Without caps, one frame can park
// an arbitrarily large body in JSON.parse, queue an unbounded run of tool
// calls, or hand the audio path an absurd buffer — all before any of the
// per-call limits are consulted.
const boundedSocket = await openJarvis();

// An oversized text frame must be refused unparsed, and the socket closed:
// a provider that ignores the protocol's shape does not get to keep talking.
input.value = '';
const sendCallsBeforeHugeFrame = sendCalls;
const hugeFrame = JSON.stringify({
  toolCall: { functionCalls: [{ id: 'huge', name: 'run_hermes', args: { task: 'huge', pad: 'x'.repeat(1024 * 1024 + 1024) } }] },
});
await boundedSocket.onmessage({ data: hugeFrame });
assert.equal(sendCalls, sendCallsBeforeHugeFrame, 'an oversized frame must never reach the composer');
assert.equal(boundedSocket.readyState, 3, 'an oversized frame must close the socket');

// An oversized Blob must be refused by its size, BEFORE its body is decoded.
const blobSocket = await openJarvis();
class HugeBlob {
  constructor() { this.size = 1024 * 1024 + 1; }
  text() { throw new Error('an oversized Blob body must never be decoded'); }
}
sandbox.Blob = HugeBlob;
await blobSocket.onmessage({ data: new HugeBlob() });
assert.equal(blobSocket.readyState, 3, 'an oversized Blob frame must close the socket');

// A run of tool calls beyond anything legitimate is a protocol violation.
const callsSocket = await openJarvis();
input.value = '';
const sendCallsBeforeRun = sendCalls;
await callsSocket.onmessage({
  data: JSON.stringify({
    toolCall: {
      functionCalls: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, name: 'run_hermes', args: { task: `run ${i}` } })),
    },
  }),
});
assert.equal(sendCalls, sendCallsBeforeRun, 'a tool-call flood must not run anything');
assert.equal(callsSocket.readyState, 3, 'a tool-call flood must close the socket');
assert.equal(
  callsSocket.sent.some((message) => message.includes('toolResponse')),
  false,
  'a tool-call flood gets no responses, it gets disconnected',
);

// One absurd inline-audio part is dropped rather than decoded; a sane part in
// a later frame still plays.
const audioSocket = await openJarvis();
const startedBeforeAudioCap = started.length;
await audioSocket.onmessage({
  data: JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: 'A'.repeat(800 * 1024) } }] } },
  }),
});
assert.equal(started.length, startedBeforeAudioCap, 'an oversized inline-audio part must not be decoded or scheduled');
await audioSocket.onmessage({ data: audioMessage });
assert.equal(started.length, startedBeforeAudioCap + 1, 'a sane audio part must still play');

// ---- disconnect during setup must not poison the next connect -------------
// connect() reuses a pending promise. If disconnect() leaves that promise
// pending (its 15s timer is the only thing that settles it), an immediate
// reconnect adopts the abandoned attempt and no new socket is ever created.
jarvis.disconnect(); // the audio-cap test above leaves a live session behind
const socketsBeforeSetupCancel = sockets.length;
const pendingSetup = jarvis.connect();
pendingSetup.catch(() => {});
await flush();
const setupSocket = sockets.at(-1);
setupSocket.onopen();
jarvis.disconnect();
const reconnectAfterCancel = jarvis.connect();
await flush();
assert.equal(
  sockets.length,
  socketsBeforeSetupCancel + 2,
  'reconnect after a mid-setup disconnect must create a fresh socket, not adopt the stale attempt',
);
await assert.rejects(pendingSetup, /cancelled/, 'the abandoned setup attempt must reject immediately');
const freshSetupSocket = sockets.at(-1);
freshSetupSocket.onopen();
await flush();
freshSetupSocket.onmessage({ data: JSON.stringify({ setupComplete: true }) });
await reconnectAfterCancel;

// ---- geometry and dismissal ----------------------------------------------
// The panel must anchor to the live composer band instead of fixed viewport
// offsets: at 390x844 the fixed FAB covered core's Send button almost exactly,
// and the open card overlapped the textarea at both sizes. The harness has no
// layout engine, so anchoring is asserted as deletion guards; dismissal is
// behavioural.
assert.match(js, /getBoundingClientRect/, 'panel must measure the live composer box');
assert.match(js, /ResizeObserver/, 'panel must track composer growth (multiline expansion)');
assert.match(js, /visualViewport/, 'panel must track the on-screen keyboard');
assert.match(css, /--jarvis-bottom/, 'panel offsets must flow through the anchoring custom property');

// Clicking outside the panel dismisses the card.
dispatchEvent(domNodes.button, 'click', {});
assert.equal(domNodes.card.hidden, false, 'toggle opens the card');
dispatchDocEvent('pointerdown', { target: {} });
assert.equal(domNodes.card.hidden, true, 'a click outside the panel must dismiss the card');

// Clicking inside it must not.
dispatchEvent(domNodes.button, 'click', {});
dispatchDocEvent('pointerdown', { target: domNodes.log });
assert.equal(domNodes.card.hidden, false, 'a click inside the panel must not dismiss the card');

// Escape works from anywhere in the document, not only inside the panel...
domNodes.button.focused = false;
dispatchDocEvent('keydown', { key: 'Escape', target: {} });
assert.equal(domNodes.card.hidden, true, 'Escape must dismiss the card wherever focus sits');
assert.equal(domNodes.button.focused, true, 'document-level Escape must return focus to the toggle');

// ...but yields to a core dialog that already claimed the key.
dispatchEvent(domNodes.button, 'click', {});
dispatchDocEvent('keydown', { key: 'Escape', target: {}, defaultPrevented: true });
assert.equal(domNodes.card.hidden, false, 'an Escape claimed by a core dialog must be yielded');
dispatchDocEvent('keydown', { key: 'Escape', target: {} });
assert.equal(domNodes.card.hidden, true);

// ---- voice state must be accessible and lifecycle-complete ----------------
// The status line must carry live semantics so a screen reader hears state
// changes, and Talk must expose its toggle state instead of silently changing
// what a click does.
assert.match(js, /id="jarvisVoiceStatus" role="status"/, 'the status line must be a live status region');

// Small text and control boundaries may not ride on --accent: core's light
// theme renders it at 2.81:1, below both the 4.5:1 text and 3:1 boundary floors.
assert.equal(css.includes('color: var(--accent'), false, 'small text must not use the accent token');

// Talk is a toggle: pressed while listening, not pressed after stop.
const { talk } = domNodes;
sandbox.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
await jarvis.startMic();
assert.equal(talk.getAttribute('aria-pressed'), 'true', 'Talk must expose pressed state while listening');
jarvis.stopMic();
assert.equal(talk.getAttribute('aria-pressed'), 'false', 'Talk must expose unpressed state after stop');

// A deliberate Stop during startup is a cancellation, not a failure: the click
// handler must not convert it into status "error".
let releaseCancelledMic;
sandbox.navigator = { mediaDevices: { getUserMedia: () => new Promise((resolve) => {
  releaseCancelledMic = () => resolve({ getTracks: () => [{ stop() {} }] });
}) } };
dispatchEvent(talk, 'click', {});
await flush();
jarvis.stopMic();
releaseCancelledMic();
await flush();
await flush();
assert.notEqual(domNodes.status.textContent, 'error', 'a deliberate cancel must not read as an error');
assert.equal(domNodes.status.textContent, 'ready', 'a cancelled mic start settles back to ready');

// Permission revocation / device removal ends the track outside our control.
// Capture must observe that and stop, not stay in a false "listening" state.
const endedTrack = { stop() {}, onended: null };
sandbox.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [endedTrack] }) } };
await jarvis.startMic();
assert.equal(typeof endedTrack.onended, 'function', 'capture must observe MediaStreamTrack termination');
endedTrack.onended();
assert.equal(talk.getAttribute('aria-pressed'), 'false', 'a dead track must end the listening state');
assert.equal(domNodes.status.textContent, 'ready', 'a dead track must not leave status stuck on listening');

// ---- a failed setup must revoke the socket's authority --------------------
// fail() used to close the socket but leave state.ws and the epoch alone, so a
// frame parked in Blob decode when the 15-second deadline fired resumed AFTER
// the failure, passed its ownership recheck, and drove run_hermes into core
// send() on behalf of a session that never came up.
jarvis.disconnect();
let releaseSetupBlob;
const setupToolFrame = JSON.stringify({
  toolCall: { functionCalls: [{ id: 'st', name: 'run_hermes', args: { task: 'setup timeout task' } }] },
});
class SetupParkedBlob {
  text() { return new Promise((resolve) => { releaseSetupBlob = () => resolve(setupToolFrame); }); }
}
sandbox.Blob = SetupParkedBlob;
let setupTimeoutReads = 0;
sandbox.__apiImpl = async () => {
  setupTimeoutReads += 1;
  if (setupTimeoutReads === 1) return { session: { message_count: 0, messages: [] } };
  return { session: { message_count: 2, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'ghost reply' }] } };
};
input.value = '';
const sendCallsBeforeSetupTimeout = sendCalls;
const timedOutSetup = jarvis.connect();
timedOutSetup.catch(() => {});
await flush();
const setupTimeoutSocket = sockets.at(-1);
setupTimeoutSocket.onopen();
const parkedSetupFrame = setupTimeoutSocket.onmessage({ data: new SetupParkedBlob() });
await flush();
longTimers.at(-1).fn(); // the 15-second setup deadline fires
await assert.rejects(timedOutSetup, /timed out/);
releaseSetupBlob();
await parkedSetupFrame;
await flush();
assert.equal(
  sendCalls,
  sendCallsBeforeSetupTimeout,
  'a frame parked in decode when setup failed must not start a Hermes task',
);
assert.equal(input.value, '', 'a revoked setup must not leave a prompt in the composer');
assert.equal(
  setupTimeoutSocket.sent.some((message) => message.includes('toolResponse')),
  false,
  'no tool response may be sent on a socket whose setup failed',
);

// ---- ambiguity must be terminal, not retried ------------------------------
// Flag-and-keep-polling turns the ambiguity guard into a delayed coin flip:
// core's bounded tail shifts between polls, and a later window that drops ONE
// of the two identical rows makes the survivor look unique — so the loop
// resolves on somebody else's reply after all. Once two candidates have been
// seen, no later window can be trusted to disambiguate.
sandbox.Blob = class {};
let shiftMetaReads = 0;
let shiftWindowReads = 0;
sandbox.__apiImpl = async (path) => {
  if (/messages=0/.test(path)) {
    shiftMetaReads += 1;
    return { session: { message_count: shiftMetaReads === 1 ? 2 : 6, messages: [] } };
  }
  shiftWindowReads += 1;
  if (shiftWindowReads === 1) {
    return {
      session: {
        message_count: 6,
        _messages_offset: 2,
        messages: [
          { role: 'user', content: 'shifting task' },
          { role: 'assistant', content: 'reply A' },
          { role: 'user', content: 'shifting task' },
          { role: 'assistant', content: 'reply B' },
        ],
      },
    };
  }
  // The tail shifted: the first duplicate scrolled out of the window and the
  // survivor now looks unique. Resolving here returns the WRONG reply.
  return {
    session: {
      message_count: 6,
      _messages_offset: 4,
      messages: [
        { role: 'user', content: 'shifting task' },
        { role: 'assistant', content: 'reply B' },
      ],
    },
  };
};
input.value = '';
await assert.rejects(
  jarvis.runHermes('shifting task'),
  /could not be matched/,
  'an ambiguous anchor must fail the task immediately, not resolve on a later shifted window',
);
assert.equal(shiftWindowReads, 1, 'ambiguity must stop the poll loop at the window that exposed it');

// ...and the widened-window branch is the same coin flip one layer down.
let widenMetaReads = 0;
let widenWindowReads = 0;
sandbox.__apiImpl = async (path) => {
  if (/messages=0/.test(path)) {
    widenMetaReads += 1;
    return { session: { message_count: widenMetaReads === 1 ? 2 : 6, messages: [] } };
  }
  widenWindowReads += 1;
  const limit = Number((path.match(/msg_limit=(\d+)/) || [])[1] || 0);
  if (limit < REPLY_MAX) {
    if (widenWindowReads > 2) {
      // A later round's sized window shows a unique survivor — the coin flip.
      return {
        session: {
          message_count: 6,
          _messages_offset: 4,
          messages: [
            { role: 'user', content: 'widened task' },
            { role: 'assistant', content: 'reply B' },
          ],
        },
      };
    }
    // Round one: the sized window missed the anchor and reports truncation...
    return {
      session: {
        message_count: 6,
        _messages_offset: 6,
        messages: [{ role: 'assistant', content: 'tail row' }],
        _messages_truncated: true,
      },
    };
  }
  // ...and the widened read exposes TWO identical anchors in range.
  return {
    session: {
      message_count: 6,
      _messages_offset: 2,
      messages: [
        { role: 'user', content: 'widened task' },
        { role: 'assistant', content: 'reply A' },
        { role: 'user', content: 'widened task' },
        { role: 'assistant', content: 'reply B' },
      ],
    },
  };
};
input.value = '';
await assert.rejects(
  jarvis.runHermes('widened task'),
  /could not be matched/,
  'ambiguity found in the widened window must also be terminal',
);
assert.equal(widenWindowReads, 2, 'the widened read that exposed the ambiguity must be the last');

// ---- Stop during capture-context resume must cancel, not crash ------------
// stopMic() landing while startMic() is parked on AudioContext.resume() nulls
// state.captureCtx and closes the context. The continuation used to
// dereference that null (audioWorklet.addModule), surfacing a TypeError to
// the user in place of the clean cancellation they asked for.
const resumeSocket = await openJarvis();
let releaseCaptureResume;
sandbox.AudioContext = class SuspendedCaptureContext {
  constructor() {
    this.state = 'suspended';
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  async resume() {
    await new Promise((resolve) => { releaseCaptureResume = resolve; });
    this.state = 'running';
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() {}
};
sandbox.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
const resumeParkedMic = jarvis.startMic();
await flush();
jarvis.stopMic();
releaseCaptureResume();
await assert.rejects(
  resumeParkedMic,
  /cancelled/,
  'Stop during AudioContext.resume() must reject as a cancellation, not a TypeError',
);
assert.equal(resumeSocket.sent.some((m) => m.includes('audio/pcm')), false, 'no capture audio may follow a cancelled mic start');

console.log('ok jarvis voice runtime checks');
process.exit(0);
