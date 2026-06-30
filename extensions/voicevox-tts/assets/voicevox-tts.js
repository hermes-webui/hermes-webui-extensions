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

  // ── iOS Safari audio unlock ────────────────────────────────────────
  // iOS Safari suspends AudioContext until the first user gesture (touch/
  // click).  Without this the extension returns valid WAV bytes but the
  // core's <audio> / AudioContext playback produces silence.  A one-shot
  // silent buffer on the first interaction unlocks the audio subsystem.
  (function installIOSAudioUnlock() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;   // no Web Audio API → nothing to unlock
    function unlock() {
      try {
        var ctx = new AC();
        var buf = ctx.createBuffer(1, 1, 22050);   // 1 sample of silence
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        if (ctx.state === 'suspended') ctx.resume();
        setTimeout(function () { ctx.close(); }, 1000);
      } catch (_) { /* best-effort unlock */ }
    }
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('click',     unlock, { once: true });
  })();

  // VOICEVOX engine base. Configurable via localStorage (hermes-ext-voicevox-base).
  // The speaker id is also configurable; default 1 (a standard VOICEVOX voice).
  const BASE_KEY = 'hermes-ext-voicevox-base';
  const DEF_BASE = 'http://127.0.0.1:50021';
  const SPEAKER_KEY = 'hermes-ext-voicevox-speaker';

  // Accept ONLY a loopback http(s) host, OR a safe root-relative same-origin proxy
  // path (single leading slash, no protocol-relative '//', no query/hash). This
  // keeps the loopback-only / network_external:false disclosure honest — an
  // arbitrary external host is rejected and falls back to the default. (Codex gate, PR #29.)
  function isLoopbackHost(h) {
    h = (h || '').toLowerCase();
    if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
    // 127.0.0.0/8
    var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m && m[1] === '127') return true;
    return false;
  }
  function baseUrl() {
    var v = (localStorage.getItem(BASE_KEY) || '').trim();
    if (!v) return DEF_BASE;
    // Same-origin proxy path: a SINGLE leading slash, reject protocol-relative '//'
    // and any query/hash so it can't smuggle an off-origin target.
    if (v.charAt(0) === '/') {
      if (v.charAt(1) === '/') return DEF_BASE;          // protocol-relative → reject
      if (v.indexOf('?') >= 0 || v.indexOf('#') >= 0) return DEF_BASE;
      return v.replace(/\/+$/, '');
    }
    try {
      var u = new URL(v);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname)) {
        return v.replace(/\/+$/, '');
      }
    } catch (_) {}
    return DEF_BASE;                                       // anything else → loopback default
  }

  // Resolve the speaker id, preferring the core voice selection (opts.voice from
  // the Settings dropdown / hermes-tts-voice) over the extension's own key, both
  // validated as a non-negative integer. (Codex gate, PR #29.)
  function resolveSpeaker(opts) {
    function asId(raw) {
      var n = parseInt(raw, 10);
      return (Number.isFinite(n) && n >= 0) ? n : null;
    }
    if (opts && opts.voice != null) { var ov = asId(opts.voice); if (ov != null) return ov; }
    var stored = asId(localStorage.getItem(SPEAKER_KEY));
    return stored != null ? stored : 1;
  }

  function speakerId() {
    const v = parseInt(localStorage.getItem(SPEAKER_KEY) || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }

  // VOICEVOX synthesis is two calls:
  //   1) POST /audio_query?text=...&speaker=N  -> a query JSON
  //   2) POST /synthesis?speaker=N  (body: the query JSON)  -> WAV audio bytes
  // credentials:'omit' — never send ambient cookies to the (possibly same-origin
  // proxy) VOICEVOX endpoint. (Codex gate, PR #29.)
  function synthesize(text, opts) {
    const base = baseUrl();
    const speaker = resolveSpeaker(opts);
    const q = base + '/audio_query?text=' + encodeURIComponent(text) +
      '&speaker=' + encodeURIComponent(speaker);
    return fetch(q, { method: 'POST', credentials: 'omit' })
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
        return fetch(base + '/synthesis?speaker=' + encodeURIComponent(speaker), {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('VOICEVOX synthesis failed: ' + r.status);
        return r.arrayBuffer();   // WAV bytes -> core plays via <audio>
      });
  }

  // ── Voice list ───────────────────────────────────────────────────
  var _voiceCache = null, _voiceCacheTs = 0, _voiceCacheBase = null;

  function fetchVoices() {
    var cb = baseUrl();
    if (_voiceCache && _voiceCacheBase === cb && Date.now() - _voiceCacheTs < 30000)
      return Promise.resolve(_voiceCache);
    return fetch(cb + '/speakers', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('speakers ' + r.status); return r.json(); })
      .then(function (speakers) {
        var voices = [];
        speakers.forEach(function (sp) {
          (sp.styles || []).forEach(function (st) {
            voices.push({ value: String(st.id), label: sp.name + ' (' + st.name + ')' });
          });
        });
        _voiceCache = voices; _voiceCacheTs = Date.now(); _voiceCacheBase = cb;
        return voices;
      });
  }

  function populateVoiceDropdown(sel) {
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading voices...</option>';
    fetchVoices().then(function (voices) {
      if (!voices || !voices.length) { sel.innerHTML = '<option value="">No voices available</option>'; return; }
      var cur = localStorage.getItem('hermes-tts-voice') || '';
      sel.innerHTML = '<option value="">Default speaker</option>';
      voices.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v.value; opt.textContent = v.label;
        if (v.value === cur) opt.selected = true;
        sel.appendChild(opt);
      });
    }).catch(function () { sel.innerHTML = '<option value="">Failed to load voices</option>'; });
  }

  // ── URL field + MutationObserver ──────────────────────────────────-
  var _urlInjected = false;
  function injectUrlField() {
    if (_urlInjected) return;
    var vs = document.getElementById('settingsTtsVoice');
    if (!vs) return;
    var vf = vs.closest('.settings-field');
    if (!vf) return;
    var div = document.createElement('div');
    div.className = 'settings-field'; div.id = 'settingsVoicevoxUrlField';
    div.style.display = 'none';
    div.innerHTML = '<label for="settingsVoicevoxUrl">VOICEVOX Server URL</label>'
      + '<input type="text" id="settingsVoicevoxUrl" style="width:100%;padding:8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px" placeholder="http://127.0.0.1:50021">'
      + '<div style="font-size:11px;color:var(--muted);margin-top:4px">Override the VOICEVOX server address. Defaults to the standard loopback. Use a relative path for same-origin proxies.</div>';
    vf.parentNode.insertBefore(div, vf.nextSibling);
    var inp = document.getElementById('settingsVoicevoxUrl');
    if (inp) {
      inp.value = localStorage.getItem(BASE_KEY) || DEF_BASE;
      inp.oninput = function () {
        var v = this.value.trim();
        if (v) localStorage.setItem(BASE_KEY, v); else localStorage.removeItem(BASE_KEY);
        if (window.__vvUrlTimer) clearTimeout(window.__vvUrlTimer);
        window.__vvUrlTimer = setTimeout(function () {
          _voiceCache = null;
          var s = document.getElementById('settingsTtsVoice');
          if (s) populateVoiceDropdown(s);
        }, 400);
      };
    }
    _urlInjected = true;
  }

  function onEngineChange() {
    var f = document.getElementById('settingsVoicevoxUrlField');
    var es = document.getElementById('settingsTtsEngine');
    var eng = es ? es.value : 'browser';
    if (f) f.style.display = (eng === 'voicevox') ? '' : 'none';
    if (eng === 'voicevox') {
      var s = document.getElementById('settingsTtsVoice');
      if (s) populateVoiceDropdown(s);
    }
  }

  new MutationObserver(function () {
    injectUrlField();
    var es = document.getElementById('settingsTtsEngine');
    if (es && !es.__vvHooked) {
      es.__vvHooked = true;
      es.addEventListener('change', onEngineChange);
      onEngineChange();
    }
  }).observe(document.body, { childList: true, subtree: true });

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
        base: baseUrl(),
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
