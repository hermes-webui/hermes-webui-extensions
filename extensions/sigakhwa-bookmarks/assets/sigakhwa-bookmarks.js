/*
 * sigakhwa-bookmarks — Hermes WebUI extension (plain classic script, no build step).
 *
 *  • message action "북마크" (core messages.registerAction, icon 'bookmark', roles user+assistant)
 *  • a small toolbar button in .messages-shell that opens a two-tab panel:
 *      북마크 — every saved bookmark grouped by profile → conversation, click → HermesVizNav.goTo
 *      목차   — TOC of the current conversation built from assistant replies (headings / tables /
 *               mermaid diagrams / sigakhwa 한 줄 프레임), click → HermesVizNav.goTo
 *  • persistence through window.HermesVizStore (namespace 'bookmarks'): localStorage, or the
 *    sigakhwa-bookmarks sidecar through the consented WebUI proxy when it is reachable.
 *
 * Pure helpers (parseToc, defaultName, …) are exposed on window.SigakhwaBookmarks for unit tests;
 * the DOM part installs only when `document` exists. Re-injection is a no-op (init guard), also while
 * the first copy is still waiting for .messages-shell (`installing`).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var I18N = {
    "ko": {
      "s0": "나",
      "s1": "북마크",
      "s2": "표",
      "s3": "도식",
      "s4": "프레임",
      "s5": "코어 UI를 찾을 수 없어 이동할 수 없습니다.",
      "s6": "대화를 열 수 없습니다 (삭제되었거나 이 프로필에서 접근할 수 없음).",
      "s7": "다른 프로필(",
      "s8": ")의 대화입니다. 먼저 해당 프로필로 전환해 주세요.",
      "s9": "메시지를 찾을 수 없습니다 (삭제·압축되었을 수 있음).",
      "s10": "응답 생성 중에는 이동할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      "s11": "이동에 실패했습니다.",
      "s12": "저장",
      "s13": "취소",
      "s14": "확인",
      "s15": "동기화됨",
      "s16": "일부 동기화됨 · ",
      "s17": "개는 이 기기에만",
      "s18": "이 기기에만 저장됨",
      "s19": "오류",
      "s20": "대화가 바뀌어 북마크를 저장하지 않았습니다. 다시 시도해 주세요.",
      "s21": "북마크 편집",
      "s22": "북마크 저장",
      "s23": " · 메시지 #",
      "s24": " · 이름을 정해 저장합니다",
      "s25": "북마크 이름",
      "s26": "이름 변경",
      "s27": "삭제",
      "s28": "저장 공간이 부족하거나 저장소를 사용할 수 없습니다.",
      "s29": "변경할 수 없는 항목입니다.",
      "s30": "사이드카 권한이 없습니다. 설정에서 프록시 허용을 확인하세요.",
      "s31": "저장에 실패했습니다",
      "s32": "이름을 입력해 주세요.",
      "s33": "북마크 이름을 변경했습니다",
      "s34": "북마크를 저장했습니다",
      "s35": " (이 기기에만 저장됨)",
      "s36": "북마크를 삭제했습니다",
      "s37": "북마크 · 목차 열기",
      "s38": "북마크와 목차",
      "s39": "북마크 · 목차",
      "s40": "브라우저 localStorage에만 저장됩니다. PC·폰 동기화는 사이드카가 필요합니다.",
      "s41": "닫기",
      "s42": "목차",
      "s43": "사이드카에 저장되어 같은 WebUI에 로그인한 다른 기기에서도 보입니다.",
      "s44": "서버가 받지 않은 항목은 이 브라우저에만 남아 있습니다 (목록에서 \"이 기기\" 표시).",
      "s45": "대화 ",
      "s46": "저장소를 초기화하는 중…",
      "s47": "북마크 목록을 불러오지 못했습니다 (",
      "s48": "). 사이드카 상태를 확인한 뒤 새로고침하세요. 아래는 마지막으로 읽은 목록입니다.",
      "s49": "저장된 북마크가 없습니다. 메시지 하단의 북마크 버튼으로 저장하세요.",
      "s50": "프로필: ",
      "s51": " (현재)",
      "s52": "현재 대화",
      "s53": "내보내기(JSON)",
      "s54": "가져오기(JSON)",
      "s55": "이 기기에만 저장됨. ",
      "s56": "사이드카는 응답했지만 데이터 요청이 실패했습니다 (",
      "s57": "). 사이드카 로그와 설정 → Extensions의 프록시 허용 상태를 확인한 뒤 새로고침하세요.",
      "s58": "PC와 폰에서 함께 보려면: ① 사이드카 실행 (sidecar/README: python -S sidecar.py) ② WebUI 비밀번호 설정 ③ 설정 → Extensions → sigakhwa-bookmarks → 사이드카 프록시 허용 ④ 새로고침. 그러면 이 기기의 북마크가 서버로 옮겨집니다.",
      "s59": "개 항목은 서버가 받지 않아 이 기기에만 남아 있습니다 (용량 초과 또는 형식 오류). 목록에서 \"이 기기\" 표시가 붙고, 새로고침할 때마다 다시 보내 봅니다. 삭제하면 이 기기에서만 지워집니다.",
      "s60": "사이드카와 동기화 중입니다. 다른 기기에서 같은 WebUI에 로그인하면 같은 목록이 보입니다.",
      "s61": "(이름 없음)",
      "s62": "이 기기",
      "s63": "서버가 받지 않아 이 브라우저에만 저장된 항목입니다.",
      "s64": "북마크 이름 변경",
      "s65": "새 이름을 입력하세요.",
      "s66": "이름을 변경했습니다",
      "s67": "변경 실패: ",
      "s68": "북마크 삭제",
      "s69": "북마크 \"",
      "s70": "\"을(를) 삭제할까요?",
      "s71": "삭제했습니다",
      "s72": "삭제 실패: ",
      "s73": "내보내기 실패",
      "s74": "파일이 너무 큽니다 (4 MiB 초과)",
      "s75": "가져오기: ",
      "s76": "개 추가, ",
      "s77": "개 건너뜀",
      "s78": "가져오기 실패: ",
      "s79": "형식이 올바르지 않습니다",
      "s80": "파일을 읽을 수 없습니다",
      "s81": "열린 대화가 없습니다.",
      "s82": "목차를 만드는 중…",
      "s83": "목차 항목이 없습니다. 제목(#, ##, ###)·표·mermaid 도식·한 줄 프레임이 있는 답변이 나타나면 여기에 모입니다.",
      "s84": "답변 · 메시지 #",
      "s85": "개 항목 · 답변 ",
      "s86": "개. 핵심 대화 개요(사용자 질문 목록)는 코어의 Conversation Outline을 그대로 사용하세요.",
      "s87": "대화 내용을 불러오지 못했습니다",
      "s88": "저장소가 아직 준비되지 않았습니다",
      "unavailable": "동기화 안 됨(재시도 중)",
      "actionUnavailable": "메시지 북마크 버튼을 등록하지 못했습니다. 다른 확장의 메시지 액션을 비활성화한 뒤 새로고침하세요.",
      "quota": "저장 한도에 도달했습니다 (1,000개 / 2 MiB).",
      "tooLarge": "항목이 너무 큽니다 (256 KiB 초과).",
      "conflict": "충돌 · 이 기기 사본"
    },
    "en": {
      "s0": "Me",
      "s1": "Bookmark",
      "s2": "Table",
      "s3": "Diagram",
      "s4": "Frame",
      "s5": "Cannot navigate because the Core UI is unavailable.",
      "s6": "Cannot open this conversation (deleted or unavailable in this profile).",
      "s7": "This conversation belongs to profile (",
      "s8": "). Please switch to that profile first.",
      "s9": "Message not found (it may have been deleted or compacted).",
      "s10": "Cannot navigate while a response is being generated. Try again shortly.",
      "s11": "Navigation failed.",
      "s12": "Save",
      "s13": "Cancel",
      "s14": "Confirm",
      "s15": "Synced",
      "s16": "Partially synced · ",
      "s17": " items on this device only",
      "s18": "Saved on this device only",
      "s19": "Error",
      "s20": "The conversation changed, so the bookmark was not saved. Please try again.",
      "s21": "Edit bookmark",
      "s22": "Save bookmark",
      "s23": " · Message #",
      "s24": " · Choose a name to save",
      "s25": "Bookmark name",
      "s26": "Rename",
      "s27": "Delete",
      "s28": "Storage is full or unavailable.",
      "s29": "This item is immutable.",
      "s30": "Sidecar access denied. Check proxy consent in Settings.",
      "s31": "Could not save",
      "s32": "Please enter a name.",
      "s33": "Bookmark renamed",
      "s34": "Bookmark saved",
      "s35": " (saved on this device only)",
      "s36": "Bookmark deleted",
      "s37": "Open bookmarks and table of contents",
      "s38": "Bookmarks and table of contents",
      "s39": "Bookmarks · Contents",
      "s40": "Saved in this browser only. A sidecar is required to sync across devices.",
      "s41": "Close",
      "s42": "Contents",
      "s43": "Saved on the sidecar and available on other devices signed into this WebUI.",
      "s44": "Items rejected by the server remain in this browser (marked \"This device\" in the list).",
      "s45": "Conversation ",
      "s46": "Initializing storage…",
      "s47": "Could not load bookmarks (",
      "s48": "). Check the sidecar and reload. The last loaded list is shown below.",
      "s49": "No bookmarks yet. Use the bookmark button below a message to save one.",
      "s50": "Profile: ",
      "s51": " (current)",
      "s52": "Current conversation",
      "s53": "Export (JSON)",
      "s54": "Import (JSON)",
      "s55": "Saved on this device only. ",
      "s56": "The sidecar responded, but the data request failed (",
      "s57": "). Check the sidecar logs and proxy consent in Settings → Extensions, then reload.",
      "s58": "To sync across devices: start the sidecar (see sidecar/README), set a WebUI password, approve its proxy in Settings → Extensions → sigakhwa-bookmarks, then reload. This browser's bookmarks will be uploaded.",
      "s59": " items remain on this device because the server rejected them (size or format). They are marked \"This device\" and retried on reload. Deleting them removes only the local copy.",
      "s60": "Synced with the sidecar. Sign into this WebUI on another device to see the same list.",
      "s61": "(Unnamed)",
      "s62": "This device",
      "s63": "The server rejected this item; it is saved in this browser only.",
      "s64": "Rename bookmark",
      "s65": "Enter a new name.",
      "s66": "Renamed",
      "s67": "Rename failed: ",
      "s68": "Delete bookmark",
      "s69": "Delete bookmark \"",
      "s70": "\"?",
      "s71": "Deleted",
      "s72": "Delete failed: ",
      "s73": "Export failed",
      "s74": "File is too large (over 4 MiB)",
      "s75": "Import: ",
      "s76": " added, ",
      "s77": " skipped",
      "s78": "Import failed: ",
      "s79": "Invalid format",
      "s80": "Cannot read the file",
      "s81": "No conversation is open.",
      "s82": "Building table of contents…",
      "s83": "No contents yet. Replies with headings (#, ##, ###), tables, Mermaid diagrams or one-line frames will appear here.",
      "s84": "Reply · Message #",
      "s85": " entries · ",
      "s86": " replies. Use Core's Conversation Outline for the list of user questions.",
      "s87": "Could not load the conversation",
      "s88": "Storage is not ready yet",
      "unavailable": "Sync unavailable",
      "actionUnavailable": "The bookmark action could not be registered. Disable another extension message action and reload.",
      "quota": "Storage limit reached (1,000 items / 2 MiB).",
      "tooLarge": "Item is too large (over 256 KiB).",
      "conflict": "Conflict · This device copy"
    }
  };
  function t(key) {
    var lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
    return I18N[/^ko/i.test(lang || '') ? 'ko' : 'en'][key];
  }

  var EXT_ID = 'sigakhwa-bookmarks';
  var NS = 'bookmarks';
  var VERSION = '0.1.1';
  var NAME_MAX = 120;
  var DEFAULT_NAME_LEN = 40;
  var PREVIEW_LEN = 120;
  var TOC_LABEL_LEN = 60;
  var TOC_MAX_LINES = 20000;
  var TOC_MAX_LINE_LEN = 2000;
  var TOC_MAX_ENTRIES = 500;

  // ── pure helpers ───────────────────────────────────────────────────────────
  function collapseWs(s) {
    // Bounded, linear: split on whitespace runs and re-join.
    return String(s || '').split(/\s+/).filter(Boolean).join(' ');
  }

  function stripInlineMarkdown(s) {
    // Remove emphasis / code markers only (single pass, linear).
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '*' || c === '_' || c === '`' || c === '~') continue;
      out += c;
    }
    return out;
  }

  function truncate(s, n) {
    s = String(s || '');
    var points = Array.from(s);
    if (points.length <= n) return s;
    return points.slice(0, n).join('').replace(/\s+$/, '') + '…';
  }

  // Leading block markers per line (heading #, bullet, ordered list, blockquote). Anchored + bounded → linear.
  var BLOCK_MARKER_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+|>[ \t]?|\d{1,3}\.[ \t]+)/gm;
  function stripBlockMarkers(s) {
    return String(s || '').replace(BLOCK_MARKER_RE, '');
  }

  // Default bookmark name = first 40 visible characters of the message text.
  function defaultName(text) {
    var visible = collapseWs(stripInlineMarkdown(stripBlockMarkers(Array.from(String(text || '')).slice(0, 4000).join(''))));
    if (!visible) return t('s1');
    return truncate(visible, DEFAULT_NAME_LEN);
  }

  function previewText(text) {
    return truncate(collapseWs(Array.from(String(text || '')).slice(0, 4000).join('')), PREVIEW_LEN);
  }

  // Message content may be a string or an array of parts ({type:'text', text}).
  function messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (!p) continue;
        if (typeof p === 'string') parts.push(p);
        else if (p.type === 'text' && typeof (p.text || p.content) === 'string') parts.push(p.text || p.content);
      }
      return parts.join('\n');
    }
    return '';
  }

  function bookmarkKey(profile, sessionId, messageIndex, role) {
    return String(profile || 'default') + '\u0000' + String(sessionId || '') + '\u0000' + String(messageIndex) + '\u0000' + String(role || '');
  }

  var FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]{0,32})/;
  var HEADING_RE = /^ {0,3}(#{1,3})[ \t]+(\S.{0,199})$/;
  var FRAME_RE = /한[ ]?줄[ ]?프레임/;

  function isTableSeparator(line) {
    if (line.indexOf('|') < 0 || line.indexOf('---') < 0) return false;
    if (line.length > 400) return false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c !== '|' && c !== '-' && c !== ':' && c !== ' ' && c !== '\t') return false;
    }
    return true;
  }

  function tableHeaderLabel(headerLine) {
    var cells = headerLine.split('|');
    var out = [];
    for (var i = 0; i < cells.length && out.length < 6; i++) {
      var cell = collapseWs(stripInlineMarkdown(cells[i]));
      if (cell) out.push(cell);
    }
    return truncate(out.join(' · '), TOC_LABEL_LEN);
  }

  function headingLabel(raw) {
    var s = raw;
    // strip closing hashes: "Title ##" → "Title"
    var end = s.length;
    while (end > 0 && (s.charAt(end - 1) === '#' || s.charAt(end - 1) === ' ')) end--;
    s = s.slice(0, end);
    return truncate(collapseWs(stripInlineMarkdown(s)), TOC_LABEL_LEN);
  }

  function frameLabel(line) {
    // Text after the "한 줄 프레임" label, minus the run of label decorations / separators that follows it
    // ("**", "]", ":", "—", "–", "-", spaces). Single linear pass over a ≤2000-char line.
    var fm = FRAME_RE.exec(line);
    if (!fm) return '';
    var after = line.slice(fm.index + fm[0].length);
    var SEP = ' \t:：—–-]*_>)';
    var i = 0;
    while (i < after.length && SEP.indexOf(after.charAt(i)) >= 0) i++;
    var text = collapseWs(stripInlineMarkdown(after.slice(i)));
    if (!text) return '';
    return truncate(text, TOC_LABEL_LEN);
  }

  // Build TOC entries from a persisted message list (absolute indexes = positions in `messages`).
  // Returns [{messageIndex, role:'assistant', kind:'heading'|'table'|'diagram'|'frame', level?, label}].
  function parseToc(messages) {
    var entries = [];
    if (!Array.isArray(messages)) return entries;
    for (var mi = 0; mi < messages.length && entries.length < TOC_MAX_ENTRIES; mi++) {
      var m = messages[mi];
      if (!m || m.role !== 'assistant') continue;
      var text = messageText(m.content);
      if (!text) continue;
      var lines = text.split('\n');
      if (lines.length > TOC_MAX_LINES) lines.length = TOC_MAX_LINES;
      var fence = null;      // opening fence string while inside a fenced block
      var fenceLang = '';
      var fenceFirst = '';
      var prev = '';
      var frameSeen = false;
      for (var li = 0; li < lines.length && entries.length < TOC_MAX_ENTRIES; li++) {
        var line = lines[li];
        if (line.length > TOC_MAX_LINE_LEN) line = line.slice(0, TOC_MAX_LINE_LEN);
        if (fence) {
          var trimmed = line.replace(/^ {0,3}/, '');
          if (trimmed.charAt(0) === fence.charAt(0) && trimmed.slice(0, fence.length) === fence && /^[`~]*\s*$/.test(trimmed)) {
            if (fenceLang === 'mermaid') entries.push({ messageIndex: mi, role: 'assistant', kind: 'diagram', label: fenceFirst || 'mermaid' });
            fence = null; fenceLang = ''; fenceFirst = ''; prev = '';
            continue;
          }
          if (fenceLang === 'mermaid' && !fenceFirst) {
            var ft = collapseWs(line);
            if (ft && ft.indexOf('%%') !== 0) fenceFirst = truncate(ft, TOC_LABEL_LEN);
          }
          continue;
        }
        var fm = FENCE_RE.exec(line);
        if (fm) {
          fence = fm[1]; fenceLang = fm[2].toLowerCase(); fenceFirst = ''; prev = '';
          continue;
        }
        var hm = HEADING_RE.exec(line);
        if (hm) {
          var label = headingLabel(hm[2]);
          if (label) entries.push({ messageIndex: mi, role: 'assistant', kind: 'heading', level: hm[1].length, label: label });
          prev = line;
          continue;
        }
        if (!frameSeen && line.length <= TOC_MAX_LINE_LEN && FRAME_RE.test(line)) {
          var fl = frameLabel(line);
          if (fl) { entries.push({ messageIndex: mi, role: 'assistant', kind: 'frame', label: fl }); frameSeen = true; }
          prev = line;
          continue;
        }
        if (isTableSeparator(line) && prev.indexOf('|') >= 0) {
          var tl = tableHeaderLabel(prev);
          entries.push({ messageIndex: mi, role: 'assistant', kind: 'table', label: tl || t('s2') });
          prev = '';
          continue;
        }
        prev = line;
      }
      if (fence && fenceLang === 'mermaid' && entries.length < TOC_MAX_ENTRIES) {
        entries.push({ messageIndex: mi, role: 'assistant', kind: 'diagram', label: fenceFirst || 'mermaid' });
      }
    }
    return entries;
  }


  function reasonText(reason, extra) {
    switch (reason) {
      case 'no_core': return t('s5');
      case 'session_not_found': return t('s6');
      case 'profile_switch_required': return t('s7') + (extra || '?') + t('s8');
      case 'row_not_found': return t('s9');
      case 'busy_switch_blocked': return t('s10');
      default: return t('s11');
    }
  }

  var pure = {
    version: VERSION,
    defaultName: defaultName,
    previewText: previewText,
    messageText: messageText,
    parseToc: parseToc,
    bookmarkKey: bookmarkKey,
    reasonText: reasonText,
  };

  // ── init guard ─────────────────────────────────────────────────────────────
  // A second evaluation must be a no-op even while the first copy is still polling for .messages-shell
  // (install() below retries for ~12 s), so the guard keys on `installing` as well as `installed`.
  var prev = window.SigakhwaBookmarks;
  if (prev && (prev.installed || prev.installing)) return;
  var pub = Object.assign({ installed: false, installing: false }, pure);
  window.SigakhwaBookmarks = pub;
  if (typeof document === 'undefined') return;
  pub.installing = true;

  // ── core access ────────────────────────────────────────────────────────────
  /* eslint-disable no-undef */
  function coreS() {
    try { if (typeof S !== 'undefined' && S) return S; } catch (_) { /* ignore */ }
    return window.S || null;
  }
  /* eslint-enable no-undef */

  function toast(msg, type) {
    if (typeof window.showToast === 'function') { try { window.showToast(msg, type === 'error' ? 5000 : 2500, type || 'info'); return; } catch (_) { /* ignore */ } }
    try { console.log('[' + EXT_ID + '] ' + msg); } catch (_) { /* ignore */ }
  }

  function currentSid() {
    var s = coreS();
    return s && s.session && s.session.session_id ? String(s.session.session_id) : null;
  }
  function currentProfile() {
    var s = coreS();
    return String((s && s.activeProfile) || 'default');
  }
  function sessionProfile() {
    var s = coreS();
    if (s && s.session && typeof s.session.profile === 'string' && s.session.profile.trim()) return s.session.profile.trim();
    return currentProfile();
  }
  function sessionTitle() {
    var s = coreS();
    var t = s && s.session ? (s.session.title || s.session.name || '') : '';
    return collapseWs(String(t || '')).slice(0, 120);
  }
  function isPhone() {
    try { return window.matchMedia && window.matchMedia('(max-width: 480px)').matches; } catch (_) { return false; }
  }

  // Keep each activation press contained, including repeats after its control disappears.
  var latchedKeys = new Set();
  var sharedDialogDepth = 0;
  function coreDialogOpen() {
    var overlay = document.getElementById('appDialogOverlay');
    return !!(overlay && !overlay.hidden && overlay.style.display !== 'none');
  }
  function containActivationKeys(node) {
    node.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.stopPropagation();
      if (!ev.repeat) latchedKeys.add(ev.key);
    });
  }
  function restoreControlFocus(origin) {
    if (coreDialogOpen()) return;
    var target = origin && origin !== document.body && origin !== document.documentElement && origin.isConnected && !origin.disabled && !origin.closest('[hidden]') ? origin : ui.toggle;
    if (target) target.focus({ preventScroll: true });
  }
  function ownSharedDialog(promise) {
    sharedDialogDepth++;
    return Promise.resolve(promise).finally(function () {
      sharedDialogDepth--;
      restoreControlFocus(document.activeElement);
    });
  }

  // Core's shared app dialogs (ui.js showPromptDialog / showConfirmDialog) when present, native fallbacks otherwise.
  function askText(title, message, value) {
    if (typeof window.showPromptDialog === 'function') {
      try { return ownSharedDialog(window.showPromptDialog({ title: title, message: message, value: value, confirmLabel: t('s12'), cancelLabel: t('s13') })); } catch (_) { /* fall back */ }
    }
    return Promise.resolve(typeof window.prompt === 'function' ? window.prompt(title + '\n' + message, value) : null);
  }
  function askConfirm(title, message, confirmLabel) {
    if (typeof window.showConfirmDialog === 'function') {
      try { return ownSharedDialog(window.showConfirmDialog({ title: title, message: message, confirmLabel: confirmLabel || t('s14'), cancelLabel: t('s13') })).then(function (r) { return r === true; }); } catch (_) { /* fall back */ }
    }
    return Promise.resolve(typeof window.confirm === 'function' ? !!window.confirm(title + '\n' + message) : false);
  }

  // ── DOM helpers (textContent only — never innerHTML with model text) ───────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (tag === 'button' || tag === 'input' || tag === 'select') containActivationKeys(n);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function btn(cls, text, label) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (label) { b.title = label; b.setAttribute('aria-label', label); }
    return b;
  }
  function clear(node) {
    if (node.contains(document.activeElement)) restoreControlFocus(ui.toggle);
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── state ──────────────────────────────────────────────────────────────────
  var store = null;
  var handle = null;
  var index = new Map();          // bookmarkKey → item
  var items = [];                 // all bookmark items (createdAt desc)
  var panelOpen = false;
  var activeTab = 'bookmarks';
  var tocCache = { key: null, entries: null, loading: null };
  var watchTimer = null;
  var lastWatchSid = null;
  var lastListError = null;       // last store.list() failure (shown in the panel instead of an empty list)
  var ui = {};
  var actionAvailable = false;
  var actionEventBound = false;
  var panelReturnFocus = null;

  // Sync state shown to the user: 'local' (this browser only) | 'partial' (sidecar in use, but
  // store.pendingLocal items were refused and remain here) | 'synced'.
  function syncState() {
    if (store && store.syncError) return 'unavailable';
    if (!store || store.backend !== 'sidecar') return 'local';
    return store.pendingLocal > 0 ? 'partial' : 'synced';
  }
  function badgeText(state) {
    if (state === 'unavailable') return t('unavailable');
    if (state === 'synced') return t('s15');
    if (state === 'partial') return t('s16') + store.pendingLocal + t('s17');
    return t('s18');
  }
  function describeError(e) {
    if (!e) return t('s19');
    if (e.status) return 'HTTP ' + e.status;
    return String(e.code || e.message || t('s19'));
  }

  function activeKeyFor(ctx) {
    return bookmarkKey(sessionProfile(), ctx.sessionId, ctx.messageIndex, ctx.role);
  }

  var refreshing = null;
  function refreshIndex() {
    if (!store) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = store.list({ kind: 'bookmark' }).then(function (rows) {
      lastListError = null;
      items = rows;
      index = new Map();
      for (var i = 0; i < rows.length; i++) {
        var it = rows[i];
        index.set(bookmarkKey(it.profile, it.sessionId, it.messageIndex, it.role), it);
      }
    }, function (e) {
      // Keep the previous index; the panel reports the failure instead of pretending the list is empty.
      lastListError = e || new Error('list failed');
      try { console.warn('[' + EXT_ID + '] list failed:', e && e.message); } catch (_) { /* ignore */ }
    }).then(function () {
      refreshing = null;
      if (handle) { try { handle.messages.invalidateActions(); } catch (_) { /* ignore */ } }
      updateBadge();
      renderPanel();
    });
    return refreshing;
  }

  // ── bookmark dialog (save / rename / delete) ───────────────────────────────
  function openBookmarkDialog(ctx) {
    return new Promise(function (resolve) {
      var returnFocus = document.activeElement;
      var existing = index.get(activeKeyFor(ctx)) || null;
      // The dialog is not modal for core: a hash/URL/SSE-driven loadSession() can change S.session while
      // it is open. Capture the file-under values now and re-check the session before saving.
      var captured = { profile: sessionProfile(), title: sessionTitle(), phone: isPhone() };
      var old = document.getElementById('svbDialogBackdrop');
      if (old) old.remove();
      if (currentSid() !== ctx.sessionId) {
        toast(t('s20'), 'error');
        resolve();
        return;
      }

      var backdrop = el('div', 'svb-dialog-backdrop');
      backdrop.id = 'svbDialogBackdrop';
      var dialog = el('div', 'svb-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'svbDialogTitle');
      var title = el('h3', 'svb-dialog-title', existing ? t('s21') : t('s22'));
      title.id = 'svbDialogTitle';
      var meta = el('div', 'svb-dialog-meta', ((ctx.role === 'user' ? t('s0') : 'AI')) + t('s23') + ctx.messageIndex + (existing ? '' : t('s24')));
      var preview = el('div', 'svb-dialog-preview', previewText(ctx.text));
      var input = el('input', 'svb-dialog-input');
      input.type = 'text';
      input.placeholder = t('s25');
      input.value = existing ? existing.name : defaultName(ctx.text);
      input.setAttribute('aria-label', t('s25'));
      var row = el('div', 'svb-dialog-actions');
      var cancel = btn('svb-btn', t('s13'));
      var save = btn('svb-btn svb-btn--primary', existing ? t('s26') : t('s12'));
      var del = existing ? btn('svb-btn svb-btn--danger', t('s27')) : null;
      var err = el('div', 'svb-dialog-error');
      err.setAttribute('role', 'alert');
      row.appendChild(cancel);
      if (del) row.appendChild(del);
      row.appendChild(save);
      dialog.appendChild(title);
      dialog.appendChild(meta);
      dialog.appendChild(preview);
      dialog.appendChild(input);
      dialog.appendChild(err);
      dialog.appendChild(row);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      var done = false;
      var sessionGuard = null;
      function close() {
        if (done) return;
        done = true;
        if (sessionGuard) clearInterval(sessionGuard);
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        restoreControlFocus(returnFocus);
        resolve();
      }
      function sessionChanged() { return currentSid() !== ctx.sessionId; }
      function abortStale() {
        close();
        toast(t('s20'), 'error');
      }
      function busy(on) { save.disabled = on; cancel.disabled = on; if (del) del.disabled = on; input.disabled = on; }
      function fail(e) {
        busy(false);
        var code = e && e.code;
        err.textContent = code === 'quota' ? t('quota')
          : code === 'too_large' ? t('tooLarge')
          : code === 'storage' ? t('s28')
          : code === 'immutable' ? t('s29')
          : code === 'unauthorized' ? t('s30')
          : t('s31') + (e && e.message ? ' (' + e.message + ')' : '') + '.';
      }
      function onSave() {
        var name = Array.from(collapseWs(input.value)).slice(0, NAME_MAX).join('');
        if (!name) { err.textContent = t('s32'); input.focus(); return; }
        if (sessionChanged()) { abortStale(); return; }
        busy(true);
        var p;
        if (existing) {
          p = store.patch(existing.id, { name: name }, existing.localOnly ? 'local' : 'server');
        } else {
          p = store.put({
            kind: 'bookmark',
            profile: captured.profile,
            sessionId: ctx.sessionId,
            messageIndex: ctx.messageIndex,
            role: ctx.role,
            name: name,
            // same session (checked above) → the live title is the freshest; captured one as fallback
            data: { preview: previewText(ctx.text), sessionTitle: sessionTitle() || captured.title, savedFrom: captured.phone ? 'phone' : 'desktop' },
          });
        }
        p.then(function () {
          toast(existing ? t('s33') : t('s34') + (store.backend === 'sidecar' ? '' : t('s35')));
          close();
          refreshIndex();
        }, fail);
      }
      function onDelete() {
        busy(true);
        store.remove(existing.id, existing.localOnly ? 'local' : 'server').then(function () {
          toast(t('s36'));
          close();
          refreshIndex();
        }, fail);
      }
      function onKey(ev) {
        if (ev.defaultPrevented || coreDialogOpen()) return;
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
        else if (ev.key === 'Enter' && ev.target === input) { ev.preventDefault(); ev.stopPropagation(); latchedKeys.add(ev.key); onSave(); }
        else if (ev.key === 'Tab') {
          var controls = Array.from(dialog.querySelectorAll('input:not([disabled]), button:not([disabled])'));
          if (!controls.length) { ev.preventDefault(); return; }
          var at = controls.indexOf(document.activeElement);
          if (at < 0 || (!ev.shiftKey && at === controls.length - 1) || (ev.shiftKey && at === 0)) {
            ev.preventDefault();
            controls[ev.shiftKey ? controls.length - 1 : 0].focus();
          }
        }
      }
      cancel.addEventListener('click', close);
      save.addEventListener('click', onSave);
      if (del) del.addEventListener('click', onDelete);
      backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(); });
      document.addEventListener('keydown', onKey, true);
      // Close by itself when core navigates away while the dialog is open.
      sessionGuard = setInterval(function () { if (!done && sessionChanged()) abortStale(); }, 500);
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) { /* ignore */ } }, 0);
    });
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  function jumpTo(target) {
    var nav = window.HermesVizNav;
    if (!nav || typeof nav.goTo !== 'function') { toast(reasonText('no_core'), 'error'); return Promise.resolve(false); }
    return nav.goTo(target).then(function (r) {
      if (!r || !r.ok) { toast(reasonText(r && r.reason, target.profile), 'error'); return false; }
      setPanelOpen(false);
      return true;
    }, function () { toast(reasonText('row_not_found'), 'error'); return false; });
  }

  // ── toolbar button ─────────────────────────────────────────────────────────
  function ensureToggle() {
    var existing = document.getElementById('svbToggleBtn');
    if (existing && existing === ui.toggle) return existing;
    if (existing) existing.remove();   // not created by this closure (stale copy) → rebuild with our listeners
    var shell = document.querySelector('.messages-shell');
    if (!shell) return null;
    var b = btn('svb-toggle', '', t('s37'));
    b.id = 'svbToggleBtn';
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', 'svbPanel');
    var glyph = el('span', 'svb-toggle-glyph', '');
    glyph.setAttribute('aria-hidden', 'true');
    // Inline SVG bookmark glyph (static markup, no user text).
    glyph.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    var badge = el('span', 'svb-toggle-badge', '0');
    badge.hidden = true;
    b.appendChild(glyph);
    b.appendChild(badge);
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); setPanelOpen(!panelOpen); });
    shell.appendChild(b);
    ui.toggle = b;
    positionToggle(b);
    return b;
  }

  // Share the top-right slot with core's #jumpToSessionStartBtn (top:16px; right:20px): sit to its left
  // whenever it is visible so the two never overlap.
  function positionToggle(b) {
    b = b || document.getElementById('svbToggleBtn');
    if (!b) return;
    var right = 20;
    var shell = document.querySelector('.messages-shell');
    var neighbours = [document.getElementById('jumpToSessionStartBtn'), document.getElementById('hwxMessagePinsHeaderBtn')];
    neighbours.forEach(function (other) {
      if (!other || !shell) return;
      try {
        var rect = other.getBoundingClientRect();
        if (getComputedStyle(other).display !== 'none' && rect.width > 0) {
          right = Math.max(right, shell.getBoundingClientRect().right - rect.left + 8);
        }
      } catch (_) { /* ignore */ }
    });
    b.style.right = right + 'px';
    var align = neighbours.find(function (other) {
      return other && getComputedStyle(other).display !== 'none' && other.getBoundingClientRect().width > 0;
    });
    var shellRect = shell && shell.getBoundingClientRect();
    var top = align && shellRect ? align.getBoundingClientRect().top - shellRect.top : 16;
    b.style.top = (Number.isFinite(top) ? top : 16) + 'px';
    positionPanel();
  }

  var startObserver = null;
  var placementFrame = null;
  function schedulePosition() {
    if (placementFrame !== null) return;
    placementFrame = window.requestAnimationFrame(function () { placementFrame = null; positionToggle(); });
  }
  function observeStartButton() {
    var shell = document.querySelector('.messages-shell');
    if (!shell || typeof MutationObserver === 'undefined') return;
    if (!startObserver) startObserver = new MutationObserver(function (records) {
      if (records.some(function (record) { return record.type === 'childList'; })) observeStartButton();
      schedulePosition();
    });
    startObserver.disconnect();
    startObserver.observe(shell, { childList: true });
    ['jumpToSessionStartBtn', 'hwxMessagePinsHeaderBtn'].forEach(function (id) {
      var other = document.getElementById(id);
      if (other) startObserver.observe(other, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    schedulePosition();
  }

  function positionPanel() {
    if (!ui.panel || !ui.toggle) return;
    var rect = ui.toggle.getBoundingClientRect();
    if (Number.isFinite(rect.bottom)) ui.panel.style.setProperty('--svb-panel-top', (rect.bottom + 8) + 'px');
    if (Number.isFinite(rect.right)) ui.panel.style.setProperty('--svb-panel-right', Math.max(16, window.innerWidth - rect.right) + 'px');
  }

  function updateBadge() {
    var b = document.getElementById('svbToggleBtn');
    if (!b) return;
    var badge = b.querySelector('.svb-toggle-badge');
    var sid = currentSid();
    var n = 0;
    for (var i = 0; i < items.length; i++) if (items[i].sessionId === sid) n++;
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    b.classList.toggle('svb-toggle--has', n > 0);
  }

  // ── panel ──────────────────────────────────────────────────────────────────
  function ensurePanel() {
    var existing = document.getElementById('svbPanel');
    if (existing && existing === ui.panel) return existing;
    if (existing) existing.remove();   // a panel whose closure we do not hold would leave `ui` empty → rebuild
    var panel = el('section', 'svb-panel');
    panel.id = 'svbPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('s38'));

    var head = el('div', 'svb-head');
    var titleWrap = el('div', 'svb-head-title');
    titleWrap.appendChild(el('span', 'svb-title', t('s39')));
    var badge = el('span', 'svb-sync-badge', t('s18'));
    badge.title = t('s40');
    titleWrap.appendChild(badge);
    head.appendChild(titleWrap);
    var close = btn('svb-close', '×', t('s41'));
    close.addEventListener('click', function () { setPanelOpen(false); });
    head.appendChild(close);

    var tabs = el('div', 'svb-tabs');
    tabs.setAttribute('role', 'tablist');
    var tabB = btn('svb-tab', t('s1'));
    tabB.setAttribute('role', 'tab');
    tabB.dataset.tab = 'bookmarks';
    tabB.id = 'svbTabBookmarks';
    tabB.setAttribute('aria-controls', 'svbPanelBody');
    var tabT = btn('svb-tab', t('s42'));
    tabT.setAttribute('role', 'tab');
    tabT.dataset.tab = 'toc';
    tabT.id = 'svbTabToc';
    tabT.setAttribute('aria-controls', 'svbPanelBody');
    tabB.addEventListener('click', function () { setTab('bookmarks'); });
    tabT.addEventListener('click', function () { setTab('toc'); });
    tabs.addEventListener('keydown', function (ev) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault();
      setTab(ev.key === 'Home' ? 'bookmarks' : ev.key === 'End' ? 'toc' : activeTab === 'bookmarks' ? 'toc' : 'bookmarks');
      (activeTab === 'bookmarks' ? tabB : tabT).focus();
    });
    tabs.appendChild(tabB);
    tabs.appendChild(tabT);

    var body = el('div', 'svb-body');
    body.setAttribute('role', 'tabpanel');
    body.id = 'svbPanelBody';
    var foot = el('div', 'svb-foot');

    panel.appendChild(head);
    panel.appendChild(tabs);
    panel.appendChild(body);
    panel.appendChild(foot);
    document.body.appendChild(panel);
    ui = { toggle: ui.toggle, panel: panel, badge: badge, tabB: tabB, tabT: tabT, body: body, foot: foot };
    return panel;
  }

  function setTab(tab) {
    activeTab = tab === 'toc' ? 'toc' : 'bookmarks';
    renderPanel();
  }

  function setPanelOpen(open) {
    ensurePanel();
    if (open && !panelOpen) panelReturnFocus = document.activeElement;
    var wasOpen = panelOpen;
    panelOpen = !!open;
    ui.panel.hidden = !panelOpen;
    var toggle = document.getElementById('svbToggleBtn');
    if (toggle) toggle.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    if (panelOpen) {
      lastWatchSid = currentSid();
      renderPanel();
      (activeTab === 'bookmarks' ? ui.tabB : ui.tabT).focus();
      refreshIndex();
      if (!watchTimer) {
        // Cheap session-change watch while open (no transcript-wide observers needed).
        watchTimer = setInterval(function () {
          if (!chatVisible()) { setPanelOpen(false); return; }
          if (store && store.syncError) refreshIndex();
          positionToggle();
          var sid = currentSid();
          if (sid !== lastWatchSid) { lastWatchSid = sid; tocCache = { key: null, entries: null, loading: null }; updateBadge(); renderPanel(); }
        }, 1000);
      }
      document.addEventListener('keydown', onPanelKey, true);
      document.addEventListener('click', onOutsideClick);
    } else {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      document.removeEventListener('keydown', onPanelKey, true);
      document.removeEventListener('click', onOutsideClick);
      if (wasOpen && panelReturnFocus && panelReturnFocus.isConnected && chatVisible() && !coreDialogOpen()) restoreControlFocus(panelReturnFocus);
    }
  }

  function chatVisible() {
    var currentPanel = window._currentPanel || 'chat';
    try { if (typeof _currentPanel !== 'undefined') currentPanel = _currentPanel || 'chat'; } catch (_) { /* ignore */ }
    if (currentPanel !== 'chat' && currentPanel !== 'todos') return false;
    var shell = document.querySelector('.messages-shell');
    if (!shell) return false;
    for (var node = shell; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return false;
    }
    return true;
  }

  function onOutsideClick(ev) {
    // The clicked dialog may already have removed itself before this event bubbles here.
    if (ev.target.closest && ev.target.closest('#appDialogOverlay, #svbDialogBackdrop')) return;
    if (ev.composedPath && ev.composedPath().some(function (node) { return node.id === 'appDialogOverlay' || node.id === 'svbDialogBackdrop'; })) return;
    if (ui.panel.contains(ev.target) || ui.toggle.contains(ev.target) || document.getElementById('svbDialogBackdrop') || coreDialogOpen()) return;
    setPanelOpen(false);
  }

  function onPanelKey(ev) {
    if (ev.defaultPrevented || coreDialogOpen()) return;
    if (ev.key === 'Escape' && !document.getElementById('svbDialogBackdrop')) { ev.preventDefault(); ev.stopPropagation(); setPanelOpen(false); }
  }

  function renderPanel() {
    if (!panelOpen || !ui.panel) return;
    positionToggle();
    if (ui.toggle) { ui.toggle.title = t('s37'); ui.toggle.setAttribute('aria-label', t('s37')); }
    var close = ui.panel.querySelector('.svb-close');
    close.title = t('s41');
    close.setAttribute('aria-label', t('s41'));
    ui.tabB.textContent = t('s1');
    ui.tabT.textContent = t('s42');
    ui.panel.querySelector('.svb-title').textContent = t('s39');
    ui.panel.setAttribute('aria-label', t('s38'));
    var state = syncState();
    ui.badge.textContent = badgeText(state);
    ui.badge.classList.toggle('svb-sync-badge--on', state === 'synced');
    ui.badge.classList.toggle('svb-sync-badge--partial', state === 'partial');
    ui.badge.title = state === 'synced' ? t('s43')
      : state === 'partial' ? t('s44')
      : t('s40');
    ui.tabB.classList.toggle('svb-tab--active', activeTab === 'bookmarks');
    ui.tabT.classList.toggle('svb-tab--active', activeTab === 'toc');
    ui.tabB.setAttribute('aria-selected', activeTab === 'bookmarks' ? 'true' : 'false');
    ui.tabT.setAttribute('aria-selected', activeTab === 'toc' ? 'true' : 'false');
    ui.tabB.tabIndex = activeTab === 'bookmarks' ? 0 : -1;
    ui.tabT.tabIndex = activeTab === 'toc' ? 0 : -1;
    ui.body.setAttribute('aria-labelledby', activeTab === 'bookmarks' ? ui.tabB.id : ui.tabT.id);
    clear(ui.body);
    clear(ui.foot);
    if (!actionAvailable) ui.body.appendChild(el('p', 'svb-empty svb-error', t('actionUnavailable')));
    if (activeTab === 'bookmarks') renderBookmarks(); else renderToc();
  }

  function sessionLabelFor(group) {
    var title = '';
    for (var i = 0; i < group.items.length && !title; i++) {
      var d = group.items[i].data;
      if (d && typeof d.sessionTitle === 'string' && d.sessionTitle.trim()) title = d.sessionTitle.trim();
    }
    if (group.sessionId === currentSid()) {
      var live = sessionTitle();
      if (live) title = live;
    }
    return title || (t('s45') + group.sessionId.slice(0, 8));
  }

  function renderBookmarks() {
    var body = ui.body;
    if (!store) { body.appendChild(el('p', 'svb-empty', t('s46'))); return; }
    if (lastListError) {
      body.appendChild(el('p', 'svb-empty svb-error', t('s47') + describeError(lastListError) + t('s48')));
    }
    if (!items.length) {
      body.appendChild(el('p', 'svb-empty', t('s49')));
    } else {
      var sid = currentSid();
      var active = currentProfile();
      // group: profile → session (current session first, then newest bookmark first)
      var profiles = new Map();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var pg = profiles.get(it.profile);
        if (!pg) { pg = { profile: it.profile, sessions: new Map() }; profiles.set(it.profile, pg); }
        var sg = pg.sessions.get(it.sessionId);
        if (!sg) { sg = { sessionId: it.sessionId, items: [], latest: 0 }; pg.sessions.set(it.sessionId, sg); }
        sg.items.push(it);
        if (it.createdAt > sg.latest) sg.latest = it.createdAt;
      }
      var profileList = Array.from(profiles.values()).sort(function (a, b) {
        if (a.profile === active) return -1;
        if (b.profile === active) return 1;
        return a.profile < b.profile ? -1 : 1;
      });
      profileList.forEach(function (pg) {
        var pHead = el('div', 'svb-group-profile', t('s50') + pg.profile + (pg.profile === active ? t('s51') : ''));
        body.appendChild(pHead);
        var sessions = Array.from(pg.sessions.values()).sort(function (a, b) {
          if (a.sessionId === sid) return -1;
          if (b.sessionId === sid) return 1;
          return b.latest - a.latest;
        });
        sessions.forEach(function (sg) {
          var sHead = el('div', 'svb-group-session');
          sHead.appendChild(el('span', 'svb-group-session-title', sessionLabelFor(sg)));
          if (sg.sessionId === sid) sHead.appendChild(el('span', 'svb-chip', t('s52')));
          body.appendChild(sHead);
          sg.items.sort(function (a, b) { return a.messageIndex - b.messageIndex; });
          sg.items.forEach(function (it) { body.appendChild(bookmarkRow(it, pg.profile)); });
        });
      });
    }
    // footer: export / import + sync hint
    var foot = ui.foot;
    var tools = el('div', 'svb-tools');
    var exp = btn('svb-btn svb-btn--small', t('s53'));
    exp.addEventListener('click', exportBookmarks);
    var imp = btn('svb-btn svb-btn--small', t('s54'));
    var file = el('input', 'svb-file');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', function () { if (file.files && file.files[0]) importBookmarks(file.files[0]); file.value = ''; });
    imp.addEventListener('click', function () { file.click(); });
    tools.appendChild(exp);
    tools.appendChild(imp);
    tools.appendChild(file);
    foot.appendChild(tools);
    var state = syncState();
    if (state === 'unavailable') {
      foot.appendChild(el('div', 'svb-hint', t('unavailable')));
    } else if (state === 'local') {
      var hint = el('div', 'svb-hint');
      hint.appendChild(el('strong', null, t('s55')));
      if (store && store.syncError) {
        // /health answered but the data routes did not: say so instead of a silent dead sync.
        hint.appendChild(document.createTextNode(t('s56') + describeError(store.syncError) + t('s57')));
      } else {
        hint.appendChild(document.createTextNode(t('s58')));
      }
      foot.appendChild(hint);
    } else if (state === 'partial') {
      foot.appendChild(el('div', 'svb-hint', store.pendingLocal + t('s59')));
    } else {
      foot.appendChild(el('div', 'svb-hint', t('s60')));
    }
  }

  function bookmarkRow(it, profile) {
    var row = el('div', 'svb-entry-row');
    var main = btn('svb-entry', '');
    main.appendChild(el('span', 'svb-role svb-role--' + it.role, (it.role === 'user' ? t('s0') : 'AI')));
    main.appendChild(el('span', 'svb-entry-name', it.name || t('s61')));
    main.appendChild(el('span', 'svb-entry-idx', '#' + it.messageIndex));
    if (it.localOnly === true) {
      var localChip = el('span', 'svb-chip svb-chip--local', t(it.conflict ? 'conflict' : 's62'));
      localChip.title = t('s63');
      main.appendChild(localChip);
    }
    main.title = (it.data && it.data.preview) ? String(it.data.preview) : it.name;
    main.addEventListener('click', function () {
      jumpTo({ profile: profile, sessionId: it.sessionId, messageIndex: it.messageIndex, role: it.role });
    });
    var rename = btn('svb-mini', '✎', t('s26'));
    rename.addEventListener('click', function (ev) {
      ev.stopPropagation();
      askText(t('s64'), t('s65'), it.name).then(function (name) {
        if (name === null || name === undefined) return;
        name = Array.from(collapseWs(name)).slice(0, NAME_MAX).join('');
        if (!name) return;
        return store.patch(it.id, { name: name }, it.localOnly ? 'local' : 'server').then(function () { toast(t('s66')); refreshIndex(); });
      }).catch(function (e) { toast(t('s67') + (e && e.message || ''), 'error'); });
    });
    var del = btn('svb-mini svb-mini--danger', '×', t('s27'));
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      askConfirm(t('s68'), t('s69') + it.name + t('s70'), t('s27')).then(function (ok) {
        if (!ok) return;
        return store.remove(it.id, it.localOnly ? 'local' : 'server').then(function () { toast(t('s71')); refreshIndex(); });
      }).catch(function (e) { toast(t('s72') + (e && e.message || ''), 'error'); });
    });
    row.appendChild(main);
    row.appendChild(rename);
    row.appendChild(del);
    return row;
  }

  function exportBookmarks() {
    if (!store) return;
    store.exportJson().then(function (text) {
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'sigakhwa-bookmarks-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      } catch (e) { toast(t('s73'), 'error'); }
    }, function () { toast(t('s73'), 'error'); });
  }

  function importBookmarks(file) {
    if (!store) return;
    if (file.size > 4 * 1024 * 1024) { toast(t('s74'), 'error'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      store.importJson(String(reader.result || ''), { merge: true }).then(function (r) {
        toast(t('s75') + r.added + t('s76') + r.skipped + t('s77'));
        refreshIndex();
      }, function (e) { toast(t('s78') + (e && e.code === 'invalid' ? t('s79') : (e && e.message || '')), 'error'); });
    };
    reader.onerror = function () { toast(t('s80'), 'error'); };
    reader.readAsText(file);
  }

  // ── TOC tab ────────────────────────────────────────────────────────────────
  function fetchTranscript(sid) {
    var path = '/api/session?session_id=' + encodeURIComponent(sid) + '&messages=1&resolve_model=0&msg_limit=all';
    return window.fetch(path, { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var msgs = data && data.session && Array.isArray(data.session.messages) ? data.session.messages : [];
      return msgs;
    });
  }

  function tocEntriesFor(sid) {
    var s = coreS();
    var count = s && s.session ? Number(s.session.message_count || 0) : 0;
    var key = sid + ':' + count;
    if (tocCache.key === key && tocCache.entries) return Promise.resolve(tocCache.entries);
    if (tocCache.loading && tocCache.key === key) return tocCache.loading;
    tocCache.key = key;
    tocCache.entries = null;
    tocCache.loading = fetchTranscript(sid).then(function (msgs) {
      var entries = parseToc(msgs);
      if (tocCache.key === key) { tocCache.entries = entries; tocCache.loading = null; }
      return entries;
    }, function (e) {
      if (tocCache.key === key) tocCache.loading = null;
      throw e;
    });
    return tocCache.loading;
  }

  function renderToc() {
    var body = ui.body;
    var sid = currentSid();
    if (!sid) { body.appendChild(el('p', 'svb-empty', t('s81'))); return; }
    var profile = sessionProfile();
    var loading = el('p', 'svb-empty', t('s82'));
    body.appendChild(loading);
    tocEntriesFor(sid).then(function (entries) {
      if (!panelOpen || activeTab !== 'toc' || currentSid() !== sid) return;
      clear(body);
      if (!entries.length) {
        body.appendChild(el('p', 'svb-empty', t('s83')));
        return;
      }
      var lastMsg = -1;
      var n = 0;
      entries.forEach(function (e) {
        if (e.messageIndex !== lastMsg) {
          lastMsg = e.messageIndex;
          n++;
          body.appendChild(el('div', 'svb-group-session', t('s84') + e.messageIndex));
        }
        var b = btn('svb-entry svb-toc-entry svb-toc-' + e.kind + (e.level ? ' svb-toc-level-' + e.level : ''), '');
        b.appendChild(el('span', 'svb-toc-tag', '[' + (({ heading: 'H', table: t('s2'), diagram: t('s3'), frame: t('s4') }[e.kind] || e.kind)) + ']'));
        b.appendChild(el('span', 'svb-entry-name', e.label));
        b.title = e.label;
        b.addEventListener('click', function () {
          jumpTo({ profile: profile, sessionId: sid, messageIndex: e.messageIndex, role: 'assistant' });
        });
        body.appendChild(b);
      });
      var foot = ui.foot;
      clear(foot);
      foot.appendChild(el('div', 'svb-hint', entries.length + t('s85') + n + t('s86')));
    }, function (e) {
      if (!panelOpen || activeTab !== 'toc') return;
      clear(body);
      body.appendChild(el('p', 'svb-empty', t('s87') + (e && e.message ? ' (' + e.message + ')' : '') + '.'));
    });
  }

  // ── install ────────────────────────────────────────────────────────────────
  function registerAction() {
    var ext = window.hermesExt;
    if (!ext || typeof ext.register !== 'function') return false;
    handle = handle || ext.register(EXT_ID);
    if (!handle) {
      try { console.warn('[' + EXT_ID + '] hermesExt.register returned null (not in the boot manifest inventory)'); } catch (_) { /* ignore */ }
      return false;
    }
    var unregister = handle.messages.registerAction({
      id: 'bookmark',
      label: t('s1'),
      icon: 'bookmark',
      roles: ['user', 'assistant'],
      getPressed: function (ctx) { return index.has(activeKeyFor(ctx)); },
      onInvoke: function (ctx) {
        if (!store) { toast(t('s88'), 'error'); return; }
        return openBookmarkDialog(ctx);
      },
    });
    if (typeof unregister !== 'function') {
      try { console.warn('[' + EXT_ID + '] registerAction rejected by core (duplicate action key, or the page-wide budget of 2 message actions is used up)'); } catch (_) { /* ignore */ }
      return false;
    }
    pub.unregisterAction = unregister;
    try {
      if (!actionEventBound) {
        handle.events.on('turn:complete', function () { tocCache = { key: null, entries: null, loading: null }; });
        actionEventBound = true;
      }
    } catch (_) { /* ignore */ }
    return true;
  }

  function openStore(attempt) {
    var VS = window.HermesVizStore;
    if (!VS || typeof VS.open !== 'function') {
      if ((attempt || 0) < 40) { setTimeout(function () { openStore((attempt || 0) + 1); }, 150); return; }
      try { console.warn('[' + EXT_ID + '] HermesVizStore missing — bookmarks disabled'); } catch (_) { /* ignore */ }
      return;
    }
    try { store = VS.open(NS); } catch (e) { try { console.warn('[' + EXT_ID + '] store open failed', e); } catch (_) { /* ignore */ } return; }
    pub.store = store;
    store.subscribe(function (ev) { if (ev.type === 'status') renderPanel(); else refreshIndex(); });
    store.ready.then(function () { refreshIndex(); }, function () { refreshIndex(); });
  }

  function install(attempt) {
    attempt = attempt || 0;
    var shell = document.querySelector('.messages-shell');
    if (!shell) {
      if (attempt < 80) { setTimeout(function () { install(attempt + 1); }, 150); return; }
      pub.installing = false;   // gave up; a later injection may try again
      try { console.warn('[' + EXT_ID + '] .messages-shell not found; not installed'); } catch (_) { /* ignore */ }
      return;
    }
    if (pub.installed) return;
    pub.installed = true;
    pub.installing = false;
    openStore(0);
    document.addEventListener('keydown', function (ev) {
      if (latchedKeys.has(ev.key)) {
        if (ev.repeat) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
        latchedKeys.delete(ev.key);
      }
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      var target = ev.target;
      // Core renders message actions repeatedly; delegate containment to a stable listener.
      if (target && target.closest && (target.closest('[data-extension-id="sigakhwa-bookmarks"][data-extension-action-id="bookmark"]') ||
          (sharedDialogDepth && target.closest('#appDialogOverlay')))) {
        ev.stopPropagation();
        if (!ev.repeat) latchedKeys.add(ev.key);
        if (sharedDialogDepth && ev.key === 'Enter' && target.tagName === 'INPUT' && !ev.defaultPrevented && !ev.isComposing) {
          ev.preventDefault();
          var confirm = document.getElementById('appDialogConfirm');
          if (confirm) confirm.click();
        }
      }
    }, true);
    actionAvailable = registerAction();
    ensureToggle();
    ensurePanel();
    observeStartButton();
    var viewObserver = new MutationObserver(function () { if (panelOpen && !chatVisible()) setPanelOpen(false); });
    for (var ancestor = shell; ancestor && ancestor.nodeType === 1; ancestor = ancestor.parentElement) {
      viewObserver.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    if (typeof ResizeObserver === 'function') {
      var resizeObserver = new ResizeObserver(schedulePosition);
      resizeObserver.observe(shell);
    }
    var languageObserver = new MutationObserver(function () {
      if (typeof pub.unregisterAction === 'function') pub.unregisterAction();
      actionAvailable = registerAction();
      ui.toggle.title = t('s37'); ui.toggle.setAttribute('aria-label', t('s37'));
      renderPanel();
      if (handle) handle.messages.invalidateActions();
    });
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    window.addEventListener('resize', function () { positionToggle(); });
    pub.open = function () { setPanelOpen(true); };
    pub.close = function () { setPanelOpen(false); };
    pub.refresh = refreshIndex;
    pub.jumpTo = jumpTo;
    pub.registered = !!handle;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { install(0); }, { once: true });
  else install(0);
})();
