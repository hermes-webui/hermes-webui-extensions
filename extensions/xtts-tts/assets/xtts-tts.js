(() => {
  'use strict';

  // ── XTTS v2 (local studio voice) — Hermes WebUI TTS engine extension ─────
  // Registers a speech engine (Settings → TTS Engine) that synthesizes through
  // a local XTTS v2 HTTP daemon on loopback. Loopback origins are already in
  // WebUI's enforced CSP connect-src, so the browser talks to the daemon
  // directly: no core changes, no backend route, no proxied traffic.
  //
  // Contract (docs/EXTENSIONS.md → "Registering a custom TTS engine"):
  //   window.registerHermesTtsEngine({ id, label, synthesize })
  // `id` must not shadow a built-in engine (browser/edge/elevenlabs/openai are
  // reserved). Core owns selection, the dropdown option, and playback; this
  // script only produces audio bytes for the text it is handed.
  //
  // The daemon owns splitting and concatenation of long input, so we POST the
  // whole reply text and return the single WAV it answers with. Language comes
  // from the extension setting, or by script when it is set to "auto"
  // (Cyrillic → ru, otherwise en). Reference daemon (HTTP contract, CORS,
  // install and start commands): https://github.com/gaidar0yegor/xtts-tts-daemon

  const EXT = 'xtts-tts';
  const ENGINE_ID = 'xtts';
  const DEFAULT_DAEMON = 'http://127.0.0.1:8120/';
  const DEFAULT_SPEAKER = 'Viktor Menelaos';
  const CYRILLIC_RE = /[\u0400-\u04FF]/;
  // Generous: a long reply on a CPU-only daemon is slow, but a promise that
  // never settles blocks voice mode from reopening the mic.
  const REQUEST_TIMEOUT_MS = 120000;
  // The 17 languages XTTS v2 was trained on.
  const LANGUAGES = new Set([
    'en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl',
    'cs', 'ar', 'zh-cn', 'ja', 'hu', 'ko', 'hi',
  ]);

  if (window.__hermesXttsTtsLoaded) return;
  window.__hermesXttsTtsLoaded = true;

  function warn(message) {
    try { console.warn('[' + EXT + '] ' + message); } catch (_) {}
  }

  // ── Scoped settings (hermesExt.register) with safe defaults ──────────────
  let settings = null;
  try {
    const api = window.hermesExt;
    if (api && typeof api.register === 'function') {
      const ext = api.register(EXT);
      if (ext && ext.id === EXT && ext.settings) settings = ext.settings;
    }
  } catch (_) {
    warn('scoped settings unavailable; using defaults');
  }

  function getSetting(key, fallback) {
    if (settings && typeof settings.get === 'function') {
      try {
        const value = settings.get(key);
        if (value !== undefined && value !== null) return value;
      } catch (_) {}
    }
    return fallback;
  }

  function enabled() {
    return getSetting('enabled', true) !== false;
  }

  // Only ever talk to loopback. A non-loopback value is refused (fail closed)
  // so the saved setting can never redirect audio synthesis off-box.
  // IPv6 loopback is deliberately NOT accepted: WebUI's enforced CSP allows
  // 127.0.0.1 and localhost but not [::1], so such a URL would pass this check
  // and then fail inside the browser.
  function daemonUrl() {
    const raw = String(getSetting('daemon_url', '') || '').trim() || DEFAULT_DAEMON;
    try {
      const url = new URL(raw);
      const host = url.hostname;
      const isLoopback = host === '127.0.0.1' || host === 'localhost';
      if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopback) {
        return url.href.endsWith('/') ? url.href : url.href + '/';
      }
    } catch (_) {}
    warn('daemon_url is not a loopback http(s) origin; using the default');
    return DEFAULT_DAEMON;
  }

  // A daemon URL on the WebUI's own origin would POST the reply text to core's
  // API with the session cookie and CSRF header. Refuse instead of falling back:
  // the fallback is checked the same way, and silently retrying at the WebUI
  // origin is the one outcome we must never allow.
  function assertNotWebuiOrigin(href) {
    let origin;
    try { origin = new URL(href).origin; } catch (_) { return; }
    const own = (typeof window.location === 'object' && window.location && window.location.origin) || '';
    if (own && origin === own) {
      throw new Error(
        'XTTS daemon_url resolves to the WebUI origin (' + origin + '); '
        + 'point it at the daemon port instead'
      );
    }
  }

  function speaker() {
    return String(getSetting('speaker', '') || '').trim() || DEFAULT_SPEAKER;
  }

  function language(text) {
    const configured = String(getSetting('language', 'auto') || 'auto').trim().toLowerCase();
    if (configured !== 'auto' && LANGUAGES.has(configured)) return configured;
    return CYRILLIC_RE.test(text) ? 'ru' : 'en';
  }

  function isWav(buffer) {
    const h = new Uint8Array(buffer.slice(0, 12));
    return h.length >= 12
      && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 // "RIFF"
      && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45; // "WAVE"
  }

  function unreachable(url, error) {
    const detail = (error && error.message) ? ': ' + error.message : '';
    return new Error(
      'XTTS daemon unreachable at ' + url + detail
      + ' — is the daemon running, and does it allow CORS from this page?'
    );
  }

  function timedOut(url) {
    return new Error(
      'XTTS daemon at ' + url + ' did not answer within '
      + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' s (long replies on a CPU-only daemon are slow)'
    );
  }

  // synthesize(text, opts) -> Promise<ArrayBuffer> of WAV audio.
  // `opts` carries the user's saved { voice, rate, pitch }; XTTS ignores them —
  // the daemon owns the speaker and prosody — so we accept and drop them.
  async function synthesize(text) {
    if (!enabled()) throw new Error('XTTS engine is disabled in extension settings');
    const clean = String(text || '').replace(/\u0000/g, '').trim();
    if (!clean) throw new Error('empty text');

    const url = daemonUrl();
    assertNotWebuiOrigin(url);

    const body = JSON.stringify({
      text: clean,
      language: language(clean),
      speaker: speaker(),
    });

    // One deadline covers fetch AND reading the body: a daemon that accepts the
    // connection and then stalls must not leave Listen pending forever.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS) : null;

    try {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          // Never send WebUI's cookies/CSRF token to the daemon.
          credentials: 'omit',
          // Keep the request on loopback even if the port answers 3xx.
          redirect: 'error',
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (error) {
        if (controller && controller.signal.aborted) throw timedOut(url);
        throw unreachable(url, error);
      }

      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch (_) {}
        throw new Error('XTTS daemon HTTP ' + resp.status + (detail ? ': ' + detail : ''));
      }

      let buffer;
      try {
        buffer = await resp.arrayBuffer();
      } catch (error) {
        if (controller && controller.signal.aborted) throw timedOut(url);
        throw new Error('XTTS daemon response could not be read: ' + (error && error.message));
      }

      // Never hand an error/empty body back as audio — core would play silence.
      if (!isWav(buffer)) throw new Error('XTTS daemon returned a non-WAV body');
      return buffer;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function registerEngine() {
    if (typeof window.registerHermesTtsEngine !== 'function') {
      warn('core registerHermesTtsEngine is unavailable (older WebUI); engine not registered');
      return false;
    }
    try {
      const ok = window.registerHermesTtsEngine({
        id: ENGINE_ID,
        label: 'XTTS v2 (local studio voice)',
        synthesize,
      });
      if (!ok) warn('core rejected the engine registration (reserved or invalid id)');
      return !!ok;
    } catch (error) {
      warn('engine registration threw: ' + (error && error.message));
      return false;
    }
  }

  const registered = registerEngine();
  // boot.js may define the registry after this script on a cold load; retry once.
  if (!registered) {
    try {
      window.addEventListener('load', () => {
        if (typeof window.registerHermesTtsEngine === 'function') registerEngine();
      }, { once: true });
    } catch (_) {}
  }

  window.HermesXttsTtsExtension = {
    version: '0.2.0',
    engineId: ENGINE_ID,
    timeoutMs: REQUEST_TIMEOUT_MS,
    isRegistered: () => typeof window._hermesTtsIsRegistered === 'function'
      && window._hermesTtsIsRegistered(ENGINE_ID),
    isEnabled: enabled,
    daemonUrl,
    speaker,
    language,
    synthesize,
  };
})();
