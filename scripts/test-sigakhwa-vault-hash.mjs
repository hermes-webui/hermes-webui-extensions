'use strict';
// contentHash: crypto.subtle SHA-256 primary path, documented non-crypto
// fallback, and the scheme guard that keeps the two from being compared.

import test from 'node:test';
import assert from 'node:assert';
import * as nodeCrypto from 'node:crypto';
import { loadVault, readExtension } from './sigakhwa-vault-fixture.mjs';

const { vault } = loadVault();
const SAMPLE = '## 덩어리 목록\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';

test('SHA-256 path matches node crypto, 64 lowercase hex chars', async () => {
  const hash = await vault.contentHash(SAMPLE, nodeCrypto.webcrypto);
  const expected = nodeCrypto.createHash('sha256').update(SAMPLE, 'utf8').digest('hex');
  assert.strictEqual(hash, expected);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('UTF-8 is hashed as bytes, not UTF-16 code units', async () => {
  const text = '한글 ① ✅';
  const hash = await vault.contentHash(text, nodeCrypto.webcrypto);
  assert.strictEqual(hash, nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex'));
});

test('no crypto.subtle -> documented fnv1a128- fallback', async () => {
  for (const broken of [null, {}, { subtle: {} }, { subtle: { digest: 'nope' } }]) {
    const hash = await vault.contentHash(SAMPLE, broken);
    assert.match(hash, /^fnv1a128-[0-9a-f]{32}$/, 'fallback shape for ' + JSON.stringify(broken));
    assert.strictEqual(hash.indexOf(vault.fallbackHashPrefix), 0);
  }
});

test('a throwing / rejecting subtle.digest also falls back instead of failing the save', async () => {
  const thrower = { subtle: { digest() { throw new Error('blocked'); } } };
  assert.match(await vault.contentHash(SAMPLE, thrower), /^fnv1a128-[0-9a-f]{32}$/);

  const rejecter = { subtle: { digest() { return Promise.reject(new Error('insecure context')); } } };
  assert.match(await vault.contentHash(SAMPLE, rejecter), /^fnv1a128-[0-9a-f]{32}$/);
});

test('the fallback is deterministic and separates near-identical inputs', async () => {
  const a = await vault.contentHash(SAMPLE, null);
  const b = await vault.contentHash(SAMPLE, null);
  assert.strictEqual(a, b);

  const seen = new Set();
  const variants = [SAMPLE, SAMPLE + ' ', SAMPLE.replace('1', '2'), SAMPLE.toUpperCase(), '', 'a', 'b', 'ab', 'ba'];
  for (const v of variants) seen.add(await vault.contentHash(v, null));
  assert.strictEqual(seen.size, variants.length, 'no collisions among the variants');
});

test('null / undefined hash as the empty string, not as a crash', async () => {
  const empty = await vault.contentHash('', nodeCrypto.webcrypto);
  assert.strictEqual(await vault.contentHash(null, nodeCrypto.webcrypto), empty);
  assert.strictEqual(await vault.contentHash(undefined, nodeCrypto.webcrypto), empty);
});

test('hashes from different schemes are never compared', async () => {
  const sha = await vault.contentHash(SAMPLE, nodeCrypto.webcrypto);
  const fnv = await vault.contentHash(SAMPLE, null);
  assert.strictEqual(vault.hashSchemesComparable(sha, sha), true);
  assert.strictEqual(vault.hashSchemesComparable(fnv, fnv), true);
  assert.strictEqual(vault.hashSchemesComparable(sha, fnv), false);
  assert.strictEqual(vault.hashSchemesComparable(sha, ''), false);
  assert.strictEqual(vault.hashSchemesComparable(undefined, fnv), false);
  assert.notStrictEqual(sha, fnv);
});

test('the extension picks up the ambient crypto when no ref is passed', async () => {
  const hash = await vault.contentHash(SAMPLE);
  assert.strictEqual(hash, nodeCrypto.createHash('sha256').update(SAMPLE, 'utf8').digest('hex'));
});

test('without an ambient crypto the loaded extension still hashes', async () => {
  const { vault: noCrypto } = loadVault({ crypto: undefined });
  const hash = await noCrypto.contentHash(SAMPLE);
  assert.match(hash, /^fnv1a128-[0-9a-f]{32}$/);
});
