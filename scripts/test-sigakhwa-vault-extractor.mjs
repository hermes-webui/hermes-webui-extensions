'use strict';
// Part extractor: 전체 답변 / markdown tables / mermaid blocks / ## sections,
// plus malformed fences and pathological input.

import test from 'node:test';
import assert from 'node:assert';
import { loadVault, readExtension } from './sigakhwa-vault-fixture.mjs';

const { vault } = loadVault();

const SAMPLE = [
  '이 자료는 네 덩어리로 묶입니다.',
  '',
  '```mermaid',
  'flowchart TD',
  '    A["① 브라우저"] --> B["② Tailscale"]',
  '```',
  '',
  '## 덩어리 목록',
  '',
  '| 덩어리 | 한 줄 |',
  '| --- | :-: |',
  '| ① PC·모바일 웹 | 같은 서버를 보는 창 |',
  '| ② Tailscale | VM까지 사설 연결 |',
  '',
  '## 다음 단계',
  '',
  '```python',
  'print("| not | a | table |")',
  '```',
  '',
  '더 궁금한 덩어리를 말하면 그때 파고듭니다.'
].join('\n');

test('전체 답변 is always the first part', () => {
  const parts = vault.extractParts(SAMPLE);
  assert.strictEqual(parts[0].type, 'full');
  assert.strictEqual(parts[0].label, '전체 답변');
  assert.strictEqual(parts[0].content, SAMPLE.replace(/\s+$/, ''));
});

test('finds the mermaid block, the table and both ## sections, in document order', () => {
  const parts = vault.extractParts(SAMPLE);
  assert.deepStrictEqual(parts.map((p) => p.type), ['full', 'mermaid', 'table', 'section', 'section']);

  const mermaid = parts[1];
  assert.ok(mermaid.label.indexOf('flowchart TD') >= 0, 'mermaid label summarises its first line');
  assert.ok(mermaid.content.startsWith('```mermaid'));
  assert.ok(mermaid.content.endsWith('```'));

  const table = parts[2];
  assert.ok(table.label.indexOf('덩어리') >= 0, 'table label summarises the header row');
  assert.ok(table.label.indexOf('한 줄') >= 0);
  assert.strictEqual(table.content.split('\n').length, 4, 'header + separator + 2 rows');

  assert.strictEqual(parts[3].label, '섹션: 덩어리 목록');
  assert.ok(parts[3].content.indexOf('| ② Tailscale') >= 0, 'section keeps its own table');
  assert.strictEqual(parts[4].label, '섹션: 다음 단계');
  assert.ok(parts[4].content.indexOf('더 궁금한') >= 0, 'last section runs to the end');
});

test('a table inside a fenced code block is not offered', () => {
  const parts = vault.extractParts(SAMPLE);
  const tables = parts.filter((p) => p.type === 'table');
  assert.strictEqual(tables.length, 1);
});

test('content types map to the store contract', () => {
  const parts = vault.extractParts(SAMPLE);
  assert.deepStrictEqual(parts.map((p) => vault.contentTypeForPart(p.type)),
    ['markdown', 'mermaid', 'table', 'markdown', 'markdown']);
});

test('handles the array-of-parts content shape and ignores non-text parts', () => {
  const parts = vault.extractParts([
    { type: 'text', text: '## 머리글\n\n본문' },
    { type: 'image', url: 'https://example.invalid/x.png' },
    { type: 'text', content: '| a | b |\n| --- | --- |\n| 1 | 2 |' }
  ]);
  assert.deepStrictEqual(parts.map((p) => p.type), ['full', 'table', 'section']);
  assert.ok(parts[0].content.indexOf('example.invalid') === -1, 'non-text parts are dropped');
});

test('a table needs a separator row', () => {
  const parts = vault.extractParts('| a | b |\n| 1 | 2 |');
  assert.deepStrictEqual(parts.map((p) => p.type), ['full']);
});

test('tables with ragged rows and no outer pipes on the separator still parse', () => {
  const parts = vault.extractParts('| a | b | c |\n|---|:---:|---:|\n| 1 | 2 |\n| 3 | 4 | 5 |');
  const table = parts.find((p) => p.type === 'table');
  assert.ok(table);
  assert.strictEqual(table.content.split('\n').length, 4);
});

