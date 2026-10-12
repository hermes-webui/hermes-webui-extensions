import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadVault } from './sigakhwa-vault-fixture.mjs';

const opts = { name: 'card', profile: 'default', sessionId: 's', messageIndex: 3, role: 'assistant',
  part: { type: 'full', label: 'answer', content: 'source' }, fullContent: 'source', sessionTitle: 'title' };
async function card(vault) { return { ...await vault.buildCard(opts), id: 'card-1', createdAt: 1 }; }
function domSetup(state, offset) {
  const dom = new JSDOM('<html lang="en"><body><button id="scrollToBottomBtn"></button></body></html>', { url: 'https://webui.test/' });
  const store = { list: async () => [], subscribe() { return () => {}; }, remove: async () => true };
  dom.window.HermesVizStore = { version: 1, open: () => store };
  const { vault } = loadVault({ window: dom.window, document: dom.window.document, state, offset });
  return { dom, vault, store, doc: dom.window.document };
}

test('valid cards and both documented hash schemes are accepted', async () => {
  const { vault } = loadVault(); const c = await card(vault);
  assert.equal(vault.validateCard(c), true);
  c.contentHash = 'a'.repeat(64); assert.equal(vault.validateCard(c), true);
});
for (const field of ['content', 'partType', 'contentType', 'partLabel', 'sessionTitle']) {
  test(`corrupt ${field} never coerces toString:null`, async () => {
    const { vault } = loadVault(); const c = await card(vault);
    c.data[field] = { toString: null }; assert.equal(vault.validateCard(c), false);
    assert.equal(vault.validatedImport(JSON.stringify({ items: [c] })).skipped, 1);
  });
}
test('coordinate tampering, prototype roles, enums and invalid hashes are refused', async () => {
  const { vault } = loadVault(); const base = await card(vault);
  for (const role of ['constructor', 'toString', '__proto__', 'system']) {
    const c = structuredClone(base); c.role = c.data.savedFrom.role = role;
    assert.equal(vault.validateCard(c), false);
  }
  for (const [key, value] of [['sessionId', 'other'], ['messageIndex', 4], ['role', 'user'], ['profile', 'other']]) {
    const c = structuredClone(base); c.data.savedFrom[key] = value;
    assert.equal(vault.validateCard(c), false);
    assert.equal((await vault.goToSource(c, { force: true })).reason, 'invalid_card');
  }
  for (const hash of ['', 'xyz', 'fnv1a128-xyz', 'a'.repeat(63)]) assert.equal(vault.validateCard({ ...base, contentHash: hash }), false);
  for (const [partType, contentType] of [['constructor', 'markdown'], ['full', 'html'], ['table', 'markdown']]) {
    assert.equal(vault.validateCard({ ...base, data: { ...base.data, partType, contentType } }), false);
  }
});
test('imports preserve valid cards, skip corrupt entries and reject wrong envelopes', async () => {
  const { vault } = loadVault(); const c = await card(vault);
  const checked = vault.validatedImport(JSON.stringify({ items: [c, { ...c, name: null }] }));
  assert.equal(checked.skipped, 1); assert.deepEqual(JSON.parse(checked.text).items, [c]);
  assert.throws(() => vault.validatedImport('{}'));
});
test('corrupt list rows cannot open but can delete', async () => {
  const { dom, doc, vault, store } = domSetup(); vault._install();
  let deleted; store.remove = async id => { deleted = id; };
  const c = await card(vault); c.data.content = { toString: null };
  const row = vault.buildCardRow(c, true); doc.body.append(row);
  assert.equal(row.textContent, 'Corrupted cardDelete');
  assert.equal(row.querySelector('.sgkv-card-open'), null);
  row.querySelector('button').click();
  doc.querySelector('.sgkv-modal-foot .sgkv-btn--danger').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(deleted, c.id); dom.window.close();
});
test('full comparison rejects shared 80-character prefixes and suffixes', () => {
  const { vault } = loadVault();
  const text = 'a'.repeat(100) + 'original' + 'b'.repeat(100);
  for (const content of ['a'.repeat(100) + 'changed', 'changed' + 'b'.repeat(100), text.replace('original', 'different')]) {
    assert.equal(vault.messageMatchesContext({ role: 'assistant', content }, { role: 'assistant', text }).reason, 'text_mismatch');
  }
  assert.equal(vault.messageMatchesContext({ role: 'assistant', content: 'A\n B' }, { role: 'assistant', text: ' A B ' }).ok, true);
  assert.equal(vault.messageMatchesContext({ role: 'assistant', content: 'a' }, { role: 'assistant' }).reason, 'source_unavailable');
  assert.equal(vault.messageMatchesContext({ role: 'user', content: 'a' }, { role: 'assistant', text: 'a' }).reason, 'role_mismatch');
});
test('capture uses loaded-message offset and creates an immutable text snapshot', () => {
  const state = { session: { session_id: 's' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }] };
  const { vault } = loadVault({ state, offset: 3 });
  const captured = vault.captureMessage({ sessionId: 's', messageIndex: 3, role: 'assistant' });
  state.messages[0].content[0].text = 'changed';
  assert.deepEqual(captured, { role: 'assistant', content: 'first\n\nsecond' });
  for (const context of [{ sessionId: 'other', messageIndex: 3, role: 'assistant' }, { sessionId: 's', messageIndex: 0, role: 'assistant' }, { sessionId: 's', messageIndex: 3, role: 'user' }]) assert.equal(vault.captureMessage(context), null);
});
test('invoke refuses unavailable Core capture before fetching', async () => {
  const { dom, doc, vault } = domSetup(); vault._install();
  await vault.onInvokeSaveCard({ sessionId: 's', messageIndex: 0, role: 'assistant', text: 'visible' });
  assert.match(doc.querySelector('#sgkvToast').textContent, /full source/);
  assert.equal(doc.querySelector('.sgkv-modal'), null); dom.window.close();
});
test('prepareSave compares captured full content against fetched array parts', async () => {
  const { vault } = loadVault({ fetch: async () => ({ ok: true, json: async () => ({ session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'whole reply' }] }] } }) }) });
  assert.equal((await vault.prepareSave({ sessionId: 's', messageIndex: 0, role: 'assistant', expectedText: 'whole reply' })).ok, true);
  assert.equal((await vault.prepareSave({ sessionId: 's', messageIndex: 0, role: 'assistant', expectedText: 'reply' })).reason, 'text_mismatch');
  assert.equal((await vault.prepareSave({ sessionId: 's', messageIndex: 0, role: 'assistant' })).reason, 'source_unavailable');
});
test('size fallback measures escaped Hangul and surrogate code units', () => {
  const { vault } = loadVault();
  assert.equal(vault.cardByteSize({ text: '한😀' }), JSON.stringify({ text: 'abc' }).length + 15);
  const cyclic = {}; cyclic.self = cyclic; assert.equal(vault.cardByteSize(cyclic), Infinity);
});
test('store measurement is preferred; oversized Hangul never reaches put', async () => {
  let measured = 0; let writes = 0;
  const { vault } = loadVault({ window: { HermesVizStore: { version: 1, open() {}, measureItemBytes() { measured++; return 300000; } } } });
  assert.equal((await vault.saveCard({ put() { writes++; } }, opts)).reason, 'too_large');
  assert.equal(measured, 1); assert.equal(writes, 0);
  const fallback = loadVault().vault;
  assert.equal((await fallback.saveCard({ put() { writes++; } }, { ...opts, part: { ...opts.part, content: '한'.repeat(50000) } })).reason, 'too_large');
  assert.equal(writes, 0);
});
for (const reason of ['quota', 'too_large', 'immutable']) {
  test(`store ${reason} errors have distinct user guidance`, async () => {
    const { vault } = loadVault({ document: null });
    const result = await vault.saveCard({ put() { throw Object.assign(new Error('rejected'), { code: reason }); } }, opts);
    assert.equal(result.reason, reason);
    assert.match(vault.saveFailureMessage(result), reason === 'quota' ? /1,000 cards \/ 2 MiB/ : reason === 'too_large' ? /256 KiB/ : /cannot be overwritten/);
  });
}
for (const [width, height, rect] of [[768, 1024, { left: 716, top: 860, right: 748, bottom: 892, width: 32, height: 32 }], [390, 844, { left: 346, top: 700, right: 378, bottom: 732, width: 32, height: 32 }], [1440, 900, { left: 1396, top: 760, right: 1428, bottom: 792, width: 32, height: 32 }]]) {
  test(`FAB has zero overlap at ${width}x${height} and restores when hidden`, () => {
    const { dom, doc, vault } = domSetup();
    Object.defineProperty(dom.window, 'innerWidth', { value: width }); Object.defineProperty(dom.window, 'innerHeight', { value: height });
    const control = doc.getElementById('scrollToBottomBtn'); control.getBoundingClientRect = () => rect;
    vault._install(); const fab = doc.getElementById('sgkvFab');
    fab.getBoundingClientRect = () => { const bottom = height - parseFloat(fab.style.bottom); return { left: width - 80, right: width - 12, top: bottom - 37, bottom, width: 68, height: 37 }; };
    assert.ok(fab.getBoundingClientRect().bottom <= rect.top - 8);
    control.style.display = 'none'; vault.positionFab(); assert.equal(fab.style.bottom, width <= 480 ? '120px' : '132px');
    dom.window.close();
  });
}
test('FAB follows mutations, replacement and ResizeObserver callbacks', async () => {
  const { dom, doc, vault } = domSetup();
  let resized; const observed = [];
  // Reload a separate fixture to inject ResizeObserver before installation.
  dom.window.__sigakhwaVaultLoaded = false;
  const current = loadVault({ window: dom.window, document: doc, ResizeObserver: class { constructor(cb) { resized = cb; } observe(node) { observed.push(node); } unobserve() {} } }).vault;
  current._install();
  const control = doc.getElementById('scrollToBottomBtn'); control.getBoundingClientRect = () => ({ top: 400, width: 32, height: 32 });
  control.className = 'visible'; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(doc.getElementById('sgkvFab').style.bottom, dom.window.innerHeight - 400 + 8 + 'px');
  const replacement = doc.createElement('button'); replacement.id = control.id;
  replacement.getBoundingClientRect = () => ({ top: 300, width: 32, height: 32 }); control.replaceWith(replacement);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(observed.includes(replacement));
  replacement.getBoundingClientRect = () => ({ top: 200, width: 32, height: 32 }); resized();
  assert.equal(doc.getElementById('sgkvFab').style.bottom, dom.window.innerHeight - 200 + 8 + 'px'); dom.window.close();
});
test('Mermaid img/image sources fall back to escaped code without calling render', () => {
  const { dom, doc, vault } = domSetup(); let calls = 0;
  dom.window.mermaid = { render() { calls++; return Promise.resolve({ svg: '<svg></svg>' }); } };
  const host = doc.createElement('div');
  for (const payload of ['<img src="https://evil.test/x">', '<IMAGE href="https://evil.test/x"/>', '&lt;img src="x"&gt;']) {
    vault.renderSnapshotInto(host, { contentType: 'mermaid', content: '```mermaid\nflowchart TD\nA["' + payload + '"]\n```' });
    assert.equal(host.querySelector('img,image,svg'), null); assert.ok(host.querySelector('pre code')); assert.match(host.textContent, /flowchart TD/);
  }
  assert.equal(calls, 0); dom.window.close();
});
test('language defaults to English and switches on the next render', () => {
  const { dom, doc, vault } = domSetup();
  assert.equal(vault.extractParts('answer')[0].label, 'Whole answer');
  doc.documentElement.lang = 'ko-KR'; assert.equal(vault.extractParts('answer')[0].label, '전체 답변');
  assert.equal(vault.t('손상된 카드'), '손상된 카드'); doc.documentElement.lang = 'fr'; assert.equal(vault.t('손상된 카드'), 'Corrupted card');
  dom.window.close();
});
test('panel chrome changes language on its next render', async () => {
  const { dom, doc, vault } = domSetup(); vault._install();
  doc.documentElement.lang = 'ko-KR'; await vault.refresh();
  assert.equal(doc.querySelector('#sgkvFab').firstChild.nodeValue, '보관함');
  assert.equal(doc.querySelector('.sgkv-panel-title').textContent, '결과 보관함');
  assert.equal(doc.querySelector('.sgkv-panel-actions button').textContent, '내보내기');
  doc.documentElement.lang = 'en'; await vault.refresh();
  assert.equal(doc.querySelector('.sgkv-panel-title').textContent, 'Result vault'); dom.window.close();
});
test('message action label follows the language and registration stays singular', () => {
  const document = { documentElement: { lang: 'en' }, readyState: 'loading', addEventListener() {} };
  const labels = []; let removed = 0; let registrations = 0;
  const window = { hermesExt: { register() { registrations++; return { messages: { registerAction(action) { labels.push(action.label); return () => { removed++; }; } } }; } } };
  const { vault } = loadVault({ window, document });
  vault._register(); vault._register(); document.documentElement.lang = 'ko-KR'; vault._register();
  assert.deepEqual(labels, ['Save to vault', '보관함에 저장']); assert.equal(removed, 1); assert.equal(registrations, 1);
});
test('a card corrupted after list rendering cannot open', async () => {
  const { dom, doc, vault, store } = domSetup(); vault._install();
  const c = await card(vault); const row = vault.buildCardRow(c, true); doc.body.append(row);
  c.createdAt = { toString: null }; store.get = async () => c;
  row.querySelector('.sgkv-card-open').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(doc.querySelector('.sgkv-modal'), null);
  assert.equal(doc.querySelector('#sgkvToast').textContent, 'Corrupted card'); dom.window.close();
});
for (const [reason, message] of [['profile_switch_required', 'Could not switch to the source profile.'], ['session_not_found', 'Source conversation not found.'], ['row_not_found', 'Source message not found.']]) {
  test(`navigation failure ${reason} is shown as user guidance`, async () => {
    const { dom, doc, store, vault: initial } = domSetup(); initial._install();
    dom.window.HermesVizNav = { version: 1, goTo: async () => ({ ok: false, reason }) };
    dom.window.__sigakhwaVaultLoaded = false;
    const { vault } = loadVault({ window: dom.window, document: doc, fetch: async () => ({ ok: true, json: async () => ({ session: { messages: [null, null, null, { role: 'assistant', content: 'source' }] } }) }) });
    const c = await card(vault); store.get = async () => c;
    const row = vault.buildCardRow(c, true); doc.body.append(row); row.querySelector('.sgkv-card-open').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    doc.querySelector('.sgkv-modal-foot button').click();
    for (let i = 0; i < 100 && !doc.querySelector('.sgkv-modal-body').textContent.includes(message); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(doc.querySelector('.sgkv-modal-body').textContent.includes(message), doc.querySelector('.sgkv-modal-body').textContent); dom.window.close();
  });
}
test('permission metadata matches and declares all used proxy/navigation routes', () => {
  const root = new URL('../extensions/sigakhwa-vault/', import.meta.url);
  const extension = JSON.parse(fs.readFileSync(new URL('extension.json', root)));
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
  assert.deepEqual(extension.permissions, manifest.extensions[0].permissions);
  assert.equal(extension.permissions.loopback_sidecar, true); assert.equal(extension.permissions.dom.mutates_core_views, true);
  assert.deepEqual(extension.permissions.storage.owned, ['hermes-viz-store:sigakhwa-vault']);
  assert.ok(extension.permissions.webui_api.write.includes('/api/profile/switch'));
  assert.ok(extension.permissions.webui_api.write.includes('/api/session/draft'));
  const base = '/api/extensions/sigakhwa-bookmarks/sidecar';
  for (const path of ['/health', '/v1/sigakhwa-vault/items', '/v1/sigakhwa-vault/items/{id}', '/v1/sigakhwa-vault/export']) assert.ok(extension.permissions.webui_api.read.includes(base + path));
  for (const path of ['/v1/sigakhwa-vault/items/{id}', '/v1/sigakhwa-vault/import']) assert.ok(extension.permissions.webui_api.write.includes(base + path));
});
