'use strict';
// node --test — HermesVizStore v1 contract, local + sidecar backends with a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeLocalStorage, fakeSidecar, loadScripts, tick, plain } from './sigakhwa-bookmarks-test-helpers.mjs';
const deepEqual = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

function baseItem(over) {
  return Object.assign({
    kind: 'bookmark', profile: 'default', sessionId: 'sess-1', messageIndex: 3, role: 'assistant',
    name: '첫 북마크', data: { preview: 'hello' },
  }, over || {});
}

function makeLocalWorld(lsOpts) {
  const ls = fakeLocalStorage(lsOpts);
  const sidecar = fakeSidecar({ healthy: false, healthStatus: 403 });
  const win = { localStorage: ls, fetch: sidecar.fetch };
  const ctx = loadScripts(['store'], win);
  return { ls, sidecar, win, Store: ctx.window.HermesVizStore };
}

test('module shape, idempotent guard, namespace validation', () => {
  const { win, Store } = makeLocalWorld();
  assert.equal(Store.version, 1);
  assert.equal(typeof Store.open, 'function');
  assert.equal(typeof Store.configure, 'function');
  const before = win.HermesVizStore;
  loadScripts(['store'], win); // second eval into another context would create a new object; emulate re-injection here
  assert.equal(win.HermesVizStore, before, 'first registration wins');
  assert.throws(() => Store.open('Bad_NS'), /invalid namespace/);
  assert.throws(() => Store.open(''), /invalid namespace/);
  assert.throws(() => Store.open('a'.repeat(33)), /invalid namespace/);
  const s = Store.open('bookmarks');
  assert.equal(Store.open('bookmarks'), s, 'open() is memoized per namespace');
  assert.equal(s.namespace, 'bookmarks');
  assert.equal(s.backend, 'local');
  assert.equal(s.synced, false);
});

test('local backend: put/get/list/patch/remove + createdAt desc + persisted key', async () => {
  const { ls, Store } = makeLocalWorld();
  const s = Store.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'local');
  assert.equal(s.synced, false);
  const events = [];
  const unsub = s.subscribe((e) => events.push(e));

  const a = await s.put(baseItem({ name: 'A', createdAt: 1000 }));
  assert.ok(a.id && typeof a.id === 'string');
  assert.equal(a.namespace, 'bookmarks');
  assert.equal(a.createdAt, 1000);
  assert.ok(a.updatedAt >= 1000);
  const b = await s.put(baseItem({ name: 'B', createdAt: 2000, messageIndex: 7, role: 'user' }));
  const c = await s.put(baseItem({ name: 'C', createdAt: 3000, profile: 'work', sessionId: 'sess-2' }));

  assert.ok(ls.getItem('hermes-viz-store:bookmarks'), 'persisted under the documented key');
  const parsed = JSON.parse(ls.getItem('hermes-viz-store:bookmarks'));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.items.length, 3);

  const all = await s.list();
  deepEqual(all.map((i) => i.name), ['C', 'B', 'A'], 'createdAt desc');
  deepEqual((await s.list({ profile: 'work' })).map((i) => i.id), [c.id]);
  deepEqual((await s.list({ sessionId: 'sess-1' })).map((i) => i.name), ['B', 'A']);
  deepEqual((await s.list({ kind: 'card' })), []);

  assert.equal((await s.get(a.id)).name, 'A');
  assert.equal(await s.get('nope'), null);

  const patched = await s.patch(b.id, { name: 'B2', tags: ['x'] });
  assert.equal(patched.name, 'B2');
  deepEqual(patched.tags, ['x']);
  await assert.rejects(s.patch('nope', { name: 'z' }), (e) => e.code === 'not_found');

  assert.equal(await s.remove(a.id), true);
  assert.equal(await s.remove(a.id), false);
  assert.equal((await s.list()).length, 2);

  deepEqual(events.map((e) => e.type), ['put', 'put', 'put', 'put', 'remove']);
  assert.ok(Object.isFrozen(events[0]));
  assert.equal(unsub(), true);
  assert.equal(unsub(), false);
  await s.remove(b.id);
  assert.equal(events.length, 5, 'unsubscribed listener receives nothing');
});

