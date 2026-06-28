(() => {
  'use strict';

  // ── VOICEVOX TTS extension for Hermes WebUI ──────────────────────────────
  // Registers VOICEVOX (a free, locally-hosted Japanese TTS engine) as a
  // selectable TTS engine via the core theme-style registration hook
  // window.registerHermesTtsEngine (nesquena/hermes-webui — TTS-engine
  // registration capability). Once selected in Settings -> TTS Engine, both the
  // per-message "Listen" button and hands-free voice mode synthesize speech
  // through your local VOICEVOX server.
  //
  // VOICEVOX runs locally (default http://127.0.0.1:50021). This extension only
  // talks to that loopback address; it makes no external network calls. If the
  // server isn't running, synthesis fails gracefully (core shows a toast / falls
  // back to listening).
  //
  // Credit: design reference is closed core PR #4116 (@luperrypf) — the
  // security-clean VOICEVOX integration (hardcoded localhost, no SSRF). This is
  // the extension form, built on the core TTS-engine registration hook.

  const EXT = 'voicevox-tts';
  if (window.__hermesVoicevoxLoaded) return;
  window.__hermesVoicevoxLoaded = true;

  // VOICEVOX engine base. Loopback only (no external network). The speaker id
  // is configurable via localStorage; default 1 (a standard VOICEVOX voice).
  const BASE = 'http://127.0.0.1:50021';
  const SPEAKER_KEY = 'hermes-ext-voicevox-speaker';

  function speakerId() {
    const v = parseInt(localStorage.getItem(SPEAKER_KEY) || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }

  // VOICEVOX synthesis is two calls:
  //   1) POST /audio_query?text=...&speaker=N  -> a query JSON
  //   2) POST /synthesis?speaker=N  (body: the query JSON)  -> WAV audio bytes
  function synthesize(text, opts) {
    const speaker = speakerId();
    const q = BASE + '/audio_query?text=' + encodeURIComponent(text) +
      '&speaker=' + encodeURIComponent(speaker);
    return fetch(q, { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('VOICEVOX audio_query failed: ' + r.status);
        return r.json();
      })
      .then(function (query) {
        // Optional: nudge speed from the user's saved rate (VOICEVOX uses
        // speedScale ~0.5..2). opts.rate is the core slider (1 = normal).
        if (opts && typeof opts.rate === 'number' && !isNaN(opts.rate)) {
          query.speedScale = Math.min(2, Math.max(0.5, opts.rate));
        }
        return fetch(BASE + '/synthesis?speaker=' + encodeURIComponent(speaker), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('VOICEVOX synthesis failed: ' + r.status);
        return r.arrayBuffer();   // WAV bytes -> core plays via <audio>
      });
  }

  function register(attempt) {
    attempt = attempt || 0;
    if (typeof window.registerHermesTtsEngine === 'function') {
      const ok = window.registerHermesTtsEngine({
        id: 'voicevox',
        label: 'VOICEVOX (local)',
        synthesize: synthesize,
      });
      if (!ok) console.warn('[' + EXT + '] registerHermesTtsEngine rejected the descriptor');
      window.HermesVoicevoxExtension = {
        version: '0.1.0',
        getSpeaker: speakerId,
        setSpeaker: function (n) { try { localStorage.setItem(SPEAKER_KEY, String(parseInt(n, 10))); } catch (_) {} },
        base: BASE,
      };
      return true;
    }
    // Core TTS-engine capability not present yet (older WebUI / boot.js not parsed).
    if (attempt < 40) { setTimeout(function () { register(attempt + 1); }, 150); return false; }
    console.warn('[' + EXT + '] window.registerHermesTtsEngine unavailable; VOICEVOX not registered (needs the core TTS-engine registration capability)');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { register(); }, { once: true });
  } else {
    register();
  }
})();
