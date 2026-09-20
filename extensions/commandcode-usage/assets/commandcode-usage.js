(() => {
  'use strict';

  // ── Command Code Usage extension for Hermes WebUI ─────────────────────────
  // Adds a quiet status button to the composer footer, right after the model chip
  // (.composer-model-wrap, beside #providerQuotaChip), that opens a panel with
  // the Command Code account usage: the account's own live five-hour and weekly
  // spend windows (used / cap + reset times), the monthly credit balance, and
  // the current billing period's totals, straight from the sidecar, which calls
  // Command Code's alpha billing endpoints. Once data arrives the chip itself
  // shows the two window percentages ("CmdCode: x%·y%").
  // Hovering the chip opens the panel; it stays pinned (fixed size, not closed
  // on mouse-out) until dismissed by Escape / an outside click / clicking the
  // chip again. The chip is a real <button> (focusable; Enter/Space opens the
  // panel) and keeps aria-expanded in sync, so keyboard users get the same panel.
  //
  // All HTTP goes through the consented loopback-sidecar proxy at
  // /api/extensions/commandcode-usage/sidecar/… — the API key stays in the
  // sidecar process and never reaches the browser. This file makes no other
  // network call and contacts no external origin.

  const EXT = 'commandcode-usage';
  if (window.__hermesCommandCodeUsageLoaded) return;
  window.__hermesCommandCodeUsageLoaded = true;

  const BASE = '/api/extensions/' + EXT + '/sidecar';
  const STATUS_URL = '/api/extensions/status';
  const FALLBACK_KEY = 'hermes-ext-commandcode-usage';
  const DEFAULTS = { auto_refresh: true, refresh_seconds: 60 };
  const WINDOW_LABELS = { five_hour: '5-hour usage', weekly: 'Weekly usage' };
  const PERCENT_ORDER = ['five_hour', 'weekly'];
  const BUTTON_LABEL = 'CommandCode';
  const MOUNT_RETRY_MS = 400;
  const MOUNT_MAX_TRIES = 25;
  const HOVER_OPEN_DELAY = 160;

  let panel = null;
  let button = null;
  let lastFocus = null;
  let timer = null;
  let outsideHandler = null;
  let keyHandler = null;
  let composerObserver = null;
  let hoverOpenTimer = null;
  let lastPayload = null;
  let fixedPanelHeight = null;
  let busy = false;

  // ── extension settings (sanctioned accessors, with a localStorage fallback) ─

  function settingsHandle() {
    try {
      const api = window.HermesExtensionSettings;
      if (!api || typeof api.settingsForExtension !== 'function') return null;
      const handle = api.settingsForExtension(EXT);
      if (!handle || handle.supported === false) return null;
      return handle;
    } catch (_) { return null; }
  }

  function readFallback() {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function writeFallback(patch) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(Object.assign(readFallback(), patch)));
    } catch (_) { /* storage disabled: settings simply do not persist */ }
  }

  function getSetting(key) {
    const handle = settingsHandle();
    if (handle) {
      try {
        const value = handle.get(key);
        if (value !== undefined && value !== null) return value;
      } catch (_) { /* fall through to the fallback store */ }
    }
    const stored = readFallback();
    return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : DEFAULTS[key];
  }

  function setSetting(key, value) {
    const handle = settingsHandle();
    if (handle) {
      try { handle.set(key, value); return; } catch (_) { /* fall through */ }
    }
    writeFallback({ [key]: value });
  }

  function refreshSeconds() {
    const raw = Number(getSetting('refresh_seconds'));
    if (!Number.isFinite(raw)) return DEFAULTS.refresh_seconds;
    return Math.min(3600, Math.max(15, Math.round(raw)));
  }

  function autoRefreshEnabled() {
    return getSetting('auto_refresh') !== false;
  }

  // ── formatting helpers ─────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtClock(epochSeconds) {
    const n = Number(epochSeconds);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // "resets in 3 h 12 min" — the raw value is an ISO timestamp from the sidecar.
  function fmtResetIn(iso) {
    if (!iso) return '';
    const when = Date.parse(iso);
    if (!Number.isFinite(when)) return '';
    const delta = Math.max(0, when - Date.now());
    const minutes = Math.floor(delta / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return 'Resets in ' + days + ' d ' + hours + ' h';
    if (hours > 0) return 'Resets in ' + hours + ' h ' + mins + ' min';
    return 'Resets in ' + mins + ' min';
  }

  // "Oct 20" — used for the plan's renewal date.
  function fmtDate(iso) {
    if (!iso) return '';
    const when = Date.parse(iso);
    if (!Number.isFinite(when)) return '';
    const d = new Date(when);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }

  function fmtMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }

  // Show a decimal only when the API actually returns a fraction (7.4 → "7.4%").
  function fmtPercent(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? n + '%' : n.toFixed(1) + '%';
  }

  function pctClass(window) {
    if (window && window.exceeded) return ' hwx-ccu-bar-fill--err';
    const n = Number(window && window.percent);
    if (!Number.isFinite(n)) return '';
    if (n >= 90) return ' hwx-ccu-bar-fill--err';
    if (n >= 70) return ' hwx-ccu-bar-fill--warn';
    return '';
  }

  // ── usage fetch + diagnostics ──────────────────────────────────────────────

  async function fetchJSON(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, ok: res.ok, body };
  }

  async function sidecarRecord() {
    try {
      const res = await fetchJSON(STATUS_URL);
      const list = res.body && Array.isArray(res.body.sidecars) ? res.body.sidecars : [];
      return list.find((entry) => entry && entry.id === EXT) || null;
    } catch (_) { return null; }
  }

  // Turn an HTTP failure of the proxy (or the sidecar itself) into something the
  // operator can act on, using core's own sidecar record for context.
  function diagnose(status, record) {
    const proxy = (record && record.proxy) || {};
    if (status === 403) {
      if (proxy.posture === 'local_unprotected') {
        return {
          title: 'WebUI authentication is off',
          detail: 'The token-v1 sidecar proxy fails closed without authentication, so no '
            + 'local process can use WebUI as a key-forwarding intermediary. Enable a '
            + 'password in Settings → Password, then approve the proxy.',
        };
      }
      return {
        title: 'Sidecar proxy not approved yet',
        detail: 'Approve it in Settings → Extensions → Diagnostics → "Loopback sidecar" '
          + 'card → "Approve proxy consent" for Command Code Usage.',
      };
    }
    if (status === 401 || status === 503) {
      return {
        title: 'Sidecar rejected the proxy token',
        detail: 'The sidecar is running but is not reading the same token as WebUI (or the '
          + 'token file does not exist yet). Make sure the sidecar and WebUI share the same '
          + 'state dir (~/.hermes/webui) and restart commandcode-usage-sidecar.',
      };
    }
    if (status === 404) {
      return {
        title: 'Extension not enabled',
        detail: 'The manifest does not declare the commandcode-usage sidecar, or the extension '
          + 'is disabled. Reload the WebUI and check Settings → Extensions.',
      };
    }
    // 502/504 and network failures are what a dead sidecar actually looks like:
    // the proxy cannot reach 127.0.0.1:17800.
    return {
      title: 'Sidecar is not responding',
      detail: 'The proxy could not reach 127.0.0.1:17800. Start the sidecar service '
        + '(`systemctl --user enable --now commandcode-usage-sidecar`) and try again. '
        + (status ? 'The proxy returned HTTP ' + status + '.' : ''),
    };
  }

  // ── composer chip label ───────────────────────────────────────────────────

  function usageLabel(payload) {
    const cc = (payload && payload.commandcode) || {};
    if (!cc.available) return BUTTON_LABEL;
    const windows = cc.windows || {};
    const parts = PERCENT_ORDER.map((key) => {
      const entry = windows[key] || {};
      const percent = Number(entry.percent);
      return Number.isFinite(percent) ? String(percent) + '%' : '—';
    });
    if (parts.every((part) => part === '—')) return BUTTON_LABEL;
    return 'CmdCode: ' + parts.join('·');
  }

  function setButtonLabel(text) {
    if (!button) return;
    const label = button.querySelector('.hwx-ccu-btn-label');
    if (label) label.textContent = text;
    button.classList.toggle('hwx-ccu-btn--live', text !== BUTTON_LABEL);
  }

  // The chip is a real <button>; keep its expanded state truthful for screen
  // readers (and the focus ring) whenever the pinned panel opens or closes.
  function setExpanded(value) {
    if (button && typeof button.setAttribute === 'function') {
      button.setAttribute('aria-expanded', value ? 'true' : 'false');
    }
  }

  // Populate the chip on page load so the percentages are visible without
  // opening the panel first. Any failure keeps the plain label.
  async function refreshButtonLabel() {
    try {
      const res = await fetchJSON(BASE + '/api/usage');
      if (res.ok && res.body) {
        lastPayload = res.body;
        setButtonLabel(usageLabel(res.body));
      }
    } catch (_) { /* keep the plain label */ }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function windowBar(key, window) {
    const row = el('div', 'hwx-ccu-window');
    const top = el('div', 'hwx-ccu-window-top');
    top.appendChild(el('span', 'hwx-ccu-window-label', WINDOW_LABELS[key] || key));
    const reset = fmtResetIn(window.resets_at);
    if (reset) top.appendChild(el('span', 'hwx-ccu-window-reset', reset));
    row.appendChild(top);

    const barRow = el('div', 'hwx-ccu-window-bar-row');
    const bar = el('div', 'hwx-ccu-bar');
    const fill = el('div', 'hwx-ccu-bar-fill' + pctClass(window));
    const width = Number.isFinite(Number(window.percent)) ? Math.min(100, Math.max(0, Number(window.percent))) : 0;
    fill.style.width = width + '%';
    bar.appendChild(fill);
    barRow.appendChild(bar);
    barRow.appendChild(el('span', 'hwx-ccu-window-pct', fmtPercent(window.percent)));
    row.appendChild(barRow);

    if (window.used !== null && window.used !== undefined && window.cap) {
      const amount = el('div', 'hwx-ccu-window-amount', fmtMoney(window.used) + ' of ' + fmtMoney(window.cap) + ' used');
      if (window.exceeded) amount.classList.add('hwx-ccu-window-amount--err');
      row.appendChild(amount);
    }
    return row;
  }

  function metaRow(label, value, warn) {
    const row = el('div', 'hwx-ccu-meta-row');
    row.appendChild(el('span', 'hwx-ccu-meta-label', label));
    const val = el('span', 'hwx-ccu-meta-value', value);
    if (warn) val.classList.add('hwx-ccu-meta-value--warn');
    row.appendChild(val);
    return row;
  }

  // The panel header already carries the "Command Code Usage" title, the
  // updated stamp and the refresh control; the body holds the window bars, the
  // account meta rows (+ any error text).
  function renderCommandCode(body, payload) {
    const cc = (payload && payload.commandcode) || {};

    if (!cc.available) {
      const error = String(cc.error || 'unknown');
      const messages = {
        no_key: 'No COMMANDCODE_API_KEY is available to the sidecar environment or ~/.hermes/.env.',
        invalid_key: 'Command Code rejected the API key (HTTP 401).',
        blocked: 'Command Code\u2019s edge blocked the request (HTTP 403).',
        not_found: 'The alpha usage endpoints answered 404 for this account (HTTP 404).',
        redirected: 'The endpoint tried to redirect; the sidecar refuses redirects for '
          + 'credentialed requests.',
        unreachable: 'Command Code could not be reached from the sidecar.',
        bad_payload: 'The usage response did not look like the expected alpha payload.',
      };
      body.appendChild(el('p', 'hwx-ccu-note',
        messages[error] || ('The usage lookup failed (' + error + ').')));
      return;
    }

    PERCENT_ORDER.forEach((key) => {
      const window = (cc.windows || {})[key];
      if (!window) return;
      body.appendChild(windowBar(key, window));
    });
    if (!Object.keys(cc.windows || {}).length) {
      body.appendChild(el('p', 'hwx-ccu-note', 'No spend-window data was returned for this account.'));
    }

    const meta = el('div', 'hwx-ccu-meta');
    const plan = cc.plan || {};
    if (plan.error) {
      meta.appendChild(metaRow('Plan', 'lookup failed (' + plan.error + ')', true));
    } else if (plan.label || plan.id) {
      let planText = plan.label || plan.id;
      if (plan.status && plan.status !== 'active') planText += ' · ' + plan.status;
      if (plan.cancel_at_period_end) planText += ' · cancels at period end';
      meta.appendChild(metaRow('Plan', planText, false));
      if (plan.renews_at) meta.appendChild(metaRow('Renews', fmtDate(plan.renews_at), false));
    }

    const credits = cc.credits || {};
    if (credits.monthly_remaining !== null && credits.monthly_remaining !== undefined) {
      meta.appendChild(metaRow('Monthly credits', fmtMoney(credits.monthly_remaining) + ' remaining', !!credits.below_threshold));
    }
    if (credits.purchased) meta.appendChild(metaRow('Purchased credits', fmtMoney(credits.purchased), false));
    if (credits.free) meta.appendChild(metaRow('Free credits', fmtMoney(credits.free), false));

    const period = cc.period || {};
    if (period.error) {
      meta.appendChild(metaRow('This period', 'lookup failed (' + period.error + ')', true));
    } else if (period.requests !== null && period.requests !== undefined) {
      let text = period.requests + ' requests';
      if (period.cost !== null && period.cost !== undefined) text += ' · ' + fmtMoney(period.cost);
      meta.appendChild(metaRow('This period', text, false));
    }

    if (meta.children.length) body.appendChild(meta);
  }

  function renderError(body, title, detail) {
    const section = el('section', 'hwx-ccu-section');
    section.appendChild(el('div', 'hwx-ccu-error-title', title));
    if (detail) section.appendChild(el('p', 'hwx-ccu-note', detail));
    body.appendChild(section);
  }

  // Pin the panel to the tallest its content has ever been (the usage rows),
  // grow-only, so it never shrinks when a refresh re-renders a smaller state.
  // The body scrolls inside the fixed height.
  function ensurePanelHeight() {
    if (!panel) return;
    const bottom = window.parseInt(panel.style.bottom, 10) || 0;
    const avail = Math.max(120, window.innerHeight - bottom - 8);
    const measured = Math.max(120, Math.min(avail, panel.offsetHeight || 200));
    if (fixedPanelHeight === null || measured > fixedPanelHeight) {
      fixedPanelHeight = measured;
    }
    panel.style.height = fixedPanelHeight + 'px';
    panel.style.minHeight = fixedPanelHeight + 'px';
  }

  function render(payload, errorState) {
    if (!panel) return;
    const body = panel.querySelector('.hwx-ccu-body');
    if (!body) return;
    body.textContent = '';

    if (errorState) {
      renderError(body, errorState.title, errorState.detail);
    } else {
      renderCommandCode(body, payload);
      ensurePanelHeight();
    }

    const stamp = panel.querySelector('.hwx-ccu-stamp');
    if (stamp) {
      const generated = payload && payload.generated_at;
      stamp.textContent = (errorState || !generated) ? '' : 'Updated ' + fmtClock(generated);
    }
  }

  function renderLoading() {
    if (!panel) return;
    const body = panel.querySelector('.hwx-ccu-body');
    if (!body) return;
    body.textContent = '';
    body.appendChild(el('div', 'hwx-ccu-empty', 'Querying Command Code usage…'));
  }

  async function load(force) {
    if (busy) return;
    busy = true;
    const refreshBtn = panel && panel.querySelector('.hwx-ccu-refresh');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('hwx-ccu-refresh--active');
    }
    // Never collapse already-rendered content on a refresh: keep showing the
    // last payload until the fresh one lands, so the panel keeps its size.
    if (!lastPayload) renderLoading();
    try {
      const res = await fetchJSON(BASE + '/api/usage' + (force ? '?refresh=1' : ''));
      if (res.ok && res.body) {
        lastPayload = res.body;
        setButtonLabel(usageLabel(res.body));
        render(res.body, null);
      } else {
        const record = await sidecarRecord();
        render(null, diagnose(res.status, record));
      }
    } catch (_) {
      render(null, diagnose(0, await sidecarRecord()));
    } finally {
      busy = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('hwx-ccu-refresh--active');
      }
    }
  }

  // ── panel lifecycle ───────────────────────────────────────────────────────

  function scheduleRefresh() {
    stopRefresh();
    if (!autoRefreshEnabled()) return;
    const seconds = refreshSeconds();
    timer = window.setInterval(() => {
      if (panel && !document.hidden) load(false);
    }, seconds * 1000);
  }

  function stopRefresh() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function closePanel() {
    cancelHoverTimers();
    setExpanded(false);
    stopRefresh();
    if (outsideHandler) {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('click', outsideHandler, true);
    }
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    outsideHandler = null;
    keyHandler = null;
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    // Re-measure on the next open: one tall error state must not condition
    // every later open.
    fixedPanelHeight = null;
    if (button && typeof button.focus === 'function') button.focus();
    lastFocus = null;
  }

  // ── hover behaviour ───────────────────────────────────────────────────────
  // Hovering the chip opens the panel after a short delay. Once open, the panel
  // stays **pinned**: it does not close when the cursor leaves (so a refresh or
  // a quick mouse movement does not dismiss it). It closes on Escape, on a click
  // anywhere outside, or by clicking the chip again.

  function cancelHoverTimers() {
    if (hoverOpenTimer) { window.clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
  }

  function hoverOpen() {
    if (panel) { cancelHoverTimers(); return; }
    if (hoverOpenTimer) return;
    hoverOpenTimer = window.setTimeout(() => {
      hoverOpenTimer = null;
      // If the chip left the layout during the delay (composer collapse), its
      // rects are empty and a panel would open orphaned — skip instead.
      if (!button || button.getClientRects().length === 0) return;
      openPanel();
    }, HOVER_OPEN_DELAY);
  }

  function buildPanel() {
    const node = el('aside', 'hwx-ccu-panel');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'Command Code usage');

    const head = el('div', 'hwx-ccu-head');
    head.appendChild(el('span', 'hwx-ccu-head-title', 'Command Code Usage'));
    head.appendChild(el('span', 'hwx-ccu-stamp', ''));

    const refreshBtn = el('button', 'hwx-ccu-icon-btn hwx-ccu-refresh');
    refreshBtn.appendChild(el('span', 'hwx-ccu-refresh-icon', '⟳'));
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh now';
    refreshBtn.setAttribute('aria-label', 'Refresh now');
    refreshBtn.addEventListener('click', () => load(true));
    head.appendChild(refreshBtn);

    node.appendChild(head);
    node.appendChild(el('div', 'hwx-ccu-body', ''));
    return node;
  }

  // The panel grows to the RIGHT of the chip (left edges flush); its bottom
  // edge leaves room for the callout tail, aligned to the chip's centre.
  function placePanel() {
    if (!panel || !button) return;
    const anchor = button.getBoundingClientRect();
    const width = panel.offsetWidth || 360;
    let left = anchor.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const bottom = Math.max(8, window.innerHeight - anchor.top + 8);
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = bottom + 'px';
    panel.style.top = 'auto';
    // Height is fixed in CSS so the panel never resizes between states.
    panel.style.setProperty('--hwx-ccu-tail-x', String(Math.max(12, anchor.width / 2)) + 'px');
  }

  function openPanel() {
    // A pending hover timer must never survive an open/toggle. Entering the chip
    // arms a HOVER_OPEN_DELAY timer; clicking before it fires opens the panel
    // here, and the still-pending timer would then re-enter openPanel() and take
    // the toggle branch below — closing the panel the user just opened. Cancel
    // first so hover-then-click (the natural gesture beside core's click-to-open
    // chips) cannot flash the panel shut.
    cancelHoverTimers();
    if (panel) { closePanel(); return; }
    lastFocus = document.activeElement;
    panel = buildPanel();
    setExpanded(true);
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    placePanel();
    // Render the freshest data we already have so the height is measured from
    // the full content before the panel is shown; load(false) then refreshes it.
    if (lastPayload) render(lastPayload, null); else renderLoading();
    panel.style.visibility = '';

    keyHandler = (event) => {
      if (event.key === 'Escape') closePanel();
    };
    // Composer-tool behaviour: pressing any other control (or clicking anywhere
    // outside) dismisses the popover. Capture phase, so core's own handlers
    // cannot keep it open.
    outsideHandler = (event) => {
      if (!panel) return;
      if (panel.contains(event.target)) return;
      if (button && button.contains(event.target)) return;
      closePanel();
    };
    document.addEventListener('keydown', keyHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('click', outsideHandler, true);

    load(false);
    scheduleRefresh();
  }

  // ── composer chip ─────────────────────────────────────────────────────────

  // A real <button> styled as a quiet composer pill: no border, no tint and no
  // title tooltip, but focusable with aria-haspopup=dialog and a live
  // aria-expanded, so keyboard and touch users can open the pinned panel too.
  // Hover opens it; clicking toggles it.
  function buildButton() {
    const node = el('button', 'hwx-ccu-btn');
    node.id = 'btnCommandCodeUsage';
    node.type = 'button';
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-expanded', 'false');
    node.appendChild(el('span', 'hwx-ccu-btn-label', BUTTON_LABEL));
    node.addEventListener('mouseenter', hoverOpen);
    // Leaving the chip disarms a not-yet-fired open timer, so a fly-over across
    // the footer cannot pin a panel the user never asked for. (Once the panel is
    // open it stays pinned — closing is Escape / outside click / clicking the
    // chip — so this only ever cancels the pending-open state.)
    node.addEventListener('mouseleave', cancelHoverTimers);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      openPanel(); // toggles the pinned panel
    });
    return node;
  }

  function mount() {
    if (button && document.body.contains(button)) return true;
    const anchor = document.querySelector('.composer-footer .composer-left .composer-model-wrap');
    if (!anchor || !anchor.parentNode) return false;
    if (!button) button = buildButton();
    // Chip in .composer-left, right after the model chip (beside #providerQuotaChip),
    // adopting that chip's styling so it does not perturb core's footer fit.
    const next = anchor.nextSibling;
    if (next) anchor.parentNode.insertBefore(button, next);
    else anchor.parentNode.appendChild(button);
    watchComposer();
    refreshButtonLabel();
    return true;
  }

  // The composer footer is static markup, but a panel switch can re-create it;
  // re-insert the chip if it ever leaves the DOM. The observer is scoped to one
  // node and re-checks containment, so our own insert cannot loop.
  function watchComposer() {
    if (composerObserver) return;
    const footer = document.querySelector('.composer-footer');
    if (!footer) return;
    composerObserver = new MutationObserver(() => {
      if (button && !document.body.contains(button)) mount();
    });
    composerObserver.observe(footer, { childList: true });
  }

  function mountWithRetry(attempt) {
    if (mount()) return;
    if (attempt >= MOUNT_MAX_TRIES) {
      console.warn('[' + EXT + '] composer footer not found; extension not mounted');
      return;
    }
    window.setTimeout(() => mountWithRetry(attempt + 1), MOUNT_RETRY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountWithRetry(0));
  } else {
    mountWithRetry(0);
  }
})();