test('local backend: reload sees persisted items; malformed JSON is tolerated', async () => {
  const ls = fakeLocalStorage();
  ls.setItem('hermes-viz-store:bookmarks', '{not json');
  let world = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch });
  let s = world.window.HermesVizStore.open('bookmarks');
  deepEqual(await s.list(), [], 'malformed JSON → empty, no throw');
  const saved = await s.put(baseItem({ name: 'persist me' }));
  // "reload the page": fresh context, same localStorage
  world = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch });
  s = world.window.HermesVizStore.open('bookmarks');
  const rows = await s.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, saved.id);
  assert.equal(rows[0].name, 'persist me');
  // garbage rows inside a valid envelope are skipped
  ls.setItem('hermes-viz-store:bookmarks', JSON.stringify({ v: 1, items: [null, 5, { id: 'x' }, rows[0]] }));
  world = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch });
  s = world.window.HermesVizStore.open('bookmarks');
  assert.equal((await s.list()).length, 1);
});

test('local backend: quota errors reject with code quota; invalid items reject with code invalid', async () => {
  const { ls, Store } = makeLocalWorld();
  const s = Store.open('bookmarks');
  await assert.rejects(s.put({ kind: 'bookmark' }), (e) => e.code === 'invalid');
  await assert.rejects(s.put(baseItem({ role: 'tool' })), (e) => e.code === 'invalid');
  await assert.rejects(s.put(baseItem({ messageIndex: -1 })), (e) => e.code === 'invalid');
  await assert.rejects(s.put(baseItem({ data: 'string' })), (e) => e.code === 'invalid');
  ls.failWrites = true;
  await assert.rejects(s.put(baseItem()), (e) => e.code === 'quota');
});

test('immutable guard (local): data/contentHash change → code immutable; same data ok; patch allowed', async () => {
  const { Store } = makeLocalWorld();
  const s = Store.open('sigakhwa-vault');
  const snap = await s.put(baseItem({ id: 'snap-1', kind: 'card', immutable: true, contentHash: 'h1', data: { table: '|a|' } }));
  assert.equal(snap.immutable, true);
  await assert.rejects(s.put(baseItem({ id: 'snap-1', kind: 'card', contentHash: 'h1', data: { table: '|b|' } })), (e) => e.code === 'immutable');
  await assert.rejects(s.put(baseItem({ id: 'snap-1', kind: 'card', contentHash: 'h2', data: { table: '|a|' } })), (e) => e.code === 'immutable');
  const same = await s.put(baseItem({ id: 'snap-1', kind: 'card', name: 'renamed via put', immutable: false, contentHash: 'h1', data: { table: '|a|' } }));
  assert.equal(same.name, 'renamed via put');
  assert.equal(same.immutable, true, 'immutable cannot be cleared by a put');
  const p = await s.patch('snap-1', { name: 'meta only', tags: ['t'] });
  assert.equal(p.name, 'meta only');
  deepEqual(p.data, { table: '|a|' });
});

test('export/import (local): merge skips existing ids, counts added/skipped, invalid JSON rejects', async () => {
  const { Store } = makeLocalWorld();
  const s = Store.open('bookmarks');
  const a = await s.put(baseItem({ name: 'A' }));
  const text = await s.exportJson();
  const parsed = JSON.parse(text);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.namespace, 'bookmarks');
  assert.equal(parsed.items.length, 1);
  parsed.items.push(baseItem({ id: 'imported-1', name: 'I' }));
  parsed.items.push({ id: 'broken' });
  const r = await s.importJson(JSON.stringify(parsed), { merge: true });
  deepEqual(r, { added: 1, skipped: 2 });
  assert.equal((await s.list()).length, 2);
  await assert.rejects(s.importJson('nope', { merge: true }), (e) => e.code === 'invalid');
  const r2 = await s.importJson(JSON.stringify({ items: [baseItem({ id: 'only', name: 'only' })] }), { merge: false });
  deepEqual(r2, { added: 1, skipped: 0 });
  deepEqual((await s.list()).map((i) => i.id), ['only']);
  assert.equal(await s.get(a.id), null);
});