test('malformed fences: an unterminated mermaid block is still offered', () => {
  const parts = vault.extractParts('앞말\n\n```mermaid\nflowchart TD\n  A --> B\n나머지');
  const mermaid = parts.find((p) => p.type === 'mermaid');
  assert.ok(mermaid, 'unterminated mermaid fence yields a part');
  assert.ok(mermaid.label.indexOf('닫히지 않은') >= 0);
  assert.ok(mermaid.content.indexOf('나머지') >= 0, 'runs to the end of the message');
});

test('malformed fences: an unterminated non-mermaid block swallows the rest', () => {
  const parts = vault.extractParts('```js\nlet x = 1;\n\n## 섹션\n\n| a |\n| --- |\n| 1 |');
  assert.deepStrictEqual(parts.map((p) => p.type), ['full'],
    'everything after an open fence stays inside it');
});

test('nested/longer fences close only on an equally long fence', () => {
  const md = '````mermaid\nflowchart TD\n```\nA --> B\n````';
  const mermaid = vault.extractParts(md).find((p) => p.type === 'mermaid');
  assert.ok(mermaid);
  assert.ok(mermaid.content.indexOf('A --> B') >= 0, 'the short inner fence does not close the block');
});

test('empty / whitespace-only / non-string content yields no parts', () => {
  assert.deepStrictEqual(vault.extractParts(''), []);
  assert.deepStrictEqual(vault.extractParts('   \n\n\t'), []);
  assert.deepStrictEqual(vault.extractParts(null), []);
  assert.deepStrictEqual(vault.extractParts(undefined), []);
  assert.deepStrictEqual(vault.extractParts(42), []);
  assert.deepStrictEqual(vault.extractParts({}), []);
});

test('pathological input stays linear and bounded', () => {
  const pieces = [];
  for (let i = 0; i < 400; i++) {
    pieces.push('## 섹션 ' + i);
    pieces.push('| a' + i + ' | b |');
    pieces.push('| --- | --- |');
    pieces.push('| 1 | 2 |');
    pieces.push('```mermaid');
    pieces.push('flowchart TD');
    pieces.push('```');
  }
  // plus the shapes that break naive regexes
  pieces.push('|'.repeat(5000));
  pieces.push('-'.repeat(50000));
  pieces.push('|' + '-|'.repeat(5000));
  pieces.push('`'.repeat(2000));
  pieces.push('#'.repeat(2000) + ' heading');
  pieces.push('a'.repeat(200000));
  const md = pieces.join('\n');

  const started = Date.now();
  const parts = vault.extractParts(md);
  const elapsed = Date.now() - started;

  assert.ok(parts.length <= 60, 'part count is capped at 60, got ' + parts.length);
  assert.strictEqual(parts[0].type, 'full');
  assert.ok(elapsed < 3000, 'extractor finished in ' + elapsed + 'ms');
});

test('a message longer than the scan cap still offers 전체 답변', () => {
  const md = new Array(25000).fill('## 섹션').join('\n');
  const parts = vault.extractParts(md);
  assert.strictEqual(parts[0].type, 'full');
  assert.ok(parts[0].content.length > 100000);
});

test('mermaidCode strips the fence for the renderer', () => {
  assert.strictEqual(vault.mermaidCode('```mermaid\nflowchart TD\n  A --> B\n```'), 'flowchart TD\n  A --> B');
  assert.strictEqual(vault.mermaidCode('flowchart TD'), 'flowchart TD', 'already-bare code passes through');
});

