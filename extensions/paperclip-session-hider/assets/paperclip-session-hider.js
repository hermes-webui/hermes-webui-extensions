(() => {
  'use strict';

  // ── Paperclip Session Hider for Hermes WebUI ─────────────────────────────
  // Hides Paperclip/Hermes tool-origin session rows from the conversation
  // sidebar. It does not delete, archive, rename, or mutate sessions; it only
  // applies extension-owned CSS classes to rendered sidebar rows.

  const EXT = 'paperclip-session-hider';
  if (window.__hermesPaperclipSessionHiderLoaded) return;
  window.__hermesPaperclipSessionHiderLoaded = true;

  const LEGACY_SETTINGS_KEY = 'hermes-ext-paperclip-session-hider';
  const HIDDEN_ROW_CLASS = 'hwx-psh-hidden';
  const HIDDEN_GROUP_CLASS = 'hwx-psh-date-group-hidden';
  const MODE_GENERIC = 'generic-tool';
  const MODE_ALL_TOOL = 'all-tool-source';
  const MODE_VALUES = new Set([MODE_GENERIC, MODE_ALL_TOOL]);
  const FETCH_DEBOUNCE_MS = 400;
  const REFRESH_AFTER_MS = 15000;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: MODE_GENERIC,
  });

  let sessionsById = new Map();
  let observer = null;
  let applyTimer = 0;
  let fetchTimer = 0;
  let fetchInFlight = false;
  let lastFetchAt = 0;
  let lastFetchAttemptAt = 0;

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeTitle(value) {
    return normalizeString(value).replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizeMode(value) {
    return MODE_VALUES.has(value) ? value : DEFAULT_SETTINGS.mode;
  }

  function readLegacySettings() {
    try {
      const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function extensionSettings() {
    try {
      const api = window.HermesExtensionSettings;
      if (api && typeof api.settingsForExtension === 'function') {
        const settings = api.settingsForExtension(EXT);
        if (settings && settings.supported) return settings;
      }
    } catch (_) {}
    return null;
  }

  function loadSettings() {
    const api = extensionSettings();
    if (api) {
      return {
        enabled: api.get('enabled') !== false,
        mode: normalizeMode(api.get('mode')),
      };
    }
    const source = readLegacySettings();
    return {
      enabled: source.enabled !== false,
      mode: normalizeMode(source.mode),
    };
  }

  function sourceValues(session) {
    if (!session || typeof session !== 'object') return [];
    return [
      session.session_source,
      session.raw_source,
      session.source_tag,
      session.source,
      session.source_label,
    ].map((value) => normalizeString(value).toLowerCase()).filter(Boolean);
  }

  function isToolSourceSession(session) {
    const values = sourceValues(session);
    return values.includes('tool') || values.includes('paperclip');
  }

  function isGenericToolTitle(title) {
    const clean = normalizeTitle(title);
    return clean === 'tool session' || clean === 'tool';
  }

  function isGeneratedToolSessionId(sessionId) {
    return /^\d{8}_\d{6}_[a-f0-9]{6,}$/i.test(normalizeString(sessionId));
  }

  function rowTitle(row) {
    if (!row) return '';
    const title = row.querySelector && row.querySelector('.session-title');
    return title ? title.textContent : row.textContent;
  }

  function shouldHideSession(session, settings, fallbackTitle = '', fallbackSid = '') {
    const effective = settings || DEFAULT_SETTINGS;
    if (!effective.enabled) return false;

    const title = normalizeString((session && session.title) || fallbackTitle);
    const sid = normalizeString((session && session.session_id) || fallbackSid);
    const sources = sourceValues(session);
    const toolSource = sources.includes('tool') || sources.includes('paperclip');

    // If the server tells us this is a normal WebUI/cron/messaging row, do not
    // hide it just because a user or automation named it "Tool Session". The
    // metadata-unavailable fallback is deliberately stricter: it requires the
    // generic title AND the generated timestamp-style session id shape used by
    // Paperclip/Hermes tool-origin sessions. Session objects can exist before
    // source metadata is populated, so only explicit non-tool source values block
    // the fallback.
    if (!toolSource) {
      if (sources.length > 0) return false;
      return isGenericToolTitle(title) && isGeneratedToolSessionId(sid);
    }
    if (effective.mode === MODE_ALL_TOOL) return true;
    return isGenericToolTitle(title);
  }

  function sameOriginSessionsUrl() {
    const qs = new URLSearchParams();
    qs.set('exclude_hidden', '1');
    return '/api/sessions?' + qs.toString();
  }

  async function refreshSessions() {
    if (fetchInFlight) return;
    fetchInFlight = true;
    lastFetchAttemptAt = Date.now();
    try {
      const response = await fetch(sameOriginSessionsUrl(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      const next = new Map();
      const rows = [];
      if (Array.isArray(payload && payload.sessions)) rows.push(...payload.sessions);
      if (Array.isArray(payload && payload.sidebar_reference_sessions)) rows.push(...payload.sidebar_reference_sessions);
      for (const session of rows) {
        if (session && session.session_id) next.set(String(session.session_id), session);
      }
      sessionsById = next;
      lastFetchAt = Date.now();
    } catch (_) {
      // Metadata fetch failures should not break the sidebar. The DOM title
      // fallback still hides generic "Tool Session" rows until the API recovers.
    } finally {
      fetchInFlight = false;
      scheduleApply();
    }
  }

  function scheduleFetch(delay = FETCH_DEBOUNCE_MS) {
    if (fetchTimer) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => {
      fetchTimer = 0;
      refreshSessions();
    }, Math.max(0, delay));
  }

  function shouldPauseForBatchSelection(list) {
    return !!(list && list.querySelector('.session-select-bar'));
  }

  function applyGroupVisibility(list) {
    if (!list) return;
    const groups = list.querySelectorAll('.session-date-group');
    for (const group of groups) {
      const body = group.querySelector('.session-date-body');
      if (!body || body.querySelector('.session-virtual-spacer')) {
        group.classList.remove(HIDDEN_GROUP_CLASS);
        continue;
      }
      const visibleRows = body.querySelectorAll(
        '.session-item:not(.' + HIDDEN_ROW_CLASS + '), .session-child-session:not(.' + HIDDEN_ROW_CLASS + ')'
      );
      group.classList.toggle(HIDDEN_GROUP_CLASS, visibleRows.length === 0);
    }
  }

  function unhideAll(list) {
    if (!list) return;
    for (const row of list.querySelectorAll('.' + HIDDEN_ROW_CLASS)) {
      row.classList.remove(HIDDEN_ROW_CLASS);
      row.removeAttribute('aria-hidden');
    }
    for (const group of list.querySelectorAll('.' + HIDDEN_GROUP_CLASS)) {
      group.classList.remove(HIDDEN_GROUP_CLASS);
    }
  }

  function applyHiddenRows() {
    const list = document.getElementById('sessionList');
    if (!list) return;

    if (shouldPauseForBatchSelection(list)) {
      unhideAll(list);
      return;
    }

    const settings = loadSettings();
    let sawUnknownSid = false;
    const rows = list.querySelectorAll('.session-item[data-sid], .session-child-session[data-sid]');
    for (const row of rows) {
      const sid = row.dataset && row.dataset.sid;
      const session = sid ? sessionsById.get(String(sid)) : null;
      if (sid && !session) sawUnknownSid = true;
      const hide = shouldHideSession(session, settings, rowTitle(row), sid);
      row.classList.toggle(HIDDEN_ROW_CLASS, hide);
      if (hide) row.setAttribute('aria-hidden', 'true');
      else row.removeAttribute('aria-hidden');
    }
    applyGroupVisibility(list);
    try {
      document.documentElement.dataset.hwxPaperclipSessionHider = settings.enabled ? 'enabled' : 'disabled';
    } catch (_) {}

    if (sawUnknownSid && Date.now() - lastFetchAttemptAt > REFRESH_AFTER_MS) scheduleFetch();
  }

  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = requestAnimationFrame(() => {
      applyTimer = 0;
      applyHiddenRows();
    });
  }

  function observeSidebar() {
    const list = document.getElementById('sessionList');
    if (!list || observer) return;
    observer = new MutationObserver((mutations) => {
      let shouldFetch = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes && mutation.addedNodes.length) {
          shouldFetch = true;
          break;
        }
      }
      scheduleApply();
      if (shouldFetch) scheduleFetch();
    });
    observer.observe(list, { childList: true, subtree: true });
  }

  function start() {
    observeSidebar();
    scheduleFetch(0);
    scheduleApply();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleFetch(0);
    });
    document.addEventListener('change', scheduleApply, true);
    window.addEventListener('storage', (event) => {
      if (!event.key || event.key.includes(EXT) || event.key.includes(encodeURIComponent(EXT))) scheduleApply();
    });
  }

  window.hermesExt = window.hermesExt || {};
  window.hermesExt.paperclipSessionHider = {
    shouldHideSession,
    isToolSourceSession,
    isGenericToolTitle,
    isGeneratedToolSessionId,
    loadSettings,
    applyHiddenRows,
    refreshSessions,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
