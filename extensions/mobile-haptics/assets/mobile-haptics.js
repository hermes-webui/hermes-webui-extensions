(() => {
  'use strict';

  // ── Mobile Haptics extension for Hermes WebUI ────────────────────────────
  // Give a short device vibration when the current page observes a completed
  // assistant turn. This extension relies only on the cooperative E0/B1
  // extension capability handle; it does not inspect Core-owned DOM state.

  const EXT = 'mobile-haptics';
  if (window.__hermesMobileHapticsLoaded) return;
  window.__hermesMobileHapticsLoaded = true;

  const COMPLETE_PATTERN = [18];

  function hapticsSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  function warn(message) {
    try { console.warn('[' + EXT + '] ' + message); } catch (_) {}
  }

  function scopedCapability() {
    const api = window.hermesExt;
    if (!api || typeof api.register !== 'function') {
      warn('hermesExt.register is unavailable; haptics disabled');
      return null;
    }

    let ext;
    try {
      ext = api.register(EXT);
    } catch (_) {
      warn('hermesExt.register failed; haptics disabled');
      return null;
    }
    if (!ext || ext.id !== EXT) {
      warn('scoped extension handle is unavailable; haptics disabled');
      return null;
    }

    const settings = ext.settings;
    if (!settings || typeof settings.get !== 'function' || typeof settings.set !== 'function') {
      warn('scoped settings are unavailable; haptics disabled');
      return null;
    }
    if (!ext.events || typeof ext.events.on !== 'function') {
      warn('scoped lifecycle events are unavailable; haptics disabled');
      return null;
    }
    return ext;
  }

  const ext = scopedCapability();
  const settings = ext && ext.settings;
  let lifecycleReady = false;

  function enabled() {
    if (!settings) return false;
    try {
      const value = settings.get('enabled');
      return value === undefined ? true : value !== false;
    } catch (_) {
      return false;
    }
  }

  function setEnabled(on) {
    if (!settings) return false;
    try {
      const result = settings.set('enabled', !!on);
      return !!(result && typeof result === 'object' && result.ok === true);
    } catch (_) {
      return false;
    }
  }

  function onTurnComplete(event) {
    if (!lifecycleReady) return;
    if (!event || event.type !== 'turn:complete') return;
    if (!enabled() || !hapticsSupported()) return;
    try { navigator.vibrate(COMPLETE_PATTERN); } catch (_) {}
  }

  if (ext) {
    try {
      const unsubscribe = ext.events.on('turn:complete', onTurnComplete);
      if (typeof unsubscribe === 'function') {
        lifecycleReady = true;
      } else {
        warn('turn:complete subscription was rejected; haptics disabled');
      }
    } catch (_) {
      warn('turn:complete subscription failed; haptics disabled');
    }
  }

  window.HermesMobileHapticsExtension = {
    version: '0.1.0',
    supported: hapticsSupported(),
    isEnabled: enabled,
    setEnabled,
    test() {
      if (!lifecycleReady || !hapticsSupported()) return false;
      try {
        navigator.vibrate(COMPLETE_PATTERN);
        return true;
      } catch (_) {
        return false;
      }
    },
  };

  if (!hapticsSupported()) {
    try {
      console.info('[' + EXT + '] navigator.vibrate not supported on this device (desktop / iOS Safari); haptics inactive.');
    } catch (_) {}
  }
})();
