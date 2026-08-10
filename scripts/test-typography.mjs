import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vm from 'node:vm';

const source = await readFile(new URL('../extensions/typography/assets/typography.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../extensions/typography/assets/typography.css', import.meta.url), 'utf8');
const document = {
  readyState: 'complete',
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};
const writes = [];
const window = {};
vm.runInNewContext(source, {
  window,
  document,
  localStorage: {
    getItem: () => JSON.stringify({ interface: 'local:font-123', conversation: 'same-ui', code: 'default' }),
    setItem: (...args) => writes.push(args),
  },
  setTimeout() {},
  console,
});

const extension = window.HermesTypographyExtension;
assert.equal(extension.version, '0.1.0');
const expectedPresets = [
  ['webui-default', 'WebUI Default', 'default', 'same-ui', 'default'],
  ['nous', 'Nous', 'courier-prime', 'same-ui', 'courier-prime'],
  ['modern', 'Modern', 'geist', 'same-ui', 'geist-mono'],
  ['accessible', 'Accessible', 'atkinson-hyperlegible-next', 'same-ui', 'atkinson-hyperlegible-mono'],
  ['comfortable-reading', 'Comfortable Reading', 'lexend-deca', 'literata', 'source-code-pro'],
  ['noto', 'Noto', 'noto-sans', 'noto-serif', 'noto-sans-mono'],
  ['ibm-plex', 'IBM Plex', 'ibm-plex-sans', 'ibm-plex-serif', 'ibm-plex-mono'],
  ['developer', 'Developer', 'inter', 'same-ui', 'jetbrains-mono'],
  ['dense', 'Dense', 'public-sans', 'same-ui', 'inconsolata'],
  ['warm', 'Warm', 'nunito-sans', 'lora', 'fira-code'],
  ['cyberdeck', 'Cyberdeck', 'oxanium', 'geist', 'space-mono'],
];
assert.equal(extension.presets.length, expectedPresets.length);
const bitter = extension.catalog.conversation.find(option => option.value === 'bitter');
assert.ok(bitter, 'Bitter is a Conversations catalog option');
assert.equal(bitter.label, 'Bitter');
assert.equal(extension.catalog.interface.some(option => option.value === 'bitter'), false, 'Bitter is not an Interface option');
assert.equal(extension.catalog.code.some(option => option.value === 'bitter'), false, 'Bitter is not a Code option');
assert.equal(
  JSON.stringify(extension.presets.map(({ id, label, interface: interfaceFont, conversation, code }) => [id, label, interfaceFont, conversation, code])),
  JSON.stringify(expectedPresets),
);
for (const [id, label, interfaceFont, conversation, code] of expectedPresets) {
  const preset = extension.presets.find((candidate) => candidate.id === id);
  assert.ok(preset, `missing preset: ${label}`);
  assert.equal(preset.label, label);
  assert.equal(preset.interface, interfaceFont);
  assert.equal(preset.conversation, conversation);
  assert.notEqual(preset.conversation, preset.interface, `${label} uses same-ui instead of repeating the interface family`);
  assert.equal(preset.code, code);
  assert.ok(extension.catalog.interface.some(option => option.value === interfaceFont), `${label} interface font is catalogued`);
  assert.ok(
    conversation === 'same-ui' || extension.catalog.conversation.some(option => option.value === conversation),
    `${label} conversation font is catalogued`,
  );
  assert.ok(extension.catalog.code.some(option => option.value === code), `${label} code font is catalogued`);
}

const buildGoogleStylesheetHref = extension.debug.buildGoogleStylesheetHref;
assert.equal(
  buildGoogleStylesheetHref({ interface: 'default', conversation: 'default', code: 'space-mono' }),
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;500;600;700&display=swap',
  'code-only hosted families use upright weights',
);
assert.equal(
  buildGoogleStylesheetHref({ interface: 'geist', conversation: 'geist', code: 'default' }),
  'https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&display=swap',
  'interface and conversation hosted families include true italics',
);
assert.equal(
  buildGoogleStylesheetHref({ interface: 'default', conversation: 'bitter', code: 'default' }),
  'https://fonts.googleapis.com/css2?family=Bitter:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&display=swap',
  'Bitter is a hosted prose family',
);
const sharedHref = buildGoogleStylesheetHref({ interface: 'courier-prime', conversation: 'default', code: 'courier-prime' });
assert.equal(
  sharedHref,
  'https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&display=swap',
  'shared hosted families use the prose union once',
);
assert.equal((sharedHref.match(/family=/g) || []).length, 1, 'shared hosted families are deduplicated');