test('sidecar probe failure (403 / network) → local fallback, synced=false, no data calls', async () => {
  for (const sc of [fakeSidecar({ healthy: false, healthStatus: 403 }), fakeSidecar({ healthy: false, healthStatus: 502 })]) {
    const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
    const s = ctx.window.HermesVizStore.open('bookmarks');
    await s.ready;
    assert.equal(s.backend, 'local');
    assert.equal(s.synced, false);
    deepEqual(sc.state.calls.map((c) => c.url), ['/api/extensions/sigakhwa-bookmarks/sidecar/health']);
    assert.equal(sc.state.calls[0].init.credentials, 'same-origin');
    await s.put(baseItem());
    assert.equal(sc.state.calls.length, 1, 'no sidecar traffic in local mode');
  }
  const throwing = { fetch: () => Promise.reject(new TypeError('Failed to fetch')) };
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: throwing.fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'local');
  assert.equal(s.synced, false);
});

test('sidecar reachable → backend sidecar, synced=true, CRUD goes to the proxy with same-origin credentials', async () => {
  const sc = fakeSidecar();
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  const events = [];
  s.subscribe((e) => events.push(e.type));
  await s.ready;
  assert.equal(s.backend, 'sidecar');
  assert.equal(s.synced, true);
  deepEqual(events, ['reload']);
  const a = await s.put(baseItem({ name: 'remote A' }));
  assert.ok(sc.state.ns.get('bookmarks').has(a.id));
  const putCall = sc.state.calls.find((c) => c.method === 'PUT');
  assert.equal(putCall.init.credentials, 'same-origin');
  assert.match(putCall.url, /^\/api\/extensions\/sigakhwa-bookmarks\/sidecar\/v1\/bookmarks\/items\//);
  assert.equal((await s.get(a.id)).name, 'remote A');
  assert.equal((await s.list({ sessionId: 'sess-1' })).length, 1);
  const p = await s.patch(a.id, { name: 'remote A2' });
  assert.equal(p.name, 'remote A2');
  assert.equal(await s.remove(a.id), true);
  assert.equal(await s.remove(a.id), false);
  assert.equal(ctx.window.localStorage.getItem('hermes-viz-store:bookmarks'), null, 'server mode does not mirror to localStorage');
});

test('sidecar: immutable 409 → code immutable; export/import round trip through the proxy', async () => {
  const sc = fakeSidecar();
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const s = ctx.window.HermesVizStore.open('sigakhwa-vault');
  await s.ready;
  await s.put(baseItem({ id: 'snap', kind: 'card', immutable: true, contentHash: 'h', data: { x: 1 } }));
  await assert.rejects(s.put(baseItem({ id: 'snap', kind: 'card', contentHash: 'h', data: { x: 2 } })), (e) => e.code === 'immutable' && e.status === 409);
  const text = await s.exportJson();
  const parsed = JSON.parse(text);
  assert.equal(parsed.items.length, 1);
  parsed.items.push(baseItem({ id: 'new', kind: 'card' }));
  const r = await s.importJson(JSON.stringify(parsed), { merge: true });
  deepEqual(r, { added: 1, skipped: 1 });
  assert.equal(sc.state.ns.get('sigakhwa-vault').size, 2);
});

test('sidecar: migration retires acknowledged copies, preserves conflicts and keeps server deletions', async () => {
  const ls = fakeLocalStorage();
  // Phase 1: offline → two local bookmarks
  let sc = fakeSidecar({ healthy: false });
  let ctx = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch });
  let s = ctx.window.HermesVizStore.open('bookmarks');
  const l1 = await s.put(baseItem({ name: 'local 1' }));
  const l2 = await s.put(baseItem({ name: 'local 2', messageIndex: 9 }));
  // Phase 2: sidecar up, holding an unrelated item and a DIFFERENT version of l2.
  sc = fakeSidecar();
  sc.state.ns.set('bookmarks', new Map([
    ['srv-1', baseItem({ id: 'srv-1', name: 'server only', createdAt: 5 })],
    [l2.id, Object.assign({}, l2, { name: 'server copy of l2' })],
  ]));
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'sidecar');
  assert.equal(s.synced, false, 'a conflicting local version is not synced');
  assert.equal(s.pendingLocal, 1);
  const server = sc.state.ns.get('bookmarks');
  assert.equal(server.size, 3, 'l1 imported, l2 not duplicated');
  assert.equal(server.get(l1.id).name, 'local 1');
  assert.equal(server.get(l2.id).name, 'server copy of l2', 'migration never overwrites the server version');
  deepEqual(JSON.parse(ls.getItem('hermes-viz-store:bookmarks')).items, [l2], 'only the acknowledged l1 copy is retired');
  const rows = await s.list();
  assert.equal(rows.length, 4, 'both versions of l2 remain visible');
  const conflict = rows.find(row => row.id === l2.id && row.localOnly);
  assert.equal(conflict.name, 'local 2');
  assert.equal(conflict.conflict, true);
  assert.equal((await s.get(l2.id)).name, 'local 2');
  const exported = JSON.parse(await s.exportJson());
  assert.equal(exported.items.filter(row => row.id === l2.id).length, 2);
  assert.equal(exported.items.find(row => row.localOnly).conflict, true);
  // Phase 3: a delete on the server (another device) stays deleted after reload
  server.delete(l1.id);
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(server.size, 2, 'nothing resurrected');
  assert.equal(server.has(l1.id), false);
  assert.equal(server.get(l2.id).name, 'server copy of l2');
  assert.equal(s.pendingLocal, 1, 'reload preserves the unresolved conflict');
  assert.equal((await s.get(l2.id)).conflict, true);
  assert.equal((await s.list()).length, 3);
  assert.equal(JSON.parse(await s.exportJson()).items.length, 3);
});

