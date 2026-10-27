// Behavior test for extensions/xtts-tts: the engine registers, speaks the
// documented request shape, and fails closed on every path that could hand core
// silence, credentials, or off-box traffic.
//
// Runs the extension source in a vm context with a stub `window`, and drives
// synthesize() against a real loopback HTTP server, so the fetch path
// (headers, body, redirect/credentials policy) is exercised, not simulated.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as vm from 'node:vm';

const SOURCE = await readFile(
  new URL('../extensions/xtts-tts/assets/xtts-tts.js', import.meta.url),
  'utf8',
);
const WEBUI_ORIGIN = 'http://127.0.0.1:8787';

function wavBytes(frames = 240) {
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(24000 * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 2, 40);
  return buffer;
}

// ── Loopback stand-in for the daemon ────────────────────────────────────────
const seen = [];
let route = 'wav';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const cors = { 'Access-Control-Allow-Origin': WEBUI_ORIGIN };
    if (route === 'wav') {
      const wav = wavBytes();
      res.writeHead(200, { ...cors, 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      res.end(wav);
      return;
    }
    if (route === 'nonwav') {
      const payload = Buffer.from('{"ok":true}', 'utf8');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Content-Length': payload.length });
      res.end(payload);
      return;
    }
    if (route === 'error') {
      const payload = Buffer.from('model exploded', 'utf8');
      res.writeHead(500, { ...cors, 'Content-Length': payload.length });
      res.end(payload);
      return;
    }
    if (route === 'redirect') {
      res.writeHead(302, { ...cors, Location: 'http://example.invalid/' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const DAEMON = `http://127.0.0.1:${port}/`;

// ── Harness ────────────────────────────────────────────────────────────────
function harness({ settings = {}, locationOrigin = WEBUI_ORIGIN, fakeSetTimeout = null } = {}) {
  const store = new Map(Object.entries({
    enabled: true,
    daemon_url: DAEMON,
    speaker: 'Viktor Menelaos',
    language: 'auto',
    ...settings,
  }));
  const registrations = [];
  const calls = [];
  const timers = [];
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URL,
    Uint8Array,
    AbortController,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return globalThis.fetch(url, init);
    },
    setTimeout: fakeSetTimeout
      ? (fn) => { fakeSetTimeout(fn); return 1; }
      : (fn, ms) => { const timer = setTimeout(fn, ms); timers.push(timer); return timer; },
    clearTimeout: (timer) => clearTimeout(timer),
  };
  sandbox.window = {
    location: { origin: locationOrigin },
    addEventListener() {},
    hermesExt: {
      register(id) {
        return { id, settings: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) } };
      },
    },
    registerHermesTtsEngine(engine) {
      registrations.push(engine);
      return true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'xtts-tts.js' });
  return { sandbox, store, calls, timers, engine: registrations[0], api: sandbox.window.HermesXttsTtsExtension };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Registration ───────────────────────────────────────────────────────────
test('registers engine id "xtts" with a synthesize function', async () => {
  const { engine } = harness();
  assert.equal(engine.id, 'xtts');
  assert.equal(typeof engine.synthesize, 'function');
  assert.match(engine.label, /XTTS/);
});

test('no-ops without a warning-free crash when the core seam is missing', async () => {
  const { sandbox } = harness();
  assert.equal(typeof sandbox.window.HermesXttsTtsExtension, 'object');
  const legacy = { console: { warn() {} }, URL, Uint8Array, AbortController, fetch: async () => { throw new Error('unused'); }, setTimeout, clearTimeout };
  legacy.window = { location: { origin: WEBUI_ORIGIN }, addEventListener() {} };
  vm.createContext(legacy);
  vm.runInContext(SOURCE, legacy, { filename: 'xtts-tts.js' });
  assert.equal(legacy.window.HermesXttsTtsExtension.engineId, 'xtts');
});

// ── Happy path ─────────────────────────────────────────────────────────────
test('POSTs the documented JSON body and returns the WAV bytes', async () => {
  route = 'wav';
  seen.length = 0;
  const { engine, calls } = harness();
  const buffer = await engine.synthesize('Привет, сэр. Как дела?');

  const wav = Buffer.from(buffer);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.ok(wav.length > 44);

  assert.equal(seen.length, 1);
  const request = seen[0];
  assert.equal(request.method, 'POST');
  assert.match(request.headers['content-type'], /^application\/json/);
  const payload = JSON.parse(request.body);
  assert.deepEqual(Object.keys(payload).sort(), ['language', 'speaker', 'text']);
  assert.equal(payload.text, 'Привет, сэр. Как дела?');
  assert.equal(payload.language, 'ru', 'Cyrillic text must default to ru');
  assert.equal(payload.speaker, 'Viktor Menelaos');

  const init = calls[0].init;
  assert.equal(init.credentials, 'omit', 'must never send WebUI cookies to the daemon');
  assert.equal(init.redirect, 'error', 'must not follow a redirect off loopback');
  assert.ok(init.signal, 'a deadline signal must cover the request');
  assert.equal(init.method, 'POST');
});

test('language setting overrides script detection', async () => {
  route = 'wav';
  seen.length = 0;
  const { engine } = harness({ settings: { language: 'fr' } });
  await engine.synthesize('Привет');
  assert.equal(JSON.parse(seen[0].body).language, 'fr');
});

test('non-Cyrillic text defaults to en', async () => {
  route = 'wav';
  seen.length = 0;
  const { engine } = harness();
  await engine.synthesize('Hello there');
  assert.equal(JSON.parse(seen[0].body).language, 'en');
});

// ── Fail-closed paths ──────────────────────────────────────────────────────
test('rejects a non-WAV body instead of handing core silence', async () => {
  route = 'nonwav';
  const { engine } = harness();
  await assert.rejects(() => engine.synthesize('hello'), /non-WAV/);
});

test('surfaces the daemon HTTP status and its detail', async () => {
  route = 'error';
  const { engine } = harness();
  await assert.rejects(() => engine.synthesize('hello'), /HTTP 500: model exploded/);
});

test('rejects a redirect instead of following it', async () => {
  route = 'redirect';
  const { engine } = harness();
  await assert.rejects(() => engine.synthesize('hello'), /unreachable|Failed to fetch|redirect/i);
});

test('refuses a daemon_url on the WebUI origin, even via the default', async () => {
  let fetched = 0;
  const { sandbox } = harness();
  sandbox.fetch = async () => { fetched += 1; throw new Error('must not be called'); };
  // daemon_url pointing at the WebUI's own origin: no cookie-bearing POST, ever.
  const probe = harness({ settings: { daemon_url: `${WEBUI_ORIGIN}/` } });
  await assert.rejects(() => probe.engine.synthesize('hello'), /WebUI origin/);
  assert.equal(probe.calls.length, 0, 'no request may leave for the WebUI origin');
  assert.equal(fetched, 0);
});

test('refuses the fallback when the WebUI itself runs on the default daemon port', async () => {
  // An invalid daemon_url falls back to http://127.0.0.1:8120/ (the default);
  // if WebUI itself is served from that origin the engine must refuse.
  const { engine } = harness({ settings: { daemon_url: 'ftp://nope/' }, locationOrigin: 'http://127.0.0.1:8120' });
  await assert.rejects(() => engine.synthesize('hello'), /WebUI origin/);
});

test('ignores a non-loopback or IPv6 daemon_url and falls back to loopback', async () => {
  const remote = harness({ settings: { daemon_url: 'http://example.com:8120/' } });
  assert.equal(remote.api.daemonUrl(), 'http://127.0.0.1:8120/', 'non-loopback falls back to the default');
  const ipv6 = harness({ settings: { daemon_url: 'http://[::1]:8120/' } });
  assert.equal(ipv6.api.daemonUrl().includes('[::1]'), false, 'CSP does not allow [::1]');
});

test('rejects empty text and a disabled engine before any request', async () => {
  route = 'wav';
  seen.length = 0;
  const { engine } = harness();
  await assert.rejects(() => engine.synthesize('   '), /empty text/);
  const disabled = harness({ settings: { enabled: false } });
  await assert.rejects(() => disabled.engine.synthesize('hello'), /disabled/);
  assert.equal(seen.length, 0);
});

test('a stalled daemon hits the deadline instead of hanging voice mode', async () => {
  // Fire the timeout callback immediately: the abort must surface as a timeout.
  const { engine } = harness({ fakeSetTimeout: (fn) => { void Promise.resolve().then(fn); } });
  await assert.rejects(() => engine.synthesize('hello'), /did not answer within 120 s/);
});

// ── Runner ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${name}`);
    console.error(String(error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error));
  }
}
server.close();
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
