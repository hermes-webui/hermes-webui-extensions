#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const input = { value: '', dispatchEvent() {} };
const longTimers = [];
const sandbox = {
  console,
  setTimeout(fn, ms) {
    const timer = { fn, cleared: false };
    if (ms >= 1000) longTimers.push(timer);
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
sandbox.S = { session: { session_id: 's1' }, messages: [], pendingFiles: [] };

const js = readFileSync(new URL('../extensions/jarvis-voice/assets/jarvis-voice.js', import.meta.url), 'utf8');
vm.runInNewContext(js, sandbox, { filename: 'jarvis-voice.js' });
const jarvis = sandbox.HermesJarvisVoice;
assert.equal(typeof jarvis.runHermes, 'function');

let sendCalls = 0;
let sentText = '';
sandbox.send = async () => { sendCalls += 1; sentText = input.value; input.value = ''; };
sandbox.api = async () => ({ session: { message_count: 0, messages: [] } });

sandbox.S.session.pending_user_message = true;
assert.match(await jarvis.runHermes('busy'), /already running/);
assert.equal(sendCalls, 0);
sandbox.S.session.pending_user_message = false;

input.value = 'draft';
assert.match(await jarvis.runHermes('draft'), /unsent composer draft/);
assert.equal(sendCalls, 0);
input.value = '';

sandbox.S.pendingFiles = [{ name: 'x.txt' }];
assert.match(await jarvis.runHermes('file'), /pending attachments/);
assert.equal(sendCalls, 0);
sandbox.S.pendingFiles = [];

sandbox.S.session.is_read_only = true;
assert.match(await jarvis.runHermes('read only'), /Read-only/);
assert.equal(sendCalls, 0);
sandbox.S.session.is_read_only = false;

sandbox.api = async () => ({ session: { message_count: 1, active_stream_id: 'server-stream', messages: [] } });
assert.match(await jarvis.runHermes('server busy'), /already running/);
assert.equal(sendCalls, 0);
sandbox.api = async () => ({ session: { message_count: 0, messages: [] } });

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
input.dispatchEvent = () => { sandbox.S.busy = true; };
sandbox.send = async () => { lateBusySendCalls += 1; };
sandbox.api = async () => ({ session: { message_count: 0, messages: [] } });
assert.match(await jarvis.runHermes('late busy'), /already running/);
assert.equal(lateBusySendCalls, 0);
assert.equal(input.value, '');
sandbox.S.busy = false;
input.dispatchEvent = realDispatch;
sandbox.send = realSend;

let release;
const slow = new Promise((resolve) => { release = resolve; });
sandbox.api = async () => {
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

sandbox.api = async () => {
  sandbox.S.session.session_id = 's2';
  return { session: { message_count: 2, messages: [] } };
};
assert.match(await jarvis.runHermes('switched'), /conversation changed/);
assert.equal(sendCalls, 1);
sandbox.S.session.session_id = 's1';

delete sandbox.S.session.message_count;
sandbox.S.messages = [{ role: 'user', content: 'old user' }, { role: 'assistant', content: 'old assistant' }];
let reads = 0;
sandbox.api = async () => {
  reads += 1;
  if (reads === 1) return { session: { message_count: 1000, messages: [{ role: 'assistant', content: 'old assistant' }] } };
  if (reads === 2) return { session: { message_count: 1001, messages: [{ role: 'assistant', content: 'old assistant' }] } };
  return { session: { message_count: 1002, messages: [{ role: 'user', content: sentText }, { role: 'assistant', content: 'long done' }] } };
};
assert.equal(await jarvis.runHermes('long history'), 'long done');
assert.equal(sendCalls, 2);
assert.equal(reads, 3);

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
sandbox.api = async () => {
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
sandbox.S.session.session_id = 's1';
sandbox.api = async () => {
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

console.log('ok jarvis voice runtime checks');
process.exit(0);