// ── review fix 1: no quadratic trailing-whitespace regex ───────────────────
function timeMs(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const WHITESPACE_RUNS = {
  'spaces between lines (review repro)': '답변\n' + ' '.repeat(60000) + '\n끝',
  'newlines (review repro)': '답변' + '\n'.repeat(60000) + '끝',
  'trailing tabs': '답변' + '\t'.repeat(60000),
  'trailing spaces at the very end': '답변' + ' '.repeat(60000),
  'ideographic spaces': '답변' + '\u3000'.repeat(60000) + 'x',
  'CRLF run': '답변' + '\r\n'.repeat(30000) + '끝',
  'NBSP run': '답변' + '\u00a0'.repeat(60000) + 'x',
  'whitespace inside a table row': '| a | b |\n| --- | --- |\n| 1 ' + ' '.repeat(60000) + '|',
  'whitespace after a heading marker': '## ' + ' '.repeat(60000) + 'x',
  'whitespace in a fence info string': '```' + ' '.repeat(60000) + 'js\ncode\n```',
  'whitespace inside a mermaid block': '```mermaid\nflowchart TD\n' + ' '.repeat(60000) + '\n```'
};

for (const [name, input] of Object.entries(WHITESPACE_RUNS)) {
  test('60k whitespace run stays fast: ' + name, () => {
    const extractMs = timeMs(() => vault.extractParts(input));
    const renderMs = timeMs(() => vault.renderMarkdownToSafeHtml(input));
    assert.ok(extractMs < 100, 'extractParts took ' + extractMs.toFixed(1) + 'ms');
    assert.ok(renderMs < 100, 'renderMarkdownToSafeHtml took ' + renderMs.toFixed(1) + 'ms');
  });
}

test('the 전체 답변 part is right-trimmed exactly like String#trimEnd', () => {
  const input = '답변\n' + ' '.repeat(60000) + '\n끝 \t\n\u3000';
  const parts = vault.extractParts(input);
  assert.strictEqual(parts[0].content, input.trimEnd());
  assert.strictEqual(vault.trimEndLinear('  a b \t\n\u00a0\u3000'), '  a b');
  assert.strictEqual(vault.trimEndLinear(''), '');
  assert.strictEqual(vault.trimEndLinear(null), '');
  assert.strictEqual(vault.trimEndLinear('x'), 'x');
});

test('the shipped extension has no trailing-whitespace-anchored regex left', () => {
  const src = readExtension();
  // ignore comment lines (they mention the forbidden pattern on purpose)
  const code = src.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
  assert.ok(code.indexOf('\\s+$') === -1 && code.indexOf('\\s*$') === -1,
    'found a \\s+$ / \\s*$ regex in the extension code');
  // and the guard itself works: the comment really does contain the pattern
  assert.ok(src.indexOf('\\s+$') !== -1, 'sanity: the explanatory comment mentions \\s+$');
});

// ── review fix 5: fence openers with info strings ──────────────────────────
test('fence openers accept an info string after the language token', () => {
  assert.deepStrictEqual(vault.parseFenceOpen('```js title="a.js"'), { ticks: 3, lang: 'js' });
  assert.deepStrictEqual(vault.parseFenceOpen('```python:main.py'), { ticks: 3, lang: 'python' });
  assert.deepStrictEqual(vault.parseFenceOpen('   ````Mermaid  %% note'), { ticks: 4, lang: 'mermaid' });
  assert.deepStrictEqual(vault.parseFenceOpen('```'), { ticks: 3, lang: '' });
  assert.deepStrictEqual(vault.parseFenceOpen('```{r}'), { ticks: 3, lang: '' });
  assert.strictEqual(vault.parseFenceOpen('``js'), null, 'two backticks are not a fence');
  assert.strictEqual(vault.parseFenceOpen('    ```js'), null, 'four spaces of indent is a code block, not a fence');
  assert.strictEqual(vault.parseFenceOpen('```js `x`'), null, 'a backtick in the info string means inline code');

  assert.strictEqual(vault.isFenceClose('```', 3), true);
  assert.strictEqual(vault.isFenceClose('  ````  ', 3), true);
  assert.strictEqual(vault.isFenceClose('```', 4), false, 'a shorter run does not close a longer fence');
  assert.strictEqual(vault.isFenceClose('```js', 3), false, 'a closer has no info string');
});

test('a fence with an info string closes properly, so later parts are still found', () => {
  const md = [
    '```js title="a.js"',
    'const x = 1;',
    '```',
    '',
    '## 정리',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```mermaid title="구조"',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
    '```python:main.py',
    'print(1)',
    '```'
  ].join('\n');
  const parts = vault.extractParts(md);
  assert.deepStrictEqual(parts.map((p) => p.type), ['full', 'table', 'mermaid', 'section']);
  const mermaid = parts.find((p) => p.type === 'mermaid');
  assert.ok(mermaid.content.endsWith('```'), 'the mermaid block ends at its own closer');
  assert.strictEqual(vault.mermaidCode(mermaid.content), 'flowchart TD\n  A --> B');
  const html = vault.renderMarkdownToSafeHtml(md);
  assert.strictEqual((html.match(/<pre>/g) || []).length, 3, 'three separate code blocks, nothing swallowed');
  assert.ok(html.indexOf('<table>') >= 0);
});
