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
  var ROLE_LABEL = { user: '나', assistant: 'AI' };

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
    if (s.length <= n) return s;
    return s.slice(0, n).replace(/\s+$/, '') + '…';
  }

  // Leading block markers per line (heading #, bullet, ordered list, blockquote). Anchored + bounded → linear.
  var BLOCK_MARKER_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+|>[ \t]?|\d{1,3}\.[ \t]+)/gm;
  function stripBlockMarkers(s) {
    return String(s || '').replace(BLOCK_MARKER_RE, '');
  }

  // Default bookmark name = first 40 visible characters of the message text.
  function defaultName(text) {
    var t = collapseWs(stripInlineMarkdown(stripBlockMarkers(String(text || '').slice(0, 4000))));
    if (!t) return '북마크';
    return truncate(t, DEFAULT_NAME_LEN);
  }

  function previewText(text) {
    return truncate(collapseWs(String(text || '').slice(0, 4000)), PREVIEW_LEN);
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
          entries.push({ messageIndex: mi, role: 'assistant', kind: 'table', label: tl || '표' });
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

  var KIND_TAG = { heading: 'H', table: '표', diagram: '도식', frame: '프레임' };

  function reasonText(reason, extra) {
    switch (reason) {
      case 'no_core': return '코어 UI를 찾을 수 없어 이동할 수 없습니다.';
      case 'session_not_found': return '대화를 열 수 없습니다 (삭제되었거나 이 프로필에서 접근할 수 없음).';
      case 'profile_switch_required': return '다른 프로필(' + (extra || '?') + ')의 대화입니다. 먼저 해당 프로필로 전환해 주세요.';
      case 'row_not_found': return '메시지를 찾을 수 없습니다 (삭제·압축되었을 수 있음).';
      case 'busy_switch_blocked': return '응답 생성 중에는 이동할 수 없습니다. 잠시 후 다시 시도해 주세요.';
      default: return '이동에 실패했습니다.';
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

  // Core's shared app dialogs (ui.js showPromptDialog / showConfirmDialog) when present, native fallbacks otherwise.
  function askText(title, message, value) {
    if (typeof window.showPromptDialog === 'function') {
      try { return Promise.resolve(window.showPromptDialog({ title: title, message: message, value: value, confirmLabel: '저장', cancelLabel: '취소' })); } catch (_) { /* fall back */ }
    }
    return Promise.resolve(typeof window.prompt === 'function' ? window.prompt(title + '\n' + message, value) : null);
  }
  function askConfirm(title, message, confirmLabel) {
    if (typeof window.showConfirmDialog === 'function') {
      try { return Promise.resolve(window.showConfirmDialog({ title: title, message: message, confirmLabel: confirmLabel || '확인', cancelLabel: '취소' })).then(function (r) { return r === true; }); } catch (_) { /* fall back */ }
    }
    return Promise.resolve(typeof window.confirm === 'function' ? !!window.confirm(title + '\n' + message) : false);
  }

  // ── DOM helpers (textContent only — never innerHTML with model text) ───────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function btn(cls, text, label) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (label) { b.title = label; b.setAttribute('aria-label', label); }
    return b;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

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

  // Sync state shown to the user: 'local' (this browser only) | 'partial' (sidecar in use, but
  // store.pendingLocal items were refused and remain here) | 'synced'.
  function syncState() {
    if (!store || store.backend !== 'sidecar') return 'local';
    return store.pendingLocal > 0 ? 'partial' : 'synced';
  }
  function badgeText(state) {
    if (state === 'synced') return '동기화됨';
    if (state === 'partial') return '일부 동기화됨 · ' + store.pendingLocal + '개는 이 기기에만';
    return '이 기기에만 저장됨';
  }
  function describeError(e) {
    if (!e) return '오류';
    if (e.status) return 'HTTP ' + e.status;
    return String(e.code || e.message || '오류');
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
      var existing = index.get(activeKeyFor(ctx)) || null;
      // The dialog is not modal for core: a hash/URL/SSE-driven loadSession() can change S.session while
      // it is open. Capture the file-under values now and re-check the session before saving.
      var captured = { profile: sessionProfile(), title: sessionTitle(), phone: isPhone() };
      var old = document.getElementById('svbDialogBackdrop');
      if (old) old.remove();
      if (currentSid() !== ctx.sessionId) {
        toast('대화가 바뀌어 북마크를 저장하지 않았습니다. 다시 시도해 주세요.', 'error');
        resolve();
        return;
      }

      var backdrop = el('div', 'svb-dialog-backdrop');
      backdrop.id = 'svbDialogBackdrop';
      var dialog = el('div', 'svb-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'svbDialogTitle');
      var title = el('h3', 'svb-dialog-title', existing ? '북마크 편집' : '북마크 저장');
      title.id = 'svbDialogTitle';
      var meta = el('div', 'svb-dialog-meta', (ROLE_LABEL[ctx.role] || ctx.role) + ' · 메시지 #' + ctx.messageIndex + (existing ? '' : ' · 이름을 정해 저장합니다'));
      var preview = el('div', 'svb-dialog-preview', previewText(ctx.text));
      var input = el('input', 'svb-dialog-input');
      input.type = 'text';
      input.maxLength = NAME_MAX;
      input.placeholder = '북마크 이름';
      input.value = existing ? existing.name : defaultName(ctx.text);
      input.setAttribute('aria-label', '북마크 이름');
      var row = el('div', 'svb-dialog-actions');
      var cancel = btn('svb-btn', '취소');
      var save = btn('svb-btn svb-btn--primary', existing ? '이름 변경' : '저장');
      var del = existing ? btn('svb-btn svb-btn--danger', '삭제') : null;
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
        resolve();
      }
      function sessionChanged() { return currentSid() !== ctx.sessionId; }
      function abortStale() {
        close();
        toast('대화가 바뀌어 북마크를 저장하지 않았습니다. 다시 시도해 주세요.', 'error');
      }
      function busy(on) { save.disabled = on; cancel.disabled = on; if (del) del.disabled = on; input.disabled = on; }
      function fail(e) {
        busy(false);
        var code = e && e.code;
        err.textContent = code === 'storage' ? '저장 공간이 부족하거나 저장소를 사용할 수 없습니다.'
          : code === 'immutable' ? '변경할 수 없는 항목입니다.'
          : code === 'unauthorized' ? '사이드카 권한이 없습니다. 설정에서 프록시 허용을 확인하세요.'
          : '저장에 실패했습니다' + (e && e.message ? ' (' + e.message + ')' : '') + '.';
      }
      function onSave() {
        var name = collapseWs(input.value).slice(0, NAME_MAX);
        if (!name) { err.textContent = '이름을 입력해 주세요.'; input.focus(); return; }
        if (sessionChanged()) { abortStale(); return; }
        busy(true);
        var p;
        if (existing) {
          p = store.patch(existing.id, { name: name });
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
          toast(existing ? '북마크 이름을 변경했습니다' : '북마크를 저장했습니다' + (store.backend === 'sidecar' ? '' : ' (이 기기에만 저장됨)'));
          close();
          refreshIndex();
        }, fail);
      }
      function onDelete() {
        busy(true);
        store.remove(existing.id).then(function () {
          toast('북마크를 삭제했습니다');
          close();
          refreshIndex();
        }, fail);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
        else if (ev.key === 'Enter' && ev.target === input) { ev.preventDefault(); onSave(); }
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
      if (isPhone()) setPanelOpen(false);
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
    var b = btn('svb-toggle', '', '북마크 · 목차 열기');
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
    var start = document.getElementById('jumpToSessionStartBtn');
    if (start) {
      var visible = false;
      try { visible = getComputedStyle(start).display !== 'none' && start.getBoundingClientRect().width > 0; } catch (_) { visible = false; }
      if (visible) right = 20 + start.getBoundingClientRect().width + 8;
    }
    b.style.right = right + 'px';
  }

  var startObserver = null;
  function observeStartButton() {
    var start = document.getElementById('jumpToSessionStartBtn');
    if (!start || startObserver || typeof MutationObserver === 'undefined') return;
    // Scoped: attributes of one core button only (its display toggles on scroll).
    startObserver = new MutationObserver(function () { positionToggle(); });
    startObserver.observe(start, { attributes: true, attributeFilter: ['style', 'class'] });
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
    panel.setAttribute('aria-label', '북마크와 목차');

    var head = el('div', 'svb-head');
    var titleWrap = el('div', 'svb-head-title');
    titleWrap.appendChild(el('span', 'svb-title', '북마크 · 목차'));
    var badge = el('span', 'svb-sync-badge', '이 기기에만 저장됨');
    badge.title = '브라우저 localStorage에만 저장됩니다. PC·폰 동기화는 사이드카가 필요합니다.';
    titleWrap.appendChild(badge);
    head.appendChild(titleWrap);
    var close = btn('svb-close', '×', '닫기');
    close.addEventListener('click', function () { setPanelOpen(false); });
    head.appendChild(close);

    var tabs = el('div', 'svb-tabs');
    tabs.setAttribute('role', 'tablist');
    var tabB = btn('svb-tab', '북마크');
    tabB.setAttribute('role', 'tab');
    tabB.dataset.tab = 'bookmarks';
    var tabT = btn('svb-tab', '목차');
    tabT.setAttribute('role', 'tab');
    tabT.dataset.tab = 'toc';
    tabB.addEventListener('click', function () { setTab('bookmarks'); });
    tabT.addEventListener('click', function () { setTab('toc'); });
    tabs.appendChild(tabB);
    tabs.appendChild(tabT);

    var body = el('div', 'svb-body');
    body.setAttribute('role', 'tabpanel');
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
    panelOpen = !!open;
    ui.panel.hidden = !panelOpen;
    var toggle = document.getElementById('svbToggleBtn');
    if (toggle) toggle.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    if (panelOpen) {
      lastWatchSid = currentSid();
      renderPanel();
      refreshIndex();
      if (!watchTimer) {
        // Cheap session-change watch while open (no transcript-wide observers needed).
        watchTimer = setInterval(function () {
          var sid = currentSid();
          if (sid !== lastWatchSid) { lastWatchSid = sid; tocCache = { key: null, entries: null, loading: null }; updateBadge(); renderPanel(); }
        }, 1000);
      }
      document.addEventListener('keydown', onPanelKey, true);
    } else {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      document.removeEventListener('keydown', onPanelKey, true);
    }
  }

  function onPanelKey(ev) {
    if (ev.key === 'Escape' && !document.getElementById('svbDialogBackdrop')) { setPanelOpen(false); }
  }

  function renderPanel() {
    if (!panelOpen || !ui.panel) return;
    var state = syncState();
    ui.badge.textContent = badgeText(state);
    ui.badge.classList.toggle('svb-sync-badge--on', state === 'synced');
    ui.badge.classList.toggle('svb-sync-badge--partial', state === 'partial');
    ui.badge.title = state === 'synced' ? '사이드카에 저장되어 같은 WebUI에 로그인한 다른 기기에서도 보입니다.'
      : state === 'partial' ? '서버가 받지 않은 항목은 이 브라우저에만 남아 있습니다 (목록에서 "이 기기" 표시).'
      : '브라우저 localStorage에만 저장됩니다. PC·폰 동기화는 사이드카가 필요합니다.';
    ui.tabB.classList.toggle('svb-tab--active', activeTab === 'bookmarks');
    ui.tabT.classList.toggle('svb-tab--active', activeTab === 'toc');
    ui.tabB.setAttribute('aria-selected', activeTab === 'bookmarks' ? 'true' : 'false');
    ui.tabT.setAttribute('aria-selected', activeTab === 'toc' ? 'true' : 'false');
    clear(ui.body);
    clear(ui.foot);
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
    return title || ('대화 ' + group.sessionId.slice(0, 8));
  }

  function renderBookmarks() {
    var body = ui.body;
    if (!store) { body.appendChild(el('p', 'svb-empty', '저장소를 초기화하는 중…')); return; }
    if (lastListError) {
      body.appendChild(el('p', 'svb-empty svb-error', '북마크 목록을 불러오지 못했습니다 (' + describeError(lastListError) + '). 사이드카 상태를 확인한 뒤 새로고침하세요. 아래는 마지막으로 읽은 목록입니다.'));
    }
    if (!items.length) {
      body.appendChild(el('p', 'svb-empty', '저장된 북마크가 없습니다. 메시지 하단의 북마크 버튼으로 저장하세요.'));
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
        var pHead = el('div', 'svb-group-profile', '프로필: ' + pg.profile + (pg.profile === active ? ' (현재)' : ''));
        body.appendChild(pHead);
        var sessions = Array.from(pg.sessions.values()).sort(function (a, b) {
          if (a.sessionId === sid) return -1;
          if (b.sessionId === sid) return 1;
          return b.latest - a.latest;
        });
        sessions.forEach(function (sg) {
          var sHead = el('div', 'svb-group-session');
          sHead.appendChild(el('span', 'svb-group-session-title', sessionLabelFor(sg)));
          if (sg.sessionId === sid) sHead.appendChild(el('span', 'svb-chip', '현재 대화'));
          body.appendChild(sHead);
          sg.items.sort(function (a, b) { return a.messageIndex - b.messageIndex; });
          sg.items.forEach(function (it) { body.appendChild(bookmarkRow(it, pg.profile)); });
        });
      });
    }
    // footer: export / import + sync hint
    var foot = ui.foot;
    var tools = el('div', 'svb-tools');
    var exp = btn('svb-btn svb-btn--small', '내보내기(JSON)');
    exp.addEventListener('click', exportBookmarks);
    var imp = btn('svb-btn svb-btn--small', '가져오기(JSON)');
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
    if (state === 'local') {
      var hint = el('div', 'svb-hint');
      hint.appendChild(el('strong', null, '이 기기에만 저장됨. '));
      if (store && store.syncError) {
        // /health answered but the data routes did not: say so instead of a silent dead sync.
        hint.appendChild(document.createTextNode('사이드카는 응답했지만 데이터 요청이 실패했습니다 (' + describeError(store.syncError) + '). 사이드카 로그와 설정 → Extensions의 프록시 허용 상태를 확인한 뒤 새로고침하세요.'));
      } else {
        hint.appendChild(document.createTextNode('PC와 폰에서 함께 보려면: ① 사이드카 실행 (sidecar/README: python -S sidecar.py) ② WebUI 비밀번호 설정 ③ 설정 → Extensions → sigakhwa-bookmarks → 사이드카 프록시 허용 ④ 새로고침. 그러면 이 기기의 북마크가 서버로 옮겨집니다.'));
      }
      foot.appendChild(hint);
    } else if (state === 'partial') {
      foot.appendChild(el('div', 'svb-hint', store.pendingLocal + '개 항목은 서버가 받지 않아 이 기기에만 남아 있습니다 (용량 초과 또는 형식 오류). 목록에서 "이 기기" 표시가 붙고, 새로고침할 때마다 다시 보내 봅니다. 삭제하면 이 기기에서만 지워집니다.'));
    } else {
      foot.appendChild(el('div', 'svb-hint', '사이드카와 동기화 중입니다. 다른 기기에서 같은 WebUI에 로그인하면 같은 목록이 보입니다.'));
    }
  }

  function bookmarkRow(it, profile) {
    var row = el('div', 'svb-entry-row');
    var main = btn('svb-entry', '');
    main.appendChild(el('span', 'svb-role svb-role--' + it.role, ROLE_LABEL[it.role] || it.role));
    main.appendChild(el('span', 'svb-entry-name', it.name || '(이름 없음)'));
    main.appendChild(el('span', 'svb-entry-idx', '#' + it.messageIndex));
    if (it.localOnly === true) {
      var localChip = el('span', 'svb-chip svb-chip--local', '이 기기');
      localChip.title = '서버가 받지 않아 이 브라우저에만 저장된 항목입니다.';
      main.appendChild(localChip);
    }
    main.title = (it.data && it.data.preview) ? String(it.data.preview) : it.name;
    main.addEventListener('click', function () {
      jumpTo({ profile: profile, sessionId: it.sessionId, messageIndex: it.messageIndex, role: it.role });
    });
    var rename = btn('svb-mini', '✎', '이름 변경');
    rename.addEventListener('click', function (ev) {
      ev.stopPropagation();
      askText('북마크 이름 변경', '새 이름을 입력하세요.', it.name).then(function (name) {
        if (name === null || name === undefined) return;
        name = collapseWs(name).slice(0, NAME_MAX);
        if (!name) return;
        return store.patch(it.id, { name: name }).then(function () { toast('이름을 변경했습니다'); refreshIndex(); });
      }).catch(function (e) { toast('변경 실패: ' + (e && e.message || ''), 'error'); });
    });
    var del = btn('svb-mini svb-mini--danger', '×', '삭제');
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      askConfirm('북마크 삭제', '북마크 "' + it.name + '"을(를) 삭제할까요?', '삭제').then(function (ok) {
        if (!ok) return;
        return store.remove(it.id).then(function () { toast('삭제했습니다'); refreshIndex(); });
      }).catch(function (e) { toast('삭제 실패: ' + (e && e.message || ''), 'error'); });
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
      } catch (e) { toast('내보내기 실패', 'error'); }
    }, function () { toast('내보내기 실패', 'error'); });
  }

  function importBookmarks(file) {
    if (!store) return;
    if (file.size > 4 * 1024 * 1024) { toast('파일이 너무 큽니다 (4 MiB 초과)', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      store.importJson(String(reader.result || ''), { merge: true }).then(function (r) {
        toast('가져오기: ' + r.added + '개 추가, ' + r.skipped + '개 건너뜀');
        refreshIndex();
      }, function (e) { toast('가져오기 실패: ' + (e && e.code === 'invalid' ? '형식이 올바르지 않습니다' : (e && e.message || '')), 'error'); });
    };
    reader.onerror = function () { toast('파일을 읽을 수 없습니다', 'error'); };
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
    if (!sid) { body.appendChild(el('p', 'svb-empty', '열린 대화가 없습니다.')); return; }
    var profile = sessionProfile();
    var loading = el('p', 'svb-empty', '목차를 만드는 중…');
    body.appendChild(loading);
    tocEntriesFor(sid).then(function (entries) {
      if (!panelOpen || activeTab !== 'toc' || currentSid() !== sid) return;
      clear(body);
      if (!entries.length) {
        body.appendChild(el('p', 'svb-empty', '목차 항목이 없습니다. 제목(#, ##, ###)·표·mermaid 도식·한 줄 프레임이 있는 답변이 나타나면 여기에 모입니다.'));
        return;
      }
      var lastMsg = -1;
      var n = 0;
      entries.forEach(function (e) {
        if (e.messageIndex !== lastMsg) {
          lastMsg = e.messageIndex;
          n++;
          body.appendChild(el('div', 'svb-group-session', '답변 · 메시지 #' + e.messageIndex));
        }
        var b = btn('svb-entry svb-toc-entry svb-toc-' + e.kind + (e.level ? ' svb-toc-level-' + e.level : ''), '');
        b.appendChild(el('span', 'svb-toc-tag', '[' + (KIND_TAG[e.kind] || e.kind) + ']'));
        b.appendChild(el('span', 'svb-entry-name', e.label));
        b.title = e.label;
        b.addEventListener('click', function () {
          jumpTo({ profile: profile, sessionId: sid, messageIndex: e.messageIndex, role: 'assistant' });
        });
        body.appendChild(b);
      });
      var foot = ui.foot;
      clear(foot);
      foot.appendChild(el('div', 'svb-hint', entries.length + '개 항목 · 답변 ' + n + '개. 핵심 대화 개요(사용자 질문 목록)는 코어의 Conversation Outline을 그대로 사용하세요.'));
    }, function (e) {
      if (!panelOpen || activeTab !== 'toc') return;
      clear(body);
      body.appendChild(el('p', 'svb-empty', '대화 내용을 불러오지 못했습니다' + (e && e.message ? ' (' + e.message + ')' : '') + '.'));
    });
  }

  // ── install ────────────────────────────────────────────────────────────────
  function registerAction() {
    var ext = window.hermesExt;
    if (!ext || typeof ext.register !== 'function') return false;
    handle = ext.register(EXT_ID);
    if (!handle) {
      try { console.warn('[' + EXT_ID + '] hermesExt.register returned null (not in the boot manifest inventory)'); } catch (_) { /* ignore */ }
      return false;
    }
    var unregister = handle.messages.registerAction({
      id: 'bookmark',
      label: '북마크',
      icon: 'bookmark',
      roles: ['user', 'assistant'],
      getPressed: function (ctx) { return index.has(activeKeyFor(ctx)); },
      onInvoke: function (ctx) {
        if (!store) { toast('저장소가 아직 준비되지 않았습니다', 'error'); return; }
        return openBookmarkDialog(ctx);
      },
    });
    if (typeof unregister !== 'function') {
      try { console.warn('[' + EXT_ID + '] registerAction rejected by core (duplicate action key, or the page-wide budget of 2 message actions is used up)'); } catch (_) { /* ignore */ }
      return false;
    }
    pub.unregisterAction = unregister;
    try {
      handle.events.on('turn:complete', function () { tocCache = { key: null, entries: null, loading: null }; });
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
    store.subscribe(function () { refreshIndex(); });
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
    registerAction();
    ensureToggle();
    ensurePanel();
    observeStartButton();
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