test('sidecar: paginated list follows nextOffset', async () => {
  const sc = fakeSidecar({ pageSize: 2 });
  const map = new Map();
  for (let i = 0; i < 5; i++) map.set('id-' + i, baseItem({ id: 'id-' + i, name: 'n' + i, createdAt: 100 + i }));
  sc.state.ns.set('bookmarks', map);
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  const rows = await s.list();
  deepEqual(rows.map((r) => r.name), ['n4', 'n3', 'n2', 'n1', 'n0']);
  const exported = JSON.parse(await s.exportJson());
  assert.equal(exported.items.length, 5);
});

test('ids must match the sidecar ID_RE: invalid ids reject (put) or are skipped (import / localStorage), never re-keyed', async () => {
  const { ls, Store } = makeLocalWorld();
  const s = Store.open('bookmarks');
  for (const bad of ['a/b', 'a b', 'a+b', 'a%2Fb', '', 'x'.repeat(129), 5]) {
    await assert.rejects(s.put(baseItem({ id: bad })), (e) => e.code === 'invalid', 'id ' + JSON.stringify(bad));
  }
  for (const good of ['a.b_c:d-e', 'A1', 'x'.repeat(128), '0123abcd-ef01-4567-89ab-cdef01234567']) {
    assert.equal((await s.put(baseItem({ id: good }))).id, good);
  }
  const r = await s.importJson(JSON.stringify({ items: [baseItem({ id: 'ok-1' }), baseItem({ id: 'bad/1' })] }), { merge: true });
  deepEqual(r, { added: 1, skipped: 1 }, 'hand-edited import rows with a bad id are counted as skipped');
  // a hand-edited localStorage row with an invalid id is ignored on read, not silently given a new id
  ls.setItem('hermes-viz-store:other', JSON.stringify({ v: 1, items: [baseItem({ id: 'bad id', createdAt: 1, updatedAt: 1 }), baseItem({ id: 'fine', createdAt: 2, updatedAt: 2 })] }));
  deepEqual((await Store.open('other').list()).map((i) => i.id), ['fine']);
});

