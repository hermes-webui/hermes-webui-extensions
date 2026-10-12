/*
 * hermes-viz-store.js — window.HermesVizStore v1 (docs/INTERFACES.md §2). Owner: B (sigakhwa-bookmarks).
 *
 * Shared item store with two backends:
 *   local   — localStorage key 'hermes-viz-store:<namespace>' (per browser; never described as sync)
 *   sidecar — the WebUI sidecar proxy (default '/api/extensions/sigakhwa-bookmarks/sidecar') →
 *             GET  /v1/<ns>/items[?profile=&sessionId=&kind=]   GET/PUT/DELETE /v1/<ns>/items/<id>
 *             PATCH /v1/<ns>/items/<id>   GET /v1/<ns>/export   POST /v1/<ns>/import
 *
 * open(ns) probes GET <base>/health. Any non-2xx / network error → local backend, synced=false.
 * When the sidecar answers, items that exist only locally are imported ONE WAY (local → server) and
 * removed from the local copy once the server confirmed them, so a later server-side delete can never
 * be resurrected from a stale local copy. The server is preferred from then on (backend='sidecar').
 *
 * Honesty rules (README Storage and sync): `synced` is true ONLY when the sidecar answered AND nothing is
 * left behind in this browser. Items the server refused (413 store_full, 400 invalid, network error
 * mid-import) stay in localStorage, remain visible through list()/get() flagged `localOnly:true`, are
 * counted in `pendingLocal`, and are retried on the next open(). When /health answers but the data
 * routes fail, the store stays local and `syncError` {code,status,message} says why.
 *
 * Validation mirrors the sidecar (routes_impl.py): ids must match /^[A-Za-z0-9._:-]{1,128}$/ and an
 * item's size is measured as the sidecar SERVES it (ASCII-escaped JSON, 6 bytes per non-ASCII UTF-16
 * code unit) so a Korean item accepted here is never rejected there, and every proxied response fits
 * the WebUI proxy's 512 KiB buffer.
 *
 * Plain classic script, idempotent, never throws at load time.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var BUILD = 2026101301;
  var previous = window.HermesVizStore;
  if (previous && previous.build >= BUILD) {
    if (previous.build > BUILD) console.warn('[HermesVizStore] older helper ignored');
    return;
  }
  if (previous) console.warn('[HermesVizStore] replacing older helper; existing stores remain usable');

  var NS_RE = /^[a-z0-9-]{1,32}$/;
  var ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;   // same as routes_impl.py ID_RE (PUT → 400 'invalid id' otherwise)
  var LOCAL_PREFIX = 'hermes-viz-store:';
  var DEFAULT_BASE = '/api/extensions/sigakhwa-bookmarks/sidecar';
  var MAX_NAME = 500;
  var MAX_TAGS = 32;
  var MAX_TAG = 64;
  var MAX_STR = 256;
  var MAX_ITEM_BYTES = 256 * 1024;
  var MAX_ITEMS = 1000;
  var MAX_NAMESPACE_BYTES = 2 * 1024 * 1024;
  var PROBE_TIMEOUT_MS = 4000;
  var REQUEST_TIMEOUT_MS = 12000;

  var config = { sidecarProxyBase: DEFAULT_BASE };
  var stores = new Map();

  // ── helpers ──────────────────────────────────────────────────────────────
  function err(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
    return e;
  }

  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_) { /* fall through */ }
    var out = '';
    var hex = '0123456789abcdef';
    for (var i = 0; i < 32; i++) {
      var r = (Math.random() * 16) | 0;
      if (i === 12) out += '4';
      else if (i === 16) out += hex[(r & 0x3) | 0x8];
      else out += hex[r];
      if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
    }
    return out;
  }

  function clone(v) {
    if (v === undefined) return v;
    return JSON.parse(JSON.stringify(v));
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function str(v, max) {
    if (typeof v !== 'string') return null;
    if (v.length > max) return null;
    return v;
  }

  // Size of a JSON text as the sidecar serves it: Python json.dumps (ensure_ascii=True) writes every
  // code unit outside 0x20..0x7E as a 6-byte \uXXXX escape (JSON.stringify already turned < 0x20 into
  // ASCII escape sequences, so those count as-is). Single linear pass; both sides share MAX_ITEM_BYTES.
  function wireSize(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += (c < 0x20 || c > 0x7e) ? 6 : 1;
    }
    return n;
  }

  // Python json.dumps defaults include a space after every structural comma/colon.
  function measureItemBytes(item) {
    var text = JSON.stringify(item);
    var size = wireSize(text), quoted = false, escaped = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === ',' || c === ':') size++;
    }
    return size;
  }

  function sortNewest(a, b) {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  // Validate a stored/incoming item. Returns a normalized copy or null.
  function normalizeItem(raw, namespace, existing) {
    if (!isPlainObject(raw)) return null;
    var id = null;
    if (raw.id !== undefined && raw.id !== null) {
      // An id that is present must be acceptable to the sidecar too; never silently re-key it.
      if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
      id = raw.id;
    }
    var kind = str(raw.kind, 64);
    var profile = str(raw.profile, MAX_STR);
    var sessionId = str(raw.sessionId, MAX_STR);
    var role = raw.role;
    var messageIndex = raw.messageIndex;
    var name = str(raw.name === undefined ? '' : raw.name, MAX_NAME);
    if (!kind || !kind.trim() || !profile || !profile.trim() || !sessionId || !sessionId.trim()) return null;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof messageIndex !== 'number' || !Number.isSafeInteger(messageIndex) || messageIndex < 0) return null;
    if (name === null) return null;
    var data = raw.data === undefined ? {} : raw.data;
    if (!isPlainObject(data)) return null;
    var tags;
    if (raw.tags !== undefined) {
      if (!Array.isArray(raw.tags) || raw.tags.length > MAX_TAGS) return null;
      tags = [];
      for (var i = 0; i < raw.tags.length; i++) {
        var tg = str(raw.tags[i], MAX_TAG);
        if (tg === null) return null;
        tags.push(tg);
      }
    }
    var immutable = raw.immutable === true || (existing && existing.immutable === true);
    var contentHash = raw.contentHash === undefined ? undefined : str(raw.contentHash, 128);
    if (contentHash === null) return null;
    var now = Date.now();
    var createdAt = existing ? existing.createdAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : now);
    var out = {
      id: id || uuid(),
      namespace: namespace,
      kind: kind,
      createdAt: createdAt,
      updatedAt: now,
      profile: profile,
      sessionId: sessionId,
      messageIndex: messageIndex,
      role: role,
      name: name,
      data: clone(data),
    };
    if (tags) out.tags = tags;
    if (immutable) out.immutable = true;
    if (contentHash !== undefined) out.contentHash = contentHash;
    var size;
    try { size = measureItemBytes(out); } catch (_) { return null; }
    if (size > MAX_ITEM_BYTES) throw err('too_large', 'item exceeds 256 KiB');
    return out;
  }

  // Accept an already-persisted row (export/import/localStorage) without re-stamping timestamps.
  function acceptStoredItem(raw, namespace) {
    var n;
    try { n = normalizeItem(raw, namespace, null); } catch (_) { return null; }
    if (!n) return null;
    if (Number.isFinite(raw.createdAt)) n.createdAt = raw.createdAt;
    if (Number.isFinite(raw.updatedAt)) n.updatedAt = raw.updatedAt;
    return n;
  }

  function immutableConflict(existing, incoming) {
    if (!existing || existing.immutable !== true) return false;
    var sameData;
    try { sameData = JSON.stringify(existing.data) === JSON.stringify(incoming.data); } catch (_) { sameData = false; }
    var sameHash = (existing.contentHash || null) === (incoming.contentHash || null);
    return !(sameData && sameHash);
  }

  function matches(item, filter) {
    var f = filter || {};
    if (f.profile !== undefined && item.profile !== f.profile) return false;
    if (f.sessionId !== undefined && item.sessionId !== f.sessionId) return false;
    if (f.kind !== undefined && item.kind !== f.kind) return false;
    return true;
  }

  function exportEnvelope(namespace, rows) {
    return JSON.stringify({ v: 1, namespace: namespace, exportedAt: Date.now(), items: rows }, null, 2);
  }

  function parseImportText(text) {
    var parsed;
    try { parsed = JSON.parse(String(text)); } catch (_) { throw err('invalid', 'import text is not JSON'); }
    var rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    if (!rows) throw err('invalid', 'import payload has no items array');
    return rows;
  }

  // ── local backend ────────────────────────────────────────────────────────
  function localBackend(namespace) {
    var key = LOCAL_PREFIX + namespace;

    function storage() {
      try { return window.localStorage || null; } catch (_) { return null; }
    }

    function readAll() {
      var ls = storage();
      if (!ls) return new Map();
      var raw;
      try { raw = ls.getItem(key); } catch (_) { return new Map(); }
      if (!raw) return new Map();
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { return new Map(); }
      var rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
      var map = new Map();
      for (var i = 0; i < rows.length; i++) {
        var it = acceptStoredItem(rows[i], namespace);
        if (it) map.set(it.id, it);
      }
      return map;
    }

    function writeAll(map) {
      var ls = storage();
      if (!ls) throw err('storage', 'localStorage unavailable');
      var rows = Array.from(map.values());
      var text = JSON.stringify({ v: 1, namespace: namespace, items: rows });
      if (rows.length > MAX_ITEMS || measureItemBytes({ v: 1, namespace: namespace, items: rows }) > MAX_NAMESPACE_BYTES) {
        throw err('quota', 'namespace exceeds 1,000 items or 2 MiB');
      }
      try {
        if (!rows.length) ls.removeItem(key);
        else ls.setItem(key, text);
      } catch (e) {
        throw err(e && e.name === 'QuotaExceededError' ? 'quota' : 'storage', 'localStorage write failed', { cause: e && e.message });
      }
    }

    return {
      name: 'local',
      list: function (filter) {
        var out = [];
        readAll().forEach(function (it) { if (matches(it, filter)) out.push(it); });
        out.sort(sortNewest);
        return Promise.resolve(out.map(clone));
      },
      get: function (id) {
        var it = readAll().get(id);
        return Promise.resolve(it ? clone(it) : null);
      },
      put: function (item) {
        try {
          var map = readAll();
          var existing = typeof item.id === 'string' ? map.get(item.id) : null;
          var next = normalizeItem(item, namespace, existing || null);
          if (!next) return Promise.reject(err('invalid', 'invalid item'));
          if (immutableConflict(existing, next)) return Promise.reject(err('immutable', 'item is immutable'));
          map.set(next.id, next);
          writeAll(map);
          return Promise.resolve(clone(next));
        } catch (e) { return Promise.reject(e); }
      },
      patch: function (id, fields) {
        try {
          var map = readAll();
          var existing = map.get(id);
          if (!existing) return Promise.reject(err('not_found', 'item not found'));
          var next = clone(existing);
          if (fields && typeof fields.name === 'string') {
            if (fields.name.length > MAX_NAME) return Promise.reject(err('invalid', 'name too long'));
            next.name = fields.name;
          }
          if (fields && Array.isArray(fields.tags)) {
            if (fields.tags.length > MAX_TAGS) return Promise.reject(err('invalid', 'too many tags'));
            var tags = [];
            for (var i = 0; i < fields.tags.length; i++) {
              var tg = str(fields.tags[i], MAX_TAG);
              if (tg === null) return Promise.reject(err('invalid', 'bad tag'));
              tags.push(tg);
            }
            next.tags = tags;
          }
          next.updatedAt = Date.now();
          next = normalizeItem(next, namespace, existing);
          if (!next) return Promise.reject(err('invalid', 'invalid patched item'));
          map.set(id, next);
          writeAll(map);
          return Promise.resolve(clone(next));
        } catch (e) { return Promise.reject(e); }
      },
      remove: function (id) {
        try {
          var map = readAll();
          var ok = map.delete(id);
          if (ok) writeAll(map);
          return Promise.resolve(ok);
        } catch (e) { return Promise.reject(e); }
      },
      exportJson: function () {
        var rows = Array.from(readAll().values()).sort(sortNewest);
        return Promise.resolve(exportEnvelope(namespace, rows));
      },
      importJson: function (text, opts) {
        try {
          var merge = !opts || opts.merge !== false;
          var rows = parseImportText(text);
          var map = merge ? readAll() : new Map();
          var added = 0, skipped = 0;
          for (var i = 0; i < rows.length; i++) {
            var it = acceptStoredItem(rows[i], namespace);
            if (!it || map.has(it.id)) { skipped++; continue; }
            map.set(it.id, it);
            added++;
          }
          writeAll(map);
          return Promise.resolve({ added: added, skipped: skipped });
        } catch (e) { return Promise.reject(e); }
      },
      // internal: raw map access for the one-way import to the sidecar
      _readAll: readAll,
      _writeAll: writeAll,
    };
  }

  // ── sidecar backend ──────────────────────────────────────────────────────
  function sidecarBackend(namespace, base) {
    var requestCount = 0;
    var root = base + '/v1/' + encodeURIComponent(namespace);

    function request(method, path, body, timeoutMs) {
      requestCount++;
      var fetchFn = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
      if (!fetchFn) return Promise.reject(err('network', 'fetch unavailable'));
      var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      var controller = null;
      var timer = null;
      try {
        if (typeof AbortController !== 'undefined') {
          controller = new AbortController();
          opts.signal = controller.signal;
          timer = setTimeout(function () { try { controller.abort(); } catch (_) { /* ignore */ } }, timeoutMs || REQUEST_TIMEOUT_MS);
        }
      } catch (_) { controller = null; }
      return fetchFn(path, opts).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (text) {
          var json = null;
          if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
          return { status: res.status, ok: res.status >= 200 && res.status < 300, json: json, text: text };
        });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        throw err('network', 'sidecar request failed', { cause: e && e.message });
      });
    }

    function fail(res, fallbackCode) {
      var code = fallbackCode || 'server';
      if (res.status === 409 && res.json && res.json.error === 'immutable') code = 'immutable';
      else if (res.status === 404) code = 'not_found';
      else if (res.status === 400) code = 'invalid';
      else if (res.status === 413) code = res.json && res.json.error === 'too_large' ? 'too_large' : 'quota';
      else if (res.status === 401 || res.status === 403) code = 'unauthorized';
      var e = err(code, (res.json && res.json.error) || ('sidecar responded ' + res.status), { status: res.status });
      return Promise.reject(e);
    }

    function qs(filter) {
      var f = filter || {};
      var parts = [];
      if (f.profile !== undefined) parts.push('profile=' + encodeURIComponent(String(f.profile)));
      if (f.sessionId !== undefined) parts.push('sessionId=' + encodeURIComponent(String(f.sessionId)));
      if (f.kind !== undefined) parts.push('kind=' + encodeURIComponent(String(f.kind)));
      return parts.length ? '?' + parts.join('&') : '';
    }

    function listAll(filter) {
      // The server pages at 500 newest / ~400 KiB per response; follow nextOffset.
      var out = [];
      function page(offset) {
        var q = qs(filter);
        q += (q ? '&' : '?') + 'offset=' + offset;
        return request('GET', root + '/items' + q).then(function (res) {
          if (!res.ok || !res.json || !Array.isArray(res.json.items)) return fail(res);
          for (var i = 0; i < res.json.items.length; i++) {
            var it = acceptStoredItem(res.json.items[i], namespace);
            if (it) out.push(it);
          }
          var next = res.json.nextOffset;
          if (Number.isSafeInteger(next) && next > offset && out.length < 20000) return page(next);
          out.sort(sortNewest);
          return out;
        });
      }
      return page(0);
    }

    return {
      name: 'sidecar',
      _requestCount: function () { return requestCount; },
      probe: function () {
        return request('GET', base + '/health', undefined, PROBE_TIMEOUT_MS).then(function (res) { return res.ok; }, function () { return false; });
      },
      list: function (filter) { return listAll(filter).then(function (rows) { return rows.map(clone); }); },
      get: function (id) {
        return request('GET', root + '/items/' + encodeURIComponent(id)).then(function (res) {
          if (res.status === 404) return null;
          if (!res.ok) return fail(res);
          return acceptStoredItem(res.json, namespace);
        });
      },
      put: function (item) {
        var probe;
        try { probe = normalizeItem(item, namespace, null); } catch (e) { return Promise.reject(e); }
        if (!probe) return Promise.reject(err('invalid', 'invalid item'));
        var payload = clone(item);
        payload.id = probe.id;
        payload.namespace = namespace;
        return request('PUT', root + '/items/' + encodeURIComponent(probe.id), payload).then(function (res) {
          if (!res.ok) return fail(res);
          var stored = acceptStoredItem(res.json, namespace);
          if (!stored) return Promise.reject(err('server', 'sidecar returned an invalid item'));
          return stored;
        });
      },
      patch: function (id, fields) {
        var body = {};
        if (fields && typeof fields.name === 'string') body.name = fields.name;
        if (fields && Array.isArray(fields.tags)) body.tags = fields.tags;
        return request('PATCH', root + '/items/' + encodeURIComponent(id), body).then(function (res) {
          if (!res.ok) return fail(res);
          var stored = acceptStoredItem(res.json, namespace);
          if (!stored) return Promise.reject(err('server', 'sidecar returned an invalid item'));
          return stored;
        });
      },
      remove: function (id) {
        return request('DELETE', root + '/items/' + encodeURIComponent(id)).then(function (res) {
          if (res.status === 404) return false;
          if (!res.ok) return fail(res);
          return !!(res.json && res.json.removed !== false);
        });
      },
      exportRows: function () {
        var rows = [];
        function page(offset) {
          return request('GET', root + '/export?offset=' + offset).then(function (res) {
            if (!res.ok || !res.json || !Array.isArray(res.json.items)) return fail(res);
            for (var i = 0; i < res.json.items.length; i++) rows.push(res.json.items[i]);
            var next = res.json.nextOffset;
            if (Number.isSafeInteger(next) && next > offset && rows.length < 20000) return page(next);
            return rows;
          });
        }
        return page(0);
      },
      exportJson: function () {
        return this.exportRows().then(function (rows) { return exportEnvelope(namespace, rows); });
      },
      importJson: function (text, opts) {
        var merge = !opts || opts.merge !== false;
        var rows;
        try { rows = parseImportText(text); } catch (e) { return Promise.reject(e); }
        return request('POST', root + '/import?merge=' + (merge ? '1' : '0'), { v: 1, items: rows }).then(function (res) {
          if (!res.ok || !res.json) return fail(res);
          return { added: Number(res.json.added) || 0, skipped: Number(res.json.skipped) || 0 };
        });
      },
    };
  }

  // ── Store ────────────────────────────────────────────────────────────────
  function createStore(namespace) {
    var local = localBackend(namespace);
    var remote = sidecarBackend(namespace, config.sidecarProxyBase);
    var active = local;
    var subs = new Set();
    var store = {};

    function emit(ev) {
      var frozen = Object.freeze(Object.assign({}, ev));
      subs.forEach(function (cb) {
        try { cb(frozen); } catch (e) {
          try { console.error('[HermesVizStore] subscriber failed:', e); } catch (_) { /* ignore */ }
        }
      });
    }

    // While the sidecar is active, whatever is still in localStorage is a leftover the server refused.
    function leftovers() { return local._readAll(); }
    function markLocalOnly(it) { var c = clone(it); c.localOnly = true; return c; }
    function syncFlags() {
      var n = active === hybrid ? leftovers().size : 0;
      store.pendingLocal = n;
      store.synced = active === hybrid && n === 0 && !store.syncError;
    }

    // Sidecar backend + leftovers kept visible and editable: reads merge the two (leftovers flagged
    // localOnly), metadata edits / removes of a leftover stay local, and a successful remote put of
    // the same id retires the local copy. New items always go to the server.
    var hybrid = {
      name: 'sidecar',
      list: function (filter) {
        return remote.list(filter).then(function (rows) {
          var lo = leftovers();
          if (!lo.size) return rows;
          var ids = new Set(rows.map(function (r) { return r.id; }));
          lo.forEach(function (it) { if (!ids.has(it.id) && matches(it, filter)) rows.push(markLocalOnly(it)); });
          rows.sort(sortNewest);
          return rows;
        });
      },
      get: function (id) {
        return remote.get(id).then(function (it) {
          if (it) return it;
          var lo = leftovers().get(id);
          return lo ? markLocalOnly(lo) : null;
        });
      },
      put: function (item) {
        return remote.put(item).then(function (saved) {
          var lo = leftovers();
          if (lo.has(saved.id)) {
            lo.delete(saved.id);
            try { local._writeAll(lo); } catch (_) { /* non-fatal: retried on next open() */ }
            syncFlags();
          }
          return saved;
        });
      },
      patch: function (id, fields) {
        if (leftovers().has(id)) return local.patch(id, fields).then(markLocalOnly);
        return remote.patch(id, fields);
      },
      remove: function (id) {
        return remote.remove(id).then(function (ok) {
          if (!leftovers().has(id)) return ok;
          return local.remove(id).then(function (ok2) { syncFlags(); return ok || ok2; });
        });
      },
      exportJson: function () {
        return remote.exportRows().then(function (rows) {
          var lo = leftovers();
          if (lo.size) {
            var ids = new Set(rows.map(function (r) { return r && r.id; }));
            lo.forEach(function (it) { if (!ids.has(it.id)) rows.push(markLocalOnly(it)); });
          }
          return exportEnvelope(namespace, rows);
        });
      },
      importJson: function (text, opts) { return remote.importJson(text, opts); },
    };

    // One-way import: local items the server does not have → PUT to server; drop the local copy
    // only after the server confirmed, so nothing is lost on partial failure. Resolves
    // {migrated, leftover}; leftovers stay in localStorage (visible as localOnly, retried next open).
    function importLocalToServer() {
      var localMap = local._readAll();
      // Always touch the data route once: /health alone does not prove the proxied data path works.
      return remote.list().then(function (serverRows) {
        if (!localMap.size) return { migrated: 0, leftover: 0 };
        var onServer = new Set(serverRows.map(function (r) { return r.id; }));
        var pending = [];
        localMap.forEach(function (it) { if (!onServer.has(it.id)) pending.push(it); });
        var migrated = [];
        var failed = 0;
        var chain = Promise.resolve();
        pending.forEach(function (it) {
          chain = chain.then(function () {
            return remote.put(it).then(function () { migrated.push(it.id); }, function (e) {
              failed++;
              try { console.warn('[HermesVizStore] ' + namespace + ': item ' + it.id + ' stays in this browser only (' + ((e && e.code) || 'error') + (e && e.status ? ' ' + e.status : '') + ')'); } catch (_) { /* ignore */ }
            });
          });
        });
        return chain.then(function () {
          // Items already on the server (same id) are also redundant locally.
          localMap.forEach(function (it) { if (onServer.has(it.id)) migrated.push(it.id); });
          if (migrated.length) {
            var current = local._readAll();
            migrated.forEach(function (id) {
              if (JSON.stringify(current.get(id)) === JSON.stringify(localMap.get(id))) current.delete(id);
            });
            try { local._writeAll(current); } catch (_) { /* non-fatal */ }
          }
          return { migrated: migrated.length, leftover: failed };
        });
      });
    }

    var ready = remote.probe().then(function (ok) {
      if (!ok) return;
      return importLocalToServer().then(function () {
        active = hybrid;
        store.backend = 'sidecar';
        store.syncError = null;
        syncFlags();
        emit({ type: 'reload' });
      }, function (e) {
        // Health answered but the data routes did not: stay local, keep synced=false, and say why
        // (e.g. 502 from the proxy) instead of failing silently.
        store.syncError = { code: (e && e.code) || 'server', status: (e && e.status) || null, message: (e && e.message) || '' };
      });
    }).catch(function () { /* stay local */ });

    function run(fn) {
      var before;
      return ready.then(function () { before = remote._requestCount(); return fn(active); }).then(function (value) {
        if (active === hybrid && store.syncError && remote._requestCount() > before) { store.syncError = null; syncFlags(); emit({ type: 'status' }); }
        return value;
      }, function (e) {
        if (active === hybrid && (!e || ['network', 'server', 'unauthorized'].indexOf(e.code) >= 0)) {
          var changed = !store.syncError || store.syncError.code !== ((e && e.code) || 'server') || store.syncError.status !== ((e && e.status) || null);
          store.syncError = { code: (e && e.code) || 'server', status: (e && e.status) || null };
          syncFlags();
          if (changed) emit({ type: 'status' });
        }
        throw e;
      });
    }

    store.namespace = namespace;
    store.backend = 'local';
    store.synced = false;
    store.pendingLocal = 0;   // leftovers the sidecar refused (0 unless backend === 'sidecar')
    store.syncError = null;   // {code,status,message} when /health answered but data routes failed
    store.ready = ready;
    store.list = function (filter) { return run(function (b) { return b.list(filter); }); };
    store.get = function (id) {
      if (typeof id !== 'string' || !id) return Promise.resolve(null);
      return run(function (b) { return b.get(id); });
    };
    store.put = function (item) {
      return run(function (b) { return b.put(item); }).then(function (saved) {
        emit({ type: 'put', id: saved.id });
        return saved;
      });
    };
    store.patch = function (id, fields) {
      if (typeof id !== 'string' || !id) return Promise.reject(err('not_found', 'item not found'));
      return run(function (b) { return b.patch(id, fields || {}); }).then(function (saved) {
        emit({ type: 'put', id: saved.id });
        return saved;
      });
    };
    store.remove = function (id) {
      if (typeof id !== 'string' || !id) return Promise.resolve(false);
      return run(function (b) { return b.remove(id); }).then(function (ok) {
        if (ok) emit({ type: 'remove', id: id });
        return ok;
      });
    };
    store.subscribe = function (cb) {
      if (typeof cb !== 'function') return function () { return false; };
      subs.add(cb);
      var on = true;
      return function unsubscribe() {
        if (!on) return false;
        on = false;
        subs.delete(cb);
        return true;
      };
    };
    store.exportJson = function () { return run(function (b) { return b.exportJson(); }); };
    store.importJson = function (text, opts) {
      return run(function (b) { return b.importJson(text, opts); }).then(function (r) {
        emit({ type: 'reload' });
        return r;
      });
    };
    return store;
  }

  var api = {
    version: 1,
    build: BUILD,
    measureItemBytes: measureItemBytes,
    configure: function (opts) {
      if (opts && typeof opts.sidecarProxyBase === 'string' && opts.sidecarProxyBase.charAt(0) === '/') {
        config.sidecarProxyBase = opts.sidecarProxyBase.replace(/\/+$/, '');
      }
      return Object.assign({}, config);
    },
    open: function (namespace) {
      if (typeof namespace !== 'string' || !NS_RE.test(namespace)) throw err('invalid', 'invalid namespace');
      var existing = stores.get(namespace);
      if (existing) return existing;
      var s = createStore(namespace);
      stores.set(namespace, s);
      return s;
    },
    // test-only: forget cached stores (not part of the contract)
    _resetForTests: function () { stores.clear(); },
  };
  Object.defineProperty(api, 'version', { value: 1, writable: false, enumerable: true });
  window.HermesVizStore = api;
})();
