(() => {
  'use strict';

  const ID = 'jarvis-voice';
  const WSS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
  const state = {
    ws: null,
    connected: false,
    listening: false,
    micStream: null,
    captureCtx: null,
    captureNode: null,
    silentNode: null,
    sourceNode: null,
    micStartPromise: null,
    micEpoch: 0,
    captureChunks: [],
    captureSamples: 0,
    playCtx: null,
    nextPlayAt: 0,
    playEpoch: 0,
    playSuppressed: false,
    activeSources: [],
    connectPromise: null,
    cancelConnect: null,
    disconnectEpoch: 0,
    hermesToolRunning: false,
    panel: null,
    button: null,
    status: null,
    transcript: null,
  };

  function settings() {
    const api = window.HermesExtensionSettings && window.HermesExtensionSettings.settingsForExtension(ID);
    const get = (key, fallback) => {
      try {
        if (api && api.supported && typeof api.get === 'function') {
          const value = api.get(key);
          return value === undefined || value === null || value === '' ? fallback : value;
        }
      } catch (_) {}
      return fallback;
    };
    return {
      model: String(get('model', 'gemini-3.1-flash-live-preview')),
      voice: String(get('voice', 'Puck')),
      timeoutSeconds: Math.max(15, Number(get('hermesTimeoutSeconds', 180)) || 180),
    };
  }

  function setStatus(text) {
    if (state.status) state.status.textContent = text;
    if (state.button) state.button.dataset.state = text.toLowerCase().split(/\s+/)[0] || 'idle';
  }

  // A long voice session emits a transcript line per utterance forever, so the
  // panel is bounded in both directions: oldest lines are dropped, and one
  // pathological line cannot balloon the DOM on its own.
  const LOG_MAX_LINES = 200;
  const LOG_MAX_CHARS = 500;

  function log(text) {
    if (!state.transcript) return;
    const line = document.createElement('div');
    line.textContent = String(text == null ? '' : text).slice(0, LOG_MAX_CHARS);
    state.transcript.appendChild(line);
    while (state.transcript.childElementCount > LOG_MAX_LINES) {
      state.transcript.removeChild(state.transcript.firstElementChild);
    }
    state.transcript.scrollTop = state.transcript.scrollHeight;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // 100ms at 16kHz. Sending one socket frame per render quantum measured at 874
  // outbound frames over a ten-second exchange against live Gemini — roughly 90 a
  // second, each holding a few dozen samples. The payload was never the problem,
  // the frame count was.
  const CAPTURE_BATCH_SAMPLES = 1600;

  // Send whatever capture is pending. Called on every full batch and, critically,
  // by stopMic() before it signals end-of-stream: discarding the tail would clip
  // the speaker's last word, and server-side VAD cannot recover audio it never
  // received.
  function flushCapture() {
    const chunks = state.captureChunks;
    const total = state.captureSamples;
    state.captureChunks = [];
    state.captureSamples = 0;
    if (!total) return;
    if (!state.connected || !state.ws || state.ws.readyState !== 1) return;
    const merged = new Int16Array(total);
    let at = 0;
    for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length; }
    try {
      sendGemini({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: bytesToB64(merged.buffer) } } });
    } catch (_) {}
  }

  function pcm16ToFloat32(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < out.length; i += 1) {
      const sample = view.getInt16(i * 2, true);
      out[i] = sample / 32768;
    }
    return out;
  }

  async function playPcm24(base64) {
    if (state.playSuppressed) return;
    // Snapshot the epoch: a Stop that lands while we are awaiting resume() must
    // not have its silence undone by this chunk finishing its await and
    // scheduling anyway.
    const epoch = state.playEpoch;
    if (!state.playCtx) {
      state.playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      state.nextPlayAt = state.playCtx.currentTime;
    }
    if (state.playCtx.state === 'suspended') await state.playCtx.resume();
    if (state.playSuppressed || epoch !== state.playEpoch) return;
    const floats = pcm16ToFloat32(b64ToBytes(base64));
    const buf = state.playCtx.createBuffer(1, floats.length, 24000);
    buf.copyToChannel(floats, 0);
    const src = state.playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(state.playCtx.destination);
    state.nextPlayAt = Math.max(state.nextPlayAt, state.playCtx.currentTime);
    src.start(state.nextPlayAt);
    state.nextPlayAt += buf.duration;
    state.activeSources.push(src);
    src.onended = () => { state.activeSources = state.activeSources.filter((item) => item !== src); };
  }

  // `suppress` is the difference between the two reasons playback stops. A user
  // pressing Stop wants silence for the rest of this turn, so later chunks of it
  // must be dropped too. A Gemini `interrupted` only means "discard what is
  // queued" — its replacement audio follows immediately and must still play.
  function stopPlayback(suppress = false) {
    state.playEpoch += 1;
    if (suppress) state.playSuppressed = true;
    state.activeSources.splice(0).forEach((src) => { try { src.stop(); } catch (_) {} });
    if (state.playCtx) state.nextPlayAt = state.playCtx.currentTime;
  }

  // Turn boundary: a completed turn, a fresh user utterance, or pressing Talk
  // all mean the user is engaged again, so stop swallowing audio.
  function resumePlayback() {
    state.playSuppressed = false;
    if (state.playCtx) state.nextPlayAt = state.playCtx.currentTime;
  }

  // Every byte of a frame is provider-controlled, so the frame is bounded
  // BEFORE it is decoded or parsed: the whole frame by size, the tool-call list
  // by count, one inline-audio part by its base64 length. A frame over the
  // whole-frame or tool-call limit is a protocol violation — Gemini never
  // legitimately sends one — so the socket is closed rather than argued with.
  const MAX_FRAME_BYTES = 1024 * 1024;
  const MAX_TOOL_CALLS_DECODED = 8;
  const MAX_AUDIO_PART_B64_CHARS = 768 * 1024;

  function frameOversized(data) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size > MAX_FRAME_BYTES;
    return String(data == null ? '' : data).length > MAX_FRAME_BYTES;
  }

  function frameViolation(parsed) {
    const calls = parsed && parsed.toolCall && parsed.toolCall.functionCalls;
    return Array.isArray(calls) && calls.length > MAX_TOOL_CALLS_DECODED;
  }

  function refuseFrame(ws) {
    try { ws.close(); } catch (_) {}
    // Revoke here rather than waiting for the close event: the session is dead
    // the moment the violation is seen, and nothing in flight may keep acting
    // on its behalf.
    if (state.ws === ws) {
      state.disconnectEpoch += 1;
      state.ws = null;
      state.connected = false;
      state.listening = false;
      stopMic();
    }
    setStatus('error');
  }

  function parseGeminiMessage(data) {
    const out = [];
    if (data.setupComplete) out.push({ type: 'setup' });
    if (data.toolCall) out.push({ type: 'tool', data: data.toolCall });
    const content = data.serverContent;
    const parts = content && content.modelTurn && content.modelTurn.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data
          && String(part.inlineData.data).length <= MAX_AUDIO_PART_B64_CHARS) {
          out.push({ type: 'audio', data: part.inlineData.data });
        }
        if (part.text) out.push({ type: 'text', data: part.text });
      }
    }
    if (content && content.inputTranscription && content.inputTranscription.text) {
      out.push({ type: 'input', data: content.inputTranscription.text });
    }
    if (content && content.outputTranscription && content.outputTranscription.text) {
      out.push({ type: 'output', data: content.outputTranscription.text });
    }
    if (content && content.interrupted) out.push({ type: 'interrupted' });
    if (content && content.turnComplete) out.push({ type: 'turnComplete' });
    return out;
  }

  // Ownership must be re-established after EVERY await on the message path. A
  // socket that was current when a frame arrived can be superseded while its
  // body is still decoding, and the handler resumes into the new session.
  // Identity alone would do today (each connect builds a fresh WebSocket), but
  // the epoch keeps this correct if the object is ever reused.
  function socketCurrent(ws, epoch) {
    return state.ws === ws && state.disconnectEpoch === epoch;
  }

  // The provider does not get to queue an unbounded run of real actions behind a
  // single frame, nor hand the composer an unbounded prompt.
  const MAX_TOOL_CALLS_PER_EVENT = 1;
  const MAX_TASK_CHARS = 2000;
  const CANCELLED_MESSAGE = 'Jarvis was disconnected before the task was sent. Nothing ran.';
  // Distinct from CANCELLED_MESSAGE: by this point the task really was submitted,
  // so claiming nothing ran would be a lie.
  const ABANDONED_MESSAGE = 'Jarvis disconnected while Hermes was still working. The task was sent and may still be running.';

  function sendGemini(message, ws = state.ws) {
    if (!ws || typeof ws.send !== 'function') throw new Error('Jarvis is not connected');
    ws.send(JSON.stringify(message));
  }

  function sendSetup(ws = state.ws) {
    const cfg = settings();
    sendGemini({
      setup: {
        model: `models/${cfg.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: [
          'You are Jarvis, a concise voice layer for Hermes WebUI.',
          'For any request that needs calendar, email, files, web, code, tools, memory, cron, or actions, call run_hermes with a natural-language task.',
          'Answer casual conversation yourself. Do not claim an action is done unless run_hermes returned it.',
          'If run_hermes reports Hermes is busy, ask the user whether to wait or stop the current task.'
        ].join(' ') }] },
        tools: [{ functionDeclarations: [{
          name: 'run_hermes',
          description: 'Run a task through the current Hermes WebUI session and return the final assistant reply.',
          parameters: {
            type: 'object',
            properties: { task: { type: 'string', description: 'Natural-language task for Hermes Agent.' } },
            required: ['task']
          }
        }] }],
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: false, silenceDurationMs: 900, prefixPaddingMs: 300 },
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
        }
      }
    }, ws);
  }

  async function connect() {
    if (state.connected) return;
    if (state.connectPromise) return state.connectPromise;
    const attempt = (async () => {
      const epoch = state.disconnectEpoch;
      const cancelled = () => epoch !== state.disconnectEpoch;
      const cfg = settings();
      setStatus('token');
      const res = await fetch('/api/extensions/jarvis-voice/sidecar/api/token', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (cancelled()) throw new Error('Jarvis connection cancelled');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Enable WebUI authentication under Settings → Password, then approve Jarvis Voice under Settings → Extensions.');
        }
        if (res.status === 404) {
          throw new Error('Jarvis Voice needs a WebUI build containing sidecar token-v1 support (#6331).');
        }
        // The sidecar answers with {"error": "..."} — e.g. a missing Gemini
        // credential, or an unreachable provider. Pass that through: a bare
        // status code hides a one-line fix. Nothing acts after this await, so it
        // needs no cancellation re-check.
        let detail = '';
        try {
          const body = await res.json();
          if (body && typeof body.error === 'string') detail = body.error;
        } catch (_) {}
        throw new Error(detail
          ? `Jarvis token request failed (${res.status}): ${detail}`
          : `Jarvis token proxy returned ${res.status}`);
      }
      const data = await res.json();
      if (cancelled()) throw new Error('Jarvis connection cancelled');
      if (!data.token) throw new Error('token server returned no token');
      setStatus('connecting');
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail(new Error('Gemini setup timed out')), 15000);
        let ws = null;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          state.cancelConnect = null;
          clearTimeout(timer);
          state.connected = false;
          if (ws && state.ws === ws) { try { ws.close(); } catch (_) {} }
          stopMic();
          reject(err instanceof Error ? err : new Error(String(err || 'Gemini connection failed')));
        };
        try {
          ws = new WebSocket(`${WSS_URL}?access_token=${encodeURIComponent(data.token)}`);
        } catch (err) {
          fail(err);
          return;
        }
        state.ws = ws;
        // Handed to disconnect() so a mid-setup cancel settles this promise NOW
        // instead of at its 15-second deadline.
        state.cancelConnect = () => fail(new Error('Jarvis connection cancelled'));
        ws.onopen = () => { if (state.ws !== ws || cancelled()) { fail(new Error('Jarvis connection cancelled')); return; } sendSetup(ws); };
        ws.onclose = () => {
          if (state.ws !== ws) return;
          // A close the user never asked for still takes this socket's
          // authority with it: advance the generation and drop the reference so
          // tool work parked on an await (Blob decode, session read, completion
          // poll) fails its ownership recheck instead of acting for a dead
          // session.
          state.disconnectEpoch += 1;
          state.ws = null;
          state.connected = false;
          state.listening = false;
          setStatus('closed');
          stopMic();
          fail(new Error('Gemini connection closed before setup'));
        };
        ws.onerror = () => { if (state.ws !== ws) return; setStatus('error'); fail(new Error('Gemini WebSocket error')); };
        ws.onmessage = async (event) => {
          if (state.ws !== ws || cancelled()) { fail(new Error('Jarvis connection cancelled')); return; }
          if (frameOversized(event.data)) { refuseFrame(ws); return; }
          const raw = event.data instanceof Blob ? await event.data.text() : String(event.data || '');
          // Decoding yields; the user may have disconnected or reconnected while
          // it ran. Drop the frame silently — this socket is no longer ours, and
          // failing the (already settled) connect promise would be wrong.
          if (!socketCurrent(ws, epoch)) return;
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { return; }
          if (frameViolation(parsed)) { refuseFrame(ws); return; }
          const messages = parseGeminiMessage(parsed);
          if (!settled && messages.some((msg) => msg.type === 'setup')) {
            settled = true;
            state.cancelConnect = null;
            clearTimeout(timer);
            state.connected = true;
            // A new session must not inherit the previous one's Stop suppression,
            // or reconnected audio stays silent until the user presses Talk.
            resumePlayback();
            setStatus('ready');
            resolve();
          }
          for (const msg of messages) {
            if (!socketCurrent(ws, epoch)) return;
            await handleGemini(msg, ws, epoch);
          }
        };
      });
    })();
    state.connectPromise = attempt;
    // Only this attempt may clear the slot: disconnect() may already have
    // replaced it with null (or a newer connect with its own promise), and
    // clobbering that would poison the reconnect this guard exists to protect.
    try { return await attempt; }
    finally { if (state.connectPromise === attempt) state.connectPromise = null; }
  }

  async function handleGemini(msg, ws = state.ws, epoch = state.disconnectEpoch) {
    if (msg.type === 'setup') { log('jarvis ready'); return; }
    if (msg.type === 'audio') { await playPcm24(msg.data); return; }
    if (msg.type === 'input') { resumePlayback(); log(`you: ${msg.data}`); return; }
    if (msg.type === 'output' || msg.type === 'text') { log(`jarvis: ${msg.data}`); return; }
    if (msg.type === 'interrupted') { stopPlayback(); return; }
    if (msg.type === 'turnComplete') { resumePlayback(); return; }
    if (msg.type === 'tool') { await handleToolCall(msg.data, ws, epoch); }
  }

  async function handleToolCall(toolCall, ws = state.ws, epoch = state.disconnectEpoch) {
    const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    const responses = [];
    let ran = 0;
    for (const call of calls) {
      const name = String(call.name || '');
      // Check ownership BEFORE the side effect, not just before the reply.
      // runHermes() writes a prompt into the composer and calls core send(), so
      // a stale socket that only failed the reply check has already acted.
      if (!socketCurrent(ws, epoch)) return;
      try {
        if (ran >= MAX_TOOL_CALLS_PER_EVENT) {
          throw new Error(
            `Jarvis runs at most ${MAX_TOOL_CALLS_PER_EVENT} Hermes task per turn. Ask again for the next step.`
          );
        }
        if (name !== 'run_hermes') throw new Error(`unknown tool: ${name}`);
        const task = String((call.args && call.args.task) || '').trim();
        if (!task) throw new Error('task is required');
        if (task.length > MAX_TASK_CHARS) {
          throw new Error(`task is too long (${task.length} characters, limit ${MAX_TASK_CHARS})`);
        }
        ran += 1;
        const result = await runHermes(task, () => !socketCurrent(ws, epoch));
        responses.push({ id: call.id, name, response: { result } });
      } catch (err) {
        responses.push({ id: call.id, name, response: { error: String(err && err.message || err) } });
      }
    }
    if (!socketCurrent(ws, epoch)) return;
    sendGemini({ toolResponse: { functionResponses: responses } }, ws);
  }

  // Core declares `const S = {...}` at the top level of a classic script
  // (static/ui.js), which creates a global LEXICAL binding: it is reachable as a
  // bare `S` but never lands on `window`, so reading it off `window` yields
  // undefined in the shipped app. Resolve the bare identifier, guarded so a slip
  // degrades to a clear error instead of a raw ReferenceError.
  function coreState() {
    try { return typeof S === 'undefined' ? null : S; } catch (_) { return null; }
  }

  function currentSid() {
    const core = coreState();
    return core && core.session && core.session.session_id;
  }

  function hermesBusy(session, app) {
    const s = session || {};
    const a = app || {};
    return !!(
      a.busy || a.activeStreamId || a.active_stream_id ||
      s.is_streaming || s.active_stream_id || s.activeStreamId ||
      s.pending_user_message || s.pendingUserMessage ||
      s.has_pending_user_message || s.hasPendingUserMessage
    );
  }

  // Transcript window, pulled once after the count advances and the session goes
  // idle. Core returns the LAST N renderable rows, so the window must be at least
  // as long as the turn it has to contain: a tool-heavy agent run adds dozens of
  // rows, and a window that starts after our marker makes correlation find
  // nothing, which reads as "unfinished" until the tool timeout expires.
  const REPLY_WINDOW_MIN = 40;
  const REPLY_WINDOW_MAX = 500; // core's _MAX_MSG_LIMIT
  const REPLY_WINDOW_MARGIN = 4;
  const POLL_MIN_MS = 600;
  const POLL_MAX_MS = 2500;

  // `messages=0` is core's own metadata-poll shape: it skips the transcript and
  // still returns message_count, so the completion check costs a few bytes
  // instead of re-downloading the whole conversation every tick.
  async function readSession(sid, msgLimit = 0) {
    const path = `/api/session?session_id=${encodeURIComponent(sid)}&resolve_model=0`
      + (msgLimit ? `&messages=1&msg_limit=${msgLimit}` : '&messages=0');
    if (typeof api === 'function') return api(path);
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) throw new Error(`session fetch failed: ${res.status}`);
    return res.json();
  }

  function messageText(msg) {
    return String((msg && (msg.content || msg.text)) || '');
  }

  // Locate the row we submitted, using core's own display coordinates instead of
  // decorating the prompt. `/api/chat/start` does return a `turn_id`, but core
  // does not store it on the message rows, so it cannot be matched here; and a
  // marker in the prompt text is not an option because core renders it in the
  // message bubble and derives the sidebar title from it.
  //
  // Anchor: the user row at or after the pre-send count whose text is exactly the
  // task. Nothing is appended to the prompt, so the stored row and the text we
  // typed match verbatim. The count bound is what stops an older, identical
  // message from being mistaken for ours.
  //
  // If TWO rows in range match, the anchor is ambiguous — the user typed the same
  // thing during our turn, or message_count under-reported so an earlier row fell
  // inside the window. Text alone cannot say which row is ours, and picking one
  // hands the model an answer to somebody else's question. Report the ambiguity
  // instead of guessing; ROW_AMBIGUOUS is deliberately distinct from "not found
  // yet" so the caller can keep waiting without ever resolving on a coin flip.
  const ROW_AMBIGUOUS = -2;

  function findRequestRow(messages, offset, beforeCount, task) {
    let found = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      if (offset + i < beforeCount) continue;
      if (messageText(msg) !== task) continue;
      if (found >= 0) return ROW_AMBIGUOUS;
      found = i;
    }
    return found;
  }

  function replyForRequestRow(messages, rowIndex) {
    let reply = '';
    for (let i = rowIndex + 1; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg) continue;
      // A later user turn closes ours. Anything past it answers a different
      // request and must never be handed back as this task's result.
      if (msg.role === 'user') break;
      if (msg.role !== 'assistant' || msg._live) continue;
      const text = messageText(msg);
      if (text) reply = text;
    }
    return reply;
  }

  // Returns null when the caller went away mid-wait. The loop runs for up to the
  // whole tool timeout, so without this it keeps polling core for minutes after
  // the user disconnected, for a reply nobody is left to receive.
  async function waitForHermes(sid, beforeCount, timeoutMs, task, isStale = () => false) {
    const start = Date.now();
    let delay = POLL_MIN_MS;
    let ambiguous = false;
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (isStale()) return null;
      // Back off: a Hermes agent run can take minutes, and a fixed fast tick just
      // spends core's request budget to learn nothing.
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      const meta = await readSession(sid, 0);
      if (isStale()) return null;
      const metaSession = (meta && meta.session) || {};
      if (hermesBusy(metaSession, {})) continue;
      const count = Number(metaSession.message_count ?? 0);
      if (!(count > beforeCount + 1)) continue;
      // Size the window from the growth we just observed, so however many rows
      // the agent turn produced, our own row is still inside it.
      const span = Math.max(0, count - beforeCount) + REPLY_WINDOW_MARGIN;
      const limit = Math.min(REPLY_WINDOW_MAX, Math.max(REPLY_WINDOW_MIN, span));
      let data = await readSession(sid, limit);
      if (isStale()) return null;
      let session = (data && data.session) || {};
      let messages = Array.isArray(session.messages) ? session.messages : [];
      let offset = Number(session._messages_offset ?? 0);
      let row = findRequestRow(messages, offset, beforeCount, task);
      if (row === ROW_AMBIGUOUS) {
        ambiguous = true;
        continue;
      }
      // Belt for a coordinate-space mismatch: message_count is a display count,
      // so if it under-reports the rows in the turn our row can still fall
      // outside the window. Widen once rather than silently timing out.
      if (row < 0 && limit < REPLY_WINDOW_MAX && session._messages_truncated) {
        data = await readSession(sid, REPLY_WINDOW_MAX);
        if (isStale()) return null;
        session = (data && data.session) || {};
        messages = Array.isArray(session.messages) ? session.messages : [];
        offset = Number(session._messages_offset ?? 0);
        row = findRequestRow(messages, offset, beforeCount, task);
        if (row === ROW_AMBIGUOUS) {
          ambiguous = true;
          continue;
        }
      }
      if (row < 0) continue;
      if (hermesBusy(session, {})) continue;
      const reply = replyForRequestRow(messages, row);
      if (reply) return reply.slice(0, 8000);
    }
    if (ambiguous) {
      throw new Error(
        'The Hermes reply could not be matched to this task because an identical '
        + 'message was sent in the same window. Ask the user to check the conversation.'
      );
    }
    throw new Error('Hermes did not finish before the Jarvis tool timeout');
  }

  function composerBlockReason(msg, sid, ownPrompt = '') {
    const core = coreState();
    if (!core) return 'Hermes WebUI state is unavailable.';
    if (currentSid() !== sid) return 'The active Hermes conversation changed. Ask before sending this voice task.';
    if (core.session && (core.session.read_only || core.session.is_read_only)) return 'Read-only imported sessions cannot be modified.';
    if (document.querySelector && document.querySelector('.msg-edit-area')) return 'A message edit is active. Finish or cancel the edit before sending a voice task.';
    if (hermesBusy(core.session, core)) return 'Hermes is already running a task. Ask the user whether to wait, stop it, or steer it.';
    const draft = String(msg.value || '');
    if (draft.trim() && draft !== String(ownPrompt || '')) return 'The user already has an unsent composer draft. Ask before replacing or sending anything.';
    if (Array.isArray(core.pendingFiles) && core.pendingFiles.length) return 'The user has pending attachments in the composer. Ask before sending a voice task.';
    return '';
  }

  function clearOwnPrompt(msg, prompt) {
    if (String(msg.value || '') !== String(prompt)) return false;
    msg.value = '';
    msg.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof window.autoResize === 'function') window.autoResize();
    return true;
  }

  // `isStale` lets a caller cancel across the awaits below. handleToolCall passes
  // its socket identity, so pressing Disconnect while the session read is in
  // flight stops the task before it is written and submitted. Direct callers of
  // the public API get the no-op default.
  async function runHermes(task, isStale = () => false) {
    if (!task) throw new Error('task is required');
    const core = coreState();
    if (!core) throw new Error('Hermes WebUI state is unavailable');
    if (state.hermesToolRunning) return 'Hermes is already handling a Jarvis tool call. Ask the user to wait.';
    state.hermesToolRunning = true;
    try {
      const msg = document.getElementById('msg');
      if (!msg || typeof window.send !== 'function') throw new Error('Hermes composer is unavailable');
      const sid = currentSid();
      if (!sid) throw new Error('No active Hermes session');
      const blocked = composerBlockReason(msg, sid);
      if (blocked) return blocked;
      // Baseline only needs the count and the busy flags, so take the cheap
      // metadata shape here too.
      const baseline = await readSession(sid, false);
      // The session itself is unchanged by a Disconnect, so composerBlockReason()
      // cannot see this; it needs its own check.
      if (isStale()) return CANCELLED_MESSAGE;
      const blockedAfterBaseline = composerBlockReason(msg, sid);
      if (blockedAfterBaseline) return blockedAfterBaseline;
      const baselineSession = baseline && baseline.session || {};
      if (hermesBusy(baselineSession, {})) return 'Hermes is already running a task. Ask the user whether to wait, stop it, or steer it.';
      const beforeCount = Number(baselineSession.message_count ?? (core.session && core.session.message_count) ?? (Array.isArray(core.messages) ? core.messages.length : 0));
      // The prompt is the task, verbatim. Nothing is appended: core renders any
      // added text in the message bubble and derives the sidebar conversation
      // title from it, so a correlation marker here defaces every voice task.
      const prompt = task;
      log(`hermes ← ${task}`);
      msg.value = prompt;
      msg.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof window.autoResize === 'function') window.autoResize();
      const blockedBeforeSend = composerBlockReason(msg, sid, prompt);
      if (blockedBeforeSend) {
        clearOwnPrompt(msg, prompt);
        return blockedBeforeSend;
      }
      // Last gate before the irreversible step.
      if (isStale()) {
        clearOwnPrompt(msg, prompt);
        return CANCELLED_MESSAGE;
      }
      try {
        await window.send({ literalSlash: true });
      } catch (err) {
        clearOwnPrompt(msg, prompt);
        throw err;
      }
      if (currentSid() !== sid) throw new Error('Hermes conversation changed before the Jarvis task was accepted');
      if (clearOwnPrompt(msg, prompt)) throw new Error('Hermes did not accept the Jarvis task');
      if (String(msg.value || '')) throw new Error('The composer changed while the Jarvis task was sending');
      const reply = await waitForHermes(sid, beforeCount, settings().timeoutSeconds * 1000, task, isStale);
      if (reply === null) return ABANDONED_MESSAGE;
      log('hermes → done');
      return reply;
    } finally {
      state.hermesToolRunning = false;
    }
  }

  async function startMic() {
    if (state.listening) return;
    if (state.micStartPromise) return state.micStartPromise;
    state.micStartPromise = (async () => {
      const epoch = state.disconnectEpoch;
      const micEpoch = state.micEpoch;
      const cancelled = () => epoch !== state.disconnectEpoch || micEpoch !== state.micEpoch || !state.connected;
      let stream = null;
      try {
        await connect();
        if (cancelled()) throw new Error('Jarvis microphone cancelled');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        if (cancelled()) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('Jarvis microphone cancelled');
        }
        state.micStream = stream;
        state.captureCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        if (state.captureCtx.state === 'suspended' && typeof state.captureCtx.resume === 'function') await state.captureCtx.resume();
        // The worklet posts every render quantum. That is deliberately cheap —
        // postMessage carries a transferred buffer, no JSON and no base64 — and it
        // keeps the pending tail on the main thread, where stopMic() can flush it
        // synchronously before end-of-stream. Batching inside the worklet cut the
        // socket frame count just as well but put the tail somewhere only an async
        // round trip could reach, which clipped the speaker's last word.
        // Each output sample is the MEAN of the input window it covers, not one
        // sample plucked from it. Picking every third sample at 48kHz applies no
        // low-pass at all, so a 12kHz component folds to |12000-16000| = 4000Hz —
        // the middle of the speech band, at full amplitude. Measured: a 12kHz tone
        // came through at 0.707 RMS, i.e. completely unattenuated.
        //
        // A boxcar mean is a crude filter (about -9.5dB at 12kHz, gentle roll-off
        // rather than a brick wall). It is a large improvement over no filter and
        // stays a few lines inside the worklet. If transcription accuracy at the
        // top of the band ever matters, replace it with a short windowed-sinc FIR.
        //
        // The window accumulator (sum/n) and the next window boundary persist
        // ACROSS process() calls: a window that straddles a 128-sample quantum
        // boundary keeps accumulating in the next call instead of being emitted
        // short and restarted, so chunked processing is bit-identical to
        // processing the same PCM contiguously.
        const worklet = `class P extends AudioWorkletProcessor{constructor(){super();this.t=0;this.next=0;this.sum=0;this.n=0;}process(i){const c=i&&i[0]&&i[0][0];if(!c)return true;const ratio=sampleRate/16000;const out=[];for(let k=0;k<c.length;k+=1){if(this.t>=this.next){if(this.n){const v=this.sum/this.n;const s=Math.max(-1,Math.min(1,v));out.push(s<0?s*32768:s*32767);}this.sum=0;this.n=0;this.next+=ratio;}this.sum+=c[k];this.n+=1;this.t+=1;}if(!out.length)return true;const pcm=new Int16Array(out);this.port.postMessage(pcm.buffer,[pcm.buffer]);return true;}} registerProcessor('jarvis-capture',P);`;
        const url = URL.createObjectURL(new Blob([worklet], { type: 'application/javascript' }));
        try { await state.captureCtx.audioWorklet.addModule(url); }
        finally { URL.revokeObjectURL(url); }
        if (cancelled()) throw new Error('Jarvis microphone cancelled');
        state.sourceNode = state.captureCtx.createMediaStreamSource(state.micStream);
        state.captureNode = new AudioWorkletNode(state.captureCtx, 'jarvis-capture');
        state.captureNode.port.onmessage = (event) => {
          if (!state.listening || !state.connected) return;
          const chunk = new Int16Array(event.data);
          if (!chunk.length) return;
          state.captureChunks.push(chunk);
          state.captureSamples += chunk.length;
          if (state.captureSamples >= CAPTURE_BATCH_SAMPLES) flushCapture();
        };
        state.silentNode = state.captureCtx.createGain();
        state.silentNode.gain.value = 0;
        state.sourceNode.connect(state.captureNode);
        state.captureNode.connect(state.silentNode);
        state.silentNode.connect(state.captureCtx.destination);
        state.listening = true;
        // Pressing Talk is a turn boundary: lift any Stop-induced suppression.
        resumePlayback();
        setStatus('listening');
      } catch (err) {
        stopMic();
        throw err;
      }
    })();
    try { return await state.micStartPromise; }
    finally { state.micStartPromise = null; }
  }

  function stopMic() {
    state.micEpoch += 1;
    const wasListening = state.listening;
    state.listening = false;
    if (wasListening) {
      // Order matters: the tail goes out first, then end-of-stream.
      flushCapture();
      if (state.connected && state.ws && state.ws.readyState === 1) {
        try { sendGemini({ realtimeInput: { audioStreamEnd: true } }); } catch (_) {}
      }
    }
    state.captureChunks = [];
    state.captureSamples = 0;
    if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch (_) {} state.sourceNode = null; }
    if (state.captureNode) { try { state.captureNode.disconnect(); } catch (_) {} state.captureNode = null; }
    if (state.silentNode) { try { state.silentNode.disconnect(); } catch (_) {} state.silentNode = null; }
    if (state.captureCtx) { try { state.captureCtx.close(); } catch (_) {} state.captureCtx = null; }
    if (state.micStream) { state.micStream.getTracks().forEach((track) => track.stop()); state.micStream = null; }
    if (state.connected) setStatus('ready');
  }

  function disconnect() {
    state.disconnectEpoch += 1;
    stopMic();
    stopPlayback(true);
    // A pending connect must settle NOW, not at its 15-second deadline:
    // connect() reuses the stored promise, so a pending one left behind makes
    // the next connect adopt a socket that was already abandoned.
    if (state.cancelConnect) { const cancel = state.cancelConnect; state.cancelConnect = null; cancel(); }
    state.connectPromise = null;
    if (state.ws) { try { state.ws.close(); } catch (_) {} state.ws = null; }
    state.connected = false;
    setStatus('closed');
  }

  function render() {
    if (document.getElementById('jarvisVoicePanel')) return;
    const panel = document.createElement('div');
    panel.id = 'jarvisVoicePanel';
    panel.innerHTML = `
      <button id="jarvisVoiceButton" type="button" aria-label="Toggle Jarvis voice" aria-expanded="false" aria-controls="jarvisVoiceCard"><span>J</span></button>
      <div id="jarvisVoiceCard" role="region" aria-label="Jarvis voice controls" hidden>
        <div class="jarvis-head"><strong>Jarvis</strong><span id="jarvisVoiceStatus">closed</span></div>
        <div class="jarvis-actions">
          <button type="button" data-jarvis="talk">Talk</button>
          <button type="button" data-jarvis="stop">Stop</button>
          <button type="button" data-jarvis="disconnect">Disconnect</button>
        </div>
        <div id="jarvisVoiceLog" aria-live="polite"></div>
        <small>Needs token sidecar + WebUI CSP connect extra.</small>
      </div>`;
    document.body.appendChild(panel);
    state.panel = panel;
    state.button = panel.querySelector('#jarvisVoiceButton');
    state.status = panel.querySelector('#jarvisVoiceStatus');
    state.transcript = panel.querySelector('#jarvisVoiceLog');
    const card = panel.querySelector('#jarvisVoiceCard');
    const setOpen = (open) => {
      card.hidden = !open;
      state.button.setAttribute('aria-expanded', String(open));
    };
    state.button.addEventListener('click', () => setOpen(card.hidden));
    // Scoped to the panel, not the card. The toggle and the card are siblings, so
    // a keydown on the toggle — where focus sits after Enter/Space opens the card
    // — bubbles to the panel and never reaches the card.
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      if (typeof state.button.focus === 'function') state.button.focus();
    });
    panel.querySelector('[data-jarvis="talk"]').addEventListener('click', async () => {
      try { state.listening ? stopMic() : await startMic(); } catch (err) { setStatus('error'); log(`error: ${err.message || err}`); }
    });
    panel.querySelector('[data-jarvis="stop"]').addEventListener('click', () => { stopMic(); stopPlayback(true); });
    panel.querySelector('[data-jarvis="disconnect"]').addEventListener('click', disconnect);
  }

  window.HermesJarvisVoice = {
    connect,
    disconnect,
    startMic,
    stopMic,
    // Same semantics as the Stop button: silence the rest of this turn.
    stopPlayback: () => stopPlayback(true),
    runHermes,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
})();