test('item size cap is measured as the sidecar serves it (ASCII-escaped JSON: 6 bytes per Hangul char)', async () => {
  const { Store } = makeLocalWorld();
  const s = Store.open('sigakhwa-vault');
  // 44,000 Hangul chars = 132 KB UTF-8 but ~264 KB as served (> 256 KiB) → invalid here AND on the server
  await assert.rejects(s.put(baseItem({ kind: 'card', data: { blob: '가'.repeat(44000) } })), (e) => e.code === 'too_large');
  // 43,000 chars ≈ 258 KB as served → fits on both sides
  const ok = await s.put(baseItem({ kind: 'card', data: { blob: '가'.repeat(43000) } }));
  assert.equal(ok.data.blob.length, 43000);
  await s.put(baseItem({ kind: 'card', data: { blob: 'x'.repeat(250 * 1024) } }));
  await assert.rejects(s.put(baseItem({ kind: 'card', data: { blob: 'x'.repeat(260 * 1024) } })), (e) => e.code === 'too_large');
  // the sidecar backend pre-validates the same way: nothing is sent for an oversized item
  const sc = fakeSidecar();
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const r = ctx.window.HermesVizStore.open('sigakhwa-vault');
  await r.ready;
  const before = sc.state.calls.length;
  await assert.rejects(r.put(baseItem({ kind: 'card', data: { blob: '가'.repeat(44000) } })), (e) => e.code === 'too_large');
  assert.equal(sc.state.calls.length, before, 'rejected client-side, no PUT sent');
});

test('sidecar: items the server refuses stay visible as localOnly; pendingLocal counts them; synced only when none remain', async () => {
  const ls = fakeLocalStorage();
  // Phase 1: offline → three local bookmarks
  let sc = fakeSidecar({ healthy: false });
  let ctx = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch });
  let s = ctx.window.HermesVizStore.open('bookmarks');
  const good = await s.put(baseItem({ name: 'migrates', createdAt: 100 }));
  const stuck = await s.put(baseItem({ name: 'refused', createdAt: 200, messageIndex: 9 }));
  const gone = await s.put(baseItem({ name: 'refused too', createdAt: 300, messageIndex: 10 }));
  // Phase 2: sidecar up, but it answers 413 store_full for two of them
  const opts = { putStatus: (id) => (id === stuck.id || id === gone.id ? 413 : null) };
  sc = fakeSidecar(opts);
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'sidecar');
  assert.equal(s.synced, false, 'not everything reached the server → not "synced"');
  assert.equal(s.pendingLocal, 2);
  assert.equal(s.syncError, null);
  assert.equal(sc.state.ns.get('bookmarks').size, 1);
  assert.ok(sc.state.ns.get('bookmarks').has(good.id));
  const rows = await s.list();
  deepEqual(rows.map((r) => [r.name, r.localOnly === true]), [['refused too', true], ['refused', true], ['migrates', false]], 'leftovers still listed, flagged');
  assert.equal((await s.list({ sessionId: 'sess-1' })).length, 3);
  assert.equal((await s.list({ sessionId: 'nope' })).length, 0, 'filters apply to leftovers too');
  assert.equal((await s.get(stuck.id)).localOnly, true);
  assert.equal((await s.get(good.id)).localOnly, undefined);
  // metadata edit of a leftover stays local; a new item goes to the server
  const p = await s.patch(stuck.id, { name: 'refused (renamed)' });
  assert.equal(p.name, 'refused (renamed)');
  assert.ok(JSON.parse(ls.getItem('hermes-viz-store:bookmarks')).items.some((i) => i.name === 'refused (renamed)'));
  const fresh = await s.put(baseItem({ name: 'new one', messageIndex: 11 }));
  assert.ok(sc.state.ns.get('bookmarks').has(fresh.id));
  assert.equal(s.pendingLocal, 2);
  // export includes the leftovers
  const exported = JSON.parse(await s.exportJson());
  deepEqual(exported.items.map((r) => r.name).sort(), ['migrates', 'new one', 'refused (renamed)', 'refused too']);
  // removing a leftover removes it from this browser → count drops
  assert.equal(await s.remove(gone.id), true);
  assert.equal(s.pendingLocal, 1);
  assert.equal(s.synced, false);
  // the server accepts the last one later (re-save with the same id) → local copy retired → synced
  opts.putStatus = null;
  await s.put(p);
  assert.equal(s.pendingLocal, 0);
  assert.equal(s.synced, true);
  assert.equal(ls.getItem('hermes-viz-store:bookmarks'), null, 'leftover retired after the server accepted it');
  assert.equal(sc.state.ns.get('bookmarks').get(stuck.id).name, 'refused (renamed)');
  deepEqual((await s.list()).map((r) => r.localOnly), [undefined, undefined, undefined]);
  // Phase 3: a reload with a leftover retries the import automatically
  const retryOpts = { putStatus: () => 413 };
  const sc3 = fakeSidecar(retryOpts);
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc3.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.pendingLocal, 0, 'nothing local to begin with');
  // go offline, add one, come back with a refusing server, then with an accepting one
  ctx = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch });
  await ctx.window.HermesVizStore.open('bookmarks').put(baseItem({ name: 'late' }));
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc3.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.pendingLocal, 1);
  retryOpts.putStatus = null;
  ctx = loadScripts(['store'], { localStorage: ls, fetch: sc3.fetch });
  s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.pendingLocal, 0);
  assert.equal(s.synced, true);
  assert.ok(Array.from(sc3.state.ns.get('bookmarks').values()).some((i) => i.name === 'late'), 'retried on the next open()');
});

