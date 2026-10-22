'use strict';
// node --test — pure helpers of the extension script (TOC parser, default name, keys) loaded with a
// window but no document, so only the pure part runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './sigakhwa-bookmarks-test-helpers.mjs';
const deepEqual = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

function pure() {
  const ctx = loadScripts(['ext'], {});
  ctx.document = { documentElement: { lang: 'ko' } };
  return ctx.window.SigakhwaBookmarks;
}

test('exposes pure helpers without a document and does not install', () => {
  const P = pure();
  assert.equal(P.installed, false);
  for (const k of ['parseToc', 'defaultName', 'previewText', 'messageText', 'bookmarkKey', 'reasonText']) assert.equal(typeof P[k], 'function', k);
});

test('defaultName: first 40 chars, whitespace collapsed, inline markdown stripped', () => {
  const P = pure();
  assert.equal(P.defaultName('짧은 이름'), '짧은 이름');
  assert.equal(P.defaultName('  **굵게**   그리고\n`코드`  '), '굵게 그리고 코드');
  const long = 'a'.repeat(100);
  const n = P.defaultName(long);
  assert.equal(n.length, 41);
  assert.ok(n.endsWith('…'));
  assert.equal(n.slice(0, 40), 'a'.repeat(40));
  assert.equal(P.defaultName('# 제목\n- 항목 하나\n2. 둘\n> 인용'), '제목 항목 하나 둘 인용', 'block markers stripped');
  assert.equal(P.defaultName('C# 과 #3 는 유지'), 'C# 과 #3 는 유지');
  assert.equal(P.defaultName(''), '북마크');
  assert.equal(P.defaultName(null), '북마크');
  assert.equal(P.previewText('x'.repeat(500)).length, 121);
});

test('bookmarkKey is profile+session+index+role; reasonText is Korean per reason', () => {
  const P = pure();
  assert.equal(P.bookmarkKey('default', 's1', 3, 'user'), 'default\u0000s1\u00003\u0000user');
  assert.notEqual(P.bookmarkKey('work', 's1', 3, 'user'), P.bookmarkKey('default', 's1', 3, 'user'));
  for (const r of ['no_core', 'session_not_found', 'profile_switch_required', 'row_not_found', 'busy_switch_blocked', 'other']) {
    assert.ok(/[가-힣]/.test(P.reasonText(r, 'work')), r);
  }
  assert.match(P.reasonText('profile_switch_required', 'work'), /work/);
});

test('messageText handles strings and text parts', () => {
  const P = pure();
  assert.equal(P.messageText('abc'), 'abc');
  assert.equal(P.messageText([{ type: 'text', text: 'a' }, { type: 'image_url' }, 'b', { type: 'text', content: 'c' }]), 'a\nb\nc');
  assert.equal(P.messageText(null), '');
  assert.equal(P.messageText(42), '');
});

test('parseToc: headings 1-3 (not 4+), closing hashes, inline markdown, only assistant rows', () => {
  const P = pure();
  const msgs = [
    { role: 'user', content: '# 사용자 제목은 무시' },
    { role: 'assistant', content: '# 제목 하나 ##\n본문\n## **둘째** `코드`\n### 셋째\n#### 넷째는 무시\n#해시태그는 제목 아님\n    # 들여쓴 코드도 아님' },
    { role: 'tool', content: '# 도구' },
  ];
  const e = plain(P.parseToc(msgs));
  deepEqual(e, [
    { messageIndex: 1, role: 'assistant', kind: 'heading', level: 1, label: '제목 하나' },
    { messageIndex: 1, role: 'assistant', kind: 'heading', level: 2, label: '둘째 코드' },
    { messageIndex: 1, role: 'assistant', kind: 'heading', level: 3, label: '셋째' },
  ]);
});

test('parseToc: fenced code hides headings/tables; mermaid fences become diagrams with their first line', () => {
  const P = pure();
  const content = [
    '## 구조',
    '```mermaid',
    '%% comment first',
    'flowchart TD',
    '  A --> B',
    '```',
    '```python',
    '# not a heading',
    '| a | b |',
    '|---|---|',
    '```',
    '~~~mermaid',
    'sequenceDiagram',
    '~~~',
    '```mermaid',
    'graph LR',
  ].join('\n');
  const e = plain(P.parseToc([{ role: 'assistant', content }]));
  deepEqual(e.map((x) => [x.kind, x.label]), [
    ['heading', '구조'],
    ['diagram', 'flowchart TD'],
    ['diagram', 'sequenceDiagram'],
    ['diagram', 'graph LR'],
  ], 'unclosed trailing mermaid fence still counts');
});

test('parseToc: tables are detected by header + separator row and summarized by header cells', () => {
  const P = pure();
  const content = [
    '결과:',
    '| 항목 | 값 | **비고** |',
    '|:---|---:|:---:|',
    '| a | 1 | x |',
    '',
    '헤더 없는 구분선은 무시',
    '|---|---|',
    '',
    '열 | 둘',
    '--- | ---',
    '1 | 2',
  ].join('\n');
  const e = plain(P.parseToc([{ role: 'assistant', content }]));
  deepEqual(e.map((x) => [x.kind, x.label]), [
    ['table', '항목 · 값 · 비고'],
    ['table', '열 · 둘'],
  ]);
});

test('parseToc: sigakhwa 한 줄 프레임 line is detected once per message', () => {
  const P = pure();
  const content = [
    '1. **한 줄 프레임** — 자료는 세 덩어리로 나뉜다.',
    '2. 도식',
    '한줄 프레임: 두 번째는 무시',
  ].join('\n');
  const e = plain(P.parseToc([{ role: 'assistant', content }]));
  deepEqual(e, [{ messageIndex: 0, role: 'assistant', kind: 'frame', label: '자료는 세 덩어리로 나뉜다.' }]);
  const e2 = plain(P.parseToc([{ role: 'assistant', content: '한 줄 프레임: ' + 'x'.repeat(200) }]));
  assert.equal(e2[0].label.length, 61);
});

test('parseToc: array content parts, message indexes are absolute, entries capped at 500', () => {
  const P = pure();
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'text', text: '# A' }, { type: 'text', text: '## B' }] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: '### C' },
  ];
  const e = plain(P.parseToc(msgs));
  deepEqual(e.map((x) => [x.messageIndex, x.label]), [[1, 'A'], [1, 'B'], [3, 'C']]);
  const many = Array.from({ length: 600 }, (_, i) => '# h' + i).join('\n');
  assert.equal(P.parseToc([{ role: 'assistant', content: many }]).length, 500);
  deepEqual(P.parseToc(null), []);
  deepEqual(P.parseToc([null, {}, { role: 'assistant' }, { role: 'assistant', content: '' }]), []);
});

test('parseToc: bounded on hostile input (very long lines, many hashes/pipes) — finishes fast', () => {
  const P = pure();
  const hostile = [
    '#'.repeat(50000),
    '#'.repeat(3) + ' ' + 'a'.repeat(100000),
    '|'.repeat(50000),
    '-'.repeat(50000) + '|',
    '| ' + 'x|'.repeat(30000),
    '|' + '-|'.repeat(30000),
    '```' + 'a'.repeat(10000),
    '한 줄 프레임' + ':'.repeat(50000),
  ].join('\n');
  const t0 = Date.now();
  const e = P.parseToc([{ role: 'assistant', content: hostile }]);
  const dt = Date.now() - t0;
  assert.ok(dt < 1500, 'took ' + dt + 'ms');
  assert.ok(Array.isArray(e));
  for (const x of e) assert.ok(x.label.length <= 61);
});
