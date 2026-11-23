'use strict';
// Shared test helpers: fake localStorage, a fake in-memory sidecar reachable through a fake fetch,
// and loaders that eval the classic scripts exactly like upstream tests/test_extension_message_actions.py.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  store: path.join(ROOT, 'extensions', 'sigakhwa-bookmarks', 'assets', 'shared', 'hermes-viz-store.js'),
  nav: path.join(ROOT, 'extensions', 'sigakhwa-bookmarks', 'assets', 'shared', 'hermes-viz-nav.js'),
  ext: path.join(ROOT, 'extensions', 'sigakhwa-bookmarks', 'assets', 'sigakhwa-bookmarks.js'),
};

function fakeLocalStorage(opts) {
  const map = new Map();
  const o = opts || {};
  return {
    _map: map,
    failWrites: !!o.failWrites,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (this.failWrites) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    key(i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; },
  };
}

// Minimal in-memory sidecar that mirrors routes_impl.py semantics.
// opts: healthy/healthStatus, pageSize, base, listStatus (force GET /items to fail with this status),
//       putStatus(id, body) → non-2xx status to force a PUT rejection (e.g. 413 store_full), else null.
const SIDECAR_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function fakeSidecar(opts) {
  const o = opts || {};
  const base = o.base || '/api/extensions/sigakhwa-bookmarks/sidecar';
  const state = { healthy: o.healthy !== false, healthStatus: o.healthStatus || (o.healthy === false ? 503 : 200), ns: new Map(), calls: [] };
  function nsMap(ns) { if (!state.ns.has(ns)) state.ns.set(ns, new Map()); return state.ns.get(ns); }
  function json(status, body) {
    return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve(JSON.stringify(body)) };
  }
  async function fetch(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    state.calls.push({ method, url, init });
    if (!url.startsWith(base + '/')) return json(404, { error: 'not proxied' });
    const rest = url.slice(base.length);
    const [pathname, query = ''] = rest.split('?');
    const q = new URLSearchParams(query);
    if (pathname === '/health') {
      if (!state.healthy) return json(state.healthStatus, { error: 'unavailable' });
      return json(200, { ok: true, sidecar_base_version: 2 });
    }
    const m = /^\/v1\/([a-z0-9-]{1,32})\/(items|export|import)(?:\/([^/]+))?$/.exec(pathname);
    if (!m) return json(404, { error: 'not found' });
    const ns = m[1]; const kind = m[2]; const id = m[3] ? decodeURIComponent(m[3]) : null;
    const items = nsMap(ns);
    const body = init && init.body ? JSON.parse(init.body) : null;
    const sorted = () => Array.from(items.values()).sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    if (kind === 'items' && !id && method === 'GET') {
      if (o.listStatus) return json(o.listStatus, { error: 'forced failure' });
      let rows = sorted();
      for (const f of ['profile', 'sessionId', 'kind']) if (q.has(f)) rows = rows.filter((r) => r[f] === q.get(f));
      const offset = Number(q.get('offset') || 0);
      const pageSize = o.pageSize || 500;
      const page = rows.slice(offset, offset + pageSize);
      const out = { items: page, total: rows.length, truncated: offset + page.length < rows.length };
      if (out.truncated) out.nextOffset = offset + page.length;
      return json(200, out);
    }
    if (kind === 'items' && id && method === 'GET') {
      return items.has(id) ? json(200, items.get(id)) : json(404, { error: 'not found' });
    }
    if (kind === 'items' && id && method === 'PUT') {
      if (!SIDECAR_ID_RE.test(id)) return json(400, { error: 'invalid id' });
      const forced = typeof o.putStatus === 'function' ? o.putStatus(id, body) : null;
      if (forced) return json(forced, { error: forced === 413 ? 'store_full' : 'rejected' });
      const existing = items.get(id);
      if (existing && q.get('createOnly') === '1') return json(409, { error: 'conflict' });
      if (existing && existing.immutable) {
        const same = JSON.stringify(existing.data) === JSON.stringify(body.data) && (existing.contentHash || null) === (body.contentHash || null);
        if (!same) return json(409, { error: 'immutable' });
      }
      const now = Date.now();
      const next = Object.assign({}, body, { id, namespace: ns, createdAt: existing ? existing.createdAt : (body.createdAt || now), updatedAt: q.get('createOnly') === '1' ? (body.updatedAt ?? now) : now });
      if (existing && existing.immutable) next.immutable = true;
      items.set(id, next);
      return json(200, next);
    }
    if (kind === 'items' && id && method === 'PATCH') {
      const existing = items.get(id);
      if (!existing) return json(404, { error: 'not found' });
      const next = Object.assign({}, existing);
      if (typeof body.name === 'string') next.name = body.name;
      if (Array.isArray(body.tags)) next.tags = body.tags;
      next.updatedAt = Date.now();
      items.set(id, next);
      return json(200, next);
    }
    if (kind === 'items' && id && method === 'DELETE') {
      if (!items.has(id)) return json(404, { error: 'not found' });
      if (q.get('ifUnchanged') === '1' && JSON.stringify(items.get(id)) !== JSON.stringify(body)) return json(409, { error: 'conflict' });
      items.delete(id);
      return json(200, { removed: true });
    }
    if (kind === 'export' && method === 'GET') {
      const rows = sorted();
      const offset = Number(q.get('offset') || 0);
      const pageSize = o.pageSize || 500;
      const page = rows.slice(offset, offset + pageSize);
      const out = { v: 1, namespace: ns, items: page, total: rows.length };
      if (offset + page.length < rows.length) out.nextOffset = offset + page.length;
      return json(200, out);
    }
    if (kind === 'import' && method === 'POST') {
      const merge = q.get('merge') !== '0';
      if (!merge) items.clear();
      let added = 0; let skipped = 0;
      for (const row of (body && body.items) || []) {
        if (!row || typeof row.id !== 'string' || items.has(row.id)) { skipped++; continue; }
        items.set(row.id, Object.assign({}, row, { namespace: ns }));
        added++;
      }
      return json(200, { added, skipped });
    }
    return json(405, { error: 'method not allowed' });
  }
  return { state, fetch, base };
}

// Build a fresh fake window and eval the given classic scripts into a fresh global context.
// We use a new vm context per test so module-level idempotency guards do not leak between tests.
import vm from 'node:vm';
function loadScripts(names, win) {
  const context = { window: win, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, Number, String, Object, Array, Map, Set, Error, TextEncoder, AbortController, URLSearchParams, crypto: globalThis.crypto };
  // Core globals for nav tests are exposed both as bare identifiers and on window.
  for (const k of Object.keys(win)) if (!(k in context)) context[k] = win[k];
  const ctx = vm.createContext(context);
  for (const name of names) {
    const file = FILES[name] || name;
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
  }
  return ctx;
}

// Values created inside a vm context carry that realm's prototypes; normalize before deep-equality.
function plain(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

function tick(ms) { return new Promise((r) => setTimeout(r, ms || 0)); }

export { ROOT, FILES, fakeLocalStorage, fakeSidecar, loadScripts, tick, plain };
