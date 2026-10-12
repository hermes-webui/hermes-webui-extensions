'use strict';
// Safe renderer: only tables, headings, paragraphs and code; every piece of
// model text is escaped and nothing reaches an attribute position.

import test from 'node:test';
import assert from 'node:assert';
import { loadVault, readExtension } from './sigakhwa-vault-fixture.mjs';

const { vault } = loadVault();
const render = vault.renderMarkdownToSafeHtml;

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '"><script>alert(String.fromCharCode(88,83,83))</script>',
  "'><img src=1 onerror=alert(1)>",
  '<style>body{display:none}</style>',
  '<object data="data:text/html,<script>alert(1)</script>"></object>',
  '<math><mtext></mtext><script>alert(1)</script></math>',
  '<<SCRIPT>alert("XSS");//<</SCRIPT>',
  '<div onmouseover="alert(1)">hover</div>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<form><button formaction="javascript:alert(1)">x</button></form>'
];

// The renderer may only ever emit this exact tag whitelist, and the only
// attribute it may emit is one of its own fixed class names. Removing those
// tags must leave text with no '<' or '>' at all: anything else — an <img>, an
// <a>, an on* handler, a javascript: URL — would need a tag to be dangerous,
// and that tag would survive the strip.
const ALLOWED_TAG_RE =
  /<\/?(?:p|br|h[3-6]|pre|code|table|thead|tbody|tr|th|td|div)(?: class="sgkv-(?:md|pre-head|trunc)")?>/g;

function assertInert(html) {
  const rest = html.replace(ALLOWED_TAG_RE, '');
  assert.ok(rest.indexOf('<') === -1, 'un-whitelisted markup survived: ' + rest);
  assert.ok(rest.indexOf('>') === -1, 'un-whitelisted markup survived: ' + rest);
}

test('every XSS payload is escaped in a paragraph', () => {
  for (const payload of PAYLOADS) {
    const html = render(payload);
    assertInert(html);
    assert.ok(html.indexOf('&lt;') >= 0 || payload.indexOf('<') === -1, 'angle brackets escaped: ' + payload);
  }
});

test('payloads inside table cells, headings and code are escaped', () => {
  for (const payload of PAYLOADS) {
    assertInert(render('| h' + payload + ' |\n| --- |\n| ' + payload + ' |'));
    assertInert(render('## ' + payload));
    assertInert(render('```' + '\n' + payload + '\n```'));
    assertInert(render('```' + payload + '\n' + payload + '\n```'));
  }
});

test('quotes and ampersands are escaped so no attribute can be broken out of', () => {
  const html = render('a "b" \'c\' & d');
  assert.ok(html.indexOf('&quot;b&quot;') >= 0);
  assert.ok(html.indexOf('&#39;c&#39;') >= 0);
  assert.ok(html.indexOf('&amp; d') >= 0);
});

test('a legit fence language goes into a fixed-class div', () => {
  const html = render('```python\nprint(1)\n```');
  assertInert(html);
  assert.ok(html.indexOf('<div class="sgkv-pre-head">python</div>') >= 0, html);
  assert.ok(html.indexOf('<pre><code>print(1)</code></pre>') >= 0, html);
});

test('a fence whose info string is markup opens a plain code block and drops the markup', () => {
  const html = render('```"><script>x</script>\ncode\n```');
  assertInert(html);
  assert.ok(html.indexOf('sgkv-pre-head') === -1, 'no language token, so no language label');
  assert.ok(html.indexOf('<pre><code>code</code></pre>') >= 0, html);
  assert.ok(html.indexOf('script') === -1, 'the info string is never rendered');
});

test('only the first info-string token becomes the language label', () => {
  const html = render('```js"><img src=x onerror=alert(1)>\nlet a = 1;\n```');
  assertInert(html);
  assert.ok(html.indexOf('<div class="sgkv-pre-head">js</div>') >= 0, html);
  assert.ok(html.indexOf('onerror') === -1, html);
});

test('tables render as thead/tbody with the header column count', () => {
  const html = render('| 덩어리 | 한 줄 |\n| --- | --- |\n| ① | 창 |\n| ② | 연결 |');
  assert.ok(html.indexOf('<table><thead><tr><th>덩어리</th><th>한 줄</th></tr></thead>') >= 0, html);
  assert.strictEqual((html.match(/<tr>/g) || []).length, 3);
  assert.strictEqual((html.match(/<td>/g) || []).length, 4, 'ragged rows are padded to the header width');
});

test('headings become h3..h6 only (never h1/h2, so the panel keeps its own hierarchy)', () => {
  const html = render('# one\n## two\n### three\n#### four\n##### five\n###### six');
  assert.ok(html.indexOf('<h1') === -1 && html.indexOf('<h2') === -1);
  assert.deepStrictEqual(html.match(/<h\d/g), ['<h3', '<h4', '<h5', '<h6', '<h6', '<h6']);
});

test('paragraph line breaks survive as <br>, blank lines split paragraphs', () => {
  const html = render('one\ntwo\n\nthree');
  assert.ok(html.indexOf('<p>one<br>two</p>') >= 0, html);
  assert.ok(html.indexOf('<p>three</p>') >= 0, html);
});

test('inline markdown is deliberately NOT interpreted', () => {
  const html = render('**bold** _em_ [link](https://example.invalid) `code`');
  assert.ok(html.indexOf('<strong>') === -1 && html.indexOf('<em>') === -1);
  assert.ok(html.indexOf('<a') === -1, 'no link is ever produced');
  assert.ok(html.indexOf('**bold**') >= 0);
});

test('output is wrapped in .sgkv-md and is capped for very long snapshots', () => {
  assert.ok(render('x').startsWith('<div class="sgkv-md">'));
  const long = new Array(5000).fill('줄').join('\n');
  const html = render(long);
  assert.ok(html.indexOf('sgkv-trunc') >= 0, 'over the line cap a truncation notice is appended');
});

test('escapeHtml covers the five dangerous characters', () => {
  assert.strictEqual(vault.escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.strictEqual(vault.escapeHtml(null), '');
  assert.strictEqual(vault.escapeHtml(undefined), '');
  assert.strictEqual(vault.escapeHtml(0), '0');
});
