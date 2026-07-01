(() => {
  'use strict';

  // ── Mobile Haptics extension for Hermes WebUI ────────────────────────────
  // Gives a short device vibration when an assistant turn finishes, so a phone
  // user who set the device down gets a physical "it's done" cue. Opt-in and
  // mobile-only by nature (navigator.vibrate is a no-op on desktop and is not
  // supported on iOS Safari — so this is effectively an Android / Android-PWA
  // feature; it degrades silently everywhere else).
  //
  // It cannot see SSE events, so it detects "turn complete" purely from the DOM:
  // the composer send button (#btnSend) carries a busy action (stop / steer /
  // interrupt) while the assistant is generating, and returns to the idle 'send'
  // action when the turn finishes. The busy -> idle transition is the trigger.

  const EXT = 'mobile-haptics';
  if (window.__hermesMobileHapticsLoaded) return;
  window.__hermesMobileHapticsLoaded = true;

  const PREF_KEY = 'hermes-ext-haptics-enabled';      // '1' (default on) | '0'
  const COMPLETE_PATTERN = [18];                       // short single buzz on turn-complete
  const BUSY_ACTIONS = new Set(['stop', 'steer', 'interrupt']);
  const MIN_BUSY_MS = 100;                            // tiny floor: filters pure flicker; the sawBusy flag is the real "a turn happened" gate

  let sawBusy = false;        // have we observed a genuine busy (stop/steer/interrupt) action this turn?
  let busyStartedAt = 0;      // when the busy period began
  let observer = null;

  function hapticsSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  function enabled() {
    try {
      const v = localStorage.getItem(PREF_KEY);
      return v === null ? true : v === '1';   // default ON when supported
    } catch (_) { return true; }
  }

  function sendBtnAction() {
    const btn = document.getElementById('btnSend');
    if (!btn) return null;
    const a = btn.dataset ? btn.dataset.action : null;
    if (a) return a;
    for (const cls of BUSY_ACTIONS) if (btn.classList.contains(cls)) return cls;
    return 'send';
  }

  // Turn lifecycle as reflected by #btnSend's action:
  //   send  -> (busy: stop/steer/interrupt, possibly interleaved with 'disabled'
  //             while the composer is empty mid-stream) -> back to send/disabled idle.
  // The reliable "turn complete" signal is: we saw a genuine busy action, and the
  // button has now returned to the idle 'send'/'disabled' state. 'disabled' alone
  // is NOT busy (empty composer) and NOT a completion on its own — only the
  // transition OUT of a confirmed-busy turn counts.
  function onStateMaybeChanged() {
    const action = sendBtnAction();
    const busy = BUSY_ACTIONS.has(action);
    if (busy) {
      if (!sawBusy) { sawBusy = true; busyStartedAt = Date.now(); }
      return;
    }
    // 'queue' is NOT completion: core sets #btnSend.dataset.action to 'queue' while
    // an assistant turn is STILL active and the user has typed/queued a follow-up
    // (static/ui.js getComposerPrimaryAction). Treat it as a holding state so a
    // mid-turn stop->queue transition does not fire a premature buzz (and then a
    // second one on the real completion). (Codex gate, PR #22.)
    if (sawBusy && action === 'queue') return;
    // Not a busy/holding action. If we had seen a busy action this turn, it's done.
    if (sawBusy) {
      const ranFor = Date.now() - busyStartedAt;
      sawBusy = false;
      if (ranFor >= MIN_BUSY_MS && enabled() && hapticsSupported()) {
        try { navigator.vibrate(COMPLETE_PATTERN); } catch (_) {}
      }
    }
  }

  function startObserver() {
    const btn = document.getElementById('btnSend');
    if (!btn || observer) return !!observer;
    // Watch the send button's class + data-action for the busy/idle flip.
    observer = new MutationObserver(onStateMaybeChanged);
    observer.observe(btn, { attributes: true, attributeFilter: ['class', 'data-action'] });
    sawBusy = BUSY_ACTIONS.has(sendBtnAction());
    if (sawBusy) busyStartedAt = Date.now();
    return true;
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.getElementById('btnSend')) {
      startObserver();
      window.HermesMobileHapticsExtension = {
        version: '0.1.0',
        supported: hapticsSupported(),
        isEnabled: enabled,
        setEnabled(on) { try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (_) {} },
        test() { if (hapticsSupported()) { try { navigator.vibrate(COMPLETE_PATTERN); return true; } catch (_) {} } return false; }
      };
      if (!hapticsSupported()) {
        console.info('[' + EXT + '] navigator.vibrate not supported on this device (desktop / iOS Safari); haptics inactive.');
      }
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] send button (#btnSend) not found; haptics not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