assert.equal(
  source.includes('Ag Il1 O0 0123456789 · Clear controls and compact labels'),
  true,
  'interface preview includes the glyph diagnostic and representative text',
);
assert.equal(
  source.includes('Ag Il1 O0 0123456789 · Readable paragraphs <em>feel at home</em> with <strong>clear emphasis</strong>.'),
  true,
  'conversation preview includes the glyph diagnostic and semantic emphasis',
);
assert.equal(source.includes('<code>Il1 O0 {} [] != =&gt; ,.;:</code>'), true, 'code diagnostic preview remains unchanged');
assert.equal(
  css.includes('#hwx-type-panel .hwx-type-preview[data-hwx-type-preview="conversation"] {\n  font-size: var(--message-body-font-size, 14px);\n  line-height: var(--message-body-line-height, 1.75);\n}'),
  true,
  'conversation preview follows the core message sizing contract',
);

const validate = extension.debug.validateLocalFontMetadata;
const capacity = extension.debug.localFontCapacity;
const maxLocalFontCount = extension.debug.MAX_LOCAL_FONT_COUNT;
const maxLocalFontTotalBytes = extension.debug.MAX_LOCAL_FONT_TOTAL_BYTES;
assert.equal(capacity({ currentCount: 0, currentTotalBytes: 0, newBytes: 1 }).ok, true, 'an empty collection accepts its first font');
assert.equal(capacity({ currentCount: 1, currentTotalBytes: 1, newBytes: 1 }).count, 2, 'capacity counts the existing and new fonts');
assert.equal(capacity({ currentCount: maxLocalFontCount - 1, currentTotalBytes: 0, newBytes: 1 }).count, maxLocalFontCount, 'the maximum count is accepted exactly');
assert.equal(capacity({ currentCount: maxLocalFontCount - 1, currentTotalBytes: 0, newBytes: 1 }).ok, true, 'the maximum count remains valid');
assert.equal(capacity({ currentCount: maxLocalFontCount, currentTotalBytes: 0, newBytes: 1 }).ok, false, 'count above the maximum is rejected');
assert.equal(capacity({ currentCount: maxLocalFontCount + 1, currentTotalBytes: 0, newBytes: 1 }).ok, false, 'an already over-count collection remains rejected');
const maxCountReplacement = capacity({ currentCount: maxLocalFontCount, currentTotalBytes: 1, newBytes: 1, replacing: true, oldBytes: 1 });
assert.equal(maxCountReplacement.ok, true, 'replacement is allowed at the maximum count');
assert.equal(maxCountReplacement.count, maxLocalFontCount, 'replacement does not increase the count');
assert.equal(capacity({ currentCount: 0, currentTotalBytes: maxLocalFontTotalBytes - 1, newBytes: 1 }).totalBytes, maxLocalFontTotalBytes, 'the aggregate byte maximum is accepted exactly');
assert.equal(capacity({ currentCount: 0, currentTotalBytes: maxLocalFontTotalBytes - 1, newBytes: 1 }).ok, true, 'the aggregate byte maximum remains valid');
assert.equal(capacity({ currentCount: 0, currentTotalBytes: maxLocalFontTotalBytes, newBytes: 1 }).ok, false, 'aggregate bytes above the maximum are rejected');
const replacementCapacity = capacity({ currentCount: 3, currentTotalBytes: 30, newBytes: 20, replacing: true, oldBytes: 10 });
assert.equal(replacementCapacity.ok, true, 'replacement keeps count and subtracts the old bytes before adding the new bytes');
assert.equal(replacementCapacity.count, 3);
assert.equal(replacementCapacity.totalBytes, 40);
assert.equal(
  capacity({ currentCount: 3, currentTotalBytes: maxLocalFontTotalBytes, newBytes: 2, replacing: true, oldBytes: 1 }).ok,
  false,
  'replacement rejects the aggregate total after subtracting the old record',
);
assert.equal(validate({ name: 'sample.woff2', type: 'font/woff2', size: 4, signature: 'wOF2' }).ok, true);
assert.equal(validate({ name: 'sample.woff2', type: 'application/octet-stream', size: 4, signature: 'wOF2' }).ok, true);
assert.equal(validate({ name: 'sample.woff', type: '', size: 4, signature: 'wOFF' }).ok, true);
assert.equal(validate({ name: 'sample.ttf', type: 'font/ttf', size: 4, signature: '0x00010000' }).ok, true);
assert.equal(validate({ name: 'sample.otf', type: 'font/otf', size: 4, signature: 'OTTO' }).ok, true);
assert.equal(validate({ name: 'sample.otf', type: 'font/otf', size: 4, signature: '0x00010000' }).ok, true);
assert.equal(validate({ name: 'sample.ttf', type: 'font/ttf', size: 4, signature: 'OTTO' }).ok, false);
assert.equal(validate({ name: 'sample.otf', type: 'font/otf', size: 4, signature: 'true' }).ok, false);
assert.equal(validate({ name: 'sample.woff2', type: '', size: 0, signature: 'wOF2' }).ok, false);
assert.equal(validate({ name: 'sample.woff2', type: '', size: 4, signature: 'wOFF' }).ok, false);
assert.equal(validate({ name: 'sample.woff2', type: 'font/ttf', size: 4, signature: 'wOF2' }).ok, false);
assert.equal(validate({ name: 'sample.txt', type: '', size: 4, signature: 'wOF2' }).ok, false);
assert.equal(validate({ name: 'sample.woff2', type: '', size: 10 * 1024 * 1024 + 1, signature: 'wOF2' }).ok, false);

