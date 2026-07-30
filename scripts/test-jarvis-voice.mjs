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
  document: {
    readyState: 'loading',
    addEventListener() {},
    getElementById(id) { return id === 'msg' ? input : null; },
  },
};
sandbox.window = sandbox;

// Model core's REAL global shape. `static/ui.js:8` declares `const S = {...}` at
// the top level of a classic script, which creates a global *lexical* binding:
// reachable as a bare `S`, absent from `window`. Core's `api()` helper is the
// same. An extension that reaches for `window.S` therefore gets `undefined` in
// the shipped app, so this harness must not hand it one — a sandbox where
// `window === globalThis` and `S` is a plain property tests a world that does
// not exist and hides exactly this bug class.
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
assert.match(input.value, /jarvis_request_id:/);
assert.equal(input.value.endsWith(' '), true);
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
assert.match(sentText, /jarvis_request_id:/);
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
  return { session: { message_count: 1002, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'long done' }] } };
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
      // Built lazily: sentText is only the CURRENT request's marker after send()
      // has run, and each runHermes call mints a fresh id.
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

console.log('ok jarvis voice runtime checks');
process.exit(0);
