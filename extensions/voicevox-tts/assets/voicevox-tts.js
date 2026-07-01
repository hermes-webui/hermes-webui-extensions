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

  // VOICEVOX engine base. Configurable via localStorage (hermes-ext-voicevox-base).
  // The speaker id is also configurable; default 1 (a standard VOICEVOX voice).
  const BASE_KEY = 'hermes-ext-voicevox-base';
  const DEF_BASE = 'http://127.0.0.1:50021';
  const SPEAKER_KEY = 'hermes-ext-voicevox-speaker';
  const CORE_VOICE_KEY = 'hermes-tts-voice';
  const CORE_ENGINE_KEY = 'hermes-tts-engine';

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

  function engineNow() {
    try { return localStorage.getItem(CORE_ENGINE_KEY) || 'browser'; }
    catch (_) { return 'browser'; }
  }

  function asId(raw) {
    var n = parseInt(raw, 10);
    return (Number.isFinite(n) && n >= 0) ? n : null;
  }

  // The raw speaker candidate, preferring the core voice selection (opts.voice
  // from the Settings dropdown / hermes-tts-voice) over the extension's own key.
  function rawCandidate(opts) {
    if (opts && opts.voice != null) { var ov = asId(opts.voice); if (ov != null) return ov; }
    var stored = asId(localStorage.getItem(SPEAKER_KEY));
    return stored != null ? stored : null;
  }

  function speakerId() {
    const v = parseInt(localStorage.getItem(SPEAKER_KEY) || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }

  // ── Long-text handling (Frank, PR #29) ───────────────────────────────────
  // VOICEVOX /audio_query 500s on very long / Markdown-heavy input even with a
  // valid speaker. The user path — click Listen on a long final answer — hits
  // exactly that. So before synthesis we (1) strip Markdown/code/URL noise that
  // shouldn't be read aloud anyway, then (2) split into bounded chunks on
  // sentence boundaries, synthesize each sequentially, and (3) concatenate the
  // returned WAVs into one buffer core can play.
  const MAX_CHUNK_CHARS = 1800;   // well under the ~4k+ where /audio_query starts 500ing

  // Flatten Markdown to speakable plain text: drop fenced code blocks, inline
  // code backticks, images, link URLs (keep the label), headings/emphasis/list
  // markers, blockquote markers, and collapse whitespace. Best-effort + safe:
  // anything unmatched passes through unchanged.
  function normalizeForSpeech(text) {
    var t = String(text == null ? '' : text);
    t = t.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks
    t = t.replace(/~~~[\s\S]*?~~~/g, ' ');            // fenced (tilde) code blocks
    t = t.replace(/`([^`]*)`/g, '$1');                // inline code -> its text
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // images -> drop
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links -> keep label
    t = t.replace(/<https?:\/\/[^>\s]+>/g, ' ');      // autolinks
    t = t.replace(/\bhttps?:\/\/[^\s)]+/g, ' ');      // bare URLs
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');         // ATX headings
    t = t.replace(/^\s{0,3}>\s?/gm, '');              // blockquote markers
    t = t.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');  // list markers
    t = t.replace(/(\*\*|__|\*|_|~~)/g, '');          // emphasis markers
    t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    return t;
  }

  // Split into <= MAX_CHUNK_CHARS pieces, preferring sentence/newline boundaries
  // (CJK 。！？ + ASCII .!? + newline), never breaking mid-token when avoidable.
  // A single oversized token is hard-split so we never emit a chunk over the cap.
  function chunkText(text) {
    var chunks = [];
    var parts = String(text).split(/(?<=[。．！？!?\n])/);
    var buf = '';
    function pushBuf() { var s = buf.trim(); if (s) chunks.push(s); buf = ''; }
    parts.forEach(function (p) {
      if (!p) return;
      if (p.length > MAX_CHUNK_CHARS) {          // pathological single sentence
        pushBuf();
        for (var i = 0; i < p.length; i += MAX_CHUNK_CHARS) {
          var slice = p.slice(i, i + MAX_CHUNK_CHARS).trim();
          if (slice) chunks.push(slice);
        }
        return;
      }
      if ((buf + p).length > MAX_CHUNK_CHARS) pushBuf();
      buf += p;
    });
    pushBuf();
    return chunks.length ? chunks : [String(text).trim()].filter(Boolean);
  }

  // Concatenate multiple RIFF/WAVE ArrayBuffers that share a format (same speaker
  // + engine ⇒ identical fmt) into one WAV: keep the first header, append each
  // one's `data` chunk payload, and rewrite the RIFF + data sizes. Falls back to
  // the first buffer if a header looks unexpected (defensive; still plays).
  function concatWavs(buffers) {
    buffers = buffers.filter(function (b) { return b && b.byteLength > 44; });
    if (buffers.length === 0) return new ArrayBuffer(0);
    if (buffers.length === 1) return buffers[0];

    function findDataChunk(view) {
      // RIFF(0..3) size(4..7) WAVE(8..11) then sub-chunks: id(4) size(4) body.
      if (view.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
      if (view.getUint32(8, false) !== 0x57415645) return null; // 'WAVE'
      var off = 12;
      while (off + 8 <= view.byteLength) {
        var id = view.getUint32(off, false);
        var sz = view.getUint32(off + 4, true);
        if (id === 0x64617461) return { start: off + 8, size: Math.min(sz, view.byteLength - off - 8) }; // 'data'
        off += 8 + sz + (sz & 1); // chunks are word-aligned
      }
      return null;
    }

    var first = new DataView(buffers[0]);
    var firstData = findDataChunk(first);
    if (!firstData) return buffers[0];               // unexpected header — play chunk 1
    var headerEnd = firstData.start;                 // bytes 0..headerEnd = header incl 'data' id+size
    var payloads = [];
    var total = 0;
    for (var i = 0; i < buffers.length; i++) {
      var dv = new DataView(buffers[i]);
      var dc = findDataChunk(dv);
      if (!dc) continue;
      var bytes = new Uint8Array(buffers[i], dc.start, dc.size);
      payloads.push(bytes); total += dc.size;
    }
    var out = new Uint8Array(headerEnd + total);
    out.set(new Uint8Array(buffers[0], 0, headerEnd), 0);   // header from first WAV
    var pos = headerEnd;
    payloads.forEach(function (p) { out.set(p, pos); pos += p.length; });
    var ov = new DataView(out.buffer);
    ov.setUint32(4, out.byteLength - 8, true);              // RIFF chunk size
    ov.setUint32(headerEnd - 4, total, true);               // data chunk size
    return out.buffer;
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

  // Resolve a speaker id that is KNOWN-VALID against the live /speakers list.
  // VOICEVOX returns 500 on /audio_query for an unknown speaker id, so stale
  // numeric browser state (an id that no longer exists on this engine build)
  // must be detected and replaced before we ever hit /audio_query. Returns a
  // Promise<{speaker, fallback, ids:Set, first, rejected}>. (Frank, PR #29.)
  function pickSpeaker(opts) {
    return fetchVoices().then(function (voices) {
      var ids = new Set(), first = null;
      (voices || []).forEach(function (v) {
        var n = parseInt(v.value, 10);
        if (Number.isFinite(n)) { ids.add(n); if (first == null) first = n; }
      });
      var cand = rawCandidate(opts);
      // No live list (empty) → trust the candidate (or default 1); can't validate.
      if (ids.size === 0) return { speaker: cand != null ? cand : 1, fallback: false, ids: ids, first: first };
      if (cand != null && ids.has(cand)) return { speaker: cand, fallback: false, ids: ids, first: first };
      // Stale / invalid / unset → fall back to the first real speaker and clear
      // the stale persisted values so the UI/state self-heals.
      try {
        if (cand != null) {
          if (asId(localStorage.getItem(CORE_VOICE_KEY)) === cand) localStorage.removeItem(CORE_VOICE_KEY);
          if (asId(localStorage.getItem(SPEAKER_KEY)) === cand) localStorage.removeItem(SPEAKER_KEY);
        }
      } catch (_) {}
      return { speaker: first != null ? first : 1, fallback: true, ids: ids, first: first, rejected: cand };
    }).catch(function () {
      // /speakers unavailable (server down) — don't block synthesis; use the raw
      // candidate or the default and let synthesis surface the real failure.
      var cand = rawCandidate(opts);
      return { speaker: cand != null ? cand : 1, fallback: false, ids: null, first: null };
    });
  }

  // One VOICEVOX synthesis pass for a concrete speaker id + a (already chunked,
  // already normalized) text slice. Two calls:
  //   1) POST /audio_query?text=...&speaker=N  -> a query JSON
  //   2) POST /synthesis?speaker=N  (body: the query JSON)  -> WAV audio bytes
  // credentials:'omit' — never send ambient cookies to the (possibly same-origin
  // proxy) VOICEVOX endpoint. (Codex gate, PR #29.) Errors carry the speaker id
  // AND the text length so a 500 is diagnosable as invalid-speaker vs too-long. (Frank, PR #29.)
  function synthOnce(base, text, speaker, opts) {
    const q = base + '/audio_query?text=' + encodeURIComponent(text) +
      '&speaker=' + encodeURIComponent(speaker);
    return fetch(q, { method: 'POST', credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('VOICEVOX audio_query failed: ' + r.status +
          ' (speaker ' + speaker + ', ' + text.length + ' chars)');
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
        if (!r.ok) throw new Error('VOICEVOX synthesis failed: ' + r.status + ' (speaker ' + speaker + ')');
        return r.arrayBuffer();   // WAV bytes -> core plays via <audio>
      });
  }

  // Synthesize one text slice, retrying ONCE with a known-valid speaker if
  // audio_query 500s specifically on an invalid speaker (not a length failure).
  // On success returns {buf, speaker} so the caller can lock the corrected
  // speaker in for the remaining chunks. (Frank, PR #29.)
  function synthSliceWithSpeakerFix(base, text, sel, opts) {
    return synthOnce(base, text, sel.speaker, opts)
      .then(function (buf) { return { buf: buf, speaker: sel.speaker }; })
      .catch(function (err) {
        var msg = (err && err.message) || '';
        var is500 = /audio_query failed: 500/.test(msg);
        // A 500 on SHORT text ⇒ invalid speaker (long text 500s are a different
        // class we've already avoided by chunking). Only retry the speaker fix
        // when this slice is short enough that length can't be the cause.
        var lengthCouldBeCause = text.length > 800;
        if (is500 && !lengthCouldBeCause && !sel.fallback &&
            sel.first != null && sel.first !== sel.speaker) {
          try {
            if (asId(localStorage.getItem(CORE_VOICE_KEY)) === sel.speaker) localStorage.removeItem(CORE_VOICE_KEY);
            if (asId(localStorage.getItem(SPEAKER_KEY)) === sel.speaker) localStorage.removeItem(SPEAKER_KEY);
          } catch (_) {}
          return synthOnce(base, text, sel.first, opts)
            .then(function (buf) { return { buf: buf, speaker: sel.first }; });
        }
        throw err;
      });
  }

  // Public entry point core calls. Normalize Markdown/URLs out, chunk long text,
  // synthesize each chunk sequentially (locking in a corrected speaker after the
  // first), and concatenate the WAVs so a single long assistant answer plays as
  // one clip instead of 500ing. (Frank, PR #29.)
  function synthesize(text, opts) {
    const base = baseUrl();
    const speak = normalizeForSpeech(text);
    if (!speak) return Promise.reject(new Error('VOICEVOX: nothing speakable after normalization'));
    const chunks = chunkText(speak);
    return pickSpeaker(opts).then(function (sel) {
      var buffers = [];
      // Sequential reduce: first chunk may correct the speaker; the rest reuse it.
      return chunks.reduce(function (chain, chunk, idx) {
        return chain.then(function (lockedSel) {
          return synthSliceWithSpeakerFix(base, chunk, lockedSel, opts)
            .then(function (res) {
              buffers.push(res.buf);
              // After the first slice, treat the (possibly corrected) speaker as
              // fixed so we don't re-attempt the fallback on every chunk.
              return { speaker: res.speaker, first: lockedSel.first, fallback: true };
            });
        });
      }, Promise.resolve(sel)).then(function () {
        return concatWavs(buffers);
      });
    });
  }

  // The first option label written by THIS extension. Used to detect whether the
  // voice <select> is currently "owned" by us vs. wiped back to core's built-in
  // (browser/edge/elevenlabs) options, so re-ownership doesn't loop.
  var OWNED_FIRST_LABELS = ['Loading voices...', 'Default speaker', 'No voices available', 'Failed to load voices'];
  function selectOwnedByVv(sel) {
    if (!sel || !sel.options || !sel.options.length) return false;
    return OWNED_FIRST_LABELS.indexOf(sel.options[0].textContent) !== -1;
  }

  function populateVoiceDropdown(sel) {
    if (!sel) return;
    // Persist a chosen VOICEVOX voice on change (core also binds this, but bind
    // defensively so a selection made before core re-binds still persists).
    sel.onchange = function () { try { localStorage.setItem(CORE_VOICE_KEY, this.value); } catch (_) {} };
    sel.innerHTML = '<option value="">Loading voices...</option>';
    fetchVoices().then(function (voices) {
      if (!voices || !voices.length) { sel.innerHTML = '<option value="">No voices available</option>'; return; }
      var validIds = new Set();
      voices.forEach(function (v) { validIds.add(String(v.value)); });
      var cur = localStorage.getItem(CORE_VOICE_KEY) || '';
      // Clear stale state: a saved voice that isn't a valid VOICEVOX speaker id
      // (e.g. an edge/browser voice name left over from another engine, or a
      // speaker id this engine build no longer has) would otherwise reach
      // /audio_query as an invalid speaker and 500. (Frank, PR #29.)
      if (cur && !validIds.has(cur)) { try { localStorage.removeItem(CORE_VOICE_KEY); } catch (_) {} cur = ''; }
      sel.innerHTML = '<option value="">Default speaker</option>';
      voices.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v.value; opt.textContent = v.label;
        if (v.value === cur) opt.selected = true;
        sel.appendChild(opt);
      });
    }).catch(function () { sel.innerHTML = '<option value="">Failed to load voices</option>'; });
  }

  // ── Re-own the voice dropdown across every core repaint ───────────────────
  // Core's _populateTtsVoices() treats any non-built-in engine as browser TTS
  // (its `else` branch), so on Settings save / section switch / panel re-open it
  // wipes our VOICEVOX list back to "Default system voice". Wrap the core fn so
  // that whenever the active engine is VOICEVOX, WE own the dropdown; otherwise
  // delegate to core unchanged. Core reassigns window._populateTtsVoices on each
  // loadSettingsPanel, so the MutationObserver re-installs this wrapper. (Frank, PR #29.)
  function wrapCorePopulate() {
    var core = window._populateTtsVoices;
    if (typeof core !== 'function' || core.__vvWrapped) return;
    var wrapped = function () {
      if (engineNow() === 'voicevox') {
        var s = document.getElementById('settingsTtsVoice');
        if (s) populateVoiceDropdown(s);
        return;
      }
      return core.apply(this, arguments);
    };
    wrapped.__vvWrapped = true;
    wrapped.__vvCore = core;
    window._populateTtsVoices = wrapped;
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

  // Reconcile the URL field visibility to the current engine. Idempotent — safe
  // to call every observer tick. Reads the EFFECTIVE engine (the select value if
  // present, else persisted state) rather than only the select, because core
  // sets settingsTtsEngine.value AFTER our first hook fires, without a `change`
  // event — so a one-shot onEngineChange() at hook time would leave the field
  // hidden while VOICEVOX is actually selected. (Frank, PR #29.)
  function syncUrlFieldVisibility() {
    var f = document.getElementById('settingsVoicevoxUrlField');
    if (!f) return;
    var es = document.getElementById('settingsTtsEngine');
    var eng = (es && es.value) ? es.value : engineNow();
    f.style.display = (eng === 'voicevox') ? '' : 'none';
  }

  function onEngineChange() {
    syncUrlFieldVisibility();
    var es = document.getElementById('settingsTtsEngine');
    var eng = es ? es.value : 'browser';
    if (eng === 'voicevox') {
      var s = document.getElementById('settingsTtsVoice');
      if (s) populateVoiceDropdown(s);
    }
  }

  new MutationObserver(function () {
    injectUrlField();
    // Keep our wrapper installed over whatever _populateTtsVoices core last assigned.
    wrapCorePopulate();
    var es = document.getElementById('settingsTtsEngine');
    if (es && !es.__vvHooked) {
      es.__vvHooked = true;
      es.addEventListener('change', onEngineChange);
      onEngineChange();
    }
    // Keep the URL field visibility in sync with the effective engine every tick
    // (core may set the engine value after our first hook, with no change event).
    syncUrlFieldVisibility();
    // If VOICEVOX is the active engine but core just repainted the voice list
    // back to its built-ins (not owned by us), re-own it. selectOwnedByVv guards
    // against re-entrancy so this can't loop on our own writes.
    if (engineNow() === 'voicevox') {
      var s = document.getElementById('settingsTtsVoice');
      if (s && !selectOwnedByVv(s)) populateVoiceDropdown(s);
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