test('sidecar: /health ok but the data route fails → stays local with syncError (no silent dead sync)', async () => {
  const sc = fakeSidecar({ listStatus: 502 });
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'local');
  assert.equal(s.synced, false);
  assert.equal(s.pendingLocal, 0);
  assert.equal(s.syncError.status, 502);
  assert.equal(s.syncError.code, 'server');
  deepEqual(sc.state.calls.map((c) => c.method + ' ' + c.url.replace(/\?.*$/, '')), ['GET /api/extensions/sigakhwa-bookmarks/sidecar/health', 'GET /api/extensions/sigakhwa-bookmarks/sidecar/v1/bookmarks/items'], 'the data route is probed even with nothing to import');
  await s.put(baseItem());
  assert.equal(sc.state.calls.length, 2, 'local mode afterwards: no further sidecar traffic');
  const healthy = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: fakeSidecar().fetch }).window.HermesVizStore.open('bookmarks');
  await healthy.ready;
  assert.equal(healthy.syncError, null);
});

test('configure() changes the proxy base for stores opened afterwards', async () => {
  const sc = fakeSidecar({ base: '/api/extensions/other/sidecar' });
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  ctx.window.HermesVizStore.configure({ sidecarProxyBase: '/api/extensions/other/sidecar/' });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.backend, 'sidecar');
  assert.equal(sc.state.calls[0].url, '/api/extensions/other/sidecar/health');
  await tick(0);
});


test('prototype names are rejected as roles', async () => {
  const { Store } = makeLocalWorld();
  const s = Store.open('bookmarks');
  for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(s.put(baseItem({ role })), e => e.code === 'invalid');
  }
});

test('PATCH revalidates the full item and keeps storage unchanged on oversize', async () => {
  const { Store, ls } = makeLocalWorld();
  const s = Store.open('bookmarks');
  const item = await s.put(baseItem({ id: 'near-limit', name: '', data: { blob: 'x'.repeat(261000) } }));
  const before = ls.getItem('hermes-viz-store:bookmarks');
  await assert.rejects(s.patch(item.id, { tags: Array(32).fill('x'.repeat(64)) }), e => e.code === 'too_large');
  assert.equal(ls.getItem('hermes-viz-store:bookmarks'), before);
  assert.equal((await s.get(item.id)).data.blob.length, 261000);
});

test('local namespace caps reject atomically for count and serialized size', async () => {
  const { Store, ls } = makeLocalWorld();
  const s = Store.open('bookmarks');
  const rows = Array.from({ length: 1000 }, (_, i) => baseItem({ id: 'r' + i, createdAt: 1, updatedAt: 1 }));
  await s.importJson(JSON.stringify(rows));
  const before = ls.getItem('hermes-viz-store:bookmarks');
  await assert.rejects(s.put(baseItem({ id: 'extra' })), e => e.code === 'quota');
  assert.equal(ls.getItem('hermes-viz-store:bookmarks'), before);
  const large = Array.from({ length: 9 }, (_, i) => baseItem({ id: 'large' + i, data: { blob: 'x'.repeat(240000) } }));
  await assert.rejects(s.importJson(JSON.stringify(large), { merge: false }), e => e.code === 'quota');
  assert.equal(ls.getItem('hermes-viz-store:bookmarks'), before);
  await s.patch('r0', { name: 'still editable' });
});

