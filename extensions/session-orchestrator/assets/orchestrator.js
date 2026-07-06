// Session Orchestrator — Voice-commanded multi-session management
// Usage: speak or type "new session dev", "switch session dev", "start prompt",
//        "stop prompt", "read session dev", "maximise session".
// Dependencies: existing voice mode (boot.js SpeechRecognition), chat-tiling grid,
//               SessionChannel SSE, playNotificationSound/sendBrowserNotification.
// Install: register in extension-install-manifest.json, reload WebUI.

(() => {
  'use strict';
  if (window.__sessionOrchestratorLoaded) return;
  window.__sessionOrchestratorLoaded = true;

  const EXT = 'session-orchestrator';
  const LS_KEY = 'hwx-orch-state';

  // ── Settings (from HermesExtensionSettings API) ──
  const gs = (k, d) => {
    try {
      const w = window.HermesExtensionSettings;
      if (w) { const x = w.settingsForExtension(EXT); return x.get(k) != null ? x.get(k) : d; }
    } catch (_) {}
    return d;
  };

  // ── Command Schema ──
  // Each entry: { pattern: regex with named capture groups, action: string, parse: function }
  // The parser matches against lowercased transcript, extracts params from groups.
  const COMMANDS = [
    // new session <alias> — creates a new session and registers the alias
    { re: /^new session\s+(.+)$/i,          action: 'newSession' },
    // switch [to] session <alias> — focuses existing session by alias or sid
    { re: /^switch\s+(?:to\s+)?session\s+(.+)$/i, action: 'switchSession' },
    // start [prompt|recording] — opens input buffer for active session
    { re: /^(?:start\s+)?(?:prompt|recording)$/i, action: 'startPrompt' },
    // stop [prompt|recording|and send] — closes buffer and dispatches
    { re: /^(?:stop\s+)?(?:prompt|recording)(?:\s+and\s+send)?$/i, action: 'stopPrompt' },
    // read [session] <alias> — speaks latest response from session
    { re: /^read\s+(?:session\s+)?(.+)$/i,  action: 'readSession' },
    // maximise [session] — expands active session to full view
    { re: /^maximi[sz]e\s+(?:session\s+)?(.+)?$/i, action: 'maximize' },
    // close [session] <alias> — closes a tile / removes alias
    { re: /^close\s+(?:session\s+)?(.+)$/i, action: 'closeSession' },
    // list sessions — enumerate all tracked aliases
    { re: /^(?:list|show)\s+sessions$/i,    action: 'listSessions' },
    // help — speak available commands
    { re: /^(?:help|what can I say)\s*$/i,  action: 'help' },
  ];

  // ── State ──
  const O = {
    // alias → { sid, session_id, createdAt }
    aliases: {},
    // Reverse: session_id → alias (for lookups)
    reverse: {},
    activeAlias: null,       // currently focused alias
    bufferOpen: false,       // start prompt issued?
    inputBuffer: '',         // accumulated text since start prompt
    bufferTimer: null,       // silence timeout for buffer flush
    processingAliases: new Set(), // aliases with in-flight streams
    enabled: false,          // orchestrator mode active?
    _origVoiceSend: null,    // saved original _voiceModeSend
    _origHandleBg: null,     // saved original _handleBgTaskCompleteEvent
    _busyWatch: null,
    _prevBusy: false,
  };

  // ── CSS (inlined) ──
  document.head.appendChild(Object.assign(document.createElement('style'), {
    textContent: `
#orch-status {
  display:none; align-items:center; gap:6px; padding:4px 10px; margin:0;
  font-size:11px; border-radius:8px; background:var(--accent-bg); color:var(--accent);
  border:1px solid var(--accent); position:relative;
}
#orch-status.orch-active { display:inline-flex; }
#orch-status .orch-dot { width:6px;height:6px;border-radius:50%;background:var(--accent);animation:orch-pulse 1.2s infinite }
@keyframes orch-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
#orch-buffer-indicator {
  display:none; position:fixed; bottom:60px; left:50%; transform:translateX(-50%);
  padding:6px 16px; border-radius:20px; background:var(--accent); color:#fff;
  font-size:13px; font-weight:600; z-index:9999;
  box-shadow:0 2px 12px rgba(0,0,0,.3);
}
#orch-buffer-indicator.orch-recording { display:block; }
.orch-alias-badge {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:16px; height:16px; padding:0 5px; border-radius:999px;
  background:var(--accent); color:#fff; font-size:9px; font-weight:700;
  line-height:1; margin-left:4px; vertical-align:middle;
}
.orch-alias-badge.orch-processing { background:#f59e0b; animation:orch-pulse 1s infinite; }
.orch-alias-badge.orch-ready { background:#22c55e; }
`
  }));

  // ── Command Parser ──
  function parseCommand(text) {
    const trimmed = text.trim().toLowerCase().replace(/[.!?]+$/, '');
    for (const cmd of COMMANDS) {
      const m = trimmed.match(cmd.re);
      if (m) {
        // Extract named or positional args
        const args = m.slice(1).filter(Boolean);
        return { action: cmd.action, args, raw: trimmed };
      }
    }
    return null;
  }

  // ── Session Alias Registry ──
  function resolveAlias(name) {
    const key = name.toLowerCase().trim();
    return O.aliases[key] || null;
  }

  function registerAlias(name, sessionData) {
    const key = name.toLowerCase().trim();
    if (O.aliases[key]) {
      speakText('Overwriting existing session ' + name);
    }
    const sid = sessionData.session_id;
    O.aliases[key] = { sid, session_id: sid, name, createdAt: Date.now() };
    O.reverse[sid] = key;
    saveState();
    updateBadge(key, 'active');
  }

  function unregisterAlias(name) {
    const key = name.toLowerCase().trim();
    const entry = O.aliases[key];
    if (!entry) return false;
    delete O.reverse[entry.sid];
    delete O.aliases[key];
    removeBadge(entry.sid);
    if (O.activeAlias === key) O.activeAlias = null;
    saveState();
    return true;
  }

  function aliasForSid(sid) {
    return O.reverse[sid] || sid.slice(0, 8);
  }

  // ── Command Handlers ──
  function execCommand(parsed) {
    if (!parsed) return false;

    switch (parsed.action) {
      case 'newSession': {
        const name = parsed.args[0] || 'default';
        // Call existing newSession() in sessions.js
        if (typeof window.newSession === 'function') {
          (async () => {
            try {
              const data = await window.newSession(false, {});
              if (data && data.session_id) {
                registerAlias(name, data);
                speakText('Session ' + name + ' initialized.');
                O.activeAlias = name;
              }
            } catch (e) {
              speakText('Failed to create session.');
            }
          })();
        } else {
          speakText('Cannot create session — newSession not available.');
        }
        return true;
      }

      case 'switchSession': {
        const name = parsed.args[0];
        const entry = resolveAlias(name);
        if (!entry) {
          speakText('Session ' + name + ' does not exist. Say new session ' + name + ' to create it.');
          return true;
        }
        if (typeof window.loadSession === 'function') {
          window.loadSession(entry.sid);
          O.activeAlias = entry.name;
          speakText('Switched to session ' + name);
        }
        // Update tile focus if tiling extension is active
        if (typeof window.focusTileExt === 'function') {
          window.focusTileExt(entry.sid);
        }
        return true;
      }

      case 'startPrompt': {
        if (O.bufferOpen) {
          speakText('Already recording.');
          return true;
        }
        // Check if active session is processing
        if (O.activeAlias && O.processingAliases.has(O.activeAlias)) {
          speakText('Session ' + O.activeAlias + ' is already processing.');
          return true;
        }
        O.bufferOpen = true;
        O.inputBuffer = '';
        document.getElementById('orch-buffer-indicator')?.classList.add('orch-recording');
        speakText('Recording.');
        return true;
      }

      case 'stopPrompt': {
        if (!O.bufferOpen) return true;
        O.bufferOpen = false;
        document.getElementById('orch-buffer-indicator')?.classList.remove('orch-recording');
        clearTimeout(O.bufferTimer);
        flushBuffer();
        return true;
      }

      case 'readSession': {
        const name = parsed.args[0];
        const entry = resolveAlias(name);
        if (!entry) {
          speakText('Session ' + name + ' does not exist.');
          return true;
        }
        (async () => {
          try {
            const data = await window.api('/api/session?session_id=' + encodeURIComponent(entry.sid));
            const msgs = data && data.messages;
            if (msgs && msgs.length > 0) {
              const last = msgs[msgs.length - 1];
              const content = typeof last.content === 'string' ? last.content : '';
              if (content) {
                speakText(content.slice(0, 500));
              } else {
                speakText('Session ' + name + ' has no response yet.');
              }
            } else {
              speakText('Session ' + name + ' is empty.');
            }
          } catch (e) {
            speakText('Could not read session ' + name + '.');
          }
        })();
        return true;
      }

      case 'maximize': {
        // Toggle maximize on the current tile if tiling extension present
        const sid = O.activeAlias ? resolveAlias(O.activeAlias)?.sid : null;
        if (sid && typeof window.maximizeTileExt === 'function') {
          const tile = document.querySelector('.ext-tile[data-sid="' + CSS.escape(sid) + '"]');
          if (tile) {
            // Find the tile ID from the tiling extension state
            if (window.T && window.T.tiles) {
              const t = window.T.tiles.find(t => t.sid === sid);
              if (t) { window.maximizeTileExt(t.id); return true; }
            }
          }
        }
        speakText('No session to maximize.');
        return true;
      }

      case 'closeSession': {
        const name = parsed.args[0];
        const entry = resolveAlias(name);
        if (!entry) {
          speakText('Session ' + name + ' does not exist.');
          return true;
        }
        unregisterAlias(name);
        if (typeof window.closeTileExt === 'function') {
          window.closeTileExt(entry.sid);
        }
        speakText('Closed session ' + name);
        return true;
      }

      case 'listSessions': {
        const names = Object.keys(O.aliases);
        if (names.length === 0) {
          speakText('No sessions tracked.');
        } else {
          speakText('Tracked sessions: ' + names.join(', '));
        }
        return true;
      }

      case 'help': {
        speakText('Available commands: new session [name], switch session [name], start prompt, stop prompt, read session [name], maximise session, close session [name], list sessions.');
        return true;
      }

      default:
        return false;
    }
  }

  // ── Input Buffer ──
  function appendToBuffer(text) {
    O.inputBuffer += (O.inputBuffer ? ' ' : '') + text;
    clearTimeout(O.bufferTimer);
    O.bufferTimer = setTimeout(() => {
      if (O.bufferOpen && O.inputBuffer) {
        // Auto-flush on silence
        O.bufferOpen = false;
        document.getElementById('orch-buffer-indicator')?.classList.remove('orch-recording');
        flushBuffer();
      }
    }, gs('silence_command_ms', 1800));
  }

  function flushBuffer() {
    if (!O.inputBuffer) return;
    const text = O.inputBuffer;
    O.inputBuffer = '';

    // Get the active session
    const active = O.activeAlias ? resolveAlias(O.activeAlias) : null;
    if (active && typeof window.send === 'function') {
      // Put text into textarea and send
      const msg = document.getElementById('msg');
      if (msg) {
        msg.value = text;
        autoResize && autoResize();
        window.send();
        O.processingAliases.add(O.activeAlias);
        updateBadge(O.activeAlias, 'processing');
      }
    } else {
      // No active session — create one on the fly
      if (typeof window.newSession === 'function') {
        (async () => {
          try {
            const data = await window.newSession(false, {});
            const alias = 'default';
            registerAlias(alias, data);
            O.activeAlias = alias;
            const msg = document.getElementById('msg');
            if (msg) {
              msg.value = text;
              autoResize && autoResize();
              window.send();
              O.processingAliases.add(alias);
              updateBadge(alias, 'processing');
            }
          } catch (_) {
            speakText('Failed to create session for prompt.');
          }
        })();
      }
    }
  }

  // ── TTS (speak a text response to the user) ──
  function speakText(text) {
    if (!gs('speak_notifications', true)) return;
    try {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0; u.pitch = 1.0; u.volume = 0.8;
        window.speechSynthesis.speak(u);
      }
    } catch (_) {}
  }

  // ── Badge Management ──
  function updateBadge(alias, state) {
    const entry = resolveAlias(alias);
    if (!entry) return;
    const safeSid = CSS.escape ? CSS.escape(entry.sid) : entry.sid.replace(/[^a-zA-Z0-9_-]/g, '');
    const row = document.querySelector('[data-session-id="' + safeSid + '"]');
    if (!row) return;
    let b = row.querySelector('.orch-alias-badge');
    if (!b) {
      b = document.createElement('span');
      b.className = 'orch-alias-badge';
      (row.querySelector('.session-row-right') || row.querySelector('.session-meta') || row).appendChild(b);
    }
    b.className = 'orch-alias-badge orch-' + state;
    b.textContent = alias.slice(0, 6);
  }

  function removeBadge(sid) {
    const safeSid = CSS.escape ? CSS.escape(sid) : sid.replace(/[^a-zA-Z0-9_-]/g, '');
    const b = document.querySelector('[data-session-id="' + safeSid + '"] .orch-alias-badge');
    if (b) b.remove();
  }

  // ── Status Bar ──
  function createStatusBar() {
    if (document.getElementById('orch-status')) return;
    const bar = document.createElement('div');
    bar.id = 'orch-status';
    bar.innerHTML = '<span class="orch-dot"></span><span>Orchestrator active</span>';
    const titlebar = document.querySelector('header.app-titlebar');
    if (titlebar) titlebar.appendChild(bar);
  }

  function updateStatusBar(active) {
    const bar = document.getElementById('orch-status');
    if (!bar) return;
    bar.classList.toggle('orch-active', active);
  }

  // ── Voice Mode Hijack ──
  // Intercept the voice mode send pipeline so that transcribed speech first
  // tries to parse as a command. If it matches, dispatch. Otherwise fall
  // through to normal send (or buffer if prompt is open).
  function hijackVoiceSend() {
    // The voice mode calls _voiceModeSend() when silence is detected.
    // We save the original and wrap it.
    if (typeof window._voiceModeSend === 'function') {
      O._origVoiceSend = window._voiceModeSend;
      const orig = window._voiceModeSend;
      window._voiceModeSend = function() {
        // Get what would be sent (the textarea content at this point)
        const msg = document.getElementById('msg');
        const text = msg ? msg.value : '';
        if (!text) { return orig(); }

        // If buffer is open, accumulate instead of send
        if (O.bufferOpen) {
          // The voice mode puts transcribed text into #msg already
          appendToBuffer(text);
          msg.value = '';
          autoResize && autoResize();
          return;
        }

        // Try parsing as a command
        const parsed = parseCommand(text);
        if (parsed) {
          msg.value = '';
          autoResize && autoResize();
          execCommand(parsed);
          return;
        }

        // Not a command — send normally
        // But if we have an active alias, ensure we're in the right session
        orig();
      };
      window._origVoiceModeSendRestore = () => {
        if (O._origVoiceSend) window._voiceModeSend = O._origVoiceSend;
      };
    }
  }

  // ── Notification Wiring ──
  // Intercept _handleBgTaskCompleteEvent or watch S.busy transitions
  function wireNotifications() {
    // Method 1: Intercept the existing handler
    if (typeof window._handleBgTaskCompleteEvent === 'function') {
      O._origHandleBg = window._handleBgTaskCompleteEvent;
      const orig = window._handleBgTaskCompleteEvent;
      window._handleBgTaskCompleteEvent = function(e, sid, opts) {
        const result = orig(e, sid, opts);
        if (e && e.session_id) {
          handleSessionComplete(e.session_id);
        }
        return result;
      };
    }

    // Method 2: Watch S.busy transitions as fallback
    O._busyWatch = setInterval(() => {
      if (typeof S === 'undefined') return;
      if (O._prevBusy && !S.busy) {
        const sid = S.session && S.session.session_id;
        if (sid) handleSessionComplete(sid);
      }
      O._prevBusy = !!S.busy;
    }, 500);
  }

  function handleSessionComplete(sid) {
    if (!sid) return;
    const alias = aliasForSid(sid);
    O.processingAliases.delete(alias);
    updateBadge(alias, 'ready');

    // Clear processing state after brief delay
    setTimeout(() => {
      const entry = resolveAlias(alias);
      if (entry) updateBadge(alias, 'active');
    }, 5000);

    // Notification
    if (gs('auto_notify', true)) {
      if (typeof playAttentionSound === 'function') {
        playAttentionSound('orch-' + sid);
      }
      if (typeof sendBrowserNotification === 'function') {
        sendBrowserNotification(
          'Session ' + alias + ' ready',
          'Response completed.',
          { forceHidden: true, sid }
        );
      }
    }
    speakText('Response ready in session ' + alias);
  }

  // ── State Persistence ──
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        aliases: O.aliases,
        reverse: O.reverse,
        activeAlias: O.activeAlias,
      }));
    } catch (_) {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.aliases) O.aliases = s.aliases;
        if (s.reverse) O.reverse = s.reverse;
        if (s.activeAlias) O.activeAlias = s.activeAlias;
      }
    } catch (_) {}
  }

  // ── Keyboard Shortcut ──
  function initKeyboard() {
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O' && !e.repeat) {
        e.preventDefault();
        toggleOrchestrator();
      }
      // Escape to cancel buffer
      if (e.key === 'Escape' && O.bufferOpen) {
        O.bufferOpen = false;
        O.inputBuffer = '';
        document.getElementById('orch-buffer-indicator')?.classList.remove('orch-recording');
        clearTimeout(O.bufferTimer);
        speakText('Cancelled.');
      }
    });
  }

  // ── Toggle ──
  function toggleOrchestrator() {
    O.enabled = !O.enabled;
    updateStatusBar(O.enabled);
    if (O.enabled) {
      hijackVoiceSend();
      wireNotifications();
      loadState();
      // Re-apply badges for known sessions
      Object.keys(O.aliases).forEach(k => updateBadge(k, 'active'));
      speakText('Session Orchestrator enabled.');
    } else {
      // Restore
      if (O._origVoiceSend && typeof window._origVoiceModeSendRestore === 'function') {
        window._origVoiceModeSendRestore();
      }
      if (O._busyWatch) { clearInterval(O._busyWatch); O._busyWatch = null; }
      // Restore original _handleBgTaskCompleteEvent
      if (O._origHandleBg && typeof window._handleBgTaskCompleteEvent !== 'undefined') {
        window._handleBgTaskCompleteEvent = O._origHandleBg;
      }
      O.bufferOpen = false;
      O.inputBuffer = '';
      clearTimeout(O.bufferTimer);
      document.getElementById('orch-buffer-indicator')?.classList.remove('orch-recording');
      saveState();
      speakText('Session Orchestrator disabled.');
    }
  }

  // ── Init ──
  function init() {
    // Guard: require voice mode infrastructure
    if (typeof window._voiceModeActive !== 'function') {
      console.log('[Orch] Voice mode not available — orchestrator needs SpeechRecognition.');
      return;
    }

    createStatusBar();

    // Buffer indicator overlay
    const bi = document.createElement('div');
    bi.id = 'orch-buffer-indicator';
    bi.textContent = '● Recording...';
    document.body.appendChild(bi);

    // Restore previous state if we crashed mid-session
    loadState();
    Object.keys(O.aliases).forEach(k => updateBadge(k, 'active'));
    if (O.activeAlias) speakText('Orchestrator restored. Session ' + O.activeAlias + ' active.');

    // Clean up stale processing flags (page refresh mid-request)
    O.processingAliases.clear();

    initKeyboard();
    updateStatusBar(true);
    O.enabled = true;
    hijackVoiceSend();
    wireNotifications();

    console.log('[Orch] Session Orchestrator initialized. ' +
      Object.keys(O.aliases).length + ' aliases restored. Ctrl+Shift+O to toggle.');
  }

  // ── Exports ──
  window.Orchestrator = {
    enabled: () => O.enabled,
    aliases: () => ({ ...O.aliases }),
    activeAlias: () => O.activeAlias,
    bufferOpen: () => O.bufferOpen,
    toggle: toggleOrchestrator,
    execCommand,
    parseCommand,
    registerAlias,
    unregisterAlias,
    speak: speakText,
  };

  // Defer init until DOM + core scripts loaded
  function install(attempt) {
    if ((document.getElementById('msg') && typeof window._voiceModeActive === 'function') || attempt > 60) {
      init();
      return;
    }
    setTimeout(() => install(attempt + 1), 250);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(0), { once: true });
  } else {
    setTimeout(() => install(0), 500);
  }
})();
