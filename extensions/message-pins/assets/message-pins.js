(() => {
  'use strict';

  // ── Message Pins extension for Hermes WebUI ──────────────────────────────
  // Trusted local static-UI extension. Pins individual messages within a
  // conversation, persisting the pin set client-side (localStorage) per
  // session. No backend, no network, no core API calls.
  //
  // Design reference: closed core PR #2534 by @Michaelyklam (per-message pin
  // button, header popover with badge, click-to-jump, 3-pin cap). That PR
  // persisted server-side via a new core endpoint; this extension persists in
  // the browser instead, so it needs no core changes.

  const EXT = 'message-pins';
  if (window.__hermesMessagePinsLoaded) return;
  window.__hermesMessagePinsLoaded = true;

  const STORAGE_KEY = 'hermes-ext-message-pins';
  const MAX_PINS = 3;
  const PREVIEW_LEN = 120;
  const PIN_FLAG = 'hwxPinned';          // dataset flag on a decorated row
  const BTN_FLAG = 'hwxPinWired';        // dataset flag on a wired button

  let observer = null;
  let popover = null;
  let toastTimer = null;
  let lastSessionId = null;

  // ── small DOM helpers ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Resolve the active session id without relying on the page's module-scoped
  // `S` global (not exposed to extensions). Rendered message turns carry a
  // `data-session-id`; the route is also `/session/<id>`. Prefer the DOM
  // (path-base agnostic), fall back to the URL.
  function currentSessionId() {
    const tagged = document.querySelector('#messages [data-session-id]');
    if (tagged && tagged.dataset.sessionId) return tagged.dataset.sessionId;
    const m = location.pathname.match(/\/session\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── persistence ──────────────────────────────────────────────────────────
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) { return {}; }
  }

  function saveAll(all) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
    catch (_) { /* quota / disabled storage — degrade silently */ }
  }

  // Pins for the active session: array of { idx:number, preview:string }.
  function loadPins() {
    const sid = currentSessionId();
    if (!sid) return [];
    const entry = loadAll()[sid];
    return Array.isArray(entry) ? entry.filter((p) => p && Number.isFinite(p.idx)) : [];
  }

  function savePins(pins) {
    const sid = currentSessionId();
    if (!sid) return;
    const all = loadAll();
    if (pins.length) all[sid] = pins;
    else delete all[sid];
    saveAll(all);
  }

  function isPinned(idx, pins) { return pins.some((p) => p.idx === idx); }

  // ── toast (self-owned, does not touch core toast state) ──────────────────
  function toast(message) {
    let el = $('hwxMessagePinsToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hwxMessagePinsToast';
      el.className = 'hwx-pin-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('hwx-pin-toast--show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('hwx-pin-toast--show'), 3200);
  }

  // ── message-row inspection ───────────────────────────────────────────────
  function rowIdx(row) {
    const v = parseInt(row.getAttribute('data-msg-idx'), 10);
    return Number.isFinite(v) ? v : null;
  }

  function rowPreview(row) {
    const raw = row.getAttribute('data-raw-text');
    let text = raw && raw.trim();
    if (!text) {
      const body = row.querySelector('.msg-body');
      text = body ? body.textContent : '';
    }
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (!text) text = 'Message #' + (rowIdx(row) != null ? rowIdx(row) : '?');
    return text.length > PREVIEW_LEN ? text.slice(0, PREVIEW_LEN - 1) + '\u2026' : text;
  }

  // Find the canonical row element for a given msg-idx that is actually
  // visible (assistant turns can render multiple segment nodes, some hidden).
  function findRow(idx) {
    const container = $('messages');
    if (!container) return null;
    const all = container.querySelectorAll('[data-msg-idx="' + idx + '"]');
    for (const el of all) {
      if (el.getClientRects && el.getClientRects().length > 0) return el;
    }
    return all.length ? all[0] : null;
  }

  // ── pin / unpin ──────────────────────────────────────────────────────────
  function togglePin(idx, row) {
    let pins = loadPins();
    if (isPinned(idx, pins)) {
      pins = pins.filter((p) => p.idx !== idx);
      savePins(pins);
      toast('Message unpinned');
    } else {
      if (pins.length >= MAX_PINS) {
        toast('You can pin up to ' + MAX_PINS + ' messages. Unpin one first.');
        return;
      }
      pins.push({ idx: idx, preview: rowPreview(row) });
      pins.sort((a, b) => a.idx - b.idx);
      savePins(pins);
      toast('Message pinned');
    }
    redecorate();
    refreshHeader();
    if (popover) renderPopover();
  }

  function jumpTo(idx) {
    closePopover();
    const row = findRow(idx);
    if (row && row.getClientRects && row.getClientRects().length > 0) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('hwx-pin-flash');
      setTimeout(() => row.classList.remove('hwx-pin-flash'), 1400);
      return;
    }
    // Long transcripts virtualize rows out of the DOM; an off-window pin can't
    // be scrolled to without core's virtual-scroll internals. Tell the user
    // plainly rather than silently no-op.
    toast('That message is outside the loaded part of the transcript. Scroll up to load it, then try again.');
  }

  // ── per-row decoration ───────────────────────────────────────────────────
  function pinButtonSvg(filled) {
    // Inline SVG pin icon (created as a static string; no user data).
    const fill = filled ? 'currentColor' : 'none';
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="' + fill +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  }

  function makePinButton(idx, pinned) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action-btn hwx-pin-btn' + (pinned ? ' hwx-pin-btn--active' : '');
    btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    btn.title = pinned ? 'Unpin message' : 'Pin message';
    btn.setAttribute('aria-label', pinned ? 'Unpin message' : 'Pin message');
    btn.innerHTML = pinButtonSvg(pinned);
    btn.dataset[BTN_FLAG] = '1';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      togglePin(idx, btn.closest('[data-msg-idx]') || findRow(idx));
    });
    return btn;
  }

  function decorateRow(row, pins) {
    const idx = rowIdx(row);
    if (idx == null) return;
    const pinned = isPinned(idx, pins);
    row.dataset[PIN_FLAG] = pinned ? '1' : '0';
    row.classList.toggle('hwx-pinned-row', pinned);

    let btn = row.querySelector(':scope .hwx-pin-btn');
    if (!btn) {
      // Prefer the existing hover action bar; fall back to a floating button.
      const actions = row.querySelector(':scope .msg-foot .msg-actions') ||
                      row.querySelector(':scope .msg-actions');
      btn = makePinButton(idx, pinned);
      if (actions) {
        btn.classList.add('hwx-pin-btn--inline');
        actions.appendChild(btn);
      } else {
        btn.classList.add('hwx-pin-btn--float');
        if (getComputedStyle(row).position === 'static') row.classList.add('hwx-pin-host');
        row.appendChild(btn);
      }
    } else {
      // Update existing button state in place.
      btn.classList.toggle('hwx-pin-btn--active', pinned);
      btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      btn.title = pinned ? 'Unpin message' : 'Pin message';
      btn.setAttribute('aria-label', pinned ? 'Unpin message' : 'Pin message');
      btn.innerHTML = pinButtonSvg(pinned);
    }
  }

  // A [data-msg-idx] node is only a REAL, decoratable message row if it is
  // actually visible and carries renderable content. Core also tags hidden
  // anchor/worklog segments with data-msg-idx (assistant-segment-anchor /
  // assistant-segment-worklog-source are display:none) — decorating those
  // created floating/hidden pin buttons on non-message nodes (Frank, PR #19).
  function isRealMessageRow(row) {
    if (!row || !row.classList) return false;
    if (row.classList.contains('assistant-segment-anchor') ||
        row.classList.contains('assistant-segment-worklog-source')) return false;
    // must have a real content/action surface
    const hasContent = row.querySelector(':scope .msg-body') ||
                       row.querySelector(':scope .msg-foot .msg-actions') ||
                       row.querySelector(':scope .msg-actions');
    if (!hasContent) return false;
    // must be visibly laid out (skips display:none anchors + collapsed nodes)
    const rect = row.getBoundingClientRect();
    if (rect.height <= 1) return false;
    return true;
  }

  function redecorate() {
    const container = $('messages');
    if (!container) return;
    const pins = loadPins();
    const seen = new Set();
    container.querySelectorAll('[data-msg-idx]').forEach((row) => {
      if (!isRealMessageRow(row)) return;       // skip hidden anchor/worklog segments
      const idx = rowIdx(row);
      if (idx == null || seen.has(idx)) return; // decorate first real node per idx
      seen.add(idx);
      decorateRow(row, pins);
    });
  }

  // ── header button + popover ──────────────────────────────────────────────
  function ensureHeaderButton() {
    let btn = $('hwxMessagePinsHeaderBtn');
    if (btn) return btn;
    const shell = document.querySelector('.messages-shell');
    if (!shell) return null;
    btn = document.createElement('button');
    btn.id = 'hwxMessagePinsHeaderBtn';
    btn.type = 'button';
    btn.className = 'hwx-pin-header-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Pinned messages';
    btn.setAttribute('aria-label', 'Pinned messages');
    btn.innerHTML = pinButtonSvg(true) + '<span class="hwx-pin-badge" hidden>0</span>';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      togglePopover(btn);
    });
    shell.appendChild(btn);
    positionHeaderButton(btn);
    return btn;
  }

  // Reserve a non-overlapping slot. Core's #jumpToSessionStartBtn
  // (.session-jump-btn--start) sits at top:16px; right:20px; height:32px in the
  // same .messages-shell and only appears in long, session-nav-enabled
  // conversations. When it's visible, place the pins button to its LEFT
  // (computed from its width); otherwise use the default top-right slot.
  // (Frank, PR #19: the two controls collided in the top-right corner.)
  function positionHeaderButton(btn) {
    btn = btn || $('hwxMessagePinsHeaderBtn');
    if (!btn) return;
    const GAP = 8;
    const DEFAULT_RIGHT = 20;   // align to core's right:20px
    const startBtn = document.getElementById('jumpToSessionStartBtn');
    let right = DEFAULT_RIGHT;
    const startVisible = startBtn &&
      getComputedStyle(startBtn).display !== 'none' &&
      startBtn.getBoundingClientRect().width > 0;
    if (startVisible) {
      // sit to the left of the Start button: its width + the gap + its own right offset
      right = DEFAULT_RIGHT + startBtn.getBoundingClientRect().width + GAP;
    }
    btn.style.right = right + 'px';
    btn.style.top = '16px';      // match core's vertical slot
  }

  function refreshHeader() {
    const btn = ensureHeaderButton();
    if (!btn) return;
    const pins = loadPins();
    const badge = btn.querySelector('.hwx-pin-badge');
    if (badge) {
      badge.textContent = String(pins.length);
      badge.hidden = pins.length === 0;
    }
    btn.classList.toggle('hwx-pin-header-btn--has-pins', pins.length > 0);
    positionHeaderButton(btn);   // recompute slot (session-nav / Start btn may have toggled)
  }

  function togglePopover(anchor) {
    if (popover) { closePopover(); return; }
    openPopover(anchor);
  }

  function openPopover(anchor) {
    const btn = anchor || $('hwxMessagePinsHeaderBtn');
    if (!btn) return;
    popover = document.createElement('div');
    popover.className = 'hwx-pin-popover';
    popover.setAttribute('role', 'menu');
    popover.setAttribute('aria-label', 'Pinned messages');
    document.body.appendChild(popover);
    renderPopover();
    positionPopover(btn);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('keydown', escClose, true);
    window.addEventListener('resize', closePopover);
    window.addEventListener('scroll', closePopover, true);
  }

  function renderPopover() {
    if (!popover) return;
    const pins = loadPins();
    popover.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'hwx-pin-popover-head';
    head.textContent = pins.length ? 'Pinned messages (' + pins.length + ')' : 'Pinned messages';
    popover.appendChild(head);

    if (!pins.length) {
      const empty = document.createElement('div');
      empty.className = 'hwx-pin-popover-empty';
      empty.textContent = 'No pinned messages yet. Hover a message and click the pin icon.';
      popover.appendChild(empty);
      return;
    }

    pins.forEach((p) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'hwx-pin-item';
      item.setAttribute('role', 'menuitem');

      const text = document.createElement('span');
      text.className = 'hwx-pin-item-text';
      text.textContent = p.preview || ('Message #' + p.idx);
      item.appendChild(text);

      const remove = document.createElement('span');
      remove.className = 'hwx-pin-item-remove';
      remove.title = 'Unpin';
      remove.setAttribute('aria-label', 'Unpin this message');
      remove.innerHTML = '\u00d7';
      item.appendChild(remove);

      item.addEventListener('click', (ev) => {
        if (ev.target === remove || remove.contains(ev.target)) {
          ev.preventDefault();
          ev.stopPropagation();
          togglePin(p.idx, findRow(p.idx));
          return;
        }
        jumpTo(p.idx);
      });
      popover.appendChild(item);
    });
  }

  function positionPopover(btn) {
    if (!popover) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, Math.max(240, popover.offsetWidth || 280));
    let left = r.right - w;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    popover.style.width = w + 'px';
    popover.style.left = left + 'px';
    let top = r.bottom + 8;
    const h = popover.offsetHeight || 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    popover.style.top = top + 'px';
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    const btn = $('hwxMessagePinsHeaderBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsidePointer, true);
    document.removeEventListener('keydown', escClose, true);
    window.removeEventListener('resize', closePopover);
    window.removeEventListener('scroll', closePopover, true);
  }

  function outsidePointer(ev) {
    const btn = $('hwxMessagePinsHeaderBtn');
    if (popover && popover.contains(ev.target)) return;
    if (btn && btn.contains(ev.target)) return;
    closePopover();
  }

  function escClose(ev) {
    if (ev.key !== 'Escape') return;
    closePopover();
    const btn = $('hwxMessagePinsHeaderBtn');
    if (btn && typeof btn.focus === 'function') btn.focus();
  }

  // ── re-render handling ───────────────────────────────────────────────────
  // renderMessages() wipes #msgInner innerHTML on every rebuild, so injected
  // buttons and decorations are lost. A MutationObserver re-applies them after
  // each rebuild. We also detect a session switch (the data-session-id flips)
  // and refresh the header badge for the new session's pin set.
  function onMutations() {
    const sid = currentSessionId();
    if (sid !== lastSessionId) {
      lastSessionId = sid;
      closePopover();
    }
    redecorate();
    refreshHeader();
  }

  let rafScheduled = false;
  function scheduleSync() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      try { onMutations(); } catch (_) {}
    });
  }

  function startObserver() {
    const container = $('messages');
    if (!container || observer) return !!observer;
    observer = new MutationObserver(scheduleSync);
    observer.observe(container, { childList: true, subtree: true });
    // The core Start button (#jumpToSessionStartBtn) toggles its display on
    // scroll in long, session-nav-enabled conversations — that does NOT cause a
    // #messages childList mutation, so observe its attribute flips directly and
    // reposition the pins header button so the two never overlap (Frank, PR #19).
    const startBtn = document.getElementById('jumpToSessionStartBtn');
    if (startBtn && !startBtn.dataset.hwxPinObserved) {
      startBtn.dataset.hwxPinObserved = '1';
      const so = new MutationObserver(() => positionHeaderButton());
      so.observe(startBtn, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    // Also reposition on scroll within the shell (cheap, rAF-throttled).
    const shell = document.querySelector('.messages-shell');
    if (shell && !shell.dataset.hwxPinScroll) {
      shell.dataset.hwxPinScroll = '1';
      let posRaf = false;
      const onScroll = () => {
        if (posRaf) return;
        posRaf = true;
        requestAnimationFrame(() => { posRaf = false; positionHeaderButton(); });
      };
      shell.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }
    return true;
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function install(attempt) {
    attempt = attempt || 0;
    const container = $('messages');
    const shell = document.querySelector('.messages-shell');
    if (container && shell) {
      lastSessionId = currentSessionId();
      startObserver();
      ensureHeaderButton();
      refreshHeader();
      redecorate();
      window.HermesMessagePinsExtension = {
        version: '0.1.0',
        refresh: () => { redecorate(); refreshHeader(); },
        pinsForCurrentSession: loadPins,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] messages container not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
