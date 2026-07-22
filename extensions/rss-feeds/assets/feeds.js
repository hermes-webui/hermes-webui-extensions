// feeds.js — RSS Feeds extension
// Frontend for the RSS Feeds panel.
//
// Token-free browsing/reading. Summarize is opt-in and hands off to the
// active chat so token usage flows through normal chat accounting.

(function () {
  let _feeds = [];
  let _settings = { keywords: [], filter_enabled: false };
  let _activeFeedId = null;
  let _activeCategory = null;
  let _readView = false;   // "Read" history view (clicked articles, newest-first)
  // free-text Search view. _searchQuery is the active submitted query
  // ('' = not searching); _searchTerms are its space-split words, used to
  // <mark>-highlight matches inside title + summary on every card.
  let _searchQuery = '';
  let _searchTerms = [];
  // 🧠 Summaries — AI digests persisted server-side (free/local engine).
  let _summaryView = false;        // Summaries view active
  let _summarizedIds = new Set();  // entry_ids with a finished single-article summary
  let _summaryRunning = 0;         // count of in-flight summaries (sidebar badge)
  let _summaryTotal = 0;           // total summaries (sidebar count)
  let _clickedCount = 0;           // total clicked/read articles (sidebar count)
  let _summaryPoll = null;         // poll timer while any summary is running
  // per-feed expand state in "All feeds" / category views.
  // Keyed by feed id; absent or true = EXPANDED (default). Explicit
  // false = collapsed. Toggle flips; Expand/Collapse all set true/false.
  let _expanded = {};
  // read-tracking. localStorage-backed Set of entry IDs the user has
  // clicked or summarized. Bounded to MAX entries (LRU order — oldest
  // dropped first) so the storage doesn't grow unbounded. Persists
  // across browser sessions per origin. Not synced cross-device — if
  // the user ever wants that we'd move it server-side.
  const _READ_KEY = 'mc.feeds.read';
  const _READ_MAX = 5000;
  let _readIds = _loadReadIds();
  // 'show' | 'hide' — sidebar toolbar toggle. Persists across reloads.
  let _readVisibility = localStorage.getItem('mc.feeds.read.visibility') || 'show';

  // rotating header for the all-feeds view — a short, dryly
  // funny line instead of a static "All feeds". Picked fresh on each render.
  const _WORLDWIDE_TITLES = [
    'All feeds — what fresh chaos is this?',
    'The news, now with extra plot twists',
    'Breaking: everything, all at once',
    "Reality's latest patch notes",
    'Today in Humanity: bold choices, mixed results',
    'Global headlines — buckle up',
    'The world, lightly on fire as usual',
    'Hot takes, cold facts, lukewarm governments',
    'Democracy: still buffering…',
    "Today's forecast: chaos, chance of memes",
    "What could possibly go wrong? (a list)",
    "The planet's group chat is popping off",
    'Spoiler: it’s complicated',
    'Doomscroll responsibly',
    'Politicians said things. Again.',
  ];
  function _worldWideTitle() {
    return _WORLDWIDE_TITLES[Math.floor(Math.random() * _WORLDWIDE_TITLES.length)];
  }

  function _loadReadIds() {
    try {
      const raw = localStorage.getItem(_READ_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter(n => Number.isFinite(n)) : []);
    } catch (_) {
      return new Set();
    }
  }
  function _saveReadIds() {
    try {
      // Set iteration order is insertion order in JS — that's our LRU.
      // When we hit MAX, drop oldest.
      let arr = Array.from(_readIds);
      if (arr.length > _READ_MAX) arr = arr.slice(arr.length - _READ_MAX);
      _readIds = new Set(arr);
      localStorage.setItem(_READ_KEY, JSON.stringify(arr));
    } catch (_) {
      // Storage might be full; silently swallow — read state is best-effort.
    }
  }
  function _isRead(eOrId) {
    // Accept an entry object (preferred — carries the server's read_at for
    // cross-device state) or a bare id. Read if EITHER the local set (this
    // browser, optimistic) OR the server (any device) marked it.
    if (eOrId && typeof eOrId === 'object') {
      return _readIds.has(Number(eOrId.id)) || eOrId.read_at != null;
    }
    return _readIds.has(Number(eOrId));
  }
  function _markRead(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    // Delete first so re-insertion bumps it to the end (LRU "touch").
    _readIds.delete(n);
    _readIds.add(n);
    _saveReadIds();
    // Persist server-side so the mark follows the user across devices (best-effort).
    try {
      fetch('/api/extensions/rss-feeds/sidecar/api/feeds/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n }), credentials: 'same-origin',
      });
    } catch (_) {}
  }
  window.mcMarkEntryRead = (id) => {
    _markRead(id);
    // Update the DOM in place so the user sees the read style immediately
    // without a full re-render.
    const card = document.querySelector(`.mc-feed-entry[data-entry-id="${id}"]`);
    if (card) {
      card.classList.add('mc-feed-entry-read');
      if (_readVisibility === 'hide') {
        // Animate out instead of yanking — the empty space mid-scroll is
        // disorienting otherwise.
        card.style.transition = 'opacity 0.2s, max-height 0.3s';
        card.style.opacity = '0';
        setTimeout(() => { card.style.display = 'none'; }, 220);
      }
    }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    // Quote-safe: also escapes ' and " so esc() is safe in attribute values,
    // not only text nodes. (Inline on* handlers with dynamic args still are NOT
    // safe even so — those use data-* + delegated listeners below.)
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Quote-safe attribute escaper (esc() doesn't escape quotes — fine for text
  // nodes, unsafe for attribute values like data-title/data-link).
  function _attr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Only allow http(s) URLs to reach an href/window.open — a feed's entry link
  // can be javascript:/data:/etc (feedparser doesn't validate scheme).
  function _safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(u) ? u : '#';
  }
  // Delegated click handlers for dynamic-value controls (category + keyword
  // chips): opaque data-* instead of inline on* so a hostile category/keyword
  // name can't break out of a JS string. Attached once at module load.
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest && ev.target.closest('[data-mc-cat],[data-mc-kw]');
    if (!el) return;
    if (el.hasAttribute('data-mc-cat')) { try { mcSelectCategory(el.getAttribute('data-mc-cat')); } catch (_) {} }
    else { ev.stopPropagation(); try { mcSearchKeyword(el.getAttribute('data-mc-kw')); } catch (_) {} }
  });

  // Shared per-card actions cluster (⋯ → ✦ Summarize / ⤴ Share). The article
  // link + title ride on data-* attrs so it works in ANY row structure (feed
  // cards AND the compact Clicked-history rows) without DOM-scraping.
  function _actionsCluster(e) {
    return `<div class="mc-feed-entry-actions" data-entry-id="${e.id}" ` +
      `data-link="${_attr(e.link)}" data-title="${_attr(e.title)}">` +
      `<div class="mc-feed-act-row">` +
        `<button type="button" class="mc-feed-entry-summarize-btn mc-feed-act-item" ` +
          `onclick="event.stopPropagation(); mcMarkEntryRead(${e.id}); mcSummarizeEntry(${e.id}); mcCloseEntryActions();" ` +
          `aria-label="Summarize this article" title="Summarize (free/local)">✦</button>` +
        `<button type="button" class="mc-feed-entry-summarize-btn mc-feed-act-item" ` +
          `onclick="event.stopPropagation(); mcShareEntry(${e.id});" ` +
          `aria-label="Share this article" title="Share article link">⤴</button>` +
      `</div>` +
      `<button type="button" class="mc-feed-entry-summarize-btn mc-feed-act-toggle" ` +
        `onclick="event.stopPropagation(); mcToggleEntryActions(${e.id});" ` +
        `aria-label="Article actions" aria-haspopup="true" title="Actions — summarize or share">⋯</button>` +
    `</div>`;
  }

  // escape, then wrap any active search term in <mark> for highlight.
  // No-op (just escapes) when not in Search mode, so every view can use it.
  function _hl(s) {
    const safe = esc(s);
    if (!_searchTerms.length) return safe;
    let out = safe;
    for (const t of _searchTerms) {
      if (!t) continue;
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark class="mc-feed-hl">$1</mark>');
    }
    return out;
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd';
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function _statusGlyph(feed) {
    if (!feed.last_status) return { cls: 'never', label: 'never fetched' };
    if (feed.last_status === 'ok' || feed.last_status === 'ok_with_warnings') return { cls: 'ok', label: 'ok' };
    return { cls: 'err', label: feed.last_status };
  }

  // ── Modal infrastructure ─────────────────────────────────────────────────
  function _openModal(title, contentHTML) {
    _closeModal();
    const overlay = document.createElement('div');
    overlay.id = 'mcFeedModal';
    overlay.className = 'mc-feed-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) _closeModal(); };
    overlay.innerHTML = `
      <div class="mc-feed-modal">
        <header class="mc-feed-modal-head">
          <span>${esc(title)}</span>
          <button type="button" class="mc-feed-modal-close" onclick="mcFeedsCloseModal()" aria-label="Close">×</button>
        </header>
        <div class="mc-feed-modal-body">${contentHTML}</div>
      </div>`;
    document.body.appendChild(overlay);
    const firstInput = overlay.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
  }
  function _closeModal() {
    const m = $('mcFeedModal');
    if (m) m.remove();
  }
  window.mcFeedsCloseModal = _closeModal;

  // Body-mounted layers (modal / settings / summarize popups) stack ABOVE the
  // overlay, so the overlay's Escape handler must peel the frontmost one first
  // instead of closing the overlay out from under it, and closing the overlay
  // must tear them all down. Priority = topmost first.
  window.mcFeedsDismissTopPopup = () => {
    if ($('mcFeedModal')) { _closeModal(); return true; }
    if ($('mcFeedSettingsPopup') && window.mcCloseFeedSettings) { window.mcCloseFeedSettings(); return true; }
    if ($('mcSummarizePopup') && window.mcCloseSummarizePopup) { window.mcCloseSummarizePopup(); return true; }
    return false;
  };
  window.mcFeedsTeardownPopups = () => {
    _closeModal();
    if (window.mcCloseFeedSettings) window.mcCloseFeedSettings();
    if (window.mcCloseSummarizePopup) window.mcCloseSummarizePopup();
    if (window.mcCloseEntryActions) window.mcCloseEntryActions();
  };

  // ── Data loading ─────────────────────────────────────────────────────────
  async function loadFeedsPanel() {
    await refreshSidebar();
    if (_activeFeedId !== null) renderFeedView(_activeFeedId);
    else if (_activeCategory) renderCategoryView(_activeCategory);
    else renderAllEntries();
    _startFeedTimer();
  }

  async function refreshSidebar() {
    const sidebar = $('feedsListSidebar');
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      _feeds = Array.isArray(data.feeds) ? data.feeds : [];
      if (data.settings) _settings = data.settings;
    } catch (e) {
      if (sidebar) sidebar.innerHTML = `<div class="mc-feeds-error">Failed to load feeds: ${esc(e.message)}</div>`;
      return;
    }
    await _loadSummaryMeta();
    _warmFavicons();
    if (!sidebar) return;
    _renderSidebarToolbar(sidebar);
    _renderSidebarFeeds(sidebar);
  }

  // Cheap meta fetch: running count + which entry_ids have a done summary
  // (for the sidebar badge + the inline-card 'Summary' expander).
  async function _loadSummaryMeta() {
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries?limit=1', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      _summaryRunning = Number(d.running || 0);
      _summaryTotal = Number(d.total || 0);
      _clickedCount = Number(d.clicked || 0);
      _summarizedIds = new Set(Array.isArray(d.done_entry_ids) ? d.done_entry_ids : []);
    } catch (_) { /* leave prior state */ }
  }

  function _renderSidebarToolbar(sidebar) {
    const totalEntries = _feeds.reduce((s, f) => s + (f.entry_count || 0), 0);
    const kwLabel = _settings.keywords.length
      ? `${_settings.keywords.length} keyword${_settings.keywords.length === 1 ? '' : 's'}`
      : 'Edit keywords';
    const filterPressed = _settings.filter_enabled ? 'is-active' : '';

    // auto-fetch label + status (e.g. "Auto: 30m" / "Auto: Off")
    const afm = Number(_settings.auto_fetch_minutes || 0);
    const autoLabel = afm > 0 ? `Auto: ${_fmtMinutes(afm)}` : 'Auto: Off';
    const autoPressed = afm > 0 ? 'is-active' : '';
    const autoStatus = _autoFetchStatusLine(_settings.auto_fetch_last_at, afm);

    const toolbar = document.createElement('div');
    toolbar.className = 'mc-feed-sidebar-toolbar';
    // Desktop: the current view's counts render at the top of the sidebar.
    const prevCounts = (document.getElementById('mcFeedSideCounts') || {}).textContent || '';
    // The 4 filter/auto chips live in a wrapper: always visible on desktop,
    // collapsed on mobile behind the funnel button in the Feeds header.
    toolbar.innerHTML = `
      <div class="mc-feed-side-counts" id="mcFeedSideCounts">${esc(prevCounts)}</div>
      <div class="mc-feed-search-wrap${(_searchOpen || _searchQuery) ? ' is-open' : ''}">
        <span class="mc-feed-search-icon" aria-hidden="true">🔍</span>
        <input type="search" id="mcFeedSearch" class="mc-feed-search-input"
               placeholder="Search articles…" value="${esc(_searchQuery)}"
               autocomplete="off" spellcheck="false"
               oninput="mcFeedSearchInput(event)" onkeydown="mcFeedSearchKey(event)"
               title="Search all feeds">
        <button type="button" class="mc-feed-search-clear" onclick="mcClearSearchInput()" title="Clear" aria-label="Clear search text"${(_searchOpen || _searchQuery) && (_searchQuery) ? '' : ' hidden'}>✕</button>
      </div>
      <div class="mc-feed-tools${_toolsOpen ? ' is-open' : ''}" id="mcFeedTools">
      <button type="button" class="mc-feed-tool-btn ${filterPressed}" onclick="mcToggleFilter()"
              title="Filter by saved keywords"
              aria-pressed="${_settings.filter_enabled ? 'true' : 'false'}">
        <span class="mc-feed-filter-icon">⌕</span>
        <span>${_settings.filter_enabled ? 'Filter ON' : 'Filter OFF'}</span>
      </button>
      <button type="button" class="mc-feed-tool-btn mc-feed-tool-btn-small" onclick="mcEditKeywords()" title="Edit keywords list">
        ${esc(kwLabel)}
      </button>
      <button type="button" class="mc-feed-tool-btn ${autoPressed}" onclick="mcOpenAutoFetchPicker()"
              title="Auto-refresh interval"
              aria-pressed="${afm > 0 ? 'true' : 'false'}">
        <span class="mc-feed-filter-icon">↻</span>
        <span>${esc(autoLabel)}</span>
      </button>
      <button type="button" class="mc-feed-tool-btn ${_readVisibility === 'hide' ? 'is-active' : ''}" onclick="mcToggleReadVisibility()"
              title="Show/hide read entries"
              aria-pressed="${_readVisibility === 'hide' ? 'true' : 'false'}">
        <span class="mc-feed-filter-icon">${_readVisibility === 'hide' ? '◐' : '○'}</span>
        <span>${_readVisibility === 'hide' ? 'Hide read' : 'Show read'}</span>
      </button>
      ${afm > 0 ? `<div class="mc-feed-tool-status mc-feed-timer" data-feed-timer title="Auto-refresh countdown">${esc(autoStatus)}</div>` : ''}
      </div>
    `;
    sidebar.innerHTML = '';
    sidebar.appendChild(toolbar);
  }

  // Search bar hides behind the 🔍 header button; auto-opens while a query is live.
  let _searchOpen = false;
  window.mcToggleSearchBar = () => {
    _searchOpen = !_searchOpen;
    if (!_searchOpen && _searchQuery) { _searchOpen = false; mcClearFeedSearch(); }
    const w = document.querySelector('.mc-feed-search-wrap');
    if (w) w.classList.toggle('is-open', _searchOpen || !!_searchQuery);
    _syncNavButtons();
    if (_searchOpen) { const el = $('mcFeedSearch'); if (el) el.focus(); }
  };

  // The funnel button in the Feeds header shows/hides the chip toolbar.
  let _toolsOpen = false;
  window.mcToggleMobileTools = () => {
    _toolsOpen = !_toolsOpen;
    const el = $('mcFeedTools');
    if (el) el.classList.toggle('is-open', _toolsOpen);
    _syncNavButtons();
  };

  // Mobile: the action icons (search/filter/all/clicked/summaries/gear) hide
  // behind a burger. Tap opens the menu, tap again closes; picking any item
  // auto-closes it.
  let _menuOpen = false;
  window.mcToggleActionMenu = () => {
    _menuOpen = !_menuOpen;
    const card = document.querySelector('.hx-feeds-card');
    if (card) card.classList.toggle('is-menu-open', _menuOpen);
    document.querySelectorAll('.hx-feeds-burger').forEach(b => b.classList.toggle('is-active', _menuOpen));
  };
  window.mcCloseActionMenu = () => {
    if (!_menuOpen) return;
    _menuOpen = false;
    const card = document.querySelector('.hx-feeds-card');
    if (card) card.classList.remove('is-menu-open');
    document.querySelectorAll('.hx-feeds-burger').forEach(b => b.classList.remove('is-active'));
  };

  function _fmtMinutes(m) {
    m = Number(m) || 0;
    if (m <= 0) return 'Off';
    if (m < 60) return m + 'm';
    if (m < 1440) return (m / 60) + 'h';
    return (m / 1440) + 'd';
  }

  function _autoFetchStatusLine(lastAt, intervalMin) {
    if (!intervalMin || intervalMin <= 0) return '';
    const now = Math.floor(Date.now() / 1000);
    if (!lastAt || lastAt <= 0) return 'Next: within ' + intervalMin + 'm';
    const ago = Math.max(0, now - Math.floor(lastAt));
    const next = Math.max(0, intervalMin * 60 - ago);
    return `${_fmtAgo(ago)} ago · ${_fmtAgo(next)}`;
  }

  function _fmtAgo(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  }

  // live auto-refresh countdown. A single 1s interval updates every
  // [data-feed-timer] element from _settings, and when the interval elapses it
  // forces a real refresh so the page updates without a manual reload. Cheap:
  // no-ops when no timer element is mounted (feeds view not visible).
  let _feedTimerInterval = null;
  let _autoObserveBusy = false;
  let _autoObserveUntil = 0;

  // mm:ss (or h:mm:ss) so the countdown visibly ticks every second.
  function _fmtCountdown(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function _feedTimerState() {
    const afm = Number(_settings.auto_fetch_minutes || 0);
    if (!afm || afm <= 0) return { text: '', expired: false, off: true, pct: 0 };
    const lastAt = Number(_settings.auto_fetch_last_at || 0);
    if (!lastAt || lastAt <= 0) return { text: `Next: within ${_fmtMinutes(afm)}`, expired: false, pct: 0 };
    const total = afm * 60;
    const ago = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(lastAt));
    const remaining = total - ago;
    const pct = Math.max(0, Math.min(100, (ago / total) * 100));
    if (remaining <= 0) return { text: 'Refreshing…', expired: true, pct: 100 };
    return { text: `${_fmtAgo(ago)} ago · ${_fmtCountdown(remaining)}`, expired: false, pct };
  }

  function _tickFeedTimer() {
    const els = document.querySelectorAll('[data-feed-timer]');
    if (!els.length) return;
    const st = _feedTimerState();
    els.forEach((e) => {
      e.textContent = st.text;
      e.style.setProperty('--pct', (st.pct || 0).toFixed(1));
      e.classList.toggle('is-due', !!st.expired);
      e.classList.toggle('has-ring', !st.off);   // hide ring when auto-fetch is off
      if (e.id === 'feedsTimerTop') e.hidden = !!st.off;   // header slot only when auto is on
    });
    // The SIDECAR daemon is the sole automatic-refresh scheduler. The browser
    // never fires its own auto-refresh (that raced the daemon into overlapping
    // fetches) — on expiry we just OBSERVE the sidecar's state and reflect it.
    if (st.expired) _maybeObserveAutoRefresh();
  }

  // Countdown expired: poll settings (throttled) and reload the view once the
  // sidecar's auto_fetch_last_at advances — i.e. after its daemon finished the
  // refresh. Reflect only; never POST a refresh from here.
  function _maybeObserveAutoRefresh() {
    const now = Date.now();
    if (_autoObserveBusy || now < _autoObserveUntil) return;
    _autoObserveBusy = true;
    _autoObserveUntil = now + 10000;   // at most one settings poll per 10s
    fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : null)
      .then((s) => {
        if (s && Number(s.auto_fetch_last_at || 0) > Number(_settings.auto_fetch_last_at || 0)) {
          _settings = s;
          return Promise.resolve(refreshSidebar()).then(() => _rerenderActiveView());
        }
      })
      .catch(() => {})
      .finally(() => { _autoObserveBusy = false; });
  }

  function _rerenderActiveView() {
    if (_summaryView) return renderSummariesView();
    if (_readView) return renderReadEntries();
    if (_searchQuery) return renderSearchView(_searchQuery);
    if (_activeFeedId !== null) return renderFeedView(_activeFeedId);
    if (_activeCategory) return renderCategoryView(_activeCategory);
    return renderAllEntries();
  }

  function _startFeedTimer() {
    if (_feedTimerInterval) return;
    _feedTimerInterval = setInterval(_tickFeedTimer, 1000);
    _tickFeedTimer();
  }

  // Stop the display/observe timer when the overlay is torn down/hidden — it must
  // not keep polling in the background after the user closes Feeds.
  function _stopFeedTimer() {
    if (_feedTimerInterval) { clearInterval(_feedTimerInterval); _feedTimerInterval = null; }
    _autoObserveBusy = false;
    _autoObserveUntil = 0;
  }
  window.mcFeedsStopTimer = _stopFeedTimer;

  function _renderSidebarFeeds(sidebar) {
    const totalEntries = _feeds.reduce((s, f) => s + (f.entry_count || 0), 0);
    const byCategory = {};
    for (const f of _feeds) {
      const cat = f.category || 'general';
      (byCategory[cat] = byCategory[cat] || []).push(f);
    }
    const cats = Object.keys(byCategory).sort();
    // Mobile: one compact dropdown replaces the long scrolling list — the
    // native picker is the modern, thumb-friendly way to jump between views.
    let current = 'all';
    if (_summaryView) current = 'summaries';
    else if (_readView) current = 'clicked';
    else if (_activeFeedId !== null) current = 'feed:' + _activeFeedId;
    else if (_activeCategory) current = 'cat:' + _activeCategory;
    const opt = (v, label) =>
      `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`;
    let nav = `<div class="mc-feed-nav mc-m-only">` +
      `<select id="mcFeedNav" class="mc-feed-nav-select" aria-label="Jump to feed" onchange="mcFeedNavChange(this.value)">` +
      opt('all', `🌐 All feeds (${totalEntries})`) +
      opt('clicked', `★ Clicked (${_clickedCount})`) +
      opt('summaries', `🧠 Summaries (${_summaryTotal})`);
    for (const cat of cats) {
      const items = byCategory[cat];
      const catTotal = items.reduce((s, f) => s + (f.entry_count || 0), 0);
      nav += `<optgroup label="${esc(_categoryIcon(cat) + ' ' + cat)}">` +
        opt('cat:' + cat, `All ${cat} (${catTotal})`) +
        items.map(f => opt('feed:' + f.id, `${f.name} (${f.entry_count || 0})`)).join('') +
        `</optgroup>`;
    }
    nav += `</select><span class="mc-feed-nav-caret" aria-hidden="true">▾</span></div>`;
    let html = '';
    html += `<button type="button" class="mc-feed-sidebar-row mc-feed-all-row ${(_activeFeedId === null && !_activeCategory && !_readView) ? 'is-active' : ''}" onclick="mcSelectFeed(null)">` +
      `<span class="mc-feed-row-name">All feeds</span>` +
      `<span class="mc-feed-count">${totalEntries}</span></button>`;
    const clickedBadge = _clickedCount > 0
      ? `<span class="mc-feed-count" title="${_clickedCount} clicked article${_clickedCount === 1 ? '' : 's'}">${_clickedCount}</span>` : '';
    html += `<button type="button" class="mc-feed-sidebar-row mc-feed-read-row ${_readView ? 'is-active' : ''}" onclick="mcSelectRead()">` +
      `<span class="mc-feed-row-name">★ Clicked</span>${clickedBadge}</button>`;
    const totalBadge = _summaryTotal > 0
      ? `<span class="mc-feed-count" title="${_summaryTotal} summar${_summaryTotal === 1 ? 'y' : 'ies'}">${_summaryTotal}</span>` : '';
    const sBadge = _summaryRunning > 0
      ? `<span class="mc-feed-count mc-feed-count-live" title="${_summaryRunning} summary job(s) running">⏳ ${_summaryRunning}</span>`
      : '';
    html += `<button type="button" class="mc-feed-sidebar-row mc-feed-summaries-row ${_summaryView ? 'is-active' : ''}" onclick="mcSelectSummaries()">` +
      `<span class="mc-feed-row-name">🧠 Summaries</span>${totalBadge}${sBadge}</button>`;
    for (const cat of cats) {
      const items = byCategory[cat];
      const catTotal = items.reduce((s, f) => s + (f.entry_count || 0), 0);
      html += `<div class="mc-feed-sidebar-cat">`;
      html += `<button type="button" class="mc-feed-sidebar-row mc-feed-sidebar-cat-head ${_activeCategory === cat && _activeFeedId === null ? 'is-active' : ''}" data-mc-cat="${_attr(cat)}">` +
        `<span class="mc-feed-cat-icon" aria-hidden="true">${_categoryIcon(cat)}</span>` +
        `<span class="mc-feed-row-name">${esc(cat)}</span><span class="mc-feed-count">${catTotal}</span></button>`;
      for (const f of items) {
        const status = _statusGlyph(f);
        const offClass = !f.enabled ? ' is-disabled' : '';
        const errorTitle = f.last_error ? `title="${esc(f.last_error)}"` : '';
        html += `<div class="mc-feed-sidebar-feed-wrap">` +
          `<button type="button" class="mc-feed-sidebar-row mc-feed-sidebar-feed${offClass} ${_activeFeedId === f.id ? 'is-active' : ''}" onclick="mcSelectFeed(${f.id})" ${errorTitle}>` +
            `<span class="mc-feed-dot mc-feed-dot-${status.cls}" aria-label="${status.label}"></span>` +
            _agencyLogoHtml(f.name, f.url, 'mc-feed-sidebar-logo') +
            `<span class="mc-feed-row-name">${esc(f.name)}</span>` +
            `<span class="mc-feed-count">${f.entry_count || 0}</span>` +
          `</button>` +
          `<div class="mc-feed-sidebar-feed-actions">` +
            `<button type="button" class="mc-feed-row-act" onclick="mcEditFeed(${f.id})" title="Edit feed" aria-label="Edit ${esc(f.name)}">✎</button>` +
            `<button type="button" class="mc-feed-row-act mc-feed-row-act-danger" onclick="mcDeleteFeed(${f.id})" title="Delete feed" aria-label="Delete ${esc(f.name)}">🗑</button>` +
          `</div></div>`;
      }
      html += `</div>`;
    }
    // Desktop: full scrolling list in the sidebar. Mobile: the dropdown lives
    // in the TOP BAR (left of Add/Refresh), not here — the sidebar just holds
    // the (hidden) list. Render the dropdown into the topbar slot.
    const navSlot = document.getElementById('hxFeedsNavSlot');
    if (navSlot) navSlot.innerHTML = nav;
    sidebar.insertAdjacentHTML('beforeend', `<div class="mc-feed-sidebar-list">${html}</div>`);
  }

  window.mcFeedNavChange = (v) => {
    if (v === 'all') return mcSelectFeed(null);
    if (v === 'clicked') return mcSelectRead();
    if (v === 'summaries') return mcSelectSummaries();
    if (v.indexOf('cat:') === 0) return mcSelectCategory(v.slice(4));
    if (v.indexOf('feed:') === 0) return mcSelectFeed(parseInt(v.slice(5), 10));
  };

  async function fetchEntries(params) {
    if (_settings.filter_enabled) params.filter = '1';
    const qs = new URLSearchParams(params);
    const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/entries?' + qs.toString(), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return Array.isArray(data.entries) ? data.entries : [];
  }

  function _categoryColorClass(cat) {
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = ((h << 5) - h + cat.charCodeAt(i)) | 0;
    return 'mc-cat-color-' + (Math.abs(h) % 8);
  }

  function _renderEntryCard(e) {
    // Full summary passed to the DOM; CSS line-clamp truncates to 4 visual
    // lines so the card density stays constant regardless of source verbosity.
    const summary = e.summary || '';
    const matched = Array.isArray(e.matched_keywords) ? e.matched_keywords : [];
    // top row carries the entry's
    // identity (source) and filter-match evidence on the left, and time
    // + summarize-icon on the right. Source is shown on every card —
    // redundant with the group header above in grouped views but
    // necessary in the cross-source "Filter all" view, and the
    // consistency outweighs the redundancy.
    const source = e.feed_name ? `<span class="mc-feed-entry-source" title="${esc(e.feed_name)}">${esc(e.feed_name)}</span>` : '';
    const kwChips = matched.map(k =>
      `<button type="button" class="mc-feed-kw-chip" data-mc-kw="${_attr(k)}" title="Show all articles mentioning “${esc(k)}”">${esc(k)}</button>`).join('');
    // read-tracking. Clicking the title link or the Summarize icon
    // marks the entry as read so it's visually de-prioritized on later
    // fetches. State persists in localStorage; capped at 5000 IDs with
    // LRU eviction (see _markRead at the top of this IIFE).
    const isRead = _isRead(e);
    const readClass = isRead ? ' mc-feed-entry-read' : '';
    return `
      <article class="mc-feed-entry${readClass}" data-entry-id="${e.id}">
        <div class="mc-feed-entry-head">
          <div class="mc-feed-entry-head-left">
            ${source}
            ${kwChips}
          </div>
          <div class="mc-feed-entry-head-right">
            <span class="mc-feed-entry-time">${fmtAgo(e.published_at || e.fetched_at)}</span>
            ${_actionsCluster(e)}
          </div>
        </div>
        <a class="mc-feed-entry-title" href="${_attr(_safeUrl(e.link))}" target="_blank" rel="noopener noreferrer"
           onclick="mcMarkEntryRead(${e.id})">${_hl(e.title)}</a>
        ${summary ? `<p class="mc-feed-entry-summary">${_hl(summary)}</p>` : ''}
        ${_summarizedIds.has(e.id) ? _entrySummaryExpander(e.id) : ''}
      </article>`;
  }

  // Category → emoji icon (flags for regions, symbols for topics). Static-left in
  // the header + sidebar so a glance tells you the section. Sensible fallbacks.
  function _categoryIcon(cat) {
    const m = {
      'us': '🇺🇸', 'united states': '🇺🇸', 'usa': '🇺🇸',
      'europe': '🇪🇺', 'eu': '🇪🇺', 'uk': '🇬🇧',
      'latin america': '🌎', 'latam': '🌎', 'americas': '🌎',
      'middle east': '🕌', 'mena': '🕌',
      'asia': '🌏', 'africa': '🌍',
      'tech & ai': '💻', 'tech': '💻', 'technology': '💻', 'ai': '🤖',
      'finance': '💲', 'business': '💲', 'economy': '💹', 'markets': '📈', 'crypto': '₿',
      'world': '🌐', 'global': '🌐', 'general': '📰', 'news': '📰', 'politics': '🏛️',
      'science': '🔬', 'sports': '🏆', 'health': '🩺', 'culture': '🎭',
    };
    return m[String(cat || '').toLowerCase().trim()] || '🌐';
  }
  // Light the action icon that matches the current view/state (globe = All
  // feeds, book = Clicked, sparkles = Summaries, 🔍 = search open, funnel =
  // filters open, plus the desktop twins). Runs on every view render + toggle,
  // so the highlight always tracks what's actually showing.
  function _syncNavButtons() {
    const set = (id, on) => { const b = $(id); if (b) b.classList.toggle('is-active', !!on); };
    // Exactly one of the view trio lights (or none, on a specific feed/category).
    // Search + funnel are independent toggles (box open / chips open).
    const inSearch = !!_searchQuery;
    set('feedsAllBtn', _activeFeedId === null && !_activeCategory && !_readView && !_summaryView && !inSearch);
    set('feedsClickedBtnM', _readView);
    set('feedsSummariesBtnM', _summaryView);
    set('feedsSearchBtn', _searchOpen);
    set('feedsSearchBtnD', _searchOpen);
    set('feedsToolsBtn', _toolsOpen);
    set('feedsToolsBtnD', _toolsOpen);
  }
  // Grouped views (All feeds / feed / category / search) render the bottom
  // Expand/Collapse/Filter bar → the burger lives there. Summaries/Clicked have
  // no bar → the floating burger FAB shows instead. This flags which.
  function _setControlsBar(present) {
    const card = document.querySelector('.hx-feeds-card');
    if (card) card.classList.toggle('has-controls-bar', !!present);
  }
  function _setViewHeader(title, subtitle, iconHtml) {
    _syncNavButtons();
    const titleEl = $('feedsViewTitle');
    if (titleEl) {
      // Optional static icon (agency logo / category emoji) sits left of the title;
      // the title text marquee scrolls after it. Timer + count live in the meta row.
      titleEl.innerHTML =
        (iconHtml ? `<span class="mc-feeds-title-icon">${iconHtml}</span>` : '') +
        `<span class="mc-feeds-title-text"><span class="mc-feeds-title-inner">${esc(title)}</span></span>` +
        (subtitle ? `<span class="mc-feeds-subtitle">${esc(subtitle)}</span>` : '');
    }
    // Mobile: the main-view header is hidden, so the CURRENT view title lives
    // in the top Feeds bar instead (next to the action icons).
    const brand = $('hxFeedsBrandTitle');
    if (brand) brand.textContent = title || '';
    const empty = $('feedsViewEmpty');
    if (empty) empty.style.display = 'none';
  }

  function _renderGroupedEntries(title, subtitle, entries, showGroupControls, iconHtml) {
    // Subtitle (count / "N read hidden") lives ONLY in the meta bar below —
    // never echoed next to the title. Pass '' to the header.
    _setViewHeader(title, '', iconHtml);
    const body = $('feedsViewBody');
    if (!body) return;
    if (!entries.length) {
      body.innerHTML = `<div class="mc-feeds-empty">
        <strong>No entries.</strong><br>
        ${_settings.filter_enabled
            ? 'Filter is ON and matches nothing. Toggle Filter OFF in the sidebar, or edit your keywords.'
            : 'Click <em>Refresh all</em> in the panel header (~10s for 42 feeds).'}
      </div>`;
      return;
    }
    // Group by feed_id, preserving the (already chronological) order
    const groups = [];
    const groupIndex = new Map();
    for (const e of entries) {
      if (!groupIndex.has(e.feed_id)) {
        groupIndex.set(e.feed_id, groups.length);
        groups.push({ feed_id: e.feed_id, feed_name: e.feed_name, category: e.category, entries: [] });
      }
      groups[groupIndex.get(e.feed_id)].entries.push(e);
    }
    let html = '';
    // Row 2 — meta: auto-refresh countdown + source/entry count (sits below the title).
    const afm = Number(_settings.auto_fetch_minutes || 0);
    const timerHtml = afm > 0
      ? `<span class="mc-feeds-timer" data-feed-timer title="Auto-refresh countdown">${esc(_autoFetchStatusLine(_settings.auto_fetch_last_at, afm))}</span>`
      : '';
    // Meta + controls live in ONE wrapper so on mobile they stick to the top
    // of the scroll area while reading (timer / counts / Expand / Collapse /
    // Filtered always visible).
    html += `<div class="mc-feed-view-sticky">`;
    const countsText = `${groups.length} sources · ${entries.length} entries${subtitle ? ' · ' + subtitle : ''}`;
    const sideCounts = document.getElementById('mcFeedSideCounts');
    if (sideCounts) sideCounts.textContent = countsText;
    html += `<div class="mc-feed-meta-row">${timerHtml}` +
      `<span class="mc-feed-group-count">${esc(countsText)}</span></div>`;
    // Controls row. Mobile shows the short labels (Expand / Collapse).
    const hasControls = showGroupControls && groups.length > 1;
    _setControlsBar(hasControls);
    if (hasControls) {
      html += `<div class="mc-feed-group-controls">
        <button type="button" class="mc-btn-sm" onclick="mcExpandAll()"><span class="mc-btn-full">Expand all</span><span class="mc-btn-short">Expand</span></button>
        <button type="button" class="mc-btn-sm" onclick="mcCollapseAll()"><span class="mc-btn-full">Collapse all</span><span class="mc-btn-short">Collapse</span></button>
        <button type="button" class="mc-feed-filter-pill ${_settings.filter_enabled ? 'is-on' : 'is-off'}" onclick="mcToggleFilter()" aria-pressed="${_settings.filter_enabled ? 'true' : 'false'}" title="${_settings.filter_enabled ? 'Keyword filter ON — tap to turn off' : 'Keyword filter OFF — tap to turn on'}">Filter</button>
        <button type="button" class="hx-feeds-burger hx-feeds-burger-bar mc-m-only" onclick="mcToggleActionMenu()" aria-label="Menu"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
      </div>`;
    }
    html += `</div>`;
    for (const g of groups) {
      // default-EXPANDED. A group is collapsed only if the user
      // explicitly collapsed it (toggle) or hit "Collapse all".
      const isCollapsed = _expanded[g.feed_id] === false;
      const catCls = _categoryColorClass(g.category || 'general');
      html += `<section class="mc-feed-group ${isCollapsed ? 'is-collapsed' : ''}" data-feed-id="${g.feed_id}">
        <header class="mc-feed-group-head" onclick="mcToggleGroup(${g.feed_id})" role="button" tabindex="0">
          <span class="mc-feed-group-caret" aria-hidden="true">▾</span>
          ${_agencyLogoHtml(g.feed_name, g.entries[0] ? g.entries[0].link : '', 'mc-feed-group-logo')}
          <span class="mc-feed-badge mc-feed-badge-source">${esc(g.feed_name)}</span>
          <span class="mc-feed-badge mc-feed-badge-cat ${catCls}">${esc(g.category || 'general')}</span>
          <span class="mc-feed-group-count-inline">${g.entries.length}</span>
        </header>
        <div class="mc-feed-group-body">
          ${g.entries.map(_renderEntryCard).join('')}
        </div>
      </section>`;
    }
    body.innerHTML = html;
  }

  // when the user has "Hide read" active, drop already-clicked entries
  // before rendering. Done client-side so the toggle is instant — no
  // round trip. Note count includes only the visible-after-filter total
  // so the subtitle reflects what's actually on screen.
  function _filterRead(entries) {
    if (_readVisibility !== 'hide') return entries;
    return entries.filter(e => !_isRead(e));
  }
  function _readSubtitleSuffix(total, visible) {
    if (_readVisibility !== 'hide') return '';
    const hidden = total - visible;
    return hidden > 0 ? ` · ${hidden} read hidden` : '';
  }

  async function renderAllEntries() {
    _searchTerms = [];
    try {
      const params = { limit: Number(_settings.entries_per_page) || 100 };
      const vf = Array.isArray(_settings.visible_feeds) ? _settings.visible_feeds : [];
      if (vf.length) params.feed_ids = vf.join(',');   // agency multi-select (cross-device)
      const all = await fetchEntries(params);
      const entries = _filterRead(all);
      _renderGroupedEntries(_worldWideTitle(),
        _readSubtitleSuffix(all.length, entries.length).replace(/^\s*·\s*/, ''),
        entries, true, '<span class="mc-feeds-title-emoji">🌐</span>');
    } catch (e) {
      $('feedsViewBody').innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
    }
  }

  async function renderCategoryView(category) {
    _searchTerms = [];
    try {
      const all = await fetchEntries({ category, limit: 200 });
      const entries = _filterRead(all);
      _renderGroupedEntries(category,
        `${entries.length} entries${_settings.filter_enabled ? ' (filtered)' : ''}${_readSubtitleSuffix(all.length, entries.length)}`,
        entries, true, `<span class="mc-feeds-title-emoji">${_categoryIcon(category)}</span>`);
    } catch (e) {
      $('feedsViewBody').innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
    }
  }

  async function renderFeedView(feedId) {
    _searchTerms = [];
    const f = _feeds.find(x => x.id === feedId);
    const title = f ? f.name : ('Feed #' + feedId);
    const subtitle = f ? f.url : '';
    try {
      const all = await fetchEntries({ feed_id: feedId, limit: 200 });
      const entries = _filterRead(all);
      // Single-source view: no grouping needed; render flat with header info.
      // Show the agency's round logo next to its name in the top bar.
      _setViewHeader(title, subtitle, f ? _agencyLogoHtml(f.name, f.url || '', 'mc-feeds-title-logo') : '');
      const body = $('feedsViewBody');
      if (!body) return;
      if (!entries.length) {
        body.innerHTML = `<div class="mc-feeds-empty">
          <strong>No entries for this feed.</strong><br>
          ${f && f.last_status && f.last_status !== 'ok' && f.last_status !== 'ok_with_warnings'
            ? `Last fetch failed: <code>${esc(f.last_status)}</code> &mdash; ${esc(f.last_error || '')}`
            : 'Try <em>Refresh all</em>.'}
        </div>`;
        return;
      }
      body.innerHTML = entries.map(_renderEntryCard).join('');
    } catch (e) {
      $('feedsViewBody').innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
    }
  }

  // ── Group collapse/expand ────────────────────────────────────────────────
  // absent = EXPANDED (default); only an explicit `false` collapses.
  window.mcToggleGroup = (feedId) => {
    // currently collapsed (=== false) → expand; otherwise collapse
    _expanded[feedId] = (_expanded[feedId] === false);
    const sec = document.querySelector(`.mc-feed-group[data-feed-id="${feedId}"]`);
    if (sec) sec.classList.toggle('is-collapsed', _expanded[feedId] === false);
  };
  window.mcExpandAll = () => {
    document.querySelectorAll('.mc-feed-group').forEach(s => {
      const fid = Number(s.dataset.feedId);
      _expanded[fid] = true;
      s.classList.remove('is-collapsed');
    });
  };
  window.mcCollapseAll = () => {
    document.querySelectorAll('.mc-feed-group').forEach(s => {
      const fid = Number(s.dataset.feedId);
      _expanded[fid] = false;
      s.classList.add('is-collapsed');
    });
  };

  // ── Selection ─────────────────────────────────────────────────────────────
  window.mcLoadFeedsPanel = loadFeedsPanel;
  window.mcSelectFeed = (id) => {
    // Content tab → if a search is active, KEEP the query and re-run it scoped
    // to this feed (the box stays populated, results follow the tab).
    _summaryView = false;
    _readView = false;
    _activeFeedId = id;
    _activeCategory = null;
    refreshSidebar();
    if (_searchQuery) return renderSearchView(_searchQuery);
    if (id === null) renderAllEntries();
    else renderFeedView(id);
  };
  window.mcSelectCategory = (cat) => {
    _summaryView = false;
    _readView = false;
    _activeFeedId = null;
    _activeCategory = cat;
    refreshSidebar();
    if (_searchQuery) return renderSearchView(_searchQuery);  // keep search, scope to this category
    renderCategoryView(cat);
  };
  window.mcSelectRead = () => {
    _summaryView = false;
    _readView = true;
    _activeFeedId = null;
    _activeCategory = null;
    refreshSidebar();
    renderReadEntries();
  };
  window.mcSelectSummaries = () => {
    _readView = false;
    _activeFeedId = null;
    _activeCategory = null;
    _summaryView = true;
    refreshSidebar();
    renderSummariesView();
  };

  // Search — find every article whose title or summary contains the
  // typed term(s), across ALL feeds, regardless of the keyword filter toggle.
  // Submitted on Enter (or the live debounce below). Matches are <mark>-
  // highlighted. Clicking a keyword chip routes here via mcSearchKeyword.
  let _searchDebounce = null;
  window.mcFeedSearchInput = (ev) => {
    // Live search with a short debounce so results follow typing without a
    // request per keystroke. Enter (handled below) fires immediately.
    const raw = (ev && ev.target ? ev.target.value : '');
    const q = raw.trim();
    // Show/hide the ✕ clear button as text is typed/removed (no re-render).
    const x = $('mcFeedSearch') && $('mcFeedSearch').parentNode.querySelector('.mc-feed-search-clear');
    if (x) x.hidden = !raw.length;
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      if (q === _searchQuery) return;
      if (!q) { mcClearFeedSearch(); return; }
      _runFeedSearch(q, false);
    }, 300);
  };
  // Clear ONLY the input text (the ✕ in the box) — wipe the field, drop any
  // active search, keep the box open + focused so you can retype immediately.
  window.mcClearSearchInput = () => {
    const el = $('mcFeedSearch');
    if (el) { el.value = ''; el.focus(); }
    const x = el && el.parentNode.querySelector('.mc-feed-search-clear');
    if (x) x.hidden = true;
    if (_searchDebounce) clearTimeout(_searchDebounce);
    if (_searchQuery) { _searchQuery = ''; _searchTerms = []; _rerenderActiveView(); }
  };
  window.mcFeedSearchKey = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (_searchDebounce) clearTimeout(_searchDebounce);
      const q = (ev.target ? ev.target.value : '').trim();
      if (!q) { mcClearFeedSearch(); return; }
      _runFeedSearch(q, true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      mcClearFeedSearch();
    }
  };
  window.mcClearFeedSearch = () => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchQuery = '';
    _searchTerms = [];
    refreshSidebar();
    _rerenderActiveView();
    const el = $('mcFeedSearch');
    if (el) el.focus();
  };
  // Clicking a keyword chip on a card → search that exact word.
  window.mcSearchKeyword = (kw) => {
    if (!kw) return;
    _runFeedSearch(String(kw), true);
  };
  function _runFeedSearch(q, rebuildToolbar) {
    _searchQuery = q;
    // Search is scoped to WHATEVER section is active: a feed, a category,
    // Clicked, Summaries, or All feeds. The section renderers each honor
    // _searchQuery themselves.
    // refreshSidebar() rebuilds the toolbar (and clears the X button state).
    // Skip it during live typing so focus/caret stay put; do it on submit.
    if (rebuildToolbar) refreshSidebar();
    if (_summaryView) renderSummariesView();
    else if (_readView) renderReadEntries();
    else renderSearchView(q);
    // Restore focus + caret to the end after a toolbar rebuild.
    if (rebuildToolbar) {
      const el = $('mcFeedSearch');
      if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; }
    }
  }

  async function renderSearchView(query) {
    _searchTerms = String(query || '').split(/\s+/).filter(Boolean);
    try {
      // Search is SCOPED to the focused tab: a feed → just that feed; a
      // category (Finance, Middle East…) → just that category's agencies;
      // All feeds → everything. The keyword filter is bypassed — search
      // finds every match in scope regardless of the filter toggle.
      const params = { q: query, limit: 300 };
      let scopeLabel = '';
      if (_activeFeedId !== null) {
        params.feed_id = _activeFeedId;
        const f = _feeds.find(x => x.id === _activeFeedId);
        scopeLabel = f ? ` in ${f.name}` : '';
      } else if (_activeCategory) {
        params.category = _activeCategory;
        scopeLabel = ` in ${_activeCategory}`;
      }
      const qs = new URLSearchParams(params);
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/entries?' + qs.toString(), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const all = (await r.json()).entries || [];
      const entries = _filterRead(all);
      // Count lives only in the meta bar below (as "N entries") — don't also
      // pass it as the title subtitle, or it shows twice.
      _renderGroupedEntries(
        `Search: “${query}”${scopeLabel}`,
        '',
        entries, true, '<span class="mc-feeds-title-emoji">🔍</span>');
    } catch (e) {
      const body = $('feedsViewBody');
      if (body) body.innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
    }
  }
  // Read history: all clicked articles, newest-clicked first (server read_at —
  // cross-device). Title → opens the article; the agency chip → that feed. Bypasses
  // the keyword filter so it shows EVERYTHING you've read. Capped at read_retain.
  // ── Pagination (Clicked + Summaries): user-set page size + numbered pager ──
  // Clicked and Summaries are separate sections — each keeps its OWN page size.
  const _pageSizes = {
    clicked: parseInt(localStorage.getItem('mc.feeds.pageSize.clicked') || localStorage.getItem('mc.feeds.pageSize') || '20', 10) || 20,
    summaries: parseInt(localStorage.getItem('mc.feeds.pageSize.summaries') || localStorage.getItem('mc.feeds.pageSize') || '20', 10) || 20,
  };
  let _clickedPage = 1;
  let _sumPage = 1;

  // ── Batch select + delete (desktop, Clicked + Summaries) ──────────────────
  let _selMode = false;
  let _selIds = new Set();
  window.mcToggleSelectMode = () => { _selMode = !_selMode; _selIds.clear(); _rerenderActiveView(); };
  window.mcSelToggle = (id, el) => {
    id = Number(id);
    if (_selIds.has(id)) _selIds.delete(id); else _selIds.add(id);
    const row = el && el.closest('.mc-summary-item, .mc-read-row');
    if (row) row.classList.toggle('is-selected', _selIds.has(id));
    if (el && el.type === 'checkbox') el.checked = _selIds.has(id);
    else { const cb = row && row.querySelector('.mc-sel-cb'); if (cb) cb.checked = _selIds.has(id); }
    const c = $('mcSelCount'); if (c) c.textContent = _selIds.size + ' selected';
    const d = $('mcSelDelBtn'); if (d) d.disabled = _selIds.size === 0;
  };
  window.mcSelDeleteSelected = async () => {
    if (!_selIds.size) return;
    const ids = [..._selIds];
    const d = $('mcSelDelBtn'); if (d) { d.disabled = true; d.textContent = 'Deleting…'; }
    if (_summaryView) {
      for (const id of ids) {
        try { await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries/' + id, { method: 'DELETE', credentials: 'same-origin' }); } catch (_) {}
      }
    } else if (_readView) {
      try {
        await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/read', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, read: false }), credentials: 'same-origin',
        });
      } catch (_) {}
      ids.forEach(id => _readIds.delete(id)); _saveReadIds();
    }
    _selMode = false; _selIds.clear();
    await refreshSidebar();
    _rerenderActiveView();
  };
  function _selectBtnHtml() {
    return `<button type="button" class="mc-sel-select-btn mc-d-only" onclick="mcToggleSelectMode()">${_selMode ? 'Done' : 'Select'}</button>`;
  }
  function _selBarHtml() {
    if (!_selMode) return '';
    return `<div class="mc-sel-bar"><span class="mc-sel-count" id="mcSelCount">${_selIds.size} selected</span>` +
      `<button type="button" class="mc-btn-sm mc-btn-sm-danger" id="mcSelDelBtn" onclick="mcSelDeleteSelected()"${_selIds.size ? '' : ' disabled'}>🗑 Delete selected</button>` +
      `<button type="button" class="mc-btn-sm" onclick="mcToggleSelectMode()">Cancel</button></div>`;
  }
  function _selCbHtml(id) {
    return _selMode ? `<input type="checkbox" class="mc-sel-cb" ${_selIds.has(id) ? 'checked' : ''} onclick="event.stopPropagation(); mcSelToggle(${id}, this)" aria-label="Select">` : '';
  }
  window.mcSetPageSize = (view, v) => {
    _pageSizes[view] = parseInt(v, 10) || 20;
    try { localStorage.setItem('mc.feeds.pageSize.' + view, String(_pageSizes[view])); } catch (_) {}
    if (view === 'clicked') { _clickedPage = 1; renderReadEntries(); }
    else { _sumPage = 1; renderSummariesView(); }
  };
  window.mcClickedGoPage = (n) => { _clickedPage = n; renderReadEntries(); };
  window.mcSumGoPage = (n) => { _sumPage = n; renderSummariesView(); };
  function _pageSizeSelect(view) {
    return `<label class="mc-page-size-wrap">Show
      <select class="mc-page-size" onchange="mcSetPageSize('${view}', this.value)">
        ${[10, 20, 50, 100].map(n => `<option value="${n}"${n === _pageSizes[view] ? ' selected' : ''}>${n}</option>`).join('')}
      </select></label>`;
  }
  function _pagerHtml(total, page, goFn, view) {
    const pages = Math.max(1, Math.ceil(total / _pageSizes[view]));
    if (pages <= 1) return '';
    // number window: first, last, current ±2, with ellipses
    const nums = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]
      .filter(n => n >= 1 && n <= pages));
    const ordered = [...nums].sort((a, b) => a - b);
    let btns = '', prev = 0;
    for (const n of ordered) {
      if (prev && n > prev + 1) btns += `<span class="mc-pager-gap">…</span>`;
      btns += `<button type="button" class="mc-pager-num${n === page ? ' is-active' : ''}" onclick="${goFn}(${n})">${n}</button>`;
      prev = n;
    }
    return `<div class="mc-pager">
      <button type="button" class="mc-pager-nav" ${page <= 1 ? 'disabled' : `onclick="${goFn}(${page - 1})"`}>‹ Prev</button>
      ${btns}
      <button type="button" class="mc-pager-nav" ${page >= pages ? 'disabled' : `onclick="${goFn}(${page + 1})"`}>Next ›</button>
    </div>`;
  }
  function _pageSlice(list, page, view) {
    return list.slice((page - 1) * _pageSizes[view], page * _pageSizes[view]);
  }

  // ── Swipe-left → reveal a Delete button (Clicked + Summaries, touch) ──
  function _attachSwipe(container, rowSel, onDelete) {
    if (!container || container.__mcSwipe) return;
    container.__mcSwipe = true;
    const OPEN = -90;
    let row = null, x0 = 0, y0 = 0, dx = 0, swiping = false;
    function btnFor(r) {
      let b = r.querySelector('.mc-swipe-del-btn');
      if (!b) {
        b = document.createElement('button');
        b.type = 'button'; b.className = 'mc-swipe-del-btn'; b.textContent = 'Delete';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          r.style.transition = 'transform .18s ease, opacity .18s ease';
          r.style.transform = 'translateX(-110%)'; r.style.opacity = '0';
          setTimeout(() => onDelete(r.getAttribute('data-swipe-id'), r), 160);
        });
        r.appendChild(b);
      }
      return b;
    }
    function closeRow(r) {
      if (!r) return;
      r.classList.remove('mc-swipe-open');
      r.style.transition = 'transform .18s ease';
      r.style.transform = '';
      const b = r.querySelector('.mc-swipe-del-btn');
      if (b) { b.style.opacity = '0'; setTimeout(() => { b.remove(); r.classList.remove('mc-swiping'); }, 200); }
      else r.classList.remove('mc-swiping');
    }
    container.addEventListener('touchstart', (ev) => {
      const r = ev.target.closest(rowSel);
      const open = container.querySelector('.mc-swipe-open');
      if (open && open !== r) closeRow(open);   // only one row open at a time
      row = r;
      if (!row) return;
      const tch = ev.touches[0];
      x0 = tch.clientX; y0 = tch.clientY; dx = 0; swiping = false;
    }, { passive: true });
    container.addEventListener('touchmove', (ev) => {
      if (!row) return;
      const tch = ev.touches[0];
      const mx = tch.clientX - x0, my = tch.clientY - y0;
      if (!swiping && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.4) swiping = true;
      if (!swiping) return;
      dx = Math.min(0, mx);                     // left only
      row.classList.add('mc-swiping');          // lifts overflow:hidden clipping
      const b = btnFor(row);
      b.style.opacity = String(Math.min(1, -dx / 70));
      row.style.transition = 'none';
      row.style.transform = `translateX(${Math.max(dx, -110)}px)`;
    }, { passive: true });
    container.addEventListener('touchend', () => {
      if (!row) return;
      const r = row; row = null;
      if (!swiping) return;
      r.style.transition = 'transform .18s ease';
      if (dx < -55) {                           // snap open — Delete waits for a tap
        r.style.transform = `translateX(${OPEN}px)`;
        r.classList.add('mc-swipe-open');
        const b = btnFor(r); b.style.opacity = '1';
      } else {
        closeRow(r);
      }
    }, { passive: true });
    // Tapping anywhere else closes the open row
    container.addEventListener('click', (ev) => {
      const open = container.querySelector('.mc-swipe-open');
      if (open && !ev.target.closest('.mc-swipe-del-btn')) closeRow(open);
    }, true);
  }

  async function renderReadEntries() {
    _searchTerms = [];
    _setViewHeader(_searchQuery ? `Clicked: “${_searchQuery}”` : 'Clicked Articles & Artifacts', '', '<span class="mc-feeds-title-emoji">📌</span>');
    _setControlsBar(false);
    const body = $('feedsViewBody');
    if (!body) return;
    const retain = Number(_settings.read_retain || 200);
    let entries = [];
    try {
      const qParam = _searchQuery ? '&q=' + encodeURIComponent(_searchQuery) : '';
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/entries?read_only=1&limit=' + retain + qParam, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      entries = (await r.json()).entries || [];
    } catch (e) {
      body.innerHTML = '<div class="mc-feeds-empty"><strong>Couldn\'t load read history.</strong></div>';
      return;
    }
    if (!entries.length) {
      body.innerHTML = _searchQuery
        ? `<div class="mc-feeds-empty"><strong>No clicked articles match “${esc(_searchQuery)}”.</strong></div>`
        : '<div class="mc-feeds-empty"><strong>No read articles yet.</strong><br>Open an article title and it\'ll be saved here.</div>';
      return;
    }
    const pages = Math.max(1, Math.ceil(entries.length / _pageSizes.clicked));
    if (_clickedPage > pages) _clickedPage = pages;
    const scEl = document.getElementById('mcFeedSideCounts');
    if (scEl) scEl.textContent = `${entries.length} read · keeping last ${retain}`;
    body.innerHTML =
      `<div class="mc-feed-view-sticky"><div class="mc-feed-meta-row"><span class="mc-feed-group-count">${entries.length} read · keeping last ${retain}</span>${_selectBtnHtml()}${_pageSizeSelect('clicked')}</div>${_selBarHtml()}</div>` +
      `<div class="mc-read-list">` + _pageSlice(entries, _clickedPage, 'clicked').map(_renderReadRow).join('') + `</div>` +
      _pagerHtml(entries.length, _clickedPage, 'mcClickedGoPage', 'clicked');
    // Swipe a row left to remove it from Clicked (marks the entry unread).
    _attachSwipe(body.querySelector('.mc-read-list'), '.mc-read-row', async (id, rowEl) => {
      try {
        await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/read', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(id), read: false }), credentials: 'same-origin',
        });
      } catch (_) {}
      _readIds.delete(Number(id)); _saveReadIds();
      if (rowEl) rowEl.remove();
      _loadSummaryMeta().then(() => { if (_readView) renderReadEntries(); });
    });
  }
  function _domainOf(url) {
    try {
      let h = new URL(url).hostname.toLowerCase();
      // Strip a leading feed/cdn subdomain so the favicon resolves to the BRAND
      // domain (feeds.bbci.co.uk → bbci.co.uk, rss.dw.com → dw.com) instead of a
      // subdomain DuckDuckGo has no real icon for (which returned a generic/broken
      // glyph that hid the initials). Only one leading label is stripped.
      h = h.replace(/^(www|feeds?|rss|news|mrss|cdn|api)\./, '');
      return h;
    } catch (_) { return ''; }
  }
  function _agencyInitials(name) {
    const w = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const s = (w.length >= 2 ? (w[0][0] + w[1][0]) : (w[0] || '?').slice(0, 2));
    return s.toUpperCase();
  }
  function _agencyColor(name) {
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 42% 42%)`;
  }
  function _fmtClickedAt(epoch) {
    const n = Number(epoch);
    if (!n) return '';
    const d = new Date(n * 1000);
    const p2 = x => String(x).padStart(2, '0');
    let h = d.getHours(); const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} @ ${h}:${p2(d.getMinutes())}${ap}`;
  }
  // Round agency logo, shared by the Clicked view and the main-feed group headers:
  // site favicon (DDG proxy, cheap + fast) with an initials-circle fallback when the
  // agency has no favicon (img onerror removes itself → the colored initials show).
  // Any new agency gets a logo automatically — derived from the article domain, no config.
  function _agencyLogoHtml(feedName, link, sizeClass) {
    const domain = _domainOf(link || '');
    // Same-origin, sidecar-cached favicon (fetched once server-side, then served
    // immutable) — no external round-trip per icon, so no scroll latency.
    const logo = domain ? `/api/extensions/rss-feeds/sidecar/api/feeds/favicon?domain=${encodeURIComponent(domain)}` : '';
    return `<span class="mc-agency-logo${sizeClass ? ' ' + sizeClass : ''}" style="background:${_agencyColor(feedName)}">` +
      `<span class="mc-agency-ini">${esc(_agencyInitials(feedName))}</span>` +
      (logo ? `<img src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()" onload="if(this.naturalWidth<8){this.remove()}">` : '') +
    `</span>`;
  }
  // Warm the favicon cache for every subscribed feed's domain once, right after
  // the feed list loads, so the sidecar has them ready before you scroll.
  let _faviconsWarmed = false;
  function _warmFavicons() {
    if (_faviconsWarmed || !Array.isArray(_feeds)) return;
    _faviconsWarmed = true;
    const domains = [...new Set(_feeds.map(f => _domainOf(f.url || '')).filter(Boolean))];
    let i = 0;
    (function next() {
      if (i >= domains.length) return;
      const d = domains[i++];
      const img = new Image();
      img.onload = img.onerror = () => setTimeout(next, 40);   // gentle, serial
      img.src = `/api/extensions/rss-feeds/sidecar/api/feeds/favicon?domain=${encodeURIComponent(d)}`;
    })();
  }
  function _renderReadRow(e) {
    const when = _fmtClickedAt(e.read_at);
    return `<div class="mc-read-row${_selIds.has(e.id) ? ' is-selected' : ''}${_selMode ? ' is-selectable' : ''}" data-swipe-id="${e.id}">` +
      _selCbHtml(e.id) +
      _agencyLogoHtml(e.feed_name, e.link, 'mc-read-logo') +
      `<div class="mc-read-main">` +
        `<a class="mc-read-title" href="${_attr(_safeUrl(e.link))}" target="_blank" rel="noopener noreferrer" onclick="mcMarkEntryRead(${e.id})">${esc(e.title)}</a>` +
        `<div class="mc-read-meta">` +
          `<button type="button" class="mc-read-agency" onclick="mcSelectFeed(${e.feed_id})" title="Open ${esc(e.feed_name)}">${esc(e.feed_name)}</button>` +
          (_summarizedIds.has(e.id) ? _entrySummaryToggle(e.id) : '') +
          (when ? `<span class="mc-read-when">${esc(when)}</span>` : '') +
        `</div>` +
        (_summarizedIds.has(e.id) ? _entrySummaryBodyEl(e.id) : '') +
      `</div>` +
      `<div class="mc-read-side"><span class="mc-read-check" title="Read">✓</span><div class="mc-read-actions">${_actionsCluster(e)}</div></div>` +
    `</div>`;
  }

  // ── RSS settings popup (gear): entries/page, agency multi-select, keep-read ──
  // All persisted server-side (feed_settings) so they sync across devices.
  function _closeFeedSettingsOnce(e) {
    const p = document.getElementById('mcFeedSettingsPopup');
    if (p && !e.target.closest('#mcFeedSettingsPopup') && !e.target.closest('#feedsSettingsBtn')) mcCloseFeedSettings();
  }
  window.mcCloseFeedSettings = () => {
    const p = document.getElementById('mcFeedSettingsPopup');
    if (p) p.remove();
    document.removeEventListener('click', _closeFeedSettingsOnce);
  };
  // ── Shared category-grouped, collapsed-by-default agency list (gear + summarize) ──
  // Renders feeds grouped under their category. Each category row has a checkbox
  // (marks/unmarks every agency in it) + is click-to-expand for per-agency marking.
  function _catGroups(feeds) {
    const m = new Map();
    for (const f of feeds) { const c = f.category || 'general'; if (!m.has(c)) m.set(c, []); m.get(c).push(f); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, items]) => [cat, items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))]);
  }
  function _renderCatGroupedList(feeds, feedClass, isChecked) {
    return _catGroups(feeds).map(([cat, items]) => {
      const allOn = items.every(f => isChecked(f));
      const agencies = items.map(f =>
        `<label class="mc-summarize-item mc-cat-agency"><input type="checkbox" class="${feedClass}" value="${f.id}" ${isChecked(f) ? 'checked' : ''}><span>${esc(f.name)}</span></label>`
      ).join('');
      return `<div class="mc-cat-group" data-cat="${esc(cat)}">` +
        `<div class="mc-cat-head">` +
          `<input type="checkbox" class="mc-cat-check" ${allOn ? 'checked' : ''} aria-label="Mark all in ${esc(cat)}">` +
          `<button type="button" class="mc-cat-toggle" onclick="mcToggleCatGroup(this)">` +
            `<span class="mc-cat-caret" aria-hidden="true">▸</span>` +
            `<span class="mc-cat-emoji" aria-hidden="true">${_categoryIcon(cat)}</span>` +
            `<span class="mc-cat-name">${esc(cat)}</span>` +
            `<span class="mc-cat-count">${items.length}</span>` +
          `</button>` +
        `</div>` +
        `<div class="mc-cat-agencies" hidden>${agencies}</div>` +
      `</div>`;
    }).join('');
  }
  window.mcToggleCatGroup = (btn) => {
    const grp = btn.closest('.mc-cat-group'); if (!grp) return;
    const sub = grp.querySelector('.mc-cat-agencies'); const caret = grp.querySelector('.mc-cat-caret');
    if (sub.hasAttribute('hidden')) { sub.removeAttribute('hidden'); if (caret) caret.textContent = '▾'; }
    else { sub.setAttribute('hidden', ''); if (caret) caret.textContent = '▸'; }
  };
  function _syncCatCheck(grp, feedClass) {
    const cc = grp.querySelector('.mc-cat-check'); if (!cc) return;
    const items = [...grp.querySelectorAll('.' + feedClass)];
    const on = items.filter(a => a.checked).length;
    cc.checked = items.length > 0 && on === items.length;
    cc.indeterminate = on > 0 && on < items.length;
  }
  function _wireCatGroupedList(pop, feedClass) {
    pop.querySelectorAll('.mc-cat-group').forEach(grp => _syncCatCheck(grp, feedClass));
    pop.querySelectorAll('.mc-cat-check').forEach(cc => cc.addEventListener('change', () => {
      const grp = cc.closest('.mc-cat-group');
      grp.querySelectorAll('.' + feedClass).forEach(a => { a.checked = cc.checked; });
      cc.indeterminate = false;
    }));
    pop.querySelectorAll('.' + feedClass).forEach(a => a.addEventListener('change', () => {
      const grp = a.closest('.mc-cat-group'); if (grp) _syncCatCheck(grp, feedClass);
    }));
  }
  function _setAllCats(pop, feedClass, on) {
    pop.querySelectorAll('.' + feedClass).forEach(a => { a.checked = on; });
    pop.querySelectorAll('.mc-cat-check').forEach(cc => { cc.checked = on; cc.indeterminate = false; });
  }

  // Place a feeds popup. On a compact (phone) viewport the action buttons live in
  // the bottom titlebar, so the menu rises from the bottom as a sheet (CSS class
  // mc-popup-sheet + slide-up animation). On wider viewports it anchors under the
  // button, flipping above it when the button sits low in the viewport.
  function _placeFeedsPopup(pop, btn) {
    if (window.matchMedia('(max-width:700px)').matches) {
      pop.classList.add('mc-popup-sheet');
      return;
    }
    if (!btn) return;
    const r = btn.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const mw = pop.offsetWidth || 280;
    pop.style.left = Math.round(Math.max(8, Math.min(r.right - mw, vw - mw - 8))) + 'px';
    if (r.bottom > vh - 260) {            // low on screen → open upward
      pop.style.bottom = Math.round(vh - r.top + 6) + 'px';
      pop.style.top = 'auto';
    } else {
      pop.style.top = Math.round(r.bottom + 6) + 'px';
    }
  }
  window.mcOpenFeedSettings = (e) => {
    if (e) e.stopPropagation();
    if (typeof mcCloseSummarizePopup === 'function') mcCloseSummarizePopup();   // never both open
    if (document.getElementById('mcFeedSettingsPopup')) return mcCloseFeedSettings();
    const feeds = (_feeds || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const vf = Array.isArray(_settings.visible_feeds) ? _settings.visible_feeds : [];
    const allVisible = vf.length === 0;   // [] = all agencies
    const epp = Number(_settings.entries_per_page) || 100;
    const retain = Number(_settings.read_retain) || 200;
    const eppOpts = [25, 50, 100, 200, 500].map(n => `<option value="${n}" ${n === epp ? 'selected' : ''}>${n === 500 ? 'All (500)' : n}</option>`).join('');
    // Summary model config (local ollama / free cloud fallbacks).
    // Compact: one live status line (which backend/model would run NOW, up/down)
    // from GET summary-status; edit fields collapsed by default.
    const sc = Object.assign({ backend: 'auto', ollama_model: 'qwen2.5:14b', local_port: 11434 }, _settings.summary_config || {});
    const bOpts = [['auto', 'Auto (local → cloud)'], ['local', 'Local (ollama)'], ['openrouter', 'OpenRouter free'], ['gemini', 'Gemini free']]
      .map(([v, l]) => `<option value="${v}" ${sc.backend === v ? 'selected' : ''}>${l}</option>`).join('');
    const summaryHtml =
      `<div class="mc-summarize-popup-head" style="border-top:1px solid var(--border);border-bottom:none;margin-top:4px"><span>Summary model</span>` +
        `<button type="button" class="mc-btn-sm" onclick="mcTestSummaryModel(this)" title="Save &amp; test">Test</button></div>` +
      `<div class="mc-fs-row"><label for="mcFsSummBackend">Backend</label><select id="mcFsSummBackend" onchange="mcFsSummChanged()">${bOpts}</select></div>` +
      `<div id="mcFsSummStatus" class="mc-fs-summ-status">checking…</div>` +
      `<div id="mcFsSummTest" class="mc-fs-summ-test" style="display:none"></div>` +
      `<span id="mcFsSummEdit" class="mc-fs-summ-edit" onclick="mcFsSummEditToggle()" style="display:none">Edit local model ▸</span>` +
      `<div id="mcFsSummLocal" style="display:none">` +
        `<div class="mc-fs-row"><label for="mcFsSummModel">Ollama model</label><select id="mcFsSummModel" style="width:150px" onchange="mcFsSummChanged()"><option value="${esc(sc.ollama_model || 'qwen2.5:14b')}" selected>${esc(sc.ollama_model || 'qwen2.5:14b')}</option></select></div>` +
        `<div class="mc-fs-row"><label for="mcFsSummLport">Ollama port</label><input id="mcFsSummLport" type="number" value="${sc.local_port || 11434}" style="width:70px" oninput="mcFsSummChanged()"></div>` +
      `</div>`;
    const pop = document.createElement('div');
    pop.id = 'mcFeedSettingsPopup';
    pop.className = 'mc-summarize-popup mc-feed-settings-popup';
    pop.innerHTML =
      `<div class="mc-summarize-popup-head"><span>RSS settings</span></div>` +
      `<div class="mc-fs-row"><label for="mcFsEpp">Entries per page</label><select id="mcFsEpp">${eppOpts}</select></div>` +
      `<div class="mc-fs-row"><label for="mcFsRetain">Keep read history</label><input type="number" id="mcFsRetain" min="10" max="2000" value="${retain}"></div>` +
      summaryHtml +
      `<div class="mc-summarize-popup-head" style="border-top:1px solid var(--border);border-bottom:none;margin-top:4px"><span>Show feeds</span>` +
        `<label class="mc-summarize-all"><input type="checkbox" id="mcFsAllAg" ${allVisible ? 'checked' : ''}> All</label></div>` +
      `<div class="mc-summarize-list">` +
        _renderCatGroupedList(feeds, 'mc-fs-feed', f => allVisible || vf.includes(f.id)) +
      `</div>` +
      `<div class="mc-summarize-actions"><button type="button" class="mc-btn-sm" onclick="mcCloseFeedSettings()">Cancel</button>` +
        `<button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcSaveFeedSettings()">Save</button></div>`;
    document.body.appendChild(pop);
    _placeFeedsPopup(pop, (e && e.target && e.target.closest('button')) || $('feedsGearBtnM') || $('feedsSettingsBtn'));
    const allAg = document.getElementById('mcFsAllAg');
    if (allAg) allAg.addEventListener('change', () => _setAllCats(pop, 'mc-fs-feed', allAg.checked));
    _wireCatGroupedList(pop, 'mc-fs-feed');
    mcFsSummChanged();      // edit-link visibility for the saved backend
    _loadSummStatus();      // async live probe → fills the status line
    setTimeout(() => document.addEventListener('click', _closeFeedSettingsOnce), 0);
  };
  function _readSummaryConfig() {
    const g = (id) => (document.getElementById(id) || {});
    return {
      backend: g('mcFsSummBackend').value || 'auto',
      ollama_model: (g('mcFsSummModel').value || 'qwen2.5:14b').trim(),
      local_port: parseInt(g('mcFsSummLport').value, 10) || 11434,
    };
  }
  // Live probe of the saved summary config (ollama port up, model list,
  // API-key presence) — the "which model would actually run" truth line.
  let _summStatus = null;
  async function _loadSummStatus() {
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summary-status', { credentials: 'same-origin' });
      _summStatus = r.ok ? await r.json() : null;
    } catch (_) { _summStatus = null; }
    _fillSummModels();
    _renderSummStatus();
  }
  // Fill the Ollama-model dropdown with every model installed on the machine
  // the port leads to (from the live /api/tags probe). Keeps the current pick;
  // a saved model that's no longer installed stays listed, flagged.
  function _fillSummModels() {
    const sel = document.getElementById('mcFsSummModel');
    const st = _summStatus;
    if (!sel || !st) return;
    const models = (st.local && Array.isArray(st.local.models)) ? st.local.models : [];
    if (!models.length) return;              // ollama unreachable → keep saved entry
    const cur = sel.value || st.local.model;
    const opts = models.slice();
    if (cur && !opts.includes(cur)) opts.unshift(cur);
    sel.innerHTML = opts.map(m =>
      `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}${models.includes(m) ? '' : ' (not installed)'}</option>`
    ).join('');
  }
  function _renderSummStatus() {
    const el = document.getElementById('mcFsSummStatus');
    if (!el) return;
    const st = _summStatus;
    if (!st) { el.innerHTML = '<span class="mc-fs-summ-dot"></span>checking…'; return; }
    // Model value comes from the form field (live while editing); reachability
    // flags come from the probe of the SAVED config.
    const $v = (id) => { const n = document.getElementById(id); return n ? n.value : null; };
    const sel = $v('mcFsSummBackend') || st.config.backend || 'auto';
    const model = (($v('mcFsSummModel') ?? st.local.model) || st.local.model).trim() || st.local.model;
    const dot = (c) => `<span class="mc-fs-summ-dot ${c}"></span>`;
    const localLine = () => {
      let state, cls;
      if (st.local.port_open) { state = 'ollama up'; cls = 'ok'; }
      else { state = `ollama not reachable on :${st.local.local_port}`; cls = 'bad'; }
      let extra = '';
      if (st.local.port_open && st.local.model_present === false) extra = ' · <span class="bad">model not installed on ollama</span>';
      else if (st.local.port_open && st.local.model_present === true) extra = ' · model installed';
      return `${dot(cls)}<b>${esc(model)}</b> · ${state}${extra}`;
    };
    const keyLine = (o, name) => `${dot(o.key ? 'ok' : 'bad')}<b>${esc(o.model)}</b> · ${name} API key ${o.key ? '✓' : '✗ missing'}`;
    if (sel === 'local') el.innerHTML = localLine();
    else if (sel === 'openrouter') el.innerHTML = keyLine(st.openrouter, 'OpenRouter');
    else if (sel === 'gemini') el.innerHTML = keyLine(st.gemini, 'Gemini');
    else {
      const a = st.active || {};
      let first;
      if (a.backend === 'local') first = localLine();
      else if (a.backend === 'openrouter') first = keyLine(st.openrouter, 'OpenRouter');
      else if (a.backend === 'gemini') first = keyLine(st.gemini, 'Gemini');
      else first = `${dot('bad')}no backend available (ollama down, no API keys)`;
      el.innerHTML = `<div>now → ${first}</div>` +
        `<div class="mc-fs-summ-chain">chain: local (${esc(model)}) → OpenRouter → Gemini</div>`;
    }
  }
  window.mcFsSummChanged = () => {
    const b = (document.getElementById('mcFsSummBackend') || {}).value;
    const isLocal = (b === 'local' || b === 'auto');
    const edit = document.getElementById('mcFsSummEdit');
    const fields = document.getElementById('mcFsSummLocal');
    if (edit) edit.style.display = isLocal ? 'block' : 'none';
    if (fields && !isLocal) {
      fields.style.display = 'none';
      if (edit) edit.textContent = 'Edit local model ▸';
    }
    _renderSummStatus();
  };
  window.mcFsSummEditToggle = () => {
    const fields = document.getElementById('mcFsSummLocal');
    const edit = document.getElementById('mcFsSummEdit');
    if (!fields) return;
    const open = fields.style.display !== 'none';
    fields.style.display = open ? 'none' : 'block';
    if (edit) edit.textContent = open ? 'Edit local model ▸' : 'Hide local model ▾';
    if (!open) _fillSummModels();   // fields just revealed → ensure dropdown is populated
  };
  // Persist the entered summary config, then run a 1-word test through it.
  window.mcTestSummaryModel = async (btn) => {
    const out = document.getElementById('mcFsSummTest');
    const sc = _readSummaryConfig();
    if (btn) btn.disabled = true;
    if (out) { out.style.display = 'block'; out.textContent = 'Testing… (saves this config first)'; out.style.color = 'var(--muted)'; }
    try {
      const rs = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary_config: sc }), credentials: 'same-origin',
      });
      if (rs.ok) _settings = await rs.json();
      // Start the test as a background job (202) then poll — the model call can
      // exceed the proxy's 10s timeout on a cold model.
      const tbase = '/api/extensions/rss-feeds/sidecar/api/feeds';
      await fetch(tbase + '/summary-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin',
      });
      const d = await new Promise((resolve, reject) => {
        let n = 0;
        const tick = () => {
          fetch(tbase + '/summary-test-status', { credentials: 'same-origin' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
            .then(s => {
              if (s.running) {
                if (++n > 180) return reject(new Error('test timed out'));  // ~4.5min
                setTimeout(tick, 1500); return;
              }
              resolve(s);
            })
            .catch(reject);
        };
        setTimeout(tick, 600);
      });
      if (out) { out.textContent = d.ok ? ('✓ works — used ' + d.model) : ('✗ ' + (d.error || 'failed')); out.style.color = d.ok ? 'var(--success, #3fb950)' : 'var(--error, #ff7b7b)'; }
    } catch (e) {
      if (out) { out.textContent = '✗ ' + e.message; out.style.color = 'var(--error, #ff7b7b)'; }
    } finally { if (btn) btn.disabled = false; _loadSummStatus(); }
  };

  window.mcSaveFeedSettings = async () => {
    const pop = document.getElementById('mcFeedSettingsPopup');
    if (!pop) return;
    const epp = parseInt((document.getElementById('mcFsEpp') || {}).value, 10) || 100;
    const retain = parseInt((document.getElementById('mcFsRetain') || {}).value, 10) || 200;
    const checked = Array.from(pop.querySelectorAll('.mc-fs-feed:checked')).map(c => parseInt(c.value, 10)).filter(Number.isFinite);
    const total = pop.querySelectorAll('.mc-fs-feed').length;
    const visible_feeds = (checked.length >= total) ? [] : checked;   // all → [] (= all)
    const summary_config = _readSummaryConfig();
    mcCloseFeedSettings();
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries_per_page: epp, read_retain: retain, visible_feeds, summary_config }),
        credentials: 'same-origin',
      });
      if (r.ok) _settings = await r.json();
    } catch (_) {}
    await refreshSidebar();
    _rerenderActiveView();
  };

  // ── Keyword filter management ─────────────────────────────────────────────
  window.mcToggleFilter = async () => {
    const newVal = !_settings.filter_enabled;
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter_enabled: newVal }),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _settings = await r.json();
      await loadFeedsPanel();
    } catch (e) {
      _showModalErr('Filter toggle failed: ' + e.message);
    }
  };

  window.mcToggleReadVisibility = async () => {
    _readVisibility = _readVisibility === 'hide' ? 'show' : 'hide';
    try { localStorage.setItem('mc.feeds.read.visibility', _readVisibility); } catch (_) {}
    await loadFeedsPanel();
  };

  // auto-fetch picker modal
  window.mcOpenAutoFetchPicker = () => {
    const cur = Number(_settings.auto_fetch_minutes || 0);
    const opts = [
      { v: 0,    label: 'Off' },
      { v: 15,   label: 'Every 15 minutes' },
      { v: 30,   label: 'Every 30 minutes' },
      { v: 60,   label: 'Every hour' },
      { v: 180,  label: 'Every 3 hours' },
      { v: 360,  label: 'Every 6 hours' },
      { v: 720,  label: 'Every 12 hours' },
      { v: 1440, label: 'Every 24 hours' },
    ];
    const rows = opts.map(o => `
      <label class="mc-auto-fetch-row ${cur === o.v ? 'is-selected' : ''}">
        <input type="radio" name="mcAutoFetch" value="${o.v}" ${cur === o.v ? 'checked' : ''}>
        <span>${esc(o.label)}</span>
      </label>`).join('');
    _openModal('Auto-fetch interval', `
      <p class="mc-feed-modal-hint">
        The server refreshes all enabled feeds in the background at this interval.
        Works while this browser tab is closed. The "Refresh all" button still works
        on-demand independent of this setting. Set to <strong>Off</strong> to disable.
      </p>
      <div class="mc-auto-fetch-list">${rows}</div>
      <div class="mc-feed-modal-actions">
        <button type="button" class="mc-btn-sm" onclick="mcFeedsCloseModal()">Cancel</button>
        <button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcSaveAutoFetch()">Save</button>
      </div>`);
  };

  window.mcSaveAutoFetch = async () => {
    const picked = document.querySelector('input[name="mcAutoFetch"]:checked');
    if (!picked) return;
    const val = Number(picked.value);
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_fetch_minutes: val }),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      _settings = await r.json();
      _closeModal();
      await loadFeedsPanel();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  };

  // ── Keyword editor: chip-based UI ────────────────────────────────────────
  // mc-features: replaced the comma-separated textarea with a chip-based
  // editor so duplicates can be blocked inline and accidental removal is
  // gated by a confirm dialog. The legacy "paste many at once" workflow
  // is preserved via the input parser — comma-separated paste still
  // explodes into chips.
  let _kwDraft = [];

  window.mcEditKeywords = () => {
    _kwDraft = [...(_settings.keywords || [])];
    _openModal('Filter keywords', `
      <p class="mc-feed-modal-hint">
        Keep entries whose title or summary matches <strong>any</strong> keyword
        (case-insensitive). Paste a comma-separated list to add many at once.
      </p>
      <label class="mc-feed-modal-label">Current keywords</label>
      <div id="mcKwChips" class="mc-kw-chips"></div>
      <label class="mc-feed-modal-label" for="mcKwInput">Add keyword</label>
      <div class="mc-kw-add-row">
        <input id="mcKwInput" type="text" class="mc-feed-modal-input mc-kw-add-input"
               placeholder="politics, iran, crypto, …"
               onkeydown="if(event.key==='Enter'){event.preventDefault();mcAddKeyword();}">
        <button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcAddKeyword()">Add</button>
      </div>
      <div id="mcKwNotice" class="mc-feed-modal-hint mc-kw-notice" hidden></div>
      <div class="mc-feed-modal-actions">
        <button type="button" class="mc-btn-sm" onclick="mcFeedsCloseModal()">Cancel</button>
        <button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcSaveKeywords()">Save</button>
      </div>`);
    _renderKwChips();
  };

  function _renderKwChips() {
    const box = $('mcKwChips');
    if (!box) return;
    if (!_kwDraft.length) {
      box.innerHTML = '<div class="mc-kw-empty">No keywords yet — filter is OFF by default.</div>';
      return;
    }
    box.innerHTML = _kwDraft.map((kw, i) =>
      `<span class="mc-kw-chip-edit">
        <span class="mc-kw-chip-text">${esc(kw)}</span>
        <button type="button" class="mc-kw-chip-x" aria-label="Remove ${esc(kw)}"
                onclick="mcRemoveKeyword(${i})">×</button>
      </span>`).join('');
  }

  function _showKwNotice(msg, kind) {
    const el = $('mcKwNotice');
    if (!el) return;
    el.textContent = msg;
    el.className = 'mc-feed-modal-hint mc-kw-notice mc-kw-notice-' + (kind || 'info');
    el.hidden = false;
    clearTimeout(_showKwNotice._t);
    _showKwNotice._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  window.mcAddKeyword = () => {
    const input = $('mcKwInput');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    // Allow comma-separated paste — explode into individual chips. Keywords are
    // stored UPPERCASE (typed in any case → shown capital); matching stays
    // case-insensitive (\b…\b re.IGNORECASE), so filtering is unchanged.
    const candidates = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const lower = new Set(_kwDraft.map(k => k.toLowerCase()));
    const added = [];
    const dupes = [];
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (lower.has(key) || added.some(a => a.toLowerCase() === key)) {
        dupes.push(c);
      } else {
        added.push(c);
      }
    }
    if (added.length) _kwDraft.push(...added);
    input.value = '';
    _renderKwChips();
    if (dupes.length && !added.length) {
      _showKwNotice(`Already in list: ${dupes.join(', ')}`, 'warn');
    } else if (dupes.length) {
      _showKwNotice(`Added ${added.length}, skipped ${dupes.length} duplicate${dupes.length === 1 ? '' : 's'}: ${dupes.join(', ')}`, 'warn');
    }
    input.focus();
  };

  window.mcRemoveKeyword = (idx) => {
    if (idx < 0 || idx >= _kwDraft.length) return;
    // no per-chip confirm dialog. Two reasons:
    //   1. showConfirmDialog stacks below the open keyword modal — the
    //      dialog can't promote above the parent overlay, so the user
    //      can't see/click it cleanly.
    //   2. The chip + Save model already protects against accidental
    //      loss. Removing a chip only mutates _kwDraft in memory.
    //      Cancel closes the modal without persisting; Save commits.
    //      An errant × is recoverable by typing the keyword back in.
    _kwDraft.splice(idx, 1);
    _renderKwChips();
  };

  window.mcSaveKeywords = async () => {
    // Final dedup pass (defense in depth — adds already block dupes, but a
    // paranoid save is cheap).
    const seen = new Set();
    const kws = [];
    for (const k of _kwDraft) {
      const key = k.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        kws.push(k);
      }
    }
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: kws }),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      _settings = await r.json();
      _closeModal();
      await loadFeedsPanel();
    } catch (e) {
      _showModalErr('Save failed: ' + e.message);
    }
  };

  // ── Feed CRUD: Add / Edit / Delete via modal ──────────────────────────────
  function _feedFormHTML(feed) {
    // mc-features: Category was a free text input + datalist autocomplete.
    // Free-text means "Tech" creates a new category instead of joining
    // "💻 Tech & AI". Replaced with a <select> populated from the live
    // category list, plus a sentinel "+ Add new category…" option that
    // reveals a hidden text input.
    const cats = [...new Set(_feeds.map(x => x.category).filter(Boolean))].sort();
    // New feeds default to the first EXISTING category — never invent one.
    // With no categories at all, default to "+ Add new category…".
    const f = feed || { name: '', url: '', category: cats[0] || '', enabled: 1 };
    const currentCat = f.category || '';
    // If an edited feed's category isn't in the live list (e.g. brand new
    // category set on this same form), include it so editing doesn't lose it.
    if (currentCat && !cats.includes(currentCat)) cats.push(currentCat);
    cats.sort();
    const noCat = !currentCat;   // no categories exist yet → new-category mode
    const options = cats.map(c =>
      `<option value="${esc(c)}"${c === currentCat ? ' selected' : ''}>${esc(c)}</option>`
    ).join('');
    return `
      <label class="mc-feed-modal-label">Name</label>
      <input id="mcFeedName" type="text" class="mc-feed-modal-input" value="${esc(f.name)}" placeholder="e.g. BBC News">
      <label class="mc-feed-modal-label">URL</label>
      <input id="mcFeedUrl" type="url" class="mc-feed-modal-input" value="${esc(f.url)}" placeholder="https://example.com/rss.xml">
      <label class="mc-feed-modal-label" for="mcFeedCat">Category</label>
      <select id="mcFeedCat" class="mc-feed-modal-input" onchange="mcCategorySelectChanged()">
        ${options}
        <option value="__new__"${noCat ? ' selected' : ''}>+ Add new category…</option>
      </select>
      <div id="mcFeedCatNewRow" class="mc-feed-modal-cat-new-row"${noCat ? '' : ' hidden'}>
        <input id="mcFeedCatNew" type="text" class="mc-feed-modal-input"
               placeholder="New category name (e.g. 💻 Tech & AI)"
               aria-label="New category name">
      </div>
      <div class="mc-feed-modal-grid">
        <label class="mc-feed-modal-check">
          <input id="mcFeedEnabled" type="checkbox" ${f.enabled ? 'checked' : ''}>
          Enabled
        </label>
      </div>
      <div id="mcFeedErr" class="mc-feed-modal-err" hidden></div>`;
  }

  window.mcCategorySelectChanged = () => {
    const sel = $('mcFeedCat');
    const row = $('mcFeedCatNewRow');
    const inp = $('mcFeedCatNew');
    if (!sel || !row) return;
    if (sel.value === '__new__') {
      row.hidden = false;
      if (inp) { inp.value = ''; inp.focus(); }
    } else {
      row.hidden = true;
      if (inp) inp.value = '';
    }
  };

  // Read the category from either the select or the new-category input.
  // Returns '' if user picked "+ Add new…" but didn't fill the name; the
  // save handlers treat that as an error.
  function _readSelectedCategory() {
    const sel = $('mcFeedCat');
    if (!sel) return '';
    if (sel.value === '__new__') {
      const inp = $('mcFeedCatNew');
      return inp ? inp.value.trim() : '';
    }
    return sel.value.trim();
  }

  window.mcOpenAddFeed = () => {
    _openModal('Add feed', _feedFormHTML(null) + `
      <div class="mc-feed-modal-actions">
        <button type="button" class="mc-btn-sm" onclick="mcFeedsCloseModal()">Cancel</button>
        <button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcSaveNewFeed()">Add</button>
      </div>`);
  };

  window.mcSaveNewFeed = async () => {
    const cat = _readSelectedCategory();
    if (!cat) {
      _showModalErr('Pick a category, or type a name after choosing "+ Add new category…".');
      return;
    }
    const payload = {
      name: $('mcFeedName').value.trim(),
      url: $('mcFeedUrl').value.trim(),
      category: cat,
      enabled: $('mcFeedEnabled').checked,
    };
    if (!payload.name || !payload.url) {
      _showModalErr('Name and URL are required.');
      return;
    }
    try {
      const base = '/api/extensions/rss-feeds/sidecar/api/feeds';
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
      if (!r.ok && r.status !== 202) throw new Error(((await r.json().catch(() => ({}))).error) || ('HTTP ' + r.status));
      const created = await r.json().catch(() => ({}));
      // Back-compat: an older sidecar validated synchronously and returned the
      // feed with an embedded .check. The current sidecar returns 202 + an id and
      // validates in the background — poll add-status for the outcome.
      if (created && created.check) {
        _closeModal();
        _summaryToast(`✓ Feed OK — ${created.check.new_entries} entr${created.check.new_entries === 1 ? 'y' : 'ies'} fetched`);
        await loadFeedsPanel();
        return;
      }
      const fid = created && created.id;
      if (!fid) { _closeModal(); await loadFeedsPanel(); return; }
      _showModalErr('Validating feed…');
      const result = await new Promise((resolve, reject) => {
        let n = 0;
        const tick = () => {
          fetch(base + '/add-status?id=' + encodeURIComponent(fid), { credentials: 'same-origin' })
            .then(rr => rr.ok ? rr.json() : Promise.reject(new Error('HTTP ' + rr.status)))
            .then(s => {
              if (s.validating) { if (++n > 60) return reject(new Error('validation timed out')); setTimeout(tick, 1000); return; }
              resolve(s);
            })
            .catch(reject);
        };
        setTimeout(tick, 500);
      });
      if (!result.ok) { _showModalErr('Feed check failed: ' + (result.error || 'unreachable')); return; }
      _closeModal();
      _summaryToast(`✓ Feed OK — ${result.new_entries} entr${result.new_entries === 1 ? 'y' : 'ies'} fetched`);
      await loadFeedsPanel();
    } catch (e) {
      _showModalErr(e.message);
    }
  };

  window.mcEditFeed = (id) => {
    const f = _feeds.find(x => x.id === id);
    if (!f) return;
    _openModal('Edit feed', _feedFormHTML(f) + `
      <div class="mc-feed-modal-actions">
        <button type="button" class="mc-btn-sm" onclick="mcFeedsCloseModal()">Cancel</button>
        <button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcSaveEditFeed(${id})">Save</button>
      </div>`);
  };

  window.mcSaveEditFeed = async (id) => {
    const cat = _readSelectedCategory();
    if (!cat) {
      _showModalErr('Pick a category, or type a name after choosing "+ Add new category…".');
      return;
    }
    const payload = {
      name: $('mcFeedName').value.trim(),
      url: $('mcFeedUrl').value.trim(),
      category: cat,
      enabled: $('mcFeedEnabled').checked,
    };
    if (!payload.name || !payload.url) {
      _showModalErr('Name and URL are required.');
      return;
    }
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      _closeModal();
      await loadFeedsPanel();
    } catch (e) {
      _showModalErr(e.message);
    }
  };

  window.mcDeleteFeed = async (id) => {
    const f = _feeds.find(x => x.id === id);
    if (!f) return;
    // Use the WebUI's custom showConfirmDialog modal — the native
    // window-level dialog is forbidden by
    // tests/test_sprint33.py::test_no_native_confirm_calls_remain_in_static_js.
    const _ok = await showConfirmDialog({
      title: 'Delete feed?',
      message: `Delete "${f.name}" and all ${f.entry_count || 0} stored entries? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      focusCancel: true,
    });
    if (!_ok) return;
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/' + id, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      if (_activeFeedId === id) _activeFeedId = null;
      await loadFeedsPanel();
    } catch (e) {
      _showModalErr('Delete failed: ' + e.message);
    }
  };

  function _showModalErr(msg) {
    const el = $('mcFeedErr');
    if (el) {
      el.textContent = msg;
      el.hidden = false;
    }
  }

  // ── Refresh + Summarize ──────────────────────────────────────────────────

  // Modern 0→100% progress bar for the slow (~10–30s) parallel feed refresh.
  // /api/feeds/refresh returns all results at once (no streaming), so the bar
  // eases asymptotically toward 90% over the estimated duration, then snaps to
  // 100% on completion. Anchored as a SIBLING of #feedsViewBody so re-rendering
  // the body (loadFeedsPanel) doesn't wipe it.
  // Hybrid progress bar: the rendered pct eases smoothly toward `target`, which is
  // set from REAL feed-completion counts streamed over SSE (done/total). So the bar
  // shows honest numbers ("18/42 feeds · 43%") without the jumpy/stall feel of a raw
  // count bar.
  const _feedProgress = {
    raf: null, pct: 0, target: 0, fill: null, label: null, el: null, msg: 'Refreshing feeds…',
    start() {
      this.stop();
      const body = $('feedsViewBody');
      if (!body || !body.parentNode) return;
      const wrap = document.createElement('div');
      // INDETERMINATE bar. The WebUI sidecar-proxy buffers responses, so
      // real per-feed SSE progress can't stream — animate instead of a stuck %.
      wrap.className = 'mc-feed-progress mc-feed-progress--busy';
      wrap.id = 'mcFeedProgress';
      // Visual only — no text; the slim accent line matches the app chrome.
      wrap.innerHTML = '<div class="mc-feed-progress-track"><div class="mc-feed-progress-fill"></div></div>';
      body.parentNode.insertBefore(wrap, body);
      this.el = wrap;
      this.fill = wrap.querySelector('.mc-feed-progress-fill');
      this.label = null;
      this.pct = 0;
    },
    // Real per-feed progress from SSE. Cap at 96% until 'done' so it never hits
    // 100% before the refresh actually completes.
    setProgress(done, total) {
      if (!total) return;
      this.target = Math.min(96, (done / total) * 100);
      this.msg = `Refreshing ${done}/${total} feeds…`;
    },
    _paint() {
      if (this.fill) this.fill.style.width = this.pct.toFixed(1) + '%';
    },
    done(msg) {
      this._stop();
      if (this.el) this.el.classList.remove('mc-feed-progress--busy');
      if (this.fill) this.fill.style.width = '100%';
      const el = this.el;
      setTimeout(() => { if (el) { el.classList.add('mc-feed-progress-fade'); setTimeout(() => el.remove(), 500); } }, 900);
      // Surface the computed "N/M feeds · K new" result instead of dropping it.
      if (msg && typeof _summaryToast === 'function') _summaryToast(msg);
    },
    fail() {
      // No text — the persistent failures panel reports what went wrong.
      this._stop();
      if (this.el) this.el.classList.remove('mc-feed-progress--busy');
      if (this.el) this.el.classList.add('mc-feed-progress-err');
      const el = this.el;
      setTimeout(() => { if (el) { el.classList.add('mc-feed-progress-fade'); setTimeout(() => el.remove(), 500); } }, 1600);
    },
    _stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; },
    stop() { this._stop(); const e = $('mcFeedProgress'); if (e) e.remove(); this.el = this.fill = this.label = null; },
  };

  // Shared refresh: starts a background refresh job then polls /refresh-status,
  // feeding real per-feed progress (done/total) into the eased bar, then reloads
  // via reloadFn. Job+poll avoids the proxy's 10s timeout on a full refresh.
  function _streamRefresh(reloadFn) {
    return new Promise((resolve) => {
      _feedProgress.start();
      let settled = false;
      // ok message auto-fades; the failures panel (if any) STAYS until dismissed.
      const finish = (ok, msg, failures) => {
        if (settled) return; settled = true;
        if (ok) {
          Promise.resolve(reloadFn && reloadFn())
            .catch(() => {})
            .then(() => { _feedProgress.done(msg); _showFeedFailures(failures); resolve(); });
        } else { _feedProgress.fail(msg); resolve(); }
      };
      // A full refresh takes ~10-30s, longer than the sidecar-proxy's hard 10s
      // timeout, so a synchronous POST would 502. Instead the POST starts a
      // background job (202) and we poll GET /refresh-status for live progress +
      // the final results — no proxy timeout, and the bar tracks done/total.
      const base = '/api/extensions/rss-feeds/sidecar/api/feeds';
      const summarize = (results) => {
        const oks = results.filter(x => String(x.status).startsWith('ok'));
        const totalNew = oks.reduce((s, x) => s + (x.new_entries || 0), 0);
        const fails = results.filter(x => !String(x.status).startsWith('ok'))
          .map(x => ({ name: x.feed_name || ('feed #' + (x.feed_id || '?')), status: x.status, error: x.error || '' }));
        finish(true, `${oks.length}/${results.length} feeds · ${totalNew} new` + (fails.length ? ` · ${fails.length} failed` : ''), fails);
      };
      let _polls = 0;
      const poll = () => {
        fetch(base + '/refresh-status', { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
          .then(d => {
            if (typeof d.total === 'number' && d.total > 0) _feedProgress.setProgress(d.done || 0, d.total);
            if (d.running) {
              // Safety valve: ~5 min of polling (200 × 1.5s) then give up cleanly.
              if (++_polls > 200) { finish(false, 'Refresh timed out'); return; }
              setTimeout(poll, 1500);
              return;
            }
            if (d.error) { finish(false, 'Refresh failed: ' + d.error); return; }
            summarize(Array.isArray(d.results) ? d.results : []);
          })
          .catch(e => finish(false, 'Refresh failed: ' + e.message));
      };
      fetch(base + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(() => setTimeout(poll, 800))
        .catch(e => finish(false, 'Refresh failed: ' + e.message));
    });
  }

  // Persistent, dismissible panel listing feeds that failed to refresh — stays on
  // screen until the user clicks ✕ (so they can actually deal with the failures).
  function _failReason(f) {
    const s = String(f.status || '');
    if (s.indexOf('http_') === 0) return s.replace('http_', 'HTTP ');
    if (s === 'no_entries') return 'no entries / malformed feed';
    if (s === 'not_found') return 'feed not found';
    if (s === 'exception') return (String(f.error || '').split(':')[0]) || 'error';
    if (s === 'error') return (String(f.error || '').slice(0, 60)) || 'error';
    return s || 'error';
  }
  function _showFeedFailures(fails) {
    const old = document.getElementById('mcFeedFailures');
    if (old) old.remove();
    if (!Array.isArray(fails) || !fails.length) return;
    const body = $('feedsViewBody');
    if (!body || !body.parentNode) return;
    const rows = fails.map(f =>
      `<div class="mc-feed-fail-row">` +
        `<span class="mc-feed-fail-name" title="${esc(f.name || 'feed')}">${esc(f.name || 'feed')}</span>` +
        `<span class="mc-feed-fail-reason" title="${esc(String(f.error || f.status || ''))}">${esc(_failReason(f))}</span>` +
      `</div>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'mc-feed-failures';
    wrap.id = 'mcFeedFailures';
    wrap.classList.add('is-collapsed');   // header-only until tapped
    wrap.innerHTML =
      `<div class="mc-feed-fail-head" role="button" tabindex="0" title="Show failed feeds"
            onclick="if(!event.target.closest('.mc-feed-fail-close')){this.closest('.mc-feed-failures').classList.toggle('is-collapsed');}">` +
        `<span class="mc-feed-fail-title"><span class="mc-feed-fail-caret" aria-hidden="true">▸</span> ⚠ ${fails.length} feed${fails.length > 1 ? 's' : ''} failed to refresh</span>` +
        `<button type="button" class="mc-feed-fail-close" title="Dismiss" aria-label="Dismiss" onclick="this.closest('.mc-feed-failures').remove()">✕</button>` +
      `</div>` +
      `<div class="mc-feed-fail-list">${rows}</div>`;
    body.parentNode.insertBefore(wrap, body);
  }

  window.mcRefreshAllFeeds = async () => {
    const btns = document.querySelectorAll('#feedsRefreshBtn, #feedsRefreshBtnM');
    btns.forEach(b => b.classList.add('mc-feed-spinning'));
    try { await _streamRefresh(() => loadFeedsPanel()); }
    finally { btns.forEach(b => b.classList.remove('mc-feed-spinning')); }
  };

  // Kick off a FREE/local summary job (local ollama → OpenRouter :free). The
  // job runs server-side; the user can navigate away and find the result in
  // 🧠 Summaries (and inline on the card for a single article). No paid tokens,
  // no chat dependency.
  async function _summarize(scope, target) {
    const btn = $('feedsSummarizeBtn');
    if (btn) btn.classList.add('mc-feed-spinning');
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, target }),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      const data = await r.json();
      _summaryToast(`Summarizing “${data.title || 'feed'}” — find it in 🧠 Summaries`);
      await refreshSidebar();           // server already shows the running row → badge updates
      _startSummaryPoll();              // poll until it (and any other) finishes
      if (_summaryView) renderSummariesView();
    } catch (e) {
      _summaryToast('Summarize failed: ' + e.message, true);
    } finally {
      if (btn) btn.classList.remove('mc-feed-spinning');
    }
  }

  // ── Summaries: toast, polling, view, inline card expander ─────────────────
  let _summaryToastTimer = null;
  function _summaryToast(msg, isError) {
    let el = $('mcSummaryToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mcSummaryToast';
      el.className = 'mc-summary-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-show');
    if (_summaryToastTimer) clearTimeout(_summaryToastTimer);
    _summaryToastTimer = setTimeout(() => el.classList.remove('is-show'), 4200);
  }

  function _startSummaryPoll() {
    if (_summaryPoll) return;
    _summaryPoll = setInterval(async () => {
      const prevRunning = _summaryRunning;
      await _loadSummaryMeta();
      // keep the sidebar badge in sync without a disruptive full re-render
      _updateSummaryBadge();
      // Only rebuild the Summaries list when the running count actually changed
      // (a job finished/started) — avoids a full fetch+rebuild every 3s for nothing.
      if (_summaryView && _summaryRunning !== prevRunning) renderSummariesView();
      if (_summaryRunning === 0) {
        clearInterval(_summaryPoll); _summaryPoll = null;
        if (prevRunning > 0) {
          _summaryToast('Summary ready — in 🧠 Summaries');
          _decorateSummarizedCards();   // surface inline expanders on visible cards
          refreshSidebar();             // refresh Summaries/Clicked count badges
        }
      }
    }, 3000);
  }
  function _updateSummaryBadge() {
    const row = document.querySelector('.mc-feed-summaries-row');
    if (!row) return;
    let badge = row.querySelector('.mc-feed-count-live');
    if (_summaryRunning > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mc-feed-count mc-feed-count-live';
        row.appendChild(badge);
      }
      badge.textContent = `⏳ ${_summaryRunning}`;
    } else if (badge) {
      badge.remove();
    }
  }

  // Minimal, self-contained markdown (escape-first) for short digests.
  function _miniMarkdown(src) {
    let s = esc(String(src == null ? '' : src));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    const lines = s.split('\n');
    let html = '', inList = false;
    for (const line of lines) {
      const t = line.trim();
      const bullet = t.match(/^[-*•]\s+(.*)$/);
      const head = t.match(/^(#{1,4})\s+(.*)$/);
      if (bullet) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + bullet[1] + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (head) html += '<h4>' + head[2] + '</h4>';
        else if (t) html += '<p>' + line + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  function _parseSources(raw) {
    if (Array.isArray(raw)) return raw;
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }
  // Clickable 'Source: AGENCY: TITLE' (singular) or a 'Sources:' list (digest),
  // appended to the end of every summary so you know exactly what was summarized.
  function _renderSources(sources) {
    const list = _parseSources(sources).filter(s => s && s.link);
    if (!list.length) return '';
    // _safeUrl sanitizes on read: legacy rows may hold javascript:/data: links
    // (older writes didn't validate scheme), so gate every stored link here.
    const link = (s) => `<a href="${_attr(_safeUrl(s.link))}" target="_blank" rel="noopener noreferrer">` +
      `${esc(s.feed || '?')}: ${esc(s.title || 'article')}</a>`;
    if (list.length === 1) {
      return `<div class="mc-summary-source">Source: ${link(list[0])}</div>`;
    }
    return `<div class="mc-summary-source"><span class="mc-summary-source-label">Sources:</span>` +
      `<ul>${list.map(s => `<li>${link(s)}</li>`).join('')}</ul></div>`;
  }

  function _summaryStatusIcon(s) {
    if (s.status === 'running') return '<span class="mc-sum-ic mc-sum-run">⏳</span>';
    if (s.status === 'error') return '<span class="mc-sum-ic mc-sum-err">⚠</span>';
    // Green summary (sparkles) icon — matches the Summaries nav icon, tinted green.
    return '<span class="mc-sum-ic mc-sum-ok"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21l-.9-1.8-2.1-.9 2.1-.9z"/></svg></span>';
  }

  async function renderSummariesView() {
    _searchTerms = [];
    _setViewHeader(_searchQuery ? `Summaries: “${_searchQuery}”` : 'Summaries', '', '<span class="mc-feeds-title-emoji">🧠</span>');
    _setControlsBar(false);
    const body = $('feedsViewBody');
    if (!body) return;
    let list = [];
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries?limit=500', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      list = Array.isArray(d.summaries) ? d.summaries : [];
      if (_searchQuery) {
        const terms = _searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        list = list.filter(s => {
          const hay = String(s.title || '').toLowerCase();
          return terms.every(w => hay.includes(w));
        });
      }
      _summaryRunning = Number(d.running || 0);
    } catch (e) {
      body.innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
      return;
    }
    if (!list.length) {
      if (_searchQuery) {
        body.innerHTML = `<div class="mc-feeds-empty"><strong>No summaries match “${esc(_searchQuery)}”.</strong></div>`;
        return;
      }
      body.innerHTML = `<div class="mc-feeds-empty"><strong>No summaries yet.</strong><br>` +
        `Open the ⋯ menu on any article (or the header Summarize) and pick ✦ — ` +
        `the digest runs on the local model and lands here.</div>`;
      return;
    }
    // keep polling alive if anything is still running
    if (_summaryRunning > 0) _startSummaryPoll();
    const pages = Math.max(1, Math.ceil(list.length / _pageSizes.summaries));
    if (_sumPage > pages) _sumPage = pages;
    const scEl2 = document.getElementById('mcFeedSideCounts');
    if (scEl2) scEl2.textContent = `${list.length} summar${list.length === 1 ? 'y' : 'ies'}`;
    body.innerHTML =
      `<div class="mc-feed-view-sticky"><div class="mc-feed-meta-row"><span class="mc-feed-group-count">${list.length} summar${list.length === 1 ? 'y' : 'ies'}` +
        `${_summaryRunning > 0 ? ' · ' + _summaryRunning + ' running' : ''}</span>${_selectBtnHtml()}${_pageSizeSelect('summaries')}</div>${_selBarHtml()}</div>` +
      `<div class="mc-summary-list">` + _pageSlice(list, _sumPage, 'summaries').map(_renderSummaryRow).join('') + `</div>` +
      _pagerHtml(list.length, _sumPage, 'mcSumGoPage', 'summaries');
    // Swipe a summary left to delete it.
    _attachSwipe(body.querySelector('.mc-summary-list'), '.mc-summary-item', (id) => {
      if (id) mcDeleteSummary(Number(id));
    });
  }
  function _renderSummaryRow(s) {
    const when = fmtAgo(s.completed_at || s.created_at);
    // Only show the item count for real digests (>1). A single-article summary
    // is obviously 1 item, so drop it — keep just "Xago". The model moved out
    // of the row to the expanded action bar (next to Rerun/Copy).
    const countPart = s.entry_count > 1 ? `${s.entry_count} items · ` : '';
    const meta = `${countPart}${esc(when)} ago`;
    const running = s.status === 'running';
    return `
      <div class="mc-summary-item ${running ? 'is-running' : ''}${_selIds.has(s.id) ? ' is-selected' : ''}" data-summary-id="${s.id}" data-swipe-id="${s.id}">
        <div class="mc-summary-item-head" ${running ? '' : (_selMode ? `onclick="mcSelToggle(${s.id}, this)" role="button" tabindex="0"` : `onclick="mcToggleSummary(${s.id})" role="button" tabindex="0"`)}>
          ${_selCbHtml(s.id)}
          ${_summaryStatusIcon(s)}
          <span class="mc-summary-title">${esc(s.title)}</span>
          <span class="mc-summary-meta">${meta}</span>
        </div>
        <div class="mc-summary-body" id="mcSummaryBody-${s.id}" hidden></div>
      </div>`;
  }
  window.mcToggleSummary = async (id) => {
    const item = document.querySelector(`.mc-summary-item[data-summary-id="${id}"]`);
    const body = $(`mcSummaryBody-${id}`);
    if (!item || !body) return;
    const open = item.classList.toggle('is-open');
    body.hidden = !open;
    if (open && !body.dataset.loaded) {
      body.innerHTML = '<div class="mc-summary-loading">Loading…</div>';
      try {
        const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries?id=' + id, { credentials: 'same-origin' });
        const d = await r.json();
        const s = d.summary || {};
        body.dataset.raw = s.content || '';
        // Rerun uses the summary's own scope + target (parsed from storage).
        let rt = null; try { rt = s.target != null ? JSON.parse(s.target) : null; } catch (_) {}
        const rerunScope = s.scope || (s.entry_id ? 'entry' : 'all');
        const rerunTarget = s.entry_id || rt;
        body.innerHTML = s.status === 'error'
          ? `<div class="mc-feeds-error">Summary failed: ${esc(s.error || 'unknown')}</div>` + _summaryActionsBar(rerunScope, rerunTarget, s.model, id)
          : (_miniMarkdown(s.content || '') + _renderSources(s.sources) + _summaryActionsBar(rerunScope, rerunTarget, s.model, id));
        body.dataset.loaded = '1';
      } catch (e) {
        body.innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
      }
    }
  };
  window.mcDeleteSummary = async (id) => {
    try {
      await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries/' + id, { method: 'DELETE', credentials: 'same-origin' });
    } catch (_) { /* ignore */ }
    await refreshSidebar();
    if (_summaryView) renderSummariesView();
    _decorateSummarizedCards(true);
  };

  // Inline-on-card: add a "▸ Summary ✓" expander to any rendered article card
  // whose entry has a finished single-article summary. Called after a job
  // finishes (and cards are also born with it via _renderEntryCard).
  function _decorateSummarizedCards(removeStale) {
    // Feed cards: expander appended to the card. Clicked rows: appended inside
    // .mc-read-main so it sits under the title. Both get the indicator so you
    // can see at a glance an article was already summarized.
    document.querySelectorAll('.mc-feed-entry[data-entry-id]').forEach(card => {
      const id = Number(card.getAttribute('data-entry-id'));
      const has = _summarizedIds.has(id);
      const existing = card.querySelector('.mc-entry-summary');
      if (has && !existing) card.insertAdjacentHTML('beforeend', _entrySummaryExpander(id));
      else if (!has && existing && removeStale) existing.remove();
    });
    document.querySelectorAll('.mc-read-row .mc-feed-entry-actions[data-entry-id]').forEach(wrap => {
      const id = Number(wrap.getAttribute('data-entry-id'));
      const row = wrap.closest('.mc-read-row');
      const main = row && row.querySelector('.mc-read-main');
      const meta = row && row.querySelector('.mc-read-meta');
      if (!main || !meta) return;
      const has = _summarizedIds.has(id);
      const toggleEl = meta.querySelector('.mc-entry-summary-compact');
      const bodyEl = main.querySelector('.mc-entry-summary-body');
      if (has) {
        if (!toggleEl) meta.insertAdjacentHTML('afterbegin', _entrySummaryToggle(id));
        if (!bodyEl) main.insertAdjacentHTML('beforeend', _entrySummaryBodyEl(id));
      } else if (removeStale) {
        if (toggleEl) toggleEl.remove();
        if (bodyEl) bodyEl.remove();
      }
    });
    // If a re-run just finished, refresh any open inline expander in place.
    document.querySelectorAll('.mc-entry-summary.is-open').forEach(w => {
      const id = Number(w.getAttribute('data-entry-id'));
      const body = $(`mcEntrySum-${id}`);
      if (body) { body.dataset.loaded = ''; _loadEntrySummary(id); }
    });
  }
  function _entrySummaryExpander(id) {
    return `<div class="mc-entry-summary" data-entry-id="${id}">` +
      `<button type="button" class="mc-entry-summary-toggle" onclick="event.stopPropagation(); mcToggleEntrySummary(${id})">` +
        `<span class="mc-entry-summary-caret">▸</span> Summary <span class="mc-sum-ok">✓</span></button>` +
      `<div class="mc-entry-summary-body" id="mcEntrySum-${id}" hidden></div></div>`;
  }
  // Compact split for the Clicked list: the toggle rides inline on the meta
  // line (Summary · Agency · date); the body is a separate full-width element
  // placed below. mcToggleEntrySummary finds the body by id, so the split is
  // transparent to it.
  function _entrySummaryToggle(id) {
    return `<span class="mc-entry-summary mc-entry-summary-compact" data-entry-id="${id}">` +
      `<button type="button" class="mc-entry-summary-toggle" onclick="event.stopPropagation(); mcToggleEntrySummary(${id})">` +
        `<span class="mc-entry-summary-caret">▸</span> Summary <span class="mc-sum-ok">✓</span></button></span>`;
  }
  function _entrySummaryBodyEl(id) {
    return `<div class="mc-entry-summary-body" id="mcEntrySum-${id}" hidden></div>`;
  }
  window.mcToggleEntrySummary = async (id) => {
    const wrap = document.querySelector(`.mc-entry-summary[data-entry-id="${id}"]`);
    const body = $(`mcEntrySum-${id}`);
    if (!wrap || !body) return;
    const open = wrap.classList.toggle('is-open');
    body.hidden = !open;
    if (open && !body.dataset.loaded) await _loadEntrySummary(id);
  };
  async function _loadEntrySummary(id) {
    const body = $(`mcEntrySum-${id}`);
    if (!body) return;
    body.innerHTML = '<div class="mc-summary-loading">Loading…</div>';
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summaries?entry_id=' + id, { credentials: 'same-origin' });
      const d = await r.json();
      const s = d.summary;
      if (s && s.status === 'running') {
        body.innerHTML = '<div class="mc-summary-loading">Summarizing…</div>';
        body.dataset.loaded = '';   // let the poll reload it when done
        return;
      }
      body.dataset.raw = (s && s.content) || '';
      const main = (s && s.content) ? (_miniMarkdown(s.content) + _renderSources(s.sources))
        : (s && s.error ? `<div class="mc-feeds-error">${esc(s.error)}</div>` : '<em>No summary.</em>');
      body.innerHTML = main + _summaryActionsBar('entry', id, s && s.model);
      body.dataset.loaded = '1';
    } catch (e) {
      body.innerHTML = `<div class="mc-feeds-error">${esc(e.message)}</div>`;
    }
  }

  // Rerun + Copy controls at the bottom-left of a summary. rerunScope/rerunTarget
  // drive the re-run; Copy reads the raw markdown stashed on the body element.
  function _summaryActionsBar(rerunScope, rerunTarget, model, delId) {
    const targetAttr = _attr(JSON.stringify(rerunTarget == null ? null : rerunTarget));
    const modelBadge = model ? `<span class="mc-summary-model">${esc(model)}</span>` : '';
    // Delete is pushed to the far right of the action bar (margin-left:auto).
    const delBtn = (delId != null)
      ? `<button type="button" class="mc-summary-actbtn mc-summary-actbtn-del" title="Delete summary" onclick="event.stopPropagation(); mcDeleteSummary(${delId})">🗑 Delete</button>`
      : '';
    return `<div class="mc-summary-actbar">` +
      `<button type="button" class="mc-summary-actbtn" title="Re-run this summary (replaces it)" ` +
        `onclick="event.stopPropagation(); mcRerunSummary('${esc(rerunScope)}', ${targetAttr}, this)">↻ Rerun</button>` +
      `<button type="button" class="mc-summary-actbtn" title="Copy summary text" ` +
        `onclick="event.stopPropagation(); mcCopySummaryFrom(this)">⧉ Copy</button>` +
      modelBadge + delBtn +
    `</div>`;
  }
  window.mcCopySummaryFrom = async (btn) => {
    const body = btn.closest('.mc-entry-summary-body, .mc-summary-body');
    const raw = body ? (body.dataset.raw || body.innerText || '') : '';
    const ok = await _copyToClipboard(raw);
    const orig = btn.innerHTML;
    btn.innerHTML = ok ? '✓ Copied' : '✗ Failed';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  };
  window.mcRerunSummary = async (scope, target, btn) => {
    if (btn) { btn.disabled = true; btn.innerHTML = '↻ Rerunning…'; }
    try {
      const r = await fetch('/api/extensions/rss-feeds/sidecar/api/feeds/summarize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, target }), credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(((await r.json()).error) || ('HTTP ' + r.status));
      _summaryToast('Re-running summary…');
      // Show the in-flight state on any open expander for this entry now.
      if (scope === 'entry') {
        const body = $(`mcEntrySum-${target}`);
        if (body) { body.dataset.loaded = ''; body.innerHTML = '<div class="mc-summary-loading">Summarizing…</div>'; }
      }
      await refreshSidebar();
      _startSummaryPoll();
      if (_summaryView) renderSummariesView();
    } catch (e) {
      _summaryToast('Rerun failed: ' + e.message, true);
      if (btn) { btn.disabled = false; btn.innerHTML = '↻ Rerun'; }
    }
  };
  window.mcSummarizeEntry = (id) => _summarize('entry', id);

  // ── Per-card actions cluster (⋯ → Summarize / Share) ──────────────────────
  // The "⋯" toggle expands an inline row holding the Summarize (✦) and Share
  // (⤴) icons. Only one card's row is open at a time; a document click-away
  // closes it (mirrors the summarize-popup pattern).
  window.mcCloseEntryActions = () => {
    document.querySelectorAll('.mc-feed-entry-actions.is-open')
      .forEach(w => w.classList.remove('is-open'));
    document.removeEventListener('click', _closeEntryActionsOnce);
  };
  function _closeEntryActionsOnce(e) {
    if (e && e.target && e.target.closest('.mc-feed-entry-actions')) return;
    window.mcCloseEntryActions();
  }
  window.mcToggleEntryActions = (id) => {
    const wrap = document.querySelector(`.mc-feed-entry-actions[data-entry-id="${id}"]`);
    if (!wrap) return;
    const willOpen = !wrap.classList.contains('is-open');
    // Close any other open cluster first.
    document.querySelectorAll('.mc-feed-entry-actions.is-open')
      .forEach(w => { if (w !== wrap) w.classList.remove('is-open'); });
    wrap.classList.toggle('is-open', willOpen);
    if (willOpen) {
      setTimeout(() => document.addEventListener('click', _closeEntryActionsOnce), 0);
    } else {
      document.removeEventListener('click', _closeEntryActionsOnce);
    }
  };

  // Share the ARTICLE'S OWN link (never the WebUI URL). On Apple devices the
  // native Web Share sheet covers AirDrop / Messages / WhatsApp / Messenger;
  // elsewhere we fall back to a small menu of share targets + copy.
  function _entryShareData(id) {
    // The actions cluster carries link+title on data-* attrs, so this works
    // for both feed cards and the compact Clicked-history rows.
    const wrap = document.querySelector(`.mc-feed-entry-actions[data-entry-id="${id}"]`);
    if (!wrap) return null;
    const url = wrap.dataset.link || '';
    const title = (wrap.dataset.title || '').trim();
    return url ? { url, title } : null;
  }
  window.mcShareEntry = async (id) => {
    const data = _entryShareData(id);
    if (!data) return;
    mcMarkEntryRead(id);
    window.mcCloseEntryActions();
    if (navigator.share) {
      try {
        await navigator.share({ title: data.title || 'Article', url: data.url });
        return;
      } catch (err) {
        // User dismissed the sheet — done, no fallback.
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        // Anything else (API present but failed): drop to the web fallback.
      }
    }
    _openShareFallback(data.url, data.title);
  };

  async function _copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }
  window.mcCopyShareLink = async (btn) => {
    const url = btn && btn.getAttribute('data-url');
    if (!url) return;
    const ok = await _copyToClipboard(url);
    btn.textContent = ok ? '✓ Link copied' : 'Copy failed — select & ⌘C';
    if (!ok) { btn.title = url; }
  };
  function _openShareFallback(url, title) {
    const U = encodeURIComponent(url);
    const T = encodeURIComponent(title || '');
    const TU = encodeURIComponent(((title ? title + ' ' : '') + url));
    // Targets that work via plain web intents (no app-id needed).
    const targets = [
      ['WhatsApp',  `https://wa.me/?text=${TU}`,                       '🟢'],
      ['Messenger', `https://www.facebook.com/dialog/send?link=${U}&redirect_uri=${U}`, '💬'],
      ['Telegram',  `https://t.me/share/url?url=${U}&text=${T}`,        '✈️'],
      ['X / Twitter', `https://twitter.com/intent/tweet?url=${U}&text=${T}`, '𝕏'],
      ['Facebook',  `https://www.facebook.com/sharer/sharer.php?u=${U}`, '🔵'],
      ['Email',     `mailto:?subject=${T}&body=${TU}`,                  '✉️'],
    ];
    const links = targets.map(([name, href, ico]) =>
      `<a class="mc-share-target" href="${_attr(_safeUrl(href))}" target="_blank" rel="noopener noreferrer" onclick="mcFeedsCloseModal()">` +
        `<span class="mc-share-ico" aria-hidden="true">${ico}</span><span>${esc(name)}</span></a>`
    ).join('');
    const body =
      `<div class="mc-share-grid">${links}</div>` +
      `<div class="mc-share-copy-row">` +
        `<input type="text" class="mc-share-url" readonly value="${esc(url)}" onclick="this.select()">` +
        `<button type="button" class="mc-btn-sm mc-btn-sm-primary mc-share-copy-btn" data-url="${esc(url)}" onclick="mcCopyShareLink(this)">Copy link</button>` +
      `</div>`;
    _openModal('Share article', body);
  }
  window.mcSummarizeCurrent = () => {
    if (_activeFeedId !== null) return _summarize('feed', _activeFeedId);
    if (_activeCategory) return _summarize('category', _activeCategory);
    return _summarize('all');
  };

  // ── Summarize popup: pick which feeds to summarize ────────────────────────
  // Filter-aware on the server: when the keyword filter is ON, only matching
  // entries of the selected feeds are summarized; OFF = all their entries.
  function _closeSummarizePopupOnce(e) {
    const p = document.getElementById('mcSummarizePopup');
    if (p && !e.target.closest('#mcSummarizePopup') && !e.target.closest('#feedsSummarizeBtn')) mcCloseSummarizePopup();
  }
  window.mcCloseSummarizePopup = () => {
    const p = document.getElementById('mcSummarizePopup');
    if (p) p.remove();
    document.removeEventListener('click', _closeSummarizePopupOnce);
  };
  window.mcRunSummarizeSelected = () => {
    const ids = Array.from(document.querySelectorAll('#mcSummarizePopup .mc-sum-feed:checked'))
      .map(c => parseInt(c.value, 10)).filter(Number.isFinite);
    mcCloseSummarizePopup();
    if (!ids.length) { alert('Select at least one feed to summarize.'); return; }
    _summarize('feeds', ids);
  };
  window.mcOpenSummarizePopup = (e) => {
    if (e) e.stopPropagation();
    if (typeof mcCloseFeedSettings === 'function') mcCloseFeedSettings();   // never both open
    if (document.getElementById('mcSummarizePopup')) return mcCloseSummarizePopup();  // toggle
    const feeds = (_feeds || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!feeds.length) { alert('No feeds to summarize.'); return; }
    const filterOn = !!_settings.filter_enabled;
    const pop = document.createElement('div');
    pop.id = 'mcSummarizePopup';
    pop.className = 'mc-summarize-popup';
    pop.innerHTML =
      `<div class="mc-summarize-popup-head"><span>Summarize feeds</span>` +
        `<label class="mc-summarize-all"><input type="checkbox" id="mcSumSelectAll" checked> All</label></div>` +
      (filterOn ? `<div class="mc-summarize-note">Filter ON — only entries matching your keywords will be summarized.</div>` : '') +
      `<div class="mc-summarize-list">` +
        _renderCatGroupedList(feeds, 'mc-sum-feed', () => true) +
      `</div>` +
      `<div class="mc-summarize-actions">` +
        `<button type="button" class="mc-btn-sm" onclick="mcCloseSummarizePopup()">Cancel</button>` +
        `<button type="button" class="mc-btn-sm mc-btn-sm-primary" onclick="mcRunSummarizeSelected()">Summarize selected</button></div>`;
    document.body.appendChild(pop);
    _placeFeedsPopup(pop, (e && e.target && e.target.closest('button')) || $('feedsSummarizeBtn'));
    const all = document.getElementById('mcSumSelectAll');
    if (all) all.addEventListener('change', () => _setAllCats(pop, 'mc-sum-feed', all.checked));
    _wireCatGroupedList(pop, 'mc-sum-feed');
    setTimeout(() => document.addEventListener('click', _closeSummarizePopupOnce), 0);
  };

  // ── Jump-to-top/bottom arrows for the feeds reading pane ───────────────────
  // The pane gets long once feeds are expanded ("Expand all"); these jump to the
  // top/bottom. Shown only when the pane is actually scrollable; each arrow dims
  // when already at that end. Wired via observers so every render path, the
  // expand/collapse toggles, and resizes all keep the state in sync.
  function _feedsBody() { return document.getElementById('feedsViewBody'); }
  window.mcFeedsScrollTop = () => { const b = _feedsBody(); if (b) b.scrollTo({ top: 0, behavior: 'smooth' }); };
  window.mcFeedsScrollBottom = () => { const b = _feedsBody(); if (b) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); };
  function _updateFeedsScrollNav() {
    const b = _feedsBody();
    const top = document.getElementById('feedsScrollTopBtn');
    const bot = document.getElementById('feedsScrollBottomBtn');
    if (!b || !top || !bot) return;
    const scrollable = b.scrollHeight - b.clientHeight > 40;
    top.style.display = scrollable ? 'flex' : 'none';
    bot.style.display = scrollable ? 'flex' : 'none';
    if (scrollable) {
      top.classList.toggle('is-disabled', b.scrollTop <= 4);
      bot.classList.toggle('is-disabled', b.scrollHeight - b.scrollTop - b.clientHeight <= 4);
    }
  }
  function _initFeedsScrollNav() {
    const b = _feedsBody();
    if (!b || b._scrollNavInit) return;
    b._scrollNavInit = true;
    b.addEventListener('scroll', _updateFeedsScrollNav, { passive: true });
    if ('MutationObserver' in window) {
      new MutationObserver(() => requestAnimationFrame(_updateFeedsScrollNav))
        .observe(b, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    if ('ResizeObserver' in window) new ResizeObserver(_updateFeedsScrollNav).observe(b);
    _updateFeedsScrollNav();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initFeedsScrollNav);
  else _initFeedsScrollNav();
})();
