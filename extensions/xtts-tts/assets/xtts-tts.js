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
  // The daemon owns language and speaker: it splits long input and concatenates
  // the result, so we POST the whole reply text and return the single WAV it
  // answers with. We pick the language by script (Cyrillic → ru, else en), the
  // same rule Hermes Agent's own tts_xtts.sh wrapper applies.

  const EXT = 'xtts-tts';
  const ENGINE_ID = 'xtts';
  const DEFAULT_DAEMON = 'http://127.0.0.1:3032/';
  const DEFAULT_SPEAKER = 'Viktor Menelaos';
  const CYRILLIC_RE = /[\u0400-\u04FF]/;

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
  function daemonUrl() {
    const raw = String(getSetting('daemon_url', '') || '').trim() || DEFAULT_DAEMON;
    try {
      const url = new URL(raw);
      const host = url.hostname;
      const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
      if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopback) {
        return url.href.endsWith('/') ? url.href : url.href + '/';
      }
    } catch (_) {}
    warn('daemon_url is not a loopback http(s) origin; using the default');
    return DEFAULT_DAEMON;
  }

  function speaker() {
    return String(getSetting('speaker', '') || '').trim() || DEFAULT_SPEAKER;
  }

  function detectLanguage(text) {
    return CYRILLIC_RE.test(text) ? 'ru' : 'en';
  }

  function isWav(buffer) {
    const h = new Uint8Array(buffer.slice(0, 12));
    return h.length >= 12
      && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 // "RIFF"
      && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45; // "WAVE"
  }

  // synthesize(text, opts) -> Promise<ArrayBuffer> of WAV audio.
  // `opts` carries the user's saved { voice, rate, pitch }; XTTS ignores them —
  // the daemon owns the speaker and prosody — so we accept and drop them.
  async function synthesize(text) {
    if (!enabled()) throw new Error('XTTS engine is disabled in extension settings');
    const clean = String(text || '').replace(/\u0000/g, '').trim();
    if (!clean) throw new Error('empty text');

    const body = JSON.stringify({
      text: clean,
      language: detectLanguage(clean),
      speaker: speaker(),
    });

    const resp = await fetch(daemonUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (_) {}
      throw new Error('XTTS daemon HTTP ' + resp.status + (detail ? ': ' + detail : ''));
    }

    const buffer = await resp.arrayBuffer();
    // Never hand an error/empty body back as audio — core would play silence.
    if (!isWav(buffer)) throw new Error('XTTS daemon returned a non-WAV body');
    return buffer;
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
    version: '0.1.0',
    engineId: ENGINE_ID,
    isRegistered: () => typeof window._hermesTtsIsRegistered === 'function'
      && window._hermesTtsIsRegistered(ENGINE_ID),
    isEnabled: enabled,
    daemonUrl,
    speaker,
    synthesize,
  };
})();