test('migration preserves additions and edits in another tab while PUT awaits', async () => {
  const ls = fakeLocalStorage();
  const offline = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch });
  const local = offline.window.HermesVizStore.open('bookmarks');
  await local.put(baseItem({ id: 'changed' }));
  await local.put(baseItem({ id: 'unchanged' }));
  const sc = fakeSidecar();
  let inserted = false;
  const fetch = async (url, init) => {
    if (init?.method === 'PUT' && !inserted) {
      inserted = true;
      await local.patch('changed', { name: 'edited in another tab' });
      await local.put(baseItem({ id: 'new-in-tab' }));
    }
    return sc.fetch(url, init);
  };
  const ctx = loadScripts(['store'], { localStorage: ls, fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  const remaining = JSON.parse(ls.getItem('hermes-viz-store:bookmarks')).items;
  assert.deepEqual(remaining.map(x => x.id).sort(), ['changed', 'new-in-tab']);
  assert.equal(remaining.find(x => x.id === 'changed').name, 'edited in another tab');
  assert.equal(s.pendingLocal, 2);
});

test('newest build wins and previous open stores remain usable', async () => {
  const { Store, win } = makeLocalWorld();
  assert.ok(Number.isSafeInteger(Store.build));
  const oldStore = Store.open('bookmarks');
  await oldStore.put(baseItem({ id: 'existing' }));
  win.HermesVizStore = { version: 1, build: Store.build - 1 };
  loadScripts(['store'], win);
  assert.equal(win.HermesVizStore.build, Store.build);
  assert.equal((await oldStore.get('existing')).id, 'existing');
  const newest = { version: 1, build: Store.build + 1 };
  win.HermesVizStore = newest;
  loadScripts(['store'], win);
  assert.equal(win.HermesVizStore, newest);
});

test('public measurement matches Python default escaped JSON including separator spaces', () => {
  const { Store } = makeLocalWorld();
  const item = { data: { text: '가😀', values: [1, true, null], punctuation: ',:' } };
  // Independently specified Python json.dumps output.
  const expected = '{"data": {"text": "\\uac00\\ud83d\\ude00", "values": [1, true, null], "punctuation": ",:"}}';
  assert.equal(Store.measureItemBytes(item), expected.length);
});

test('later failed data requests clear synced and successful retry restores it', async () => {
  const options = {};
  const sc = fakeSidecar(options);
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch: sc.fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.equal(s.synced, true);
  options.listStatus = 502;
  await assert.rejects(s.list());
  assert.equal(s.synced, false);
  assert.equal(s.syncError.status, 502);
  options.listStatus = null;
  await s.list();
  assert.equal(s.synced, true);
  assert.equal(s.syncError, null);
});


test('remote PATCH size rejection is distinguished from namespace quota', async () => {
  const sc = fakeSidecar();
  const fetch = (url, init) => init?.method === 'PATCH'
    ? Promise.resolve({ status: 413, text: async () => JSON.stringify({ error: 'too_large' }) })
    : sc.fetch(url, init);
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  await assert.rejects(s.patch('near', { name: 'new' }), e => e.code === 'too_large');
});

test('response-body transport failure clears synced instead of leaving a stale badge', async () => {
  const sc = fakeSidecar();
  let broken = false;
  const fetch = (url, init) => broken
    ? Promise.resolve({ status: 200, text: async () => { throw new TypeError('stream disconnected'); } })
    : sc.fetch(url, init);
  const ctx = loadScripts(['store'], { localStorage: fakeLocalStorage(), fetch });
  const s = ctx.window.HermesVizStore.open('bookmarks');
  await s.ready;
  broken = true;
  await assert.rejects(s.list(), e => e.code === 'network');
  assert.equal(s.synced, false);
  assert.equal(s.syncError.code, 'network');
});

