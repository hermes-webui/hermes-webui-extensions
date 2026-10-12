/*
 * sigakhwa-vault — 결과 보관함 (result vault) for Hermes WebUI
 * ---------------------------------------------------------------------------
 * Trusted local static-UI extension. Adds a `star` message action to assistant
 * replies that snapshots a chosen part of the reply (whole answer, a markdown
 * table, a mermaid fenced block, or a `##` section) into an immutable card, and
 * a self-owned 보관함 panel that lists / renders / re-checks those cards.
 *
 * Contracts consumed (see README.md, WebUI surfaces used):
 *   window.HermesVizStore  (owner B) — persistence, §2
 *   window.HermesVizNav    (owner B) — jump back to the source message, §3
 * Both are optional at runtime: when the store is missing the panel shows a
 * one-line notice and saving is disabled. Nothing here may throw at
 * load time, and nothing here ever sends a message to the model.
 *
 * Core APIs used: window.hermesExt.register / handle.messages.registerAction,
 * GET /api/session (read-only), optional global showToast(), optional global
 * mermaid.render(). No core files are modified.
 */
(function () {
  'use strict';

  var EXT_ID = 'sigakhwa-vault';
  var VERSION = '0.1.0';
  var NAMESPACE = 'sigakhwa-vault';

  var I18N = {
    "ko": {
      "전체 답변": "전체 답변",
      "다이어그램: ": "다이어그램: ",
      "섹션: ": "섹션: ",
      "표: ": "표: ",
      "다이어그램(닫히지 않은 블록): ": "다이어그램(닫히지 않은 블록): ",
      "표": "표",
      "다이어그램": "다이어그램",
      "섹션": "섹션",
      "내용": "내용",
      "<p class=\"sgkv-trunc\">… (긴 내용의 일부만 표시됨)</p>": "<p class=\"sgkv-trunc\">… (긴 내용의 일부만 표시됨)</p>",
      "서버의 같은 위치에 다른 메시지가 있습니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.": "서버의 같은 위치에 다른 메시지가 있습니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.",
      "화면의 답변과 서버의 원문이 다릅니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.": "화면의 답변과 서버의 원문이 다릅니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.",
      "저장된 결과": "저장된 결과",
      "보관함": "보관함",
      "결과 보관함 열기": "결과 보관함 열기",
      "결과 보관함": "결과 보관함",
      "내보내기": "내보내기",
      "가져오기": "가져오기",
      "닫기": "닫기",
      "저장 모듈(HermesVizStore)을 불러올 수 없어 보관함 저장 기능을 쓸 수 없습니다.": "저장 모듈(HermesVizStore)을 불러올 수 없어 보관함 저장 기능을 쓸 수 없습니다.",
      "저장된 카드를 읽을 수 없습니다.": "저장된 카드를 읽을 수 없습니다.",
      "보관함을 읽는 중 오류가 발생했습니다.": "보관함을 읽는 중 오류가 발생했습니다.",
      "저장된 카드가 없습니다. 답변의 ★ 버튼으로 결과를 보관하세요.": "저장된 카드가 없습니다. 답변의 ★ 버튼으로 결과를 보관하세요.",
      "(제목 없음)": "(제목 없음)",
      "이 기기에만 저장됨": "이 기기에만 저장됨",
      "취소": "취소",
      "확인": "확인",
      "보관함 저장 한도(1,000개 / 2 MiB)에 도달했습니다. 카드를 삭제하거나 내보낸 뒤 다시 시도해 주세요.": "보관함 저장 한도(1,000개 / 2 MiB)에 도달했습니다. 카드를 삭제하거나 내보낸 뒤 다시 시도해 주세요.",
      "카드가 너무 큽니다 (": "카드가 너무 큽니다 (",
      "약 ": "약 ",
      "최대 ": "최대 ",
      " KiB). 표·다이어그램·섹션처럼 더 작은 조각을 골라 주세요.": " KiB). 표·다이어그램·섹션처럼 더 작은 조각을 골라 주세요.",
      "이미 저장된 카드는 바꿀 수 없습니다. 새 저장본으로 만들어 주세요.": "이미 저장된 카드는 바꿀 수 없습니다. 새 저장본으로 만들어 주세요.",
      "저장 모듈이 없어 저장할 수 없습니다.": "저장 모듈이 없어 저장할 수 없습니다.",
      "저장에 실패했습니다.": "저장에 실패했습니다.",
      "결과 보관함에 저장": "결과 보관함에 저장",
      "원문을 불러오는 중…": "원문을 불러오는 중…",
      "원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.": "원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      "저장할 내용을 찾지 못했습니다.": "저장할 내용을 찾지 못했습니다.",
      " 이 브라우저에만 보관되며 다른 기기와 동기화되지 않습니다.": " 이 브라우저에만 보관되며 다른 기기와 동기화되지 않습니다.",
      "제목": "제목",
      "저장할 내용": "저장할 내용",
      "저장": "저장",
      "보관함에 저장했습니다.": "보관함에 저장했습니다.",
      "저장 모듈(HermesVizStore)이 없어 저장할 수 없습니다.": "저장 모듈(HermesVizStore)이 없어 저장할 수 없습니다.",
      "저장 모듈이 없습니다.": "저장 모듈이 없습니다.",
      "카드를 찾을 수 없습니다.": "카드를 찾을 수 없습니다.",
      "카드를 열지 못했습니다.": "카드를 열지 못했습니다.",
      "출처: ": "출처: ",
      "그래도 이동": "그래도 이동",
      "이동하는 중…": "이동하는 중…",
      "원문이 저장 이후 바뀌었거나 그 위치에 다른 메시지가 있습니다. 이동하면 다른 메시지가 나올 수 있습니다.": "원문이 저장 이후 바뀌었거나 그 위치에 다른 메시지가 있습니다. 이동하면 다른 메시지가 나올 수 있습니다.",
      "원문이 그대로인지 확인할 수 없습니다(다른 프로필의 대화이거나 원문을 불러오지 못함).": "원문이 그대로인지 확인할 수 없습니다(다른 프로필의 대화이거나 원문을 불러오지 못함).",
      "이동 모듈(HermesVizNav)이 없어 원문으로 이동할 수 없습니다.": "이동 모듈(HermesVizNav)이 없어 원문으로 이동할 수 없습니다.",
      "원문으로 이동하지 못했습니다": "원문으로 이동하지 못했습니다",
      "원문으로 이동": "원문으로 이동",
      "원문을 확인하는 중…": "원문을 확인하는 중…",
      "원문 변경 확인": "원문 변경 확인",
      "원문을 다시 불러오는 중…": "원문을 다시 불러오는 중…",
      "동일 — 원문이 저장 시점과 같습니다.": "동일 — 원문이 저장 시점과 같습니다.",
      "변경됨 — 저장 위치에 다른 메시지가 있습니다. 보관된 스냅샷은 그대로입니다.": "변경됨 — 저장 위치에 다른 메시지가 있습니다. 보관된 스냅샷은 그대로입니다.",
      "변경됨 — 원문이 저장 이후 바뀌었습니다. 보관된 스냅샷은 그대로입니다.": "변경됨 — 원문이 저장 이후 바뀌었습니다. 보관된 스냅샷은 그대로입니다.",
      "변경 여부를 확인할 수 없습니다 (해시 방식이 다름).": "변경 여부를 확인할 수 없습니다 (해시 방식이 다름).",
      "원문을 불러오지 못해 확인하지 못했습니다.": "원문을 불러오지 못해 확인하지 못했습니다.",
      "새 저장본 만들기": "새 저장본 만들기",
      " (새 저장본)": " (새 저장본)",
      "이름 변경": "이름 변경",
      "새 이름": "새 이름",
      "이름을 바꿨습니다.": "이름을 바꿨습니다.",
      "이름을 바꾸지 못했습니다.": "이름을 바꾸지 못했습니다.",
      "삭제": "삭제",
      "카드 삭제": "카드 삭제",
      "” 카드를 삭제할까요? 되돌릴 수 없습니다.": "” 카드를 삭제할까요? 되돌릴 수 없습니다.",
      "카드를 삭제했습니다.": "카드를 삭제했습니다.",
      "삭제하지 못했습니다.": "삭제하지 못했습니다.",
      "보관함을 JSON으로 내보냈습니다.": "보관함을 JSON으로 내보냈습니다.",
      "내보내기에 실패했습니다.": "내보내기에 실패했습니다.",
      "가져오기 완료: ": "가져오기 완료: ",
      "건 추가, ": "건 추가, ",
      "건 건너뜀": "건 건너뜀",
      "가져오기에 실패했습니다. JSON 형식을 확인해 주세요.": "가져오기에 실패했습니다. JSON 형식을 확인해 주세요.",
      "파일을 읽지 못했습니다.": "파일을 읽지 못했습니다.",
      "보관함에 저장": "보관함에 저장",
      "손상된 카드": "손상된 카드",
      "손상된 카드를 삭제할까요? 되돌릴 수 없습니다.": "손상된 카드를 삭제할까요? 되돌릴 수 없습니다.",
      "클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.": "클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.",
      "profile_switch_required": "원문 프로필로 전환하지 못했습니다.",
      "session_not_found": "원문 대화를 찾을 수 없습니다.",
      "row_not_found": "원문 메시지를 찾을 수 없습니다.",
      "invalid_target": "원문 위치가 올바르지 않습니다.",
      "invalid_card": "손상된 카드"
    },
    "en": {
      "전체 답변": "Whole answer",
      "다이어그램: ": "Diagram: ",
      "섹션: ": "Section: ",
      "표: ": "Table: ",
      "다이어그램(닫히지 않은 블록): ": "Diagram (unclosed block): ",
      "표": "Table",
      "다이어그램": "Diagram",
      "섹션": "Section",
      "내용": "Content",
      "<p class=\"sgkv-trunc\">… (긴 내용의 일부만 표시됨)</p>": "<p class=\"sgkv-trunc\">… (Only part of this long content is shown)</p>",
      "서버의 같은 위치에 다른 메시지가 있습니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.": "The server has a different message at this position. The conversation may have been edited or regenerated. Reload and try again.",
      "화면의 답변과 서버의 원문이 다릅니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.": "The reply on screen differs from the server source. The conversation may have been edited or regenerated. Reload and try again.",
      "저장된 결과": "Saved result",
      "보관함": "Vault",
      "결과 보관함 열기": "Open result vault",
      "결과 보관함": "Result vault",
      "내보내기": "Export",
      "가져오기": "Import",
      "닫기": "Close",
      "저장 모듈(HermesVizStore)을 불러올 수 없어 보관함 저장 기능을 쓸 수 없습니다.": "HermesVizStore could not be loaded. Saving to the vault is unavailable.",
      "저장된 카드를 읽을 수 없습니다.": "Saved cards could not be read.",
      "보관함을 읽는 중 오류가 발생했습니다.": "Could not read the vault.",
      "저장된 카드가 없습니다. 답변의 ★ 버튼으로 결과를 보관하세요.": "No saved cards. Use the ★ button on a reply to save a result.",
      "(제목 없음)": "(Untitled)",
      "이 기기에만 저장됨": "Saved on this device only",
      "취소": "Cancel",
      "확인": "Confirm",
      "보관함 저장 한도(1,000개 / 2 MiB)에 도달했습니다. 카드를 삭제하거나 내보낸 뒤 다시 시도해 주세요.": "The vault limit (1,000 cards / 2 MiB) has been reached. Delete or export cards, then try again.",
      "카드가 너무 큽니다 (": "Card is too large (",
      "약 ": "about ",
      "최대 ": "maximum ",
      " KiB). 표·다이어그램·섹션처럼 더 작은 조각을 골라 주세요.": " KiB). Choose a smaller part, such as a table, diagram or section.",
      "이미 저장된 카드는 바꿀 수 없습니다. 새 저장본으로 만들어 주세요.": "Saved cards cannot be overwritten. Create a new snapshot.",
      "저장 모듈이 없어 저장할 수 없습니다.": "The storage module is unavailable. Cannot save.",
      "저장에 실패했습니다.": "Could not save.",
      "결과 보관함에 저장": "Save to result vault",
      "원문을 불러오는 중…": "Loading source…",
      "원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.": "Could not load the source. Try again shortly.",
      "저장할 내용을 찾지 못했습니다.": "No content to save.",
      " 이 브라우저에만 보관되며 다른 기기와 동기화되지 않습니다.": " Stored in this browser only; it is not synced to other devices.",
      "제목": "Title",
      "저장할 내용": "Content to save",
      "저장": "Save",
      "보관함에 저장했습니다.": "Saved to the vault.",
      "저장 모듈(HermesVizStore)이 없어 저장할 수 없습니다.": "HermesVizStore is unavailable. Cannot save.",
      "저장 모듈이 없습니다.": "The storage module is unavailable.",
      "카드를 찾을 수 없습니다.": "Card not found.",
      "카드를 열지 못했습니다.": "Could not open the card.",
      "출처: ": "Source: ",
      "그래도 이동": "Go anyway",
      "이동하는 중…": "Navigating…",
      "원문이 저장 이후 바뀌었거나 그 위치에 다른 메시지가 있습니다. 이동하면 다른 메시지가 나올 수 있습니다.": "The source changed after saving, or another message occupies its position. Navigating may show a different message.",
      "원문이 그대로인지 확인할 수 없습니다(다른 프로필의 대화이거나 원문을 불러오지 못함).": "Cannot verify the source (it belongs to another profile or could not be loaded).",
      "이동 모듈(HermesVizNav)이 없어 원문으로 이동할 수 없습니다.": "HermesVizNav is unavailable. Cannot navigate to the source.",
      "원문으로 이동하지 못했습니다": "Could not navigate to the source",
      "원문으로 이동": "Go to source",
      "원문을 확인하는 중…": "Checking source…",
      "원문 변경 확인": "Check source changes",
      "원문을 다시 불러오는 중…": "Reloading source…",
      "동일 — 원문이 저장 시점과 같습니다.": "Unchanged — the source matches the saved version.",
      "변경됨 — 저장 위치에 다른 메시지가 있습니다. 보관된 스냅샷은 그대로입니다.": "Changed — another message occupies the saved position. The snapshot is unchanged.",
      "변경됨 — 원문이 저장 이후 바뀌었습니다. 보관된 스냅샷은 그대로입니다.": "Changed — the source was edited after saving. The snapshot is unchanged.",
      "변경 여부를 확인할 수 없습니다 (해시 방식이 다름).": "Cannot check for changes (different hash schemes).",
      "원문을 불러오지 못해 확인하지 못했습니다.": "Could not load the source to check for changes.",
      "새 저장본 만들기": "Create new snapshot",
      " (새 저장본)": " (new snapshot)",
      "이름 변경": "Rename",
      "새 이름": "New name",
      "이름을 바꿨습니다.": "Renamed.",
      "이름을 바꾸지 못했습니다.": "Could not rename.",
      "삭제": "Delete",
      "카드 삭제": "Delete card",
      "” 카드를 삭제할까요? 되돌릴 수 없습니다.": "”? This cannot be undone.",
      "카드를 삭제했습니다.": "Card deleted.",
      "삭제하지 못했습니다.": "Could not delete.",
      "보관함을 JSON으로 내보냈습니다.": "Vault exported as JSON.",
      "내보내기에 실패했습니다.": "Could not export.",
      "가져오기 완료: ": "Import complete: ",
      "건 추가, ": " added, ",
      "건 건너뜀": " skipped",
      "가져오기에 실패했습니다. JSON 형식을 확인해 주세요.": "Import failed. Check the JSON format.",
      "파일을 읽지 못했습니다.": "Could not read the file.",
      "보관함에 저장": "Save to vault",
      "손상된 카드": "Corrupted card",
      "손상된 카드를 삭제할까요? 되돌릴 수 없습니다.": "Delete the corrupted card? This cannot be undone.",
      "클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.": "Cannot verify the full source of the clicked message. Reload and try again.",
      "profile_switch_required": "Could not switch to the source profile.",
      "session_not_found": "Source conversation not found.",
      "row_not_found": "Source message not found.",
      "invalid_target": "Invalid source location.",
      "invalid_card": "Corrupted card"
    }
  };

  function t(key) {
    var lang = typeof document !== 'undefined' && document && document.documentElement ? document.documentElement.lang : '';
    var messages = I18N[/^ko/i.test(lang || '') ? 'ko' : 'en'];
    return Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
  }

  // ── Init guard ───────────────────────────────────────────────────────────
  // A re-injected classic script must not create a second panel, a second
  // observer or a second message-action registration.
  if (typeof window === 'undefined') return;
  if (window.__sigakhwaVaultLoaded) return;
  window.__sigakhwaVaultLoaded = true;

  // Bounded limits. Message content is attacker-influenceable inside the
  // authenticated tab, so every scan below is linear and capped.
  var MAX_SCAN_LINES = 20000;   // lines inspected by the part extractor
  var MAX_PARTS = 60;           // saveable parts offered in the chooser
  var MAX_LABEL = 80;           // chooser label length
  var MAX_RENDER_LINES = 4000;  // lines rendered by the safe renderer
  var MAX_CELLS = 40;           // table cells per row rendered
  var FALLBACK_HASH_PREFIX = 'fnv1a128-';

  // ── text helpers ─────────────────────────────────────────────────────────
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Linear right-trim. Never use /\s+$/ on model text: V8 retries the match
  // from every position inside a whitespace run, which is quadratic (a 60k
  // space run took ~5 s).
  function isWhitespaceCode(code) {
    return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
      || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  }

  function trimEndLinear(text) {
    var s = String(text == null ? '' : text);
    var end = s.length;
    while (end > 0 && isWhitespaceCode(s.charCodeAt(end - 1))) end--;
    return end === s.length ? s : s.slice(0, end);
  }

  // Labels are short by definition: cut the input before normalising so a
  // 200k-char header line costs no more than a short one.
  function clamp(text, max) {
    var raw = String(text == null ? '' : text);
    if (max && raw.length > max * 8) raw = raw.slice(0, max * 8);
    var s = raw.replace(/\s+/g, ' ').trim();
    if (!max || s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  // A persisted message `content` is either a plain string or the
  // array-of-parts shape (see upstream static/outline.js:79-92). Only `text`
  // parts carry renderable markdown; blocks are joined with a blank line so
  // markdown block structure survives (outline.js joins with a space because
  // it only needs a one-line excerpt).
  function normalizeMessageContent(raw) {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var part = raw[i];
        if (!part) continue;
        if (typeof part === 'string') { if (part) out.push(part); continue; }
        if (typeof part !== 'object') continue;
        if (part.type !== undefined && part.type !== 'text') continue;
        var text = typeof part.text === 'string' ? part.text
          : (typeof part.content === 'string' ? part.content : '');
        if (text) out.push(text);
      }
      return out.join('\n\n');
    }
    if (raw && typeof raw === 'object') {
      if (typeof raw.text === 'string') return raw.text;
      if (typeof raw.content === 'string') return raw.content;
    }
    return '';
  }

  // ── part extractor ───────────────────────────────────────────────────────
  // Line-oriented, single pass, no regex spanning more than one line, no
  // unbounded `[^x]*`, and no `\s+$`-style trailing anchors over model text.
  // Returns [{id, type, label, content}] with 전체 답변 first.
  var HEADING_RE = /^ {0,3}(#{1,6})[ \t]{1,4}(.{0,200})$/;
  var LANG_TOKEN_RE = /^[A-Za-z0-9_+.#-]{1,64}/;

  // Fence opener (CommonMark-ish, backticks only): up to 3 spaces, 3+
  // backticks, then an info string that may not contain a backtick. The
  // language is the first token of the info string, so ```js title="a.js"
  // and ```python:main.py open js / python fences. Hand-written scan: linear
  // in the line length with no backtracking.
  function parseFenceOpen(line) {
    if (typeof line !== 'string') return null;
    var i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    var start = i;
    while (i < line.length && line.charCodeAt(i) === 96) i++;
    var ticks = i - start;
    if (ticks < 3) return null;
    if (line.indexOf('`', i) !== -1) return null;
    while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    var token = LANG_TOKEN_RE.exec(line.slice(i, i + 64));
    return { ticks: ticks, lang: token ? token[0].toLowerCase() : '' };
  }

  // Fence closer: up to 3 spaces, at least `minTicks` backticks, then only
  // spaces/tabs.
  function isFenceClose(line, minTicks) {
    if (typeof line !== 'string') return false;
    var i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    var start = i;
    while (i < line.length && line.charCodeAt(i) === 96) i++;
    if (i - start < Math.max(3, minTicks || 3)) return false;
    while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    return i === line.length;
  }
  var TABLE_SEP_CELL_RE = /^[ \t]{0,8}:?-{1,200}:?[ \t]{0,8}$/;

  function splitLines(text) {
    return String(text == null ? '' : text).split(/\r\n|\r|\n/);
  }

  function isTableRow(line) {
    if (typeof line !== 'string') return false;
    var t = line.replace(/^[ \t]{0,8}/, '');
    return t.charAt(0) === '|';
  }

  // "| --- | :-: |" — validated by splitting (linear), not by a nested regex.
  function isTableSeparator(line) {
    if (!isTableRow(line)) return false;
    var trimmed = line.trim();
    var body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    if (body.indexOf('-') === -1) return false;
    var cells = body.split('|');
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!TABLE_SEP_CELL_RE.test(cells[i])) return false;
    }
    return true;
  }

  function tableCells(line) {
    var trimmed = String(line == null ? '' : line).trim();
    var body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    var cells = body.split('|');
    var out = [];
    for (var i = 0; i < cells.length && i < MAX_CELLS; i++) out.push(cells[i].trim());
    return out;
  }

  function extractParts(rawContent) {
    var content = normalizeMessageContent(rawContent);
    var parts = [];
    var seq = 0;
    function push(type, label, text) {
      if (parts.length >= MAX_PARTS) return;
      var body = trimEndLinear(text);
      if (!body.trim()) return;
      parts.push({
        id: type + '-' + (seq++),
        type: type,
        label: clamp(label, MAX_LABEL) || type,
        content: body
      });
    }

    if (!content.trim()) return parts;
    push('full', t('전체 답변'), content);

    var lines = splitLines(content);
    var limit = Math.min(lines.length, MAX_SCAN_LINES);
    var fence = null;            // open fence info while inside a code block
    var fenceStart = -1;
    var pendingSection = null;   // {label, start}
    var i;

    function closeSection(endExclusive) {
      if (!pendingSection) return;
      var body = lines.slice(pendingSection.start, endExclusive).join('\n');
      push('section', pendingSection.label, body);
      pendingSection = null;
    }

    for (i = 0; i < limit; i++) {
      var line = lines[i];

      if (fence) {
        if (isFenceClose(line, fence.ticks)) {
          if (fence.lang === 'mermaid') {
            var block = lines.slice(fenceStart, i + 1).join('\n');
            push('mermaid', t('다이어그램: ') + clamp(lines[fenceStart + 1] || '', 40), block);
          }
          fence = null;
          fenceStart = -1;
        }
        continue;
      }

      var open = parseFenceOpen(line);
      if (open) {
        fence = open;
        fenceStart = i;
        continue;
      }

      var heading = HEADING_RE.exec(line);
      if (heading) {
        var level = heading[1].length;
        if (level <= 2) {
          closeSection(i);
          if (level === 2) pendingSection = { label: t('섹션: ') + clamp(heading[2], 48), start: i };
        }
        continue;
      }

      if (isTableRow(line) && i + 1 < limit && isTableSeparator(lines[i + 1])) {
        var tableStart = i;
        var end = i + 2;
        while (end < limit && isTableRow(lines[end])) end++;
        var tableText = lines.slice(tableStart, end).join('\n');
        push('table', t('표: ') + clamp(tableCells(lines[tableStart]).join(' | '), 60), tableText);
        i = end - 1;
        continue;
      }
    }

    // Malformed input: an unterminated mermaid fence still yields a block
    // (everything to the end of the message); an unterminated fence of any
    // other language is ignored. An open section runs to the end.
    if (fence && fence.lang === 'mermaid' && fenceStart >= 0) {
      push('mermaid', t('다이어그램(닫히지 않은 블록): ') + clamp(lines[fenceStart + 1] || '', 32),
        lines.slice(fenceStart, limit).join('\n'));
    }
    closeSection(limit);
    return parts;
  }

  function contentTypeForPart(type) {
    if (type === 'table') return 'table';
    if (type === 'mermaid') return 'mermaid';
    return 'markdown';
  }

  function validateCard(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card) || card.kind !== 'card') return false;
    var data = card.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    var fields = ['name', 'profile', 'sessionId', 'contentHash'];
    for (var i = 0; i < fields.length; i++) if (typeof card[fields[i]] !== 'string') return false;
    fields = ['content', 'partType', 'contentType', 'partLabel', 'sessionTitle'];
    for (var j = 0; j < fields.length; j++) if (typeof data[fields[j]] !== 'string') return false;
    if (card.id !== undefined && (typeof card.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(card.id))) return false;
    if (card.createdAt !== undefined && (typeof card.createdAt !== 'number' || !isFinite(card.createdAt))) return false;
    if (card.updatedAt !== undefined && (typeof card.updatedAt !== 'number' || !isFinite(card.updatedAt))) return false;
    if (!card.sessionId || (card.role !== 'user' && card.role !== 'assistant')) return false;
    if (!Number.isSafeInteger(card.messageIndex) || card.messageIndex < 0) return false;
    if (data.partType !== 'full' && data.partType !== 'section' && data.partType !== 'table' && data.partType !== 'mermaid') return false;
    if (data.contentType !== contentTypeForPart(data.partType)) return false;
    if (!/^(?:[a-fA-F0-9]{64}|fnv1a128-[a-fA-F0-9]{32})$/.test(card.contentHash)) return false;
    var ref = data.savedFrom;
    return !!ref && typeof ref === 'object' && !Array.isArray(ref)
      && typeof ref.profile === 'string' && ref.profile === card.profile
      && ref.sessionId === card.sessionId && ref.messageIndex === card.messageIndex && ref.role === card.role;
  }

  function validatedImport(text) {
    var parsed = JSON.parse(text);
    var rows = Array.isArray(parsed) ? parsed : parsed && parsed.items;
    if (!Array.isArray(rows)) throw new Error('invalid import');
    var valid = rows.filter(validateCard);
    return { text: JSON.stringify({ v: 1, namespace: NAMESPACE, items: valid }), skipped: rows.length - valid.length };
  }

  var PART_BADGES = { full: '전체 답변', table: '표', mermaid: '다이어그램', section: '섹션' };

  function badgeForCard(card) {
    var data = (card && card.data) || {};
    if (PART_BADGES[data.partType]) return t(PART_BADGES[data.partType]);
    if (data.contentType === 'table') return t('표');
    if (data.contentType === 'mermaid') return t('다이어그램');
    return t('내용');
  }

  // ── minimal safe renderer ────────────────────────────────────────────────
  // Supports ONLY tables, headings, paragraphs and fenced code. Every piece of
  // model text goes through escapeHtml() before it reaches the HTML string, and
  // no model text is ever interpolated into an attribute value.
  function renderMarkdownToSafeHtml(text) {
    var lines = splitLines(text);
    var truncated = lines.length > MAX_RENDER_LINES;
    var limit = Math.min(lines.length, MAX_RENDER_LINES);
    var html = [];
    var para = [];

    function flushParagraph() {
      if (!para.length) return;
      html.push('<p>' + para.map(escapeHtml).join('<br>') + '</p>');
      para = [];
    }

    var i = 0;
    while (i < limit) {
      var line = lines[i];

      var open = parseFenceOpen(line);
      if (open) {
        flushParagraph();
        var lang = open.lang;
        var body = [];
        var j = i + 1;
        while (j < limit) {
          if (isFenceClose(lines[j], open.ticks)) break;
          body.push(lines[j]);
          j++;
        }
        if (lang) html.push('<div class="sgkv-pre-head">' + escapeHtml(lang) + '</div>');
        html.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
        i = (j < limit ? j + 1 : limit);
        continue;
      }

      var heading = HEADING_RE.exec(line);
      if (heading) {
        flushParagraph();
        var tag = 'h' + Math.min(6, 2 + heading[1].length);
        html.push('<' + tag + '>' + escapeHtml(heading[2].trim()) + '</' + tag + '>');
        i++;
        continue;
      }

      if (isTableRow(line) && i + 1 < limit && isTableSeparator(lines[i + 1])) {
        flushParagraph();
        var head = tableCells(line);
        var rows = [];
        var k = i + 2;
        while (k < limit && isTableRow(lines[k])) { rows.push(tableCells(lines[k])); k++; }
        var table = ['<table><thead><tr>'];
        for (var h = 0; h < head.length; h++) table.push('<th>' + escapeHtml(head[h]) + '</th>');
        table.push('</tr></thead><tbody>');
        for (var r = 0; r < rows.length; r++) {
          table.push('<tr>');
          for (var c = 0; c < head.length; c++) table.push('<td>' + escapeHtml(rows[r][c] || '') + '</td>');
          table.push('</tr>');
        }
        table.push('</tbody></table>');
        html.push(table.join(''));
        i = k;
        continue;
      }

      if (!line.trim()) { flushParagraph(); i++; continue; }
      para.push(line);
      i++;
    }
    flushParagraph();
    if (truncated) html.push(t('<p class="sgkv-trunc">… (긴 내용의 일부만 표시됨)</p>'));
    return '<div class="sgkv-md">' + html.join('') + '</div>';
  }

  // Strips the surrounding fence from a saved mermaid snapshot so the code can
  // be handed to mermaid.render().
  function mermaidCode(snapshot) {
    var lines = splitLines(snapshot);
    if (!lines.length) return '';
    var open = parseFenceOpen(lines[0]);
    if (!open) return String(snapshot == null ? '' : snapshot);
    var body = [];
    for (var i = 1; i < lines.length && i <= MAX_RENDER_LINES; i++) {
      if (isFenceClose(lines[i], open.ticks)) break;
      body.push(lines[i]);
    }
    return body.join('\n');
  }

  // ── content hash ─────────────────────────────────────────────────────────
  // Primary: SHA-256 hex via crypto.subtle (64 lowercase hex chars).
  // Documented fallback: when crypto.subtle / TextEncoder are unavailable or
  // throw (non-secure context, locked-down browser), a NON-CRYPTOGRAPHIC
  // 128-bit FNV-1a composite prefixed 'fnv1a128-'. It is only used to detect
  // "did the source message change", never for integrity against an attacker,
  // and the prefix keeps the two schemes from ever comparing as equal.
  function fnv1a32(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      h = (h ^ (code & 0xff)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
      h = (h ^ ((code >>> 8) & 0xff)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hex32(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  function fnv1a128Hex(str) {
    return hex32(fnv1a32(str, 0x811c9dc5)) + hex32(fnv1a32(str, 0x9dc5811c))
      + hex32(fnv1a32(str, 0x1c9dc581)) + hex32(fnv1a32(str, 0xc5811c9d));
  }

  function bufferToHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }

  // cryptoRef is injectable so both paths are unit-testable.
  function contentHash(text, cryptoRef) {
    var source = String(text == null ? '' : text);
    var c = cryptoRef === undefined ? (typeof crypto !== 'undefined' ? crypto : null) : cryptoRef;
    var canSubtle = !!(c && c.subtle && typeof c.subtle.digest === 'function'
      && typeof TextEncoder !== 'undefined');
    if (!canSubtle) return Promise.resolve(FALLBACK_HASH_PREFIX + fnv1a128Hex(source));
    try {
      return Promise.resolve(c.subtle.digest('SHA-256', new TextEncoder().encode(source)))
        .then(bufferToHex)
        .catch(function () { return FALLBACK_HASH_PREFIX + fnv1a128Hex(source); });
    } catch (_err) {
      return Promise.resolve(FALLBACK_HASH_PREFIX + fnv1a128Hex(source));
    }
  }

  function hashSchemesComparable(a, b) {
    var aFallback = String(a || '').indexOf(FALLBACK_HASH_PREFIX) === 0;
    var bFallback = String(b || '').indexOf(FALLBACK_HASH_PREFIX) === 0;
    return !!a && !!b && aFallback === bFallback;
  }

  // ── guards shared by the save / open / jump paths (DOM-free) ─────────────
  // Runs fn and always returns a promise, so a store method that throws
  // synchronously becomes a rejection the caller's .catch() sees.
  function attempt(fn) {
    try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); }
  }

  // "이 기기에만 저장됨" unless the store positively reports a successful sync.
  function isLocalOnly(store) {
    return !store || store.synced !== true;
  }

  // Store items are capped at ~256 KiB (sidecar proxy buffer, localStorage
  // quota); refuse before writing instead of surfacing a generic failure.
  var MAX_CARD_BYTES = 256 * 1024;

  // ASCII-escaped JSON bytes, matching the shared store and sidecar.
  function cardByteSize(card) {
    var mod = storeModule();
    if (mod && typeof mod.measureItemBytes === 'function') return mod.measureItemBytes(card);
    var json;
    try { json = JSON.stringify(card); } catch (_err) { return Infinity; }
    var bytes = 0;
    for (var i = 0; i < json.length; i++) {
      var code = json.charCodeAt(i);
      bytes += code >= 0x20 && code <= 0x7e ? 1 : 6;
    }
    return bytes;
  }

  function isTooLargeError(err) {
    if (!err) return false;
    var code = String(err.code || '').toLowerCase();
    return code === 'too_large' || code === 'payload_too_large' || err.status === 413;
  }

  function normalizeForCompare(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  // Compare the complete normalized source captured from Core at invoke time.
  function messageMatchesContext(msg, expected) {
    var want = expected || {};
    var role = msg && typeof msg.role === 'string' ? msg.role : '';
    if (want.role !== 'user' && want.role !== 'assistant') return { ok: false, reason: 'source_unavailable' };
    if (role !== want.role) return { ok: false, reason: 'role_mismatch' };
    if (typeof want.text !== 'string') return { ok: false, reason: 'source_unavailable' };
    var visible = normalizeForCompare(want.text);
    var content = normalizeForCompare(normalizeMessageContent(msg && msg.content));
    if (visible === content) return { ok: true };
    return { ok: false, reason: 'text_mismatch' };
  }

  var MISMATCH_MESSAGES = {
    role_mismatch: '서버의 같은 위치에 다른 메시지가 있습니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.',
    text_mismatch: '화면의 답변과 서버의 원문이 다릅니다. 대화가 수정·재생성되었을 수 있으니 새로고침한 뒤 다시 시도해 주세요.'
  };

  // The suggested card title follows the selected part.
  function defaultTitleForPart(part, sessionTitle) {
    if (!part) return t('저장된 결과');
    if (part.type === 'full') return clamp(sessionTitle, MAX_LABEL) || t('전체 답변');
    return part.label || t('저장된 결과');
  }

  // ── card builder ─────────────────────────────────────────────────────────
  // Builds the HermesVizStore item for a chosen part (README.md, Storage and sync).
  // `fullContent` is the WHOLE message content: contentHash always covers the
  // full message so 원문 변경 확인 detects any edit, not only edits inside the
  // saved part.
  function buildCard(opts) {
    var o = opts || {};
    var part = o.part || {};
    var fullContent = normalizeMessageContent(o.fullContent);
    return contentHash(fullContent, o.cryptoRef).then(function (hash) {
      var savedFrom = {
        profile: String(o.profile || 'default'),
        sessionId: String(o.sessionId || ''),
        messageIndex: Number(o.messageIndex),
        role: o.role === 'user' ? 'user' : 'assistant'
      };
      var card = {
        kind: 'card',
        name: String(o.name || part.label || t('저장된 결과')),
        immutable: true,
        contentHash: hash,
        profile: savedFrom.profile,
        sessionId: savedFrom.sessionId,
        messageIndex: savedFrom.messageIndex,
        role: savedFrom.role,
        data: {
          contentType: contentTypeForPart(part.type),
          content: String(part.content == null ? '' : part.content),
          partType: part.type || 'full',
          partLabel: String(part.label || ''),
          sessionTitle: String(o.sessionTitle || ''),
          savedFrom: savedFrom
        }
      };
      if (o.id) card.id = o.id;
      return card;
    });
  }

  // ── core / contract bridges (all optional, all guarded) ──────────────────
  function coreState() {
    // `S` is a top-level `const` in a core classic script: a global lexical
    // binding, reachable as a bare identifier but NOT as window.S.
    try { return (typeof S !== 'undefined' && S) ? S : null; } catch (_err) { return null; }
  }

  function toast(message, type) {
    try {
      if (typeof showToast === 'function') { showToast(String(message), null, type || undefined); return; }
    } catch (_err) { /* fall through to our own toast */ }
    try {
      var el = document.getElementById('sgkvToast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sgkvToast';
        el.className = 'sgkv-toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      el.textContent = String(message);
      el.classList.add('sgkv-toast--show');
      window.setTimeout(function () { el.classList.remove('sgkv-toast--show'); }, 3200);
    } catch (_err2) { /* never crash core */ }
  }

  function storeModule() {
    var mod = window.HermesVizStore;
    if (!mod || typeof mod.open !== 'function' || !(mod.version >= 1)) return null;
    return mod;
  }

  var storeHandle = null;
  var storeUnsubscribe = null;

  function getStore() {
    if (storeHandle) return storeHandle;
    var mod = storeModule();
    if (!mod) return null;
    try { storeHandle = mod.open(NAMESPACE); } catch (_err) { storeHandle = null; }
    if (storeHandle && !storeUnsubscribe && typeof storeHandle.subscribe === 'function') {
      try {
        storeUnsubscribe = storeHandle.subscribe(function () { refreshList(); });
      } catch (_err2) { storeUnsubscribe = null; }
    }
    return storeHandle;
  }

  function navModule() {
    var mod = window.HermesVizNav;
    if (!mod || typeof mod.goTo !== 'function' || !(mod.version >= 1)) return null;
    return mod;
  }

  function currentTarget() {
    var nav = navModule();
    if (nav && typeof nav.currentTarget === 'function') {
      try {
        var t = nav.currentTarget();
        if (t && t.sessionId) return { sessionId: String(t.sessionId), profile: String(t.profile || 'default') };
      } catch (_err) { /* fall through */ }
    }
    var s = coreState();
    if (s && s.session && s.session.session_id) {
      return { sessionId: String(s.session.session_id), profile: String(s.activeProfile || 'default') };
    }
    return null;
  }

  function currentProfile() {
    var t = currentTarget();
    if (t) return t.profile;
    var s = coreState();
    return String((s && s.activeProfile) || 'default');
  }

  // ── session fetch ────────────────────────────────────────────────────────
  // Absolute same-origin fetch; never route-relative (a /session/<id> route
  // would resolve a relative path wrong).
  function fetchSessionMessage(sessionId, messageIndex) {
    var url = '/api/session?session_id=' + encodeURIComponent(String(sessionId))
      + '&messages=1&resolve_model=0&msg_limit=all';
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res || !res.ok) throw new Error('session fetch failed: ' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var session = data && data.session;
      var messages = (session && session.messages) || [];
      var row = messages[messageIndex];
      if (!row) throw new Error('message ' + messageIndex + ' not found');
      return {
        content: normalizeMessageContent(row.content),
        // Raw role, not coerced: a tool/system row at this index must fail
        // the role check instead of passing as 'assistant'.
        role: typeof row.role === 'string' ? row.role : '',
        sessionTitle: String((session && (session.title || session.name)) || ''),
        messageCount: messages.length
      };
    });
  }

  // ── own DOM: observer discipline ─────────────────────────────────────────
  // One scoped observer on document.body's direct children only (our fab and
  // panel live there). It is disconnected while we write our own DOM so our
  // writes can never feed themselves back in.
  var bodyObserver = null;
  var ownWriteDepth = 0;

  function withOwnWrites(fn) {
    ownWriteDepth++;
    if (bodyObserver) { try { bodyObserver.disconnect(); } catch (_err) {} }
    try { return fn(); }
    finally {
      ownWriteDepth--;
      if (!ownWriteDepth && bodyObserver && document.body) {
        try { bodyObserver.observe(document.body, { childList: true }); } catch (_err2) {}
      }
    }
  }

  function startBodyObserver() {
    if (bodyObserver || typeof MutationObserver === 'undefined' || !document.body) return;
    bodyObserver = new MutationObserver(function () {
      if (ownWriteDepth) return;
      // Only ever reacts to our own chrome disappearing (a core re-render of
      // document.body's children); the list is re-read so the count badge on
      // the fresh button is not stuck at 0.
      if (document.getElementById('sgkvFab')) return;
      mountChrome();
      refreshList();
    });
    try { bodyObserver.observe(document.body, { childList: true }); } catch (_err) { bodyObserver = null; }
  }

  // ── UI: elements ─────────────────────────────────────────────────────────
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    var b = el('button', className, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function formatTime(ms) {
    if (typeof ms !== 'number') return '';
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    try {
      var d = new Date(n);
      var pad = function (v) { return ('0' + v).slice(-2); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (_err) { return ''; }
  }

  function mountChrome() {
    if (!document.body) return;
    withOwnWrites(function () {
      if (!document.getElementById('sgkvFab')) {
        var fab = button(t('보관함'), 'sgkv-fab', togglePanel);
        fab.id = 'sgkvFab';
        fab.title = t('결과 보관함 열기');
        fab.setAttribute('aria-expanded', 'false');
        var count = el('span', 'sgkv-fab-count', '0');
        count.id = 'sgkvFabCount';
        count.hidden = true;
        fab.appendChild(count);
        document.body.appendChild(fab);
      }
      if (!document.getElementById('sgkvPanel')) {
        document.body.appendChild(buildPanel());
      }
      if (!document.getElementById('sgkvLayer')) {
        var layer = el('div', 'sgkv-layer');
        layer.id = 'sgkvLayer';
        layer.hidden = true;
        document.body.appendChild(layer);
      }
    });
    startFabObserver();
    positionFab();
  }

  var fabObserver = null;
  var fabResizeObserver = null;
  var observedScrollButton = null;
  function positionFab() {
    var fab = document.getElementById('sgkvFab');
    if (!fab) return;
    var control = document.getElementById('scrollToBottomBtn');
    if (fabResizeObserver && control !== observedScrollButton) {
      if (observedScrollButton) fabResizeObserver.unobserve(observedScrollButton);
      if (control) fabResizeObserver.observe(control);
      observedScrollButton = control;
    }
    var bottom = window.innerWidth <= 480 ? 120 : 132;
    if (control) {
      var rect = control.getBoundingClientRect();
      var visible = rect.width > 0 && rect.height > 0;
      for (var node = control; node && visible && node.nodeType === 1; node = node.parentElement) {
        var style = window.getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') visible = false;
      }
      if (visible) bottom = Math.max(bottom, window.innerHeight - rect.top + 8);
    }
    var value = bottom + 'px';
    if (fab.style.bottom !== value) fab.style.bottom = value;
  }

  function startFabObserver() {
    if (fabObserver || typeof MutationObserver === 'undefined') return;
    fabObserver = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (target.nodeType === 1 && target.closest('[id^="sgkv"], [class^="sgkv-"]')) continue;
        positionFab();
        break;
      }
    });
    fabObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    if (typeof ResizeObserver !== 'undefined') {
      fabResizeObserver = new ResizeObserver(positionFab);
      fabResizeObserver.observe(document.documentElement);
    }
    window.addEventListener('resize', positionFab);
  }

  function buildPanel() {
    var panel = el('aside', 'sgkv-panel');
    panel.id = 'sgkvPanel';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('결과 보관함'));

    var head = el('div', 'sgkv-panel-head');
    head.appendChild(el('span', 'sgkv-panel-title', t('결과 보관함')));
    var actions = el('div', 'sgkv-panel-actions');
    actions.appendChild(button(t('내보내기'), 'sgkv-btn sgkv-btn--ghost', exportCards));
    actions.appendChild(button(t('가져오기'), 'sgkv-btn sgkv-btn--ghost', importCards));
    var close = button('×', 'sgkv-btn sgkv-btn--icon', closePanel);
    close.setAttribute('aria-label', t('닫기'));
    actions.appendChild(close);
    head.appendChild(actions);
    panel.appendChild(head);

    var notice = el('div', 'sgkv-notice');
    notice.id = 'sgkvNotice';
    notice.hidden = true;
    panel.appendChild(notice);

    var list = el('div', 'sgkv-list');
    list.id = 'sgkvList';
    panel.appendChild(list);
    return panel;
  }

  function setNotice(message) {
    var notice = document.getElementById('sgkvNotice');
    if (!notice) return;
    withOwnWrites(function () {
      notice.textContent = String(message || '');
      notice.hidden = !message;
    });
  }

  function togglePanel() {
    var panel = document.getElementById('sgkvPanel');
    if (!panel) return;
    if (panel.hidden) openPanel(); else closePanel();
  }

  function openPanel() {
    var panel = document.getElementById('sgkvPanel');
    var fab = document.getElementById('sgkvFab');
    if (!panel) return;
    withOwnWrites(function () {
      panel.hidden = false;
      if (fab) {
        fab.setAttribute('aria-expanded', 'true');
        // At phone width the panel is a bottom sheet that would sit on top of
        // the button; hide it while the sheet is open (CSS, >480px keeps it).
        fab.classList.add('sgkv-fab--panel-open');
      }
    });
    refreshList();
  }

  function closePanel() {
    var panel = document.getElementById('sgkvPanel');
    var fab = document.getElementById('sgkvFab');
    if (!panel) return;
    withOwnWrites(function () {
      panel.hidden = true;
      if (fab) {
        fab.setAttribute('aria-expanded', 'false');
        fab.classList.remove('sgkv-fab--panel-open');
      }
    });
  }

  // ── UI: card list ────────────────────────────────────────────────────────
  function refreshList() {
    localizeChrome();
    var list = document.getElementById('sgkvList');
    if (!list) return Promise.resolve();
    var store = getStore();
    if (!store) {
      setNotice(t('저장 모듈(HermesVizStore)을 불러올 수 없어 보관함 저장 기능을 쓸 수 없습니다.'));
      withOwnWrites(function () {
        list.textContent = '';
        list.appendChild(el('div', 'sgkv-empty', t('저장된 카드를 읽을 수 없습니다.')));
      });
      updateCount(0);
      return Promise.resolve();
    }
    setNotice('');
    var ready = store.ready && typeof store.ready.then === 'function' ? store.ready : Promise.resolve();
    return ready.catch(function () {}).then(function () {
      return attempt(function () { return store.list({ kind: 'card' }); });
    }).then(function (items) {
      renderList(items || []);
    }).catch(function (err) {
      setNotice(t('보관함을 읽는 중 오류가 발생했습니다.'));
      try { console.warn('[' + EXT_ID + '] list failed', err); } catch (_e) {}
    });
  }

  function localizeChrome() {
    registerExtension();
    var fab = document.getElementById('sgkvFab');
    if (fab) {
      if (fab.firstChild && fab.firstChild.nodeType === 3) fab.firstChild.nodeValue = t('보관함');
      fab.title = t('결과 보관함 열기');
    }
    var panel = document.getElementById('sgkvPanel');
    if (!panel) return;
    panel.setAttribute('aria-label', t('결과 보관함'));
    panel.querySelector('.sgkv-panel-title').textContent = t('결과 보관함');
    var actions = panel.querySelectorAll('.sgkv-panel-actions button');
    actions[0].textContent = t('내보내기');
    actions[1].textContent = t('가져오기');
    actions[2].setAttribute('aria-label', t('닫기'));
  }

  function updateCount(n) {
    var count = document.getElementById('sgkvFabCount');
    if (!count) return;
    withOwnWrites(function () {
      count.textContent = String(n);
      count.hidden = !n;
    });
  }

  function renderList(items) {
    var list = document.getElementById('sgkvList');
    if (!list) return;
    // Recomputed on every render (the panel re-renders each time it opens and
    // on every store event), so a later successful sync clears the badge.
    var localOnly = isLocalOnly(getStore());
    withOwnWrites(function () {
      list.textContent = '';
      if (!items.length) {
        list.appendChild(el('div', 'sgkv-empty',
          t('저장된 카드가 없습니다. 답변의 ★ 버튼으로 결과를 보관하세요.')));
        return;
      }
      for (var i = 0; i < items.length; i++) {
        list.appendChild(buildCardRow(items[i], localOnly));
      }
    });
    updateCount(items.length);
  }

  function buildCardRow(card, localOnly) {
    var row = el('div', 'sgkv-card');
    if (!validateCard(card)) {
      row.appendChild(el('span', 'sgkv-card-name', t('손상된 카드')));
      if (card && typeof card.id === 'string') row.appendChild(button(t('삭제'), 'sgkv-btn sgkv-btn--danger', function () {
        confirmModal(t('카드 삭제'), t('손상된 카드를 삭제할까요? 되돌릴 수 없습니다.'), t('삭제')).then(function (ok) {
          if (!ok) return;
          var store = getStore();
          return attempt(function () { return store.remove(card.id); }).then(refreshList);
        }).catch(function () { toast(t('삭제하지 못했습니다.'), 'error'); });
      }));
      return row;
    }
    var open = button('', 'sgkv-card-open');
    open.appendChild(el('span', 'sgkv-card-name', card.name || t('(제목 없음)')));
    var meta = el('div', 'sgkv-card-meta');
    meta.appendChild(el('span', 'sgkv-badge', badgeForCard(card)));
    meta.appendChild(el('span', 'sgkv-card-time', formatTime(card.createdAt)));
    if (localOnly) meta.appendChild(el('span', 'sgkv-badge sgkv-badge--local', t('이 기기에만 저장됨')));
    open.appendChild(meta);
    open.addEventListener('click', function () { openCardModal(card.id); });
    row.appendChild(open);
    return row;
  }

  // ── UI: modal layer ──────────────────────────────────────────────────────
  var activeModal = null;   // {node, onClose}

  function closeModal() {
    var layer = document.getElementById('sgkvLayer');
    var modal = activeModal;
    activeModal = null;
    withOwnWrites(function () {
      if (layer) { layer.textContent = ''; layer.hidden = true; }
    });
    document.removeEventListener('keydown', modalKeydown, true);
    if (modal && typeof modal.onClose === 'function') {
      try { modal.onClose(); } catch (_err) {}
    }
  }

  // Closes the modal only if `box` is still the one on screen: an async
  // completion (a late save, a slow refetch) must never close whatever dialog
  // the user opened in the meantime.
  function closeModalIf(box) {
    if (!activeModal || activeModal.node !== box) return false;
    closeModal();
    return true;
  }

  function isActiveModal(box) {
    return !!activeModal && activeModal.node === box;
  }

  function modalKeydown(ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); closeModal(); }
  }

  // Opens a modal. `onClose` always runs exactly once, so a pending
  // message-action thenable can never stay unsettled.
  function openModal(title, onClose) {
    var layer = document.getElementById('sgkvLayer');
    if (!layer) return null;
    if (activeModal) closeModal();
    var box = el('div', 'sgkv-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    var head = el('div', 'sgkv-modal-head');
    head.appendChild(el('span', 'sgkv-modal-title', title));
    var x = button('×', 'sgkv-btn sgkv-btn--icon', closeModal);
    x.setAttribute('aria-label', t('닫기'));
    head.appendChild(x);
    box.appendChild(head);
    var body = el('div', 'sgkv-modal-body');
    box.appendChild(body);
    var foot = el('div', 'sgkv-modal-foot');
    box.appendChild(foot);

    withOwnWrites(function () {
      layer.textContent = '';
      layer.hidden = false;
      layer.appendChild(box);
    });
    layer.onclick = function (ev) { if (ev.target === layer) closeModal(); };
    document.addEventListener('keydown', modalKeydown, true);
    activeModal = { node: box, onClose: onClose };
    return { box: box, body: body, foot: foot };
  }

  function confirmModal(title, message, confirmLabel) {
    return new Promise(function (resolve) {
      var answered = false;
      var m = openModal(title, function () { if (!answered) { answered = true; resolve(false); } });
      if (!m) { resolve(false); return; }
      m.body.appendChild(el('p', 'sgkv-text', message));
      m.foot.appendChild(button(t('취소'), 'sgkv-btn', closeModal));
      m.foot.appendChild(button(confirmLabel || t('확인'), 'sgkv-btn sgkv-btn--danger', function () {
        answered = true;
        closeModal();
        resolve(true);
      }));
    });
  }

  function promptModal(title, label, initial) {
    return new Promise(function (resolve) {
      var answered = false;
      var m = openModal(title, function () { if (!answered) { answered = true; resolve(null); } });
      if (!m) { resolve(null); return; }
      var field = el('label', 'sgkv-field');
      field.appendChild(el('span', 'sgkv-field-label', label));
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'sgkv-input';
      input.value = String(initial == null ? '' : initial);
      input.maxLength = 120;
      field.appendChild(input);
      m.body.appendChild(field);
      function submit() {
        var value = input.value.trim();
        if (!value) { input.focus(); return; }
        answered = true;
        closeModal();
        resolve(value);
      }
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
      m.foot.appendChild(button(t('취소'), 'sgkv-btn', closeModal));
      m.foot.appendChild(button(t('확인'), 'sgkv-btn sgkv-btn--primary', submit));
      try { input.focus(); input.select(); } catch (_err) {}
    });
  }

  // ── save flow (message action) ───────────────────────────────────────────
  // DOM-free steps first so they are unit-testable.

  // Refetches the clicked row and proves it is still that row (role + full
  // normalized content). Resolves {ok:true, msg, parts} or {ok:false, reason}.
  function prepareSave(opts) {
    var o = opts || {};
    return attempt(function () { return fetchSessionMessage(o.sessionId, o.messageIndex); })
      .then(function (msg) {
        var check = messageMatchesContext(msg, { role: o.role, text: o.expectedText });
        if (!check.ok) return { ok: false, reason: check.reason };
        var parts = extractParts(msg.content);
        if (!parts.length) return { ok: false, reason: 'empty' };
        return { ok: true, msg: msg, parts: parts };
      }, function () {
        return { ok: false, reason: 'fetch_failed' };
      });
  }

  // Builds and stores one immutable card. Resolves {ok:true, item} or
  // {ok:false, reason: 'no_store'|'too_large'|'immutable'|'failed', bytes?}.
  function saveCard(store, opts) {
    if (!store || typeof store.put !== 'function') return Promise.resolve({ ok: false, reason: 'no_store' });
    return buildCard(opts).then(function (card) {
      var bytes = cardByteSize(card);
      if (bytes > MAX_CARD_BYTES) return { ok: false, reason: 'too_large', bytes: bytes };
      return attempt(function () { return store.put(card); }).then(function (item) {
        return { ok: true, item: item };
      }, function (err) {
        if (err && err.code === 'immutable') return { ok: false, reason: 'immutable' };
        if (err && (err.code === 'quota' || err.code === 'quota_exceeded' || err.name === 'QuotaExceededError')) return { ok: false, reason: 'quota' };
        if (isTooLargeError(err)) return { ok: false, reason: 'too_large', bytes: bytes };
        try { console.warn('[' + EXT_ID + '] save failed', err); } catch (_e) {}
        return { ok: false, reason: 'failed' };
      });
    });
  }

  function saveFailureMessage(res) {
    if (res.reason === 'quota') return t('보관함 저장 한도(1,000개 / 2 MiB)에 도달했습니다. 카드를 삭제하거나 내보낸 뒤 다시 시도해 주세요.');
    if (res.reason === 'too_large') {
      var kib = isFinite(res.bytes) ? Math.ceil(res.bytes / 1024) : null;
      return t('카드가 너무 큽니다 (') + (kib ? t('약 ') + kib + ' KiB, ' : '') + t('최대 ')
        + Math.floor(MAX_CARD_BYTES / 1024) + t(' KiB). 표·다이어그램·섹션처럼 더 작은 조각을 골라 주세요.');
    }
    if (res.reason === 'immutable') return t('이미 저장된 카드는 바꿀 수 없습니다. 새 저장본으로 만들어 주세요.');
    if (res.reason === 'no_store') return t('저장 모듈이 없어 저장할 수 없습니다.');
    return t('저장에 실패했습니다.');
  }

  // Returns a promise that ALWAYS settles when the dialog closes: core keeps
  // the star button pending and suppresses re-clicks until the thenable
  // settles (upstream static/extension_settings.js:596-646).
  function openSaveDialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      var m = openModal(o.title || t('결과 보관함에 저장'), done);
      if (!m) { done(); return; }

      var status = el('p', 'sgkv-text', t('원문을 불러오는 중…'));
      m.body.appendChild(status);

      function showError(message) {
        withOwnWrites(function () {
          m.body.textContent = '';
          m.body.appendChild(el('p', 'sgkv-error', message));
          m.foot.textContent = '';
          m.foot.appendChild(button(t('닫기'), 'sgkv-btn', function () { closeModalIf(m.box); }));
        });
      }

      prepareSave(o).then(function (prep) {
        if (settled || !isActiveModal(m.box)) return;
        if (!prep.ok) {
          showError(prep.reason === 'fetch_failed'
            ? t('원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
            : (prep.reason === 'empty' ? t('저장할 내용을 찾지 못했습니다.') : t(MISMATCH_MESSAGES[prep.reason] || '클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.')));
          return;
        }
        var msg = prep.msg;
        var parts = prep.parts;
        withOwnWrites(function () {
          m.body.textContent = '';

          if (isLocalOnly(getStore())) {
            var local = el('p', 'sgkv-text');
            local.appendChild(el('span', 'sgkv-badge sgkv-badge--local', t('이 기기에만 저장됨')));
            local.appendChild(document.createTextNode(t(' 이 브라우저에만 보관되며 다른 기기와 동기화되지 않습니다.')));
            m.body.appendChild(local);
          }

          var nameField = el('label', 'sgkv-field');
          nameField.appendChild(el('span', 'sgkv-field-label', t('제목')));
          var nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.className = 'sgkv-input';
          nameInput.maxLength = 120;
          // A caller-supplied name (새 저장본) counts as a user edit: it is
          // kept when another part is selected.
          var nameEdited = !!o.defaultName;
          nameInput.value = o.defaultName ? String(o.defaultName) : defaultTitleForPart(parts[0], msg.sessionTitle);
          nameInput.addEventListener('input', function () { nameEdited = true; });
          nameField.appendChild(nameInput);
          m.body.appendChild(nameField);

          m.body.appendChild(el('div', 'sgkv-field-label', t('저장할 내용')));
          var chooser = el('div', 'sgkv-chooser');
          var selected = parts[0];
          var buttons = [];
          var preview = el('pre', 'sgkv-preview', parts[0].content.slice(0, 600));
          for (var i = 0; i < parts.length; i++) {
            (function (part) {
              var b = button('', 'sgkv-choice');
              b.appendChild(el('span', 'sgkv-badge', t(PART_BADGES[part.type] || '내용')));
              b.appendChild(el('span', 'sgkv-choice-label', part.label));
              b.setAttribute('aria-pressed', part === selected ? 'true' : 'false');
              if (part === selected) b.classList.add('sgkv-choice--on');
              b.dataset.sgkvPartId = part.id;
              b.addEventListener('click', function () {
                selected = part;
                withOwnWrites(function () {
                  for (var k = 0; k < buttons.length; k++) {
                    var on = buttons[k].dataset.sgkvPartId === part.id;
                    buttons[k].classList.toggle('sgkv-choice--on', on);
                    buttons[k].setAttribute('aria-pressed', on ? 'true' : 'false');
                  }
                  preview.textContent = part.content.slice(0, 600);
                  if (!nameEdited) nameInput.value = defaultTitleForPart(part, msg.sessionTitle);
                });
              });
              buttons.push(b);
              chooser.appendChild(b);
            })(parts[i]);
          }
          m.body.appendChild(chooser);
          m.body.appendChild(preview);

          var error = el('p', 'sgkv-error');
          error.hidden = true;
          m.body.appendChild(error);

          m.foot.appendChild(button(t('취소'), 'sgkv-btn', function () { closeModalIf(m.box); }));
          var saveBtn = button(t('저장'), 'sgkv-btn sgkv-btn--primary', function () {
            saveBtn.disabled = true;
            saveCard(getStore(), {
              part: selected,
              fullContent: msg.content,
              name: nameInput.value.trim() || defaultTitleForPart(selected, msg.sessionTitle),
              profile: o.profile || currentProfile(),
              sessionId: o.sessionId,
              messageIndex: o.messageIndex,
              role: o.role,
              sessionTitle: msg.sessionTitle
            }).then(function (res) {
              if (res.ok) {
                toast(t('보관함에 저장했습니다.'), 'success');
                closeModalIf(m.box);
                refreshList();
                return;
              }
              if (!isActiveModal(m.box)) return;
              saveBtn.disabled = false;
              withOwnWrites(function () { error.textContent = saveFailureMessage(res); error.hidden = false; });
            }).catch(function (err) {
              if (isActiveModal(m.box)) {
                saveBtn.disabled = false;
                withOwnWrites(function () { error.textContent = t('저장에 실패했습니다.'); error.hidden = false; });
              }
              try { console.warn('[' + EXT_ID + '] save failed', err); } catch (_e) {}
            });
          });
          m.foot.appendChild(saveBtn);
          try { nameInput.focus(); nameInput.select(); } catch (_err) {}
        });
      }).catch(function (err) {
        if (!settled && isActiveModal(m.box)) showError(t('원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'));
        try { console.warn('[' + EXT_ID + '] save dialog failed', err); } catch (_e) {}
      });
    });
  }

  function onInvokeSaveCard(context) {
    // Capture Core state synchronously, before any fetch or modal work.
    var captured = captureMessage(context);
    if (!getStore()) {
      toast(t('저장 모듈(HermesVizStore)이 없어 저장할 수 없습니다.'), 'error');
      openPanel();
      return Promise.resolve();
    }
    if (!captured) {
      toast(t('클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.'), 'error');
      return Promise.resolve();
    }
    return openSaveDialog({
      sessionId: context.sessionId,
      messageIndex: context.messageIndex,
      role: captured.role,
      expectedText: captured.content,
      profile: currentProfile()
    });
  }

  function captureMessage(context) {
    var state = coreState();
    if (!context || !state || !state.session || state.session.session_id !== context.sessionId || !Array.isArray(state.messages)) return null;
    var offset;
    try { offset = typeof _oldestIdx !== 'undefined' ? _oldestIdx : state.session._messages_offset; } catch (_err) { return null; }
    if (offset === undefined && !state.session._messages_truncated) offset = 0;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(context.messageIndex)) return null;
    var index = context.messageIndex - offset;
    if (index < 0) return null;
    var msg = state.messages[index];
    if (!msg || msg.role !== context.role || (msg.role !== 'assistant' && msg.role !== 'user')) return null;
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) return null;
    var content = normalizeMessageContent(msg.content);
    if (!content) return null;
    return { role: msg.role, content: content };
  }

  // ── card actions (DOM-free, unit-testable) ───────────────────────────────
  // Validated top-level coordinates are authoritative.
  function sourceRefFor(card) {
    if (!validateCard(card)) return { profile: '', sessionId: '', messageIndex: NaN, role: '' };
    return {
      profile: card.profile,
      sessionId: card.sessionId,
      messageIndex: card.messageIndex,
      role: card.role
    };
  }

  // 원문 변경 확인 — refetch the source message and compare the FULL-content
  // hash with the one stored on the card (same normalisation, same scheme).
  // A row of a different role at that index is a different message.
  // The snapshot itself never changes.
  // status: 'same' | 'changed' | 'unknown' (+ reason).
  function checkSourceChanged(card) {
    var ref = sourceRefFor(card);
    if (!ref.sessionId || !isFinite(ref.messageIndex)) {
      return Promise.resolve({ status: 'unknown', reason: 'no_source' });
    }
    return attempt(function () { return fetchSessionMessage(ref.sessionId, ref.messageIndex); })
      .then(function (msg) {
        if (msg.role !== ref.role) return { status: 'changed', reason: 'role_mismatch' };
        return contentHash(msg.content).then(function (hash) {
          if (!hashSchemesComparable(hash, card && card.contentHash)) {
            return { status: 'unknown', reason: 'hash_scheme', hash: hash };
          }
          return { status: hash === card.contentHash ? 'same' : 'changed', hash: hash };
        });
      })
      .catch(function () {
        return { status: 'unknown', reason: 'fetch_failed' };
      });
  }

  function navigateTo(ref, nav) {
    return attempt(function () { return nav.goTo(ref); }).then(function (res) {
      return res && typeof res === 'object' ? res : { ok: false, reason: 'row_not_found' };
    }, function () { return { ok: false, reason: 'row_not_found' }; });
  }

  // 원문으로 이동 — HermesVizNav.goTo (README.md, WebUI surfaces used). The stored
  // index alone is not trusted (it is not durable across edit / regenerate /
  // truncate): the source is re-verified first, and the jump only happens when
  // it is unchanged, unless the caller passes {force:true} after the user
  // confirmed "그래도 이동".
  // Resolves {ok:true} | {ok:false, reason:'no_core'|'source_changed'|
  // 'source_unverified'|<nav reason>, check?}.
  function goToSource(card, opts) {
    if (!validateCard(card)) return Promise.resolve({ ok: false, reason: 'invalid_card' });
    var ref = sourceRefFor(card);
    var nav = navModule();
    if (!nav) return Promise.resolve({ ok: false, reason: 'no_core' });
    if (opts && opts.force === true) return navigateTo(ref, nav);
    return checkSourceChanged(card).then(function (check) {
      if (check.status === 'changed') return { ok: false, reason: 'source_changed', check: check };
      if (check.status !== 'same') return { ok: false, reason: 'source_unverified', check: check };
      return navigateTo(ref, nav);
    });
  }

  // ── card modal ───────────────────────────────────────────────────────────
  function openCardModal(cardId) {
    var store = getStore();
    if (!store) { toast(t('저장 모듈이 없습니다.'), 'error'); return; }
    attempt(function () { return store.get(cardId); }).then(function (card) {
      if (!card) { toast(t('카드를 찾을 수 없습니다.'), 'error'); refreshList(); return; }
      if (!validateCard(card)) { toast(t('손상된 카드'), 'error'); refreshList(); return; }
      renderCardModal(card);
    }).catch(function (err) {
      toast(t('카드를 열지 못했습니다.'), 'error');
      try { console.warn('[' + EXT_ID + '] open card failed', err); } catch (_e) {}
    });
  }

  function renderCardModal(card) {
    if (!validateCard(card)) return;
    var m = openModal(card.name || t('(제목 없음)'), null);
    if (!m) return;
    var data = card.data || {};

    var meta = el('div', 'sgkv-card-meta');
    meta.appendChild(el('span', 'sgkv-badge', badgeForCard(card)));
    meta.appendChild(el('span', 'sgkv-card-time', formatTime(card.createdAt)));
    if (isLocalOnly(getStore())) {
      meta.appendChild(el('span', 'sgkv-badge sgkv-badge--local', t('이 기기에만 저장됨')));
    }
    if (data.sessionTitle) meta.appendChild(el('span', 'sgkv-card-src', t('출처: ') + data.sessionTitle));
    m.body.appendChild(meta);

    var status = el('p', 'sgkv-text');
    status.hidden = true;
    m.body.appendChild(status);
    var statusActions = el('div', 'sgkv-status-actions');
    statusActions.hidden = true;
    m.body.appendChild(statusActions);

    var snapshot = el('div', 'sgkv-snapshot');
    m.body.appendChild(snapshot);
    renderSnapshotInto(snapshot, data);

    function setStatus(message, kind) {
      if (!isActiveModal(m.box)) return;
      withOwnWrites(function () {
        status.textContent = String(message || '');
        status.hidden = !message;
        status.className = 'sgkv-text' + (kind ? ' sgkv-text--' + kind : '');
        statusActions.textContent = '';
        statusActions.hidden = true;
      });
    }

    function offerForcedJump() {
      if (!isActiveModal(m.box)) return;
      withOwnWrites(function () {
        statusActions.textContent = '';
        statusActions.appendChild(button(t('그래도 이동'), 'sgkv-btn', function () {
          setStatus(t('이동하는 중…'));
          goToSource(card, { force: true }).then(handleJumpResult);
        }));
        statusActions.hidden = false;
      });
    }

    function handleJumpResult(res) {
      if (res && res.ok) {
        closeModalIf(m.box);
        closePanel();
        return;
      }
      var reason = res && res.reason;
      if (reason === 'source_changed') {
        setStatus(t('원문이 저장 이후 바뀌었거나 그 위치에 다른 메시지가 있습니다. 이동하면 다른 메시지가 나올 수 있습니다.'), 'warn');
        offerForcedJump();
        return;
      }
      if (reason === 'source_unverified') {
        setStatus(t('원문이 그대로인지 확인할 수 없습니다(다른 프로필의 대화이거나 원문을 불러오지 못함).'), 'warn');
        offerForcedJump();
        return;
      }
      if (reason === 'no_core') {
        setStatus(t('이동 모듈(HermesVizNav)이 없어 원문으로 이동할 수 없습니다.'), 'warn');
        return;
      }
      setStatus(Object.prototype.hasOwnProperty.call(I18N.en, reason) ? t(reason) : t('원문으로 이동하지 못했습니다') + '.', 'warn');
    }

    m.foot.appendChild(button(t('원문으로 이동'), 'sgkv-btn', function () {
      if (!navModule()) { handleJumpResult({ ok: false, reason: 'no_core' }); return; }
      setStatus(t('원문을 확인하는 중…'));
      goToSource(card).then(handleJumpResult).catch(function () { handleJumpResult({ ok: false }); });
    }));

    m.foot.appendChild(button(t('원문 변경 확인'), 'sgkv-btn', function () {
      setStatus(t('원문을 다시 불러오는 중…'));
      checkSourceChanged(card).then(function (res) {
        if (res.status === 'same') { setStatus(t('동일 — 원문이 저장 시점과 같습니다.'), 'ok'); return; }
        if (res.status === 'changed') {
          setStatus(res.reason === 'role_mismatch'
            ? t('변경됨 — 저장 위치에 다른 메시지가 있습니다. 보관된 스냅샷은 그대로입니다.')
            : t('변경됨 — 원문이 저장 이후 바뀌었습니다. 보관된 스냅샷은 그대로입니다.'), 'warn');
          return;
        }
        setStatus(res.reason === 'hash_scheme'
          ? t('변경 여부를 확인할 수 없습니다 (해시 방식이 다름).')
          : t('원문을 불러오지 못해 확인하지 못했습니다.'), 'warn');
      });
    }));

    m.foot.appendChild(button(t('새 저장본 만들기'), 'sgkv-btn', function () {
      var ref = sourceRefFor(card);
      var captured = captureMessage(ref);
      if (!captured) { toast(t('클릭한 메시지의 전체 원문을 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.'), 'error'); return; }
      closeModalIf(m.box);
      openSaveDialog({
        title: t('새 저장본 만들기'),
        sessionId: ref.sessionId,
        messageIndex: ref.messageIndex,
        role: ref.role,
        expectedText: captured.content,
        profile: ref.profile,
        defaultName: (card.name || t('저장된 결과')) + t(' (새 저장본)')
      });
    }));

    m.foot.appendChild(button(t('이름 변경'), 'sgkv-btn', function () {
      var current = card.name || '';
      closeModalIf(m.box);
      promptModal(t('이름 변경'), t('새 이름'), current).then(function (name) {
        if (!name) return null;
        var s = getStore();
        if (!s) { toast(t('저장 모듈이 없습니다.'), 'error'); return null; }
        return attempt(function () { return s.patch(card.id, { name: name }); }).then(function () {
          toast(t('이름을 바꿨습니다.'), 'success');
          refreshList();
        });
      }).catch(function (err) {
        toast(err && (err.code === 'too_large' || err.code === 'quota') ? saveFailureMessage({ reason: err.code }) : t('이름을 바꾸지 못했습니다.'), 'error');
        try { console.warn('[' + EXT_ID + '] rename failed', err); } catch (_e) {}
      });
    }));

    m.foot.appendChild(button(t('삭제'), 'sgkv-btn sgkv-btn--danger', function () {
      var name = card.name || t('(제목 없음)');
      var id = card.id;
      closeModalIf(m.box);
      confirmModal(t('카드 삭제'), (/^ko/i.test(document.documentElement.lang) ? '“' + name + t('” 카드를 삭제할까요? 되돌릴 수 없습니다.') : 'Delete “' + name + t('” 카드를 삭제할까요? 되돌릴 수 없습니다.')), t('삭제'))
        .then(function (ok) {
          if (!ok) return null;
          var s = getStore();
          if (!s) { toast(t('저장 모듈이 없습니다.'), 'error'); return null; }
          return attempt(function () { return s.remove(id); }).then(function () {
            toast(t('카드를 삭제했습니다.'), 'success');
            refreshList();
          });
        }).catch(function (err) {
          toast(t('삭제하지 못했습니다.'), 'error');
          try { console.warn('[' + EXT_ID + '] delete failed', err); } catch (_e) {}
        });
    }));
  }

  // mermaid.render() parks a temporary `#d<id>` container (and, for sandboxed
  // diagrams, `#i<id>`) in <body>; on a parse error mermaid 10 can also leave
  // its error SVG `#<id>` there. Core removes the container after both success
  // and failure (upstream static/ui.js:21927-21928, 21934-21935); we do the
  // same, and also sweep any body-level leftovers carrying our id prefix.
  var MERMAID_ID_PREFIX = 'sgkv-mermaid-';
  var mermaidInFlight = {};   // renderId -> true while mermaid.render runs

  function ownerRenderId(id) {
    var bare = id.charAt(0) === 'd' || id.charAt(0) === 'i' ? id.slice(1) : id;
    return bare.indexOf(MERMAID_ID_PREFIX) === 0 ? bare : (id.indexOf(MERMAID_ID_PREFIX) === 0 ? id : '');
  }

  function cleanupMermaidTemp(renderId, host) {
    if (typeof document === 'undefined' || !document) return;
    withOwnWrites(function () {
      var ids = ['d' + renderId, 'i' + renderId, renderId];
      for (var i = 0; i < ids.length; i++) {
        for (var guard = 0; guard < 4; guard++) {
          var node = document.getElementById(ids[i]);
          if (!node || (host && host.contains(node))) break;
          node.remove();
        }
      }
      if (document.body && document.body.children) {
        var stray = [];
        for (var k = 0; k < document.body.children.length; k++) {
          var child = document.body.children[k];
          var owner = ownerRenderId(String(child.id || ''));
          // never touch the temp nodes of a render that is still running
          if (owner && !mermaidInFlight[owner]) stray.push(child);
        }
        for (var s = 0; s < stray.length; s++) stray[s].remove();
      }
    });
  }

  // Renders a saved snapshot. Mermaid uses a global mermaid.render with a
  // unique id when present; otherwise the code block is shown as-is. Markdown
  // and tables go through our own escaping renderer.
  function renderSnapshotInto(host, data) {
    var content = data && typeof data.content === 'string' ? data.content : '';
    if (data && data.contentType === 'mermaid') {
      var code = mermaidCode(content);
      var fallback = function () {
        withOwnWrites(function () {
          host.textContent = '';
          host.insertAdjacentHTML('beforeend',
            '<pre><code>' + escapeHtml(code) + '</code></pre>');
        });
      };
      var mermaidRef = window.mermaid;
      if (/<\s*(?:img|image)\b/i.test(code) || /&lt;\s*(?:img|image)\b/i.test(code)) { fallback(); return; }
      if (!mermaidRef || typeof mermaidRef.render !== 'function') { fallback(); return; }
      var renderId = MERMAID_ID_PREFIX + Date.now().toString(36) + '-'
        + Math.floor(Math.random() * 1e6).toString(36);
      mermaidInFlight[renderId] = true;
      attempt(function () { return mermaidRef.render(renderId, code); }).then(function (out) {
        delete mermaidInFlight[renderId];
        cleanupMermaidTemp(renderId, null);
        var svg = out && typeof out.svg === 'string' ? out.svg : (typeof out === 'string' ? out : '');
        if (!svg) { fallback(); return; }
        // mermaid-generated SVG (mermaid runs with core's strict securityLevel);
        // the raw model text is never injected as HTML here.
        withOwnWrites(function () { host.textContent = ''; host.insertAdjacentHTML('beforeend', svg); });
      }, function () {
        delete mermaidInFlight[renderId];
        cleanupMermaidTemp(renderId, null);
        fallback();
      });
      return;
    }
    withOwnWrites(function () {
      host.textContent = '';
      host.insertAdjacentHTML('beforeend', renderMarkdownToSafeHtml(content));
    });
  }

  // ── export / import ──────────────────────────────────────────────────────
  function exportCards() {
    var store = getStore();
    if (!store || typeof store.exportJson !== 'function') { toast(t('저장 모듈이 없습니다.'), 'error'); return; }
    attempt(function () { return store.exportJson(); }).then(function (text) {
      var blob = new Blob([String(text)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sigakhwa-vault-' + new Date().toISOString().slice(0, 10) + '.json';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      window.setTimeout(function () {
        try { a.remove(); URL.revokeObjectURL(url); } catch (_err) {}
      }, 0);
      toast(t('보관함을 JSON으로 내보냈습니다.'), 'success');
    }).catch(function () { toast(t('내보내기에 실패했습니다.'), 'error'); });
  }

  function importCards() {
    var store = getStore();
    if (!store || typeof store.importJson !== 'function') { toast(t('저장 모듈이 없습니다.'), 'error'); return; }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      try { input.remove(); } catch (_err) {}
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var checked;
        attempt(function () {
          checked = validatedImport(String(reader.result || ''));
          return store.importJson(checked.text, { merge: true });
        }).then(function (res) {
          toast(t('가져오기 완료: ') + ((res && res.added) || 0) + t('건 추가, ')
            + (((res && res.skipped) || 0) + checked.skipped) + t('건 건너뜀'), 'success');
          refreshList();
        }).catch(function (err) { toast(err && (err.code === 'too_large' || err.code === 'quota') ? saveFailureMessage({ reason: err.code }) : t('가져오기에 실패했습니다. JSON 형식을 확인해 주세요.'), 'error'); });
      };
      reader.onerror = function () { toast(t('파일을 읽지 못했습니다.'), 'error'); };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  // ── registration + boot ──────────────────────────────────────────────────
  var registeredHandle = null;
  var unregisterAction = null;
  var registeredActionLabel = '';

  function registerExtension() {
    var ext = window.hermesExt;
    if (!ext || typeof ext.register !== 'function') return null;
    var handle = registeredHandle;
    if (!handle) {
      try { handle = ext.register(EXT_ID); } catch (_err) { handle = null; }
    }
    if (!handle) return null;
    registeredHandle = handle;
    var label = t('보관함에 저장');
    if (unregisterAction && registeredActionLabel !== label) {
      try { unregisterAction(); } catch (_err3) {}
      unregisterAction = null;
    }
    if (handle.messages && typeof handle.messages.registerAction === 'function' && !unregisterAction) {
      try {
        unregisterAction = handle.messages.registerAction({
          id: 'save-card',
          label: label,
          icon: 'star',
          roles: ['assistant'],
          onInvoke: onInvokeSaveCard
        });
        registeredActionLabel = label;
      } catch (_err2) { unregisterAction = null; }
      if (!unregisterAction) {
        try {
          console.warn('[' + EXT_ID + '] message action slot unavailable (core limit is 2 per page)');
        } catch (_e) {}
      }
    }
    return handle;
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (!document.body) {
      if (attempt < 80) window.setTimeout(function () { install(attempt + 1); }, 150);
      return false;
    }
    mountChrome();
    startBodyObserver();
    registerExtension();
    if (!storeModule() && attempt < 40) {
      // The shared store module is injected by the build script and may load
      // after us; retry quietly before showing the notice for good.
      window.setTimeout(function () { install(attempt + 1); }, 250);
      return true;
    }
    if (!storeModule()) {
      setNotice(t('저장 모듈(HermesVizStore)을 불러올 수 없어 보관함 저장 기능을 쓸 수 없습니다.'));
    } else {
      refreshList();
    }
    return true;
  }

  // Test / debug surface. Pure helpers are exported so `node --test` can
  // exercise the shipped code itself instead of a copy.
  window.SigakhwaVault = {
    id: EXT_ID,
    version: VERSION,
    namespace: NAMESPACE,
    fallbackHashPrefix: FALLBACK_HASH_PREFIX,
    t: t,
    escapeHtml: escapeHtml,
    validateCard: validateCard,
    validatedImport: validatedImport,
    captureMessage: captureMessage,
    positionFab: positionFab,
    buildCardRow: buildCardRow,
    normalizeMessageContent: normalizeMessageContent,
    extractParts: extractParts,
    renderMarkdownToSafeHtml: renderMarkdownToSafeHtml,
    mermaidCode: mermaidCode,
    contentHash: contentHash,
    hashSchemesComparable: hashSchemesComparable,
    contentTypeForPart: contentTypeForPart,
    badgeForCard: badgeForCard,
    buildCard: buildCard,
    trimEndLinear: trimEndLinear,
    parseFenceOpen: parseFenceOpen,
    isFenceClose: isFenceClose,
    messageMatchesContext: messageMatchesContext,
    defaultTitleForPart: defaultTitleForPart,
    isLocalOnly: isLocalOnly,
    maxCardBytes: MAX_CARD_BYTES,
    cardByteSize: cardByteSize,
    prepareSave: prepareSave,
    saveCard: saveCard,
    saveFailureMessage: saveFailureMessage,
    renderSnapshotInto: renderSnapshotInto,
    fetchSessionMessage: fetchSessionMessage,
    sourceRefFor: sourceRefFor,
    goToSource: goToSource,
    checkSourceChanged: checkSourceChanged,
    onInvokeSaveCard: onInvokeSaveCard,
    openPanel: openPanel,
    refresh: refreshList,
    _register: registerExtension,
    _install: install
  };

  // Never throw at load time: without a DOM (node unit tests) only the pure
  // surface above is installed.
  try {
    if (typeof document !== 'undefined' && document) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { install(0); }, { once: true });
      } else {
        install(0);
      }
    }
  } catch (err) {
    try { console.warn('[' + EXT_ID + '] install failed', err); } catch (_e) {}
  }
})();
