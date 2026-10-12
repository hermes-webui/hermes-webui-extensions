/*
 * hermes-viz-nav.js — window.HermesVizNav v1 (docs/INTERFACES.md §3). Owner: B (sigakhwa-bookmarks).
 *
 * goTo({profile, sessionId, messageIndex, role}) lands on one persisted message:
 *   1. profile differs  → core _switchProfileForSessionLoad(profile) (sessions.js:2232), the same path
 *                         loadSession() uses on a 409 session_profile_mismatch; missing → 'profile_switch_required'
 *   2. session differs  → core loadSession(sid, {skipLineageResolve:true}) (sessions.js:2276)
 *   3. row lookup       → [data-session-msg-idx="<messageIndex>"] then msg-user-<rawIdx>
 *                         (rawIdx = _messageRawIdxForSessionIndex, ui.js:1034)
 *   4. row missing      → full transcript reload (outline.js:94-131 pattern: core _ensureAllMessagesLoaded()
 *                         or fail safely if unavailable), expand the render window, renderMessages()
 *   5. scrollIntoView + flash class (core 'outline-jump-flash' + 'hermes-viz-jump-flash')
 *
 * Plain classic script, idempotent, never throws at load time. Core globals are read lazily so the module
 * loads fine before/without core.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var BUILD = 2026101301;
  var previous = window.HermesVizNav;
  if (previous && previous.build >= BUILD) {
    if (previous.build > BUILD) console.warn('[HermesVizNav] older helper ignored');
    return;
  }
  if (previous) console.warn('[HermesVizNav] replacing older helper');

  var FLASH_MS = 1200;
  var SETTLE_MS = 120;
  var MESSAGES_WAIT_MS = 4000;

  /* eslint-disable no-undef */
  // Core state lives in top-level let/const bindings of classic scripts (not on window), so each
  // accessor tries the bare identifier first and falls back to window.<name>.
  function coreS() {
    try { if (typeof S !== 'undefined' && S) return S; } catch (_) { /* ignore */ }
    return window.S || null;
  }
  function coreFn(name) {
    var fn = null;
    try {
      switch (name) {
        case '_cancelBottomSettle': fn = typeof _cancelBottomSettle === 'function' ? _cancelBottomSettle : null; break;
        case 'loadSession': fn = typeof loadSession === 'function' ? loadSession : null; break;
        case 'renderMessages': fn = typeof renderMessages === 'function' ? renderMessages : null; break;
        case 'api': fn = typeof api === 'function' ? api : null; break;
        case '_switchProfileForSessionLoad': fn = typeof _switchProfileForSessionLoad === 'function' ? _switchProfileForSessionLoad : null; break;
        case '_profileMatchesActiveProfile': fn = typeof _profileMatchesActiveProfile === 'function' ? _profileMatchesActiveProfile : null; break;
        case '_ensureAllMessagesLoaded': fn = typeof _ensureAllMessagesLoaded === 'function' ? _ensureAllMessagesLoaded : null; break;
        case '_messageRawIdxForSessionIndex': fn = typeof _messageRawIdxForSessionIndex === 'function' ? _messageRawIdxForSessionIndex : null; break;
        case '_currentMessageRenderWindowSize': fn = typeof _currentMessageRenderWindowSize === 'function' ? _currentMessageRenderWindowSize : null; break;
        case '_messageRenderableMessageCount': fn = typeof _messageRenderableMessageCount === 'function' ? _messageRenderableMessageCount : null; break;
        default: fn = null;
      }
    } catch (_) { fn = null; }
    if (!fn && typeof window[name] === 'function') fn = window[name];
    return fn;
  }
  function coreTruncated() {
    try { if (typeof _messagesTruncated !== 'undefined') return !!_messagesTruncated; } catch (_) { /* ignore */ }
    return !!window._messagesTruncated;
  }
  function expandRenderWindow() {
    // outline.js _expandOutlineRenderWindow(): make the virtualized window cover every renderable row.
    var cur = coreFn('_currentMessageRenderWindowSize');
    var count = coreFn('_messageRenderableMessageCount');
    if (!cur || !count) return false;
    var size;
    try { size = Math.max(cur(), count()); } catch (_) { return false; }
    try { if (typeof _messageRenderWindowSize !== 'undefined') { _messageRenderWindowSize = size; return true; } } catch (_) { /* ignore */ }
    if ('_messageRenderWindowSize' in window) { window._messageRenderWindowSize = size; return true; }
    return false;
  }
  /* eslint-enable no-undef */

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function result(ok, reason) { return ok ? { ok: true } : { ok: false, reason: reason }; }

  function currentTarget() {
    var s = coreS();
    if (!s || !s.session || !s.session.session_id) return null;
    return { sessionId: String(s.session.session_id), profile: String(s.activeProfile || 'default') };
  }

  function isBusy() {
    var s = coreS();
    return !!(s && (s.busy || s.activeStreamId));
  }

  function profileMatches(profile, active) {
    var fn = coreFn('_profileMatchesActiveProfile');
    if (fn) { try { return !!fn(profile, active); } catch (_) { /* fall through */ } }
    var a = (typeof active === 'string' && active.trim()) ? active.trim() : 'default';
    var p = (typeof profile === 'string' && profile.trim()) ? profile.trim() : 'default';
    return a === p;
  }

  function messagesRoot() {
    return document.getElementById('msgInner') || document.getElementById('messages') || document;
  }

  function findRow(messageIndex, role) {
    var root = messagesRoot();
    var row = null;
    try { row = root.querySelector('[data-session-msg-idx="' + String(messageIndex) + '"]'); } catch (_) { row = null; }
    if (row) {
      // Prefer the real message row; a nested element carrying the same index is still acceptable.
      var owner = row.closest ? (row.closest('[data-msg-idx]') || row) : row;
      return owner;
    }
    if (role === 'user') {
      var rawFn = coreFn('_messageRawIdxForSessionIndex');
      var rawIdx = rawFn ? rawFn(messageIndex) : messageIndex;
      if (Number.isFinite(rawIdx) && rawIdx >= 0) {
        row = document.getElementById('msg-user-' + rawIdx);
        if (row) return row;
      }
    }
    return null;
  }

  function flash(row) {
    if (!row || !row.classList) return;
    row.classList.remove('outline-jump-flash');
    row.classList.remove('hermes-viz-jump-flash');
    try { void row.offsetWidth; } catch (_) { /* ignore */ }
    row.classList.add('outline-jump-flash');
    row.classList.add('hermes-viz-jump-flash');
    setTimeout(function () {
      row.classList.remove('outline-jump-flash');
      row.classList.remove('hermes-viz-jump-flash');
    }, FLASH_MS);
  }

  function scrollTo(row) {
    // Same sticky-unpin state as manual upward scrolling (pinned Core ui.js:7123-7126; cancellation at 6647).
    var cancel = coreFn('_cancelBottomSettle');
    if (cancel) { try { cancel(); } catch (_) { /* ignore */ } }
    // Clear it immediately before scrolling so queued render/follow work cannot reclaim the tail.
    try { if (typeof _scrollPinned !== 'undefined') _scrollPinned = false; } catch (_) { /* ignore */ }
    try { if (typeof _messageUserUnpinned !== 'undefined') _messageUserUnpinned = true; } catch (_) { /* ignore */ }
    try { if (typeof _nearBottomCount !== 'undefined') _nearBottomCount = 0; } catch (_) { /* ignore */ }
    if ('_scrollPinned' in window) window._scrollPinned = false;
    if ('_messageUserUnpinned' in window) window._messageUserUnpinned = true;
    if ('_nearBottomCount' in window) window._nearBottomCount = 0;
    try { row.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {
      try { row.scrollIntoView(); } catch (_e) { /* ignore */ }
    }
    flash(row);
  }

  function waitForMessages(sid) {
    var s = coreS();
    var started = Date.now();
    function check() {
      if (!s.session || s.session.session_id !== sid) return Promise.resolve(false);
      if (Array.isArray(s.messages) && s.messages.length) return Promise.resolve(true);
      if (Date.now() - started > MESSAGES_WAIT_MS) return Promise.resolve(false);
      return delay(80).then(check);
    }
    return check();
  }

  // Load the COMPLETE transcript (explicit msg_limit=all, see outline.js:109-115) and re-render.
  function ensureFullTranscript(sid) {
    var s = coreS();
    var ensure = coreFn('_ensureAllMessagesLoaded');
    var p;
    if (coreTruncated() && ensure) {
      p = Promise.resolve().then(function () { return ensure(); }).then(function () { return true; }, function () { return false; });
    } else if (coreTruncated()) {
      p = Promise.resolve(false);
    } else {
      p = Promise.resolve(true);
    }
    return p.then(function (ok) {
      if (!ok) return false;
      if (!s.session || s.session.session_id !== sid) return false;
      expandRenderWindow();
      var render = coreFn('renderMessages');
      if (render) { try { render({ preserveScroll: true }); } catch (_) { /* ignore */ } }
      return delay(SETTLE_MS).then(function () { return true; });
    });
  }


  function goTo(target) {
    return Promise.resolve().then(function () {
      var s = coreS();
      var loadSessionFn = coreFn('loadSession');
      if (!s || !loadSessionFn || typeof document === 'undefined') return result(false, 'no_core');
      if (!target || typeof target !== 'object') return result(false, 'session_not_found');
      var sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      var messageIndex = target.messageIndex;
      var role = target.role;
      var profile = (typeof target.profile === 'string' && target.profile.trim()) ? target.profile.trim() : 'default';
      if (!sessionId) return result(false, 'session_not_found');
      if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) return result(false, 'row_not_found');
      if (role !== 'user' && role !== 'assistant') return result(false, 'row_not_found');

      var active = String(s.activeProfile || 'default');
      var needProfile = !profileMatches(profile, active);
      var currentSid = s.session && s.session.session_id ? String(s.session.session_id) : null;
      var needSession = currentSid !== sessionId;

      if ((needProfile || needSession) && isBusy()) return result(false, 'busy_switch_blocked');

      var chain = Promise.resolve();
      if (needProfile) {
        var switchFn = coreFn('_switchProfileForSessionLoad');
        if (!switchFn) return result(false, 'profile_switch_required');
        chain = chain.then(function () { return switchFn(profile); }).then(function () {
          if (!profileMatches(profile, String(s.activeProfile || 'default'))) throw { reason: 'profile_switch_required' };
        }, function (e) {
          throw (e && e.reason) ? e : { reason: 'profile_switch_required' };
        });
      }
      if (needSession || needProfile) {
        chain = chain.then(function () {
          return Promise.resolve().then(function () {
            return loadSessionFn(sessionId, { skipLineageResolve: true, skipContinuationResolve: true, skipExtHooks: false });
          }).then(function () {
            if (!s.session || String(s.session.session_id) !== sessionId) throw { reason: 'session_not_found' };
            return waitForMessages(sessionId);
          }, function (e) {
            throw (e && e.reason) ? e : { reason: 'session_not_found' };
          });
        });
      }
      return chain.then(function () {
        if (!s.session || String(s.session.session_id) !== sessionId) return result(false, 'session_not_found');
        var row = findRow(messageIndex, role);
        if (row) { scrollTo(row); return result(true); }
        if (isBusy()) return result(false, 'busy_switch_blocked');
        return ensureFullTranscript(sessionId).then(function (ok) {
          if (!ok) return result(false, 'row_not_found');
          var again = findRow(messageIndex, role);
          if (!again) return result(false, 'row_not_found');
          scrollTo(again);
          return result(true);
        });
      }, function (e) {
        return result(false, (e && e.reason) || 'session_not_found');
      });
    });
  }

  window.HermesVizNav = Object.freeze({
    version: 1,
    build: BUILD,
    currentTarget: currentTarget,
    goTo: goTo,
    // Non-contract helpers (exposed for tests / UI reuse).
    _findRow: findRow,
    _flash: flash,
    _isBusy: isBusy,
  });
})();