test('review 3: edits made during migration survive list, get, export and reload as conflicts', async () => {
  const ls = fakeLocalStorage();
  const local = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch }).window.HermesVizStore.open('bookmarks');
  await local.put(baseItem({ id: 'edited' }));
  const sc = fakeSidecar();
  let edited = false;
  const fetch = async (url, init) => {
    if (init?.method === 'PUT' && !edited) { edited = true; await local.patch('edited', { name: 'new local version' }); }
    return sc.fetch(url, init);
  };
  let s = loadScripts(['store'], { localStorage: ls, fetch }).window.HermesVizStore.open('bookmarks');
  for (let reload = 0; reload < 2; reload++) {
    await s.ready;
    const rows = await s.list();
    assert.equal(rows.length, 2);
    const conflict = rows.find(r => r.localOnly);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.name, 'new local version');
    assert.equal((await s.get('edited')).name, 'new local version');
    const out = JSON.parse(await s.exportJson());
    assert.equal(out.items.length, 2);
    assert.equal(out.items.find(r => r.localOnly).conflict, true);
    assert.equal(s.pendingLocal, 1);
    assert.equal(s.synced, false);
    s = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch }).window.HermesVizStore.open('bookmarks');
  }
  await s.ready;
  await s.remove('edited');
  assert.equal(sc.state.ns.get('bookmarks').has('edited'), true, 'deleting a local conflict keeps the server version');
});

test('review 3: create-only PUT cannot overwrite a server item created after the list', async () => {
  const ls = fakeLocalStorage();
  const local = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch }).window.HermesVizStore.open('bookmarks');
  const old = await local.put(baseItem({ id: 'race', name: 'local' }));
  const sc = fakeSidecar();
  const fetch = async (url, init) => {
    if (init?.method === 'PUT') sc.state.ns.get('bookmarks').set('race', { ...plain(old), name: 'server wins' });
    return sc.fetch(url, init);
  };
  const s = loadScripts(['store'], { localStorage: ls, fetch }).window.HermesVizStore.open('bookmarks');
  await s.ready;
  assert.match(sc.state.calls.find(c => c.method === 'PUT').url, /createOnly=1/);
  assert.equal(sc.state.ns.get('bookmarks').get('race').name, 'server wins');
  assert.equal((await s.list()).find(r => r.localOnly).conflict, true);
  assert.equal(JSON.parse(await s.exportJson()).items.length, 2);
});

test('review 3: deleted local items are not resurrected by in-flight or queued migration PUTs', async () => {
  for (const sameStore of [false, true]) {
    const ls = fakeLocalStorage();
    const local = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch }).window.HermesVizStore.open('bookmarks');
    await local.put(baseItem({ id: 'in-flight', createdAt: 2 }));
    await local.put(baseItem({ id: 'queued', createdAt: 1 }));
    const sc = fakeSidecar();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const start = new Promise(resolve => { entered = resolve; });
    const fetch = async (url, init) => {
      if (init?.method === 'PUT') { entered(); await gate; }
      return sc.fetch(url, init);
    };
    const s = loadScripts(['store'], { localStorage: ls, fetch }).window.HermesVizStore.open('bookmarks');
    await start;
    const removing = Promise.all(['in-flight', 'queued'].map(id => (sameStore ? s : local).remove(id)));
    release();
    await removing;
    await s.ready;
    assert.equal((await s.list()).length, 0);
    assert.equal(JSON.parse(await s.exportJson()).items.length, 0);
    assert.equal(ls.getItem('hermes-viz-store:bookmarks'), null);
    const reload = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch }).window.HermesVizStore.open('bookmarks');
    await reload.ready;
    assert.equal((await reload.list()).length, 0);
  }
});

test('review 3: only identical persisted versions retire local data', async () => {
  const ls = fakeLocalStorage();
  const local = loadScripts(['store'], { localStorage: ls, fetch: fakeSidecar({ healthy: false }).fetch }).window.HermesVizStore.open('bookmarks');
  const saved = await local.put(baseItem({ id: 'equal' }));
  const changed = await local.put(baseItem({ id: 'different-time' }));
  const sc = fakeSidecar();
  await sc.fetch(sc.base + '/v1/bookmarks/items?offset=0');
  sc.state.ns.get('bookmarks').set('equal', Object.fromEntries(Object.entries(plain(saved)).reverse()));
  sc.state.ns.get('bookmarks').set('different-time', { ...plain(changed), updatedAt: changed.updatedAt + 1 });
  const s = loadScripts(['store'], { localStorage: ls, fetch: sc.fetch }).window.HermesVizStore.open('bookmarks');
  await s.ready;
  const left = JSON.parse(ls.getItem('hermes-viz-store:bookmarks')).items;
  assert.deepEqual(left.map(r => r.id), ['different-time']);
  assert.equal(sc.state.calls.some(c => c.method === 'PUT'), false);
});
