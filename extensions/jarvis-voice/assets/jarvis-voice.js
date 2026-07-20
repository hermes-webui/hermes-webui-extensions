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
    playCtx: null,
    nextPlayAt: 0,
    activeSources: [],
    connectPromise: null,
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
      sidecarUrl: String(get('sidecarUrl', 'http://127.0.0.1:18787')).replace(/\/+$/, ''),
      model: String(get('model', 'gemini-3.1-flash-live-preview')),
      voice: String(get('voice', 'Puck')),
      timeoutSeconds: Math.max(15, Number(get('hermesTimeoutSeconds', 180)) || 180),
    };
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function setStatus(text) {
    if (state.status) state.status.textContent = text;
    if (state.button) state.button.dataset.state = text.toLowerCase().split(/\s+/)[0] || 'idle';
  }

  function log(text) {
    if (!state.transcript) return;
    const line = document.createElement('div');
    line.textContent = text;
    state.transcript.appendChild(line);
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
    if (!state.playCtx) {
      state.playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      state.nextPlayAt = state.playCtx.currentTime;
    }
    if (state.playCtx.state === 'suspended') await state.playCtx.resume();
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

  function stopPlayback() {
    state.activeSources.splice(0).forEach((src) => { try { src.stop(); } catch (_) {} });
    if (state.playCtx) state.nextPlayAt = state.playCtx.currentTime;
  }

  function parseGeminiMessage(data) {
    const out = [];
    if (data.setupComplete) out.push({ type: 'setup' });
    if (data.toolCall) out.push({ type: 'tool', data: data.toolCall });
    const content = data.serverContent;
    const parts = content && content.modelTurn && content.modelTurn.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) out.push({ type: 'audio', data: part.inlineData.data });
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
    state.connectPromise = (async () => {
      const epoch = state.disconnectEpoch;
      const cancelled = () => epoch !== state.disconnectEpoch;
      const cfg = settings();
      setStatus('token');
      const res = await fetch(`${cfg.sidecarUrl}/api/token`, { method: 'POST' });
      if (cancelled()) throw new Error('Jarvis connection cancelled');
      if (!res.ok) throw new Error(`token server returned ${res.status}`);
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
        ws.onopen = () => { if (state.ws !== ws || cancelled()) { fail(new Error('Jarvis connection cancelled')); return; } sendSetup(ws); };
        ws.onclose = () => {
          if (state.ws !== ws) return;
          state.connected = false;
          state.listening = false;
          setStatus('closed');
          stopMic();
          fail(new Error('Gemini connection closed before setup'));
        };
        ws.onerror = () => { if (state.ws !== ws) return; setStatus('error'); fail(new Error('Gemini WebSocket error')); };
        ws.onmessage = async (event) => {
          if (state.ws !== ws || cancelled()) { fail(new Error('Jarvis connection cancelled')); return; }
          const raw = event.data instanceof Blob ? await event.data.text() : String(event.data || '');
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { return; }
          const messages = parseGeminiMessage(parsed);
          if (!settled && messages.some((msg) => msg.type === 'setup')) {
            settled = true;
            clearTimeout(timer);
            state.connected = true;
            setStatus('ready');
            resolve();
          }
          for (const msg of messages) await handleGemini(msg, ws);
        };
      });
    })();
    try { return await state.connectPromise; }
    finally { state.connectPromise = null; }
  }

  async function handleGemini(msg, ws = state.ws) {
    if (msg.type === 'setup') { log('jarvis ready'); return; }
    if (msg.type === 'audio') { await playPcm24(msg.data); return; }
    if (msg.type === 'input') { log(`you: ${msg.data}`); return; }
    if (msg.type === 'output' || msg.type === 'text') { log(`jarvis: ${msg.data}`); return; }
    if (msg.type === 'interrupted') { stopPlayback(); return; }
    if (msg.type === 'tool') { await handleToolCall(msg.data, ws); }
  }

  async function handleToolCall(toolCall, ws = state.ws) {
    const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    const responses = [];
    for (const call of calls) {
      const name = String(call.name || '');
      try {
        if (name !== 'run_hermes') throw new Error(`unknown tool: ${name}`);
        const result = await runHermes(String((call.args && call.args.task) || '').trim());
        responses.push({ id: call.id, name, response: { result } });
      } catch (err) {
        responses.push({ id: call.id, name, response: { error: String(err && err.message || err) } });
      }
    }
    if (state.ws !== ws) return;
    sendGemini({ toolResponse: { functionResponses: responses } }, ws);
  }

  function currentSid() {
    return window.S && window.S.session && window.S.session.session_id;
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

  async function readSession(sid) {
    const path = `/api/session?session_id=${encodeURIComponent(sid)}&messages=1&resolve_model=0&msg_limit=500`;
    if (typeof api === 'function') return api(path);
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) throw new Error(`session fetch failed: ${res.status}`);
    return res.json();
  }

  function latestAssistantAfterRequest(messages, requestId) {
    let sawRequest = false;
    let reply = '';
    for (const msg of messages) {
      const text = String((msg && (msg.content || msg.text)) || '');
      if (msg && msg.role === 'user' && text.includes(requestId)) {
        sawRequest = true;
        reply = '';
      } else if (sawRequest && msg && msg.role === 'assistant' && !msg._live && text) {
        reply = text;
      }
    }
    return reply;
  }

  async function waitForHermes(sid, beforeCount, timeoutMs, requestId) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await readSession(sid);
      const session = data && data.session || {};
      const messages = Array.isArray(session.messages) ? session.messages : [];
      const count = Number(session.message_count || messages.length || 0);
      const busy = hermesBusy(session, {});
      const reply = latestAssistantAfterRequest(messages, requestId);
      if (!busy && count > beforeCount + 1 && reply) return reply.slice(0, 8000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Hermes did not finish before the Jarvis tool timeout');
  }

  function composerBlockReason(msg, sid, ownPrompt = '') {
    if (currentSid() !== sid) return 'The active Hermes conversation changed. Ask before sending this voice task.';
    if (window.S && window.S.session && (window.S.session.read_only || window.S.session.is_read_only)) return 'Read-only imported sessions cannot be modified.';
    if (document.querySelector && document.querySelector('.msg-edit-area')) return 'A message edit is active. Finish or cancel the edit before sending a voice task.';
    if (hermesBusy(window.S.session, window.S)) return 'Hermes is already running a task. Ask the user whether to wait, stop it, or steer it.';
    const draft = String(msg.value || '');
    if (draft.trim() && draft !== String(ownPrompt || '')) return 'The user already has an unsent composer draft. Ask before replacing or sending anything.';
    if (Array.isArray(window.S.pendingFiles) && window.S.pendingFiles.length) return 'The user has pending attachments in the composer. Ask before sending a voice task.';
    return '';
  }

  function clearOwnPrompt(msg, prompt) {
    if (String(msg.value || '') !== String(prompt)) return false;
    msg.value = '';
    msg.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof window.autoResize === 'function') window.autoResize();
    return true;
  }

  async function runHermes(task) {
    if (!task) throw new Error('task is required');
    if (!window.S) throw new Error('Hermes WebUI state is unavailable');
    if (state.hermesToolRunning) return 'Hermes is already handling a Jarvis tool call. Ask the user to wait.';
    state.hermesToolRunning = true;
    try {
      const msg = document.getElementById('msg');
      if (!msg || typeof window.send !== 'function') throw new Error('Hermes composer is unavailable');
      const sid = currentSid();
      if (!sid) throw new Error('No active Hermes session');
      const blocked = composerBlockReason(msg, sid);
      if (blocked) return blocked;
      const baseline = await readSession(sid);
      const blockedAfterBaseline = composerBlockReason(msg, sid);
      if (blockedAfterBaseline) return blockedAfterBaseline;
      const baselineSession = baseline && baseline.session || {};
      if (hermesBusy(baselineSession, {})) return 'Hermes is already running a task. Ask the user whether to wait, stop it, or steer it.';
      const baselineMessages = Array.isArray(baselineSession.messages) ? baselineSession.messages : [];
      const beforeCount = Number(baselineSession.message_count ?? (window.S.session && window.S.session.message_count) ?? baselineMessages.length ?? (Array.isArray(window.S.messages) ? window.S.messages.length : 0));
      const requestId = `jarvis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const prompt = `${task}\n\n<!-- jarvis_request_id:${requestId} -->`;
      log(`hermes ← ${task}`);
      msg.value = prompt;
      msg.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof window.autoResize === 'function') window.autoResize();
      const blockedBeforeSend = composerBlockReason(msg, sid, prompt);
      if (blockedBeforeSend) {
        clearOwnPrompt(msg, prompt);
        return blockedBeforeSend;
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
      const reply = await waitForHermes(sid, beforeCount, settings().timeoutSeconds * 1000, requestId);
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
        const worklet = `class P extends AudioWorkletProcessor{constructor(){super();this.offset=0;}process(i){const c=i&&i[0]&&i[0][0];if(!c)return true;const ratio=sampleRate/16000;const out=[];for(;this.offset<c.length;this.offset+=ratio){const s=Math.max(-1,Math.min(1,c[Math.floor(this.offset)]));out.push(s<0?s*32768:s*32767);}this.offset-=c.length;if(!out.length)return true;const pcm=new Int16Array(out);this.port.postMessage(pcm.buffer,[pcm.buffer]);return true;}} registerProcessor('jarvis-capture',P);`;
        const url = URL.createObjectURL(new Blob([worklet], { type: 'application/javascript' }));
        try { await state.captureCtx.audioWorklet.addModule(url); }
        finally { URL.revokeObjectURL(url); }
        if (cancelled()) throw new Error('Jarvis microphone cancelled');
        state.sourceNode = state.captureCtx.createMediaStreamSource(state.micStream);
        state.captureNode = new AudioWorkletNode(state.captureCtx, 'jarvis-capture');
        state.captureNode.port.onmessage = (event) => {
          if (!state.listening || !state.connected) return;
          sendGemini({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: bytesToB64(event.data) } } });
        };
        state.silentNode = state.captureCtx.createGain();
        state.silentNode.gain.value = 0;
        state.sourceNode.connect(state.captureNode);
        state.captureNode.connect(state.silentNode);
        state.silentNode.connect(state.captureCtx.destination);
        state.listening = true;
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
    if (wasListening && state.connected && state.ws && state.ws.readyState === 1) {
      try { sendGemini({ realtimeInput: { audioStreamEnd: true } }); } catch (_) {}
    }
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
    stopPlayback();
    if (state.ws) { try { state.ws.close(); } catch (_) {} state.ws = null; }
    state.connected = false;
    setStatus('closed');
  }

  function render() {
    if (document.getElementById('jarvisVoicePanel')) return;
    const panel = document.createElement('div');
    panel.id = 'jarvisVoicePanel';
    panel.innerHTML = `
      <button id="jarvisVoiceButton" type="button" aria-label="Toggle Jarvis voice"><span>J</span></button>
      <div id="jarvisVoiceCard" hidden>
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
    state.button.addEventListener('click', () => { card.hidden = !card.hidden; });
    panel.querySelector('[data-jarvis="talk"]').addEventListener('click', async () => {
      try { state.listening ? stopMic() : await startMic(); } catch (err) { setStatus('error'); log(`error: ${err.message || err}`); }
    });
    panel.querySelector('[data-jarvis="stop"]').addEventListener('click', () => { stopMic(); stopPlayback(); });
    panel.querySelector('[data-jarvis="disconnect"]').addEventListener('click', disconnect);
  }

  window.HermesJarvisVoice = { connect, disconnect, startMic, stopMic, runHermes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
})();