assert.equal(extension.debug.isStableLocalSelection('local:font-123'), true);
assert.equal(extension.debug.isStableLocalSelection('local:display name'), false);
assert.equal(
  JSON.stringify(extension.debug.removeLocalFontFromSelection({
    interface: 'local:font-123',
    conversation: 'same-ui',
    code: 'local:font-123',
  }, 'font-123')),
  JSON.stringify({ interface: 'default', conversation: 'same-ui', code: 'default' }),
  'deleting a local font clears every persisted role that selects it',
);
const normalizeStoredRecord = extension.debug.normalizeStoredRecord;
const corrupt = normalizeStoredRecord({
  id: 'font-corrupt',
  name: 'Broken font',
  format: 'woff2',
  bytes: new Uint8Array([0, 1, 2, 3]),
  createdAt: 123,
  updatedAt: 456,
});
assert.ok(corrupt, 'valid IDs retain corrupt stored rows');
assert.equal(corrupt.invalid, true);
assert.equal(corrupt.active, false);
assert.equal(corrupt.face, null);
assert.equal(corrupt.name, 'Broken font');
assert.equal(corrupt.format, 'woff2');
assert.equal(corrupt.bytes.byteLength, 4);
assert.equal(corrupt.createdAt, 123);
assert.equal(corrupt.updatedAt, 456);
const validStored = normalizeStoredRecord({
  id: 'font-valid',
  name: 'Valid font',
  format: 'otf',
  bytes: new Uint8Array([0, 1, 0, 0]),
});
assert.equal(validStored.invalid, false);
const emptyStored = normalizeStoredRecord({ id: 'font-empty' });
assert.equal(emptyStored.invalid, true);
assert.equal(emptyStored.format, 'unknown');
assert.equal(emptyStored.bytes.byteLength, 0);
for (const id of ['', 'bad id', '../font', 'local:font-123', '<script>', 42, null]) {
  assert.equal(normalizeStoredRecord({ id }), null, `rejects unsafe stored ID: ${String(id)}`);
}
const normalized = extension.debug.normalizeSelection({
  interface: 'local:font-123',
  conversation: 'local:missing',
  code: 'local:font-123',
}, ['font-123']);
assert.equal(normalized.interface, 'local:font-123');
assert.equal(normalized.conversation, 'same-ui');
assert.equal(normalized.code, 'local:font-123');
assert.equal(
  JSON.stringify(extension.debug.selectionForPersistence(
    { interface: 'default', conversation: 'default', code: 'default' },
    { interface: 'local:font-123', conversation: 'local:font-456', code: 'default' },
    ['interface'],
  )),
  JSON.stringify({ interface: 'default', conversation: 'local:font-456', code: 'default' }),
  'pending persistence keeps untouched unresolved local selections',
);
assert.equal(
  JSON.stringify(extension.debug.selectionForPersistence(
    { interface: 'default', conversation: 'default', code: 'default' },
    { interface: 'local:font-123', conversation: 'local:font-456', code: 'default' },
    ['interface'],
    true,
    ['font-123', 'font-456'],
  )),
  JSON.stringify({ interface: 'default', conversation: 'local:font-456', code: 'default' }),
  'ready persistence keeps a known stored local selection and lets dirty roles win',
);
assert.equal(
  JSON.stringify(extension.debug.selectionForPersistence(
    { interface: 'default', conversation: 'default', code: 'default' },
    { interface: 'local:font-123', conversation: 'local:font-456', code: 'default' },
    [],
    true,
    ['font-123'],
  )),
  JSON.stringify({ interface: 'local:font-123', conversation: 'default', code: 'default' }),
  'ready persistence does not restore a missing local selection',
);
assert.equal(extension.debug.localFallbackForRole('interface'), 'ui-sans-serif, system-ui, sans-serif');
assert.equal(extension.debug.localFallbackForRole('conversation'), 'ui-sans-serif, system-ui, sans-serif');
assert.equal(extension.debug.localFallbackForRole('code'), 'ui-monospace, monospace');
assert.equal((source.match(/Choose local fonts in any role selector\./g) || []).length, 1, 'role-selector guidance appears only below Import font');
assert.equal(source.includes("format.textContent = '· ' + record.format.toUpperCase();"), true, 'format label does not rely on leading whitespace');
assert.equal((source.match(/Local fonts stay in this browser and are never sent to a server\./g) || []).length, 1, 'local-font privacy disclosure appears once');
assert.equal(extension.getSelection().interface, 'default', 'unsupported local fonts use in-memory defaults');
assert.equal(writes.length, 0, 'unsupported local fonts do not overwrite persisted selection');

console.log('typography presets, local-font validation, and selection check passed');
