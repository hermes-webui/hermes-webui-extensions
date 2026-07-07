/* ── Fun Audio Chat Connector ────────────────────────────────────────────
 * Full-duplex speech-to-speech voice chatting with a local Fun-Audio-Chat
 * (FAC) WebSocket server. Binary protocol over WebSocket.
 *
 * Protocol:
 *   Byte 0: type (0x00=handshake, 0x01=audio/Opus, 0x02=text, 0x03=control)
 *   Bytes 1+: payload
 * ─────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  const STATE = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    ERROR: 'error',
  };

  const FAC_TYPE = {
    HANDSHAKE: 0x00,
    AUDIO: 0x01,
    TEXT: 0x02,
    CONTROL: 0x03,
  };

  const MAX_LOG_ENTRIES = 300;

  // ── Settings ────────────────────────────────────────────────────────
  // network_external:false is a hard guarantee — the FAC server is a LOCAL app.
  // Validate host to loopback only so a typed (or tampered-localStorage) host can
  // never send microphone audio to an arbitrary external WebSocket. The WebUI CSP
  // is report-only in some deployments, so this MUST be enforced in-code, not
  // relied upon at the CSP layer.
  function isLoopbackHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1') return true;
    // 127.0.0.0/8
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m && Number(m[1]) === 127 && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255)) return true;
    return false;
  }
  function sanitizePort(port) {
    const n = parseInt(String(port || '').trim(), 10);
    return (Number.isInteger(n) && n >= 1 && n <= 65535) ? String(n) : '11236';
  }

  function loadSettings() {
    const rawHost = localStorage.getItem('hermes-ext-fac-host') || '127.0.0.1';
    return {
      // Defensive: never return a non-loopback host even if one was persisted.
      host: isLoopbackHost(rawHost) ? rawHost.trim() : '127.0.0.1',
      port: sanitizePort(localStorage.getItem('hermes-ext-fac-port') || '11236'),
      mode: localStorage.getItem('hermes-ext-fac-mode') || 'S2S',
      panelOpen: localStorage.getItem('hermes-ext-fac-panel-open') === 'true',
    };
  }

  function saveSettings(settings) {
    localStorage.setItem('hermes-ext-fac-host', settings.host);
    localStorage.setItem('hermes-ext-fac-port', settings.port);
    localStorage.setItem('hermes-ext-fac-mode', settings.mode);
  }

  // ── DOM ────────────────────────────────────────────────────────────
  let toggleBtn, panel, statusDot, statusText, reconnectBtn;
  let vuFill, talkBtn, logEl, settingsPanel, settingsToggle;
  let hostInput, portInput, modeSelect;

  // ── WebSocket ──────────────────────────────────────────────────────
  let ws = null;
  let connectionState = STATE.DISCONNECTED;
  let reconnectTimer = null;

  // ── Media ──────────────────────────────────────────────────────────
  let mediaStream = null;
  let mediaRecorder = null;
  let audioContext = null;
  let gainNode = null;
  let audioQueue = [];
  let isPlaying = false;
  let isRecording = false;

  // ── VU ─────────────────────────────────────────────────────────────
  let analyserNode = null;
  let vuInterval = null;

  // ═════════════════════════════════════════════════════════════════════
  //  PANEL UI
  // ═════════════════════════════════════════════════════════════════════

  function createMicIcon() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const paths = [
      'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z',
      'M19 10v2a7 7 0 0 1-14 0v-2',
      'M12 19v4',
      'M8 23h8',
    ];
    paths.forEach((d) => {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function createToggle() {
    const btn = document.createElement('button');
    btn.id = 'hwx-fac-toggle';
    btn.title = 'Fun Audio Chat';
    btn.appendChild(createMicIcon());
    btn.addEventListener('click', () => togglePanel());
    document.body.appendChild(btn);
    return btn;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'hwx-fac-panel';

    // ── Header ──
    const header = document.createElement('div');
    header.id = 'hwx-fac-header';

    const title = document.createElement('div');
    title.id = 'hwx-fac-header-title';
    title.appendChild(createMicIcon());
    const span = document.createElement('span');
    span.textContent = 'Fun Audio Chat';
    title.appendChild(span);
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'hwx-fac-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => closePanel());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // ── Status ──
    const status = document.createElement('div');
    status.id = 'hwx-fac-status';

    statusDot = document.createElement('span');
    statusDot.id = 'hwx-fac-status-dot';
    statusDot.className = 'hwx-fac-dot-disconnected';
    status.appendChild(statusDot);

    statusText = document.createElement('span');
    statusText.id = 'hwx-fac-status-text';
    statusText.textContent = 'Disconnected';
    status.appendChild(statusText);

    reconnectBtn = document.createElement('button');
    reconnectBtn.id = 'hwx-fac-reconnect';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.addEventListener('click', () => connect());
    status.appendChild(reconnectBtn);

    panel.appendChild(status);

    // ── VU Meter ──
    const vuContainer = document.createElement('div');
    vuContainer.id = 'hwx-fac-vu-container';

    const vuLabel = document.createElement('div');
    vuLabel.id = 'hwx-fac-vu-label';
    vuLabel.textContent = 'Audio Level';
    vuContainer.appendChild(vuLabel);

    const vuBar = document.createElement('div');
    vuBar.id = 'hwx-fac-vu-bar';
    vuFill = document.createElement('div');
    vuFill.id = 'hwx-fac-vu-fill';
    vuBar.appendChild(vuFill);
    vuContainer.appendChild(vuBar);

    panel.appendChild(vuContainer);

    // ── Controls ──
    const controls = document.createElement('div');
    controls.id = 'hwx-fac-controls';

    talkBtn = document.createElement('button');
    talkBtn.id = 'hwx-fac-talk-btn';
    talkBtn.textContent = '🎤  Talk';
    talkBtn.addEventListener('click', () => toggleRecording());
    talkBtn.disabled = true;
    controls.appendChild(talkBtn);
    panel.appendChild(controls);

    // ── Log ──
    logEl = document.createElement('div');
    logEl.id = 'hwx-fac-log';
    panel.appendChild(logEl);

    // ── Settings toggle ──
    settingsToggle = document.createElement('button');
    settingsToggle.id = 'hwx-fac-settings-toggle';
    settingsToggle.textContent = '⚙  Settings';
    settingsToggle.addEventListener('click', () => {
      settingsPanel.classList.toggle('hwx-fac-open');
    });
    panel.appendChild(settingsToggle);

    // ── Settings panel ──
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'hwx-fac-settings';

    function makeSettingRow(labelText, inputEl) {
      const row = document.createElement('div');
      row.className = 'hwx-fac-setting-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      row.appendChild(label);
      row.appendChild(inputEl);
      return row;
    }

    hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.placeholder = '127.0.0.1';
    settingsPanel.appendChild(makeSettingRow('Host', hostInput));

    portInput = document.createElement('input');
    portInput.type = 'text';
    portInput.placeholder = '11236';
    settingsPanel.appendChild(makeSettingRow('Port', portInput));

    modeSelect = document.createElement('select');
    ['S2S', 'S2T', 'TTS-only'].forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modeSelect.appendChild(opt);
    });
    settingsPanel.appendChild(makeSettingRow('Mode', modeSelect));

    // Save settings on change
    [hostInput, portInput, modeSelect].forEach((el) => {
      el.addEventListener('change', () => {
        const rawHost = hostInput.value.trim() || '127.0.0.1';
        if (!isLoopbackHost(rawHost)) {
          // Reject non-loopback hosts outright — this extension only talks to a
          // LOCAL FAC server (network_external:false). Snap back to the default.
          hostInput.value = '127.0.0.1';
          addLog('Host must be loopback (localhost / 127.0.0.1) — reset to default', 'system');
        }
        const settings = {
          host: isLoopbackHost(rawHost) ? rawHost : '127.0.0.1',
          port: sanitizePort(portInput.value),
          mode: modeSelect.value,
        };
        portInput.value = settings.port;
        saveSettings(settings);
        addLog('Settings saved', 'system');
      });
    });

    panel.appendChild(settingsPanel);

    document.body.appendChild(panel);
    return panel;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  PANEL CONTROL
  // ═════════════════════════════════════════════════════════════════════

  function openPanel() {
    panel.classList.add('hwx-fac-open');
    toggleBtn.classList.add('hwx-fac-active');
    localStorage.setItem('hermes-ext-fac-panel-open', 'true');
    // Restore settings
    const s = loadSettings();
    hostInput.value = s.host;
    portInput.value = s.port;
    modeSelect.value = s.mode;
  }

  function closePanel() {
    panel.classList.remove('hwx-fac-open');
    toggleBtn.classList.remove('hwx-fac-active');
    localStorage.setItem('hermes-ext-fac-panel-open', 'false');
    // Close settings if open
    settingsPanel.classList.remove('hwx-fac-open');
  }

  function togglePanel() {
    if (panel.classList.contains('hwx-fac-open')) {
      closePanel();
    } else {
      openPanel();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  STATUS
  // ═════════════════════════════════════════════════════════════════════

  function setStatus(state, msg) {
    connectionState = state;
    statusDot.className = 'hwx-fac-dot-' + state;
    statusText.textContent = msg;

    const isConnected = state === STATE.CONNECTED;
    talkBtn.disabled = !isConnected;
    reconnectBtn.classList.toggle('hwx-fac-show', state === STATE.ERROR || state === STATE.DISCONNECTED);
  }

  function addLog(text, type) {
    const entry = document.createElement('div');
    entry.className = 'hwx-fac-log-entry hwx-fac-' + (type || 'system');
    entry.textContent = text;
    logEl.appendChild(entry);
    // Bound DOM growth: a long voice session or a reconnect loop would otherwise
    // append log rows without limit. Keep the most recent MAX_LOG_ENTRIES.
    while (logEl.childElementCount > MAX_LOG_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  WEBSOCKET
  // ═════════════════════════════════════════════════════════════════════

  function getWsUrl() {
    const s = loadSettings();
    return `ws://${s.host}:${s.port}/chat`;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setStatus(STATE.CONNECTING, 'Connecting...');
    const url = getWsUrl();
    addLog(`Connecting to ${url}...`, 'system');

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus(STATE.ERROR, 'Invalid URL');
      addLog(`Connection error: ${e.message}`, 'system');
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setStatus(STATE.CONNECTED, 'Connected');
      addLog('WebSocket connected', 'system');
      // Send handshake
      sendHandshake();
    };

    ws.onmessage = (event) => {
      handleMessage(event.data);
    };

    ws.onerror = (e) => {
      setStatus(STATE.ERROR, 'WebSocket error');
      addLog('WebSocket error', 'system');
    };

    ws.onclose = (event) => {
      if (connectionState === STATE.CONNECTED || connectionState === STATE.CONNECTING) {
        setStatus(STATE.DISCONNECTED, 'Disconnected');
        addLog(`Disconnected (code=${event.code})`, 'system');
        stopRecording();
        scheduleReconnect();
      }
    };
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setStatus(STATE.DISCONNECTED, 'Disconnected');
    stopRecording();
    // Release the playback AudioContext — browsers cap concurrent contexts (~6),
    // so leaking one per connect/disconnect cycle eventually throws.
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
      audioContext = null;
      gainNode = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    addLog('Reconnecting in 5s...', 'system');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  }

  // ── Protocol ────────────────────────────────────────────────────────

  function sendHandshake() {
    const msg = JSON.stringify({ cmd: 'hello', version: 1 });
    sendFrame(FAC_TYPE.HANDSHAKE, msg);
    addLog('Sent handshake', 'system');
  }

  function sendFrame(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let buffer;
    if (typeof payload === 'string') {
      const encoded = new TextEncoder().encode(payload);
      buffer = new Uint8Array(1 + encoded.length);
      buffer[0] = type;
      buffer.set(encoded, 1);
    } else if (payload instanceof ArrayBuffer) {
      buffer = new Uint8Array(1 + payload.byteLength);
      buffer[0] = type;
      buffer.set(new Uint8Array(payload), 1);
    } else if (payload instanceof Blob) {
      // Blob not used in our case; convert if needed
      return;
    } else {
      return;
    }

    ws.send(buffer.buffer);
  }

  function handleMessage(data) {
    if (!(data instanceof ArrayBuffer) && !(data instanceof Blob)) {
      // Text message
      try {
        const json = JSON.parse(data);
        handleTextMessage(json);
      } catch (e) {
        addLog(`Received non-binary message: ${data}`, 'system');
      }
      return;
    }

    // Binary message
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!buf || buf.length === 0) return;

    const type = buf[0];
    const payload = buf.slice(1);

    switch (type) {
      case FAC_TYPE.HANDSHAKE:
        handleHandshakeResponse(payload);
        break;
      case FAC_TYPE.AUDIO:
        handleAudioFrame(payload);
        break;
      case FAC_TYPE.TEXT:
        handleTextFrame(payload);
        break;
      case FAC_TYPE.CONTROL:
        handleControlFrame(payload);
        break;
      default:
        addLog(`Unknown frame type: 0x${type.toString(16)}`, 'system');
    }
  }

  function handleHandshakeResponse(payload) {
    try {
      const json = JSON.parse(new TextDecoder().decode(payload));
      if (json.status === 'ok') {
        addLog('Handshake accepted by FAC server', 'system');
        setStatus(STATE.CONNECTED, 'Connected — ready');
      } else {
        addLog(`Handshake failed: ${JSON.stringify(json)}`, 'system');
        setStatus(STATE.ERROR, 'Handshake failed');
      }
    } catch (e) {
      addLog(`Handshake response parse error: ${e.message}`, 'system');
    }
  }

  function handleAudioFrame(payload) {
    // Queue received Opus audio for playback
    if (payload.byteLength > 0) {
      audioQueue.push(payload.buffer);
      if (!isPlaying) {
        playNextAudio();
      }
    }
  }

  function handleTextFrame(payload) {
    try {
      const text = new TextDecoder().decode(payload);
      const json = JSON.parse(text);
      // Text messages typically contain transcription results
      if (json.text) {
        addLog(`You: ${json.text}`, 'user');
      } else {
        addLog(`Server: ${text}`, 'agent');
      }
    } catch (e) {
      const text = new TextDecoder().decode(payload);
      addLog(`Server: ${text}`, 'agent');
    }
  }

  function handleControlFrame(payload) {
    try {
      const json = JSON.parse(new TextDecoder().decode(payload));
      if (json.type === 'start') {
        addLog('Server started receiving', 'system');
      } else if (json.type === 'end_turn') {
        if (json.text) {
          addLog(`Agent: ${json.text}`, 'agent');
        }
        addLog('Agent turn ended', 'system');
        // If recording, can continue
      } else if (json.type === 'stop') {
        addLog('Session stopped', 'system');
        stopRecording();
      }
    } catch (e) {
      // ignore
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  AUDIO PLAYBACK
  // ═════════════════════════════════════════════════════════════════════

  async function playNextAudio() {
    if (audioQueue.length === 0) {
      isPlaying = false;
      return;
    }

    isPlaying = true;
    const opusData = audioQueue.shift();

    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Decode Opus via AudioContext decodeAudioData
      const audioBuffer = await audioContext.decodeAudioData(opusData);

      if (!gainNode) {
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0;
        gainNode.connect(audioContext.destination);
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      source.onended = () => {
        playNextAudio();
      };
      source.start();
    } catch (e) {
      addLog(`Audio playback error: ${e.message}`, 'system');
      playNextAudio();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  MIC RECORDING
  // ═════════════════════════════════════════════════════════════════════

  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  async function startRecording() {
    if (connectionState !== STATE.CONNECTED || !ws) {
      addLog('Not connected to FAC server', 'system');
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      addLog(`Mic access denied: ${e.message}`, 'system');
      return;
    }

    // Send start control message
    sendFrame(FAC_TYPE.CONTROL, JSON.stringify({ type: 'start' }));
    addLog('Recording started...', 'system');

    // Set up VU meter
    setupVUMeter(mediaStream);

    // Start MediaRecorder with Opus in webm container
    const options = { mimeType: 'audio/webm;codecs=opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      addLog('Opus in webm not supported, using default', 'system');
    }

    try {
      mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch (e) {
      // Fallback to default
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && connectionState === STATE.CONNECTED && ws && ws.readyState === WebSocket.OPEN) {
        // MediaRecorder emits Blobs — convert to ArrayBuffer so sendFrame can
        // frame the Opus bytes. Sending the Blob directly was silently dropped
        // (sendFrame has no Blob branch), so no audio ever reached FAC.
        try {
          const buf = await event.data.arrayBuffer();
          // Guard against a disconnect that happened during the async conversion.
          if (connectionState === STATE.CONNECTED && ws && ws.readyState === WebSocket.OPEN) {
            sendFrame(FAC_TYPE.AUDIO, buf);
          }
        } catch (e) {
          addLog('Audio frame encode failed', 'system');
        }
      }
    };

    mediaRecorder.start(100); // 100ms chunks for low latency
    isRecording = true;
    talkBtn.textContent = '⏹  Stop';
    talkBtn.classList.add('hwx-fac-recording');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    if (vuInterval) {
      clearInterval(vuInterval);
      vuInterval = null;
    }
    if (analyserNode) {
      analyserNode.disconnect();
      analyserNode = null;
    }

    isRecording = false;
    talkBtn.textContent = '🎤  Talk';
    talkBtn.classList.remove('hwx-fac-recording');
    vuFill.style.width = '0%';

    // Signal end of turn
    if (connectionState === STATE.CONNECTED && ws && ws.readyState === WebSocket.OPEN) {
      sendFrame(FAC_TYPE.CONTROL, JSON.stringify({ type: 'end_turn', text: '' }));
    }

    addLog('Recording stopped', 'system');
  }

  // ═════════════════════════════════════════════════════════════════════
  //  VU METER
  // ═════════════════════════════════════════════════════════════════════

  function setupVUMeter(stream) {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    source.connect(analyserNode);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    if (vuInterval) clearInterval(vuInterval);

    vuInterval = setInterval(() => {
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      const pct = Math.min(100, (avg / 255) * 100);
      vuFill.style.width = pct + '%';
    }, 80);
  }

  // ═════════════════════════════════════════════════════════════════════
  //  INIT
  // ═════════════════════════════════════════════════════════════════════

  function init() {
    // Create UI
    toggleBtn = createToggle();
    panel = createPanel();

    // Restore panel state
    const s = loadSettings();
    if (s.panelOpen) {
      openPanel();
    }

    addLog('Fun Audio Chat Connector loaded', 'system');
    addLog(`Default server: ws://${s.host}:${s.port}/chat`, 'system');
    addLog('Click "Reconnect" to connect, then "Talk" to start speaking', 'system');

    // Drive the initial status through setStatus() so the Reconnect button becomes
    // visible and the Talk button's disabled state is set correctly. Without this,
    // a fresh panel has NO usable connect affordance (Talk is disabled, Reconnect
    // is only revealed by a setStatus() call that never fired) — a dead-end.
    setStatus(STATE.DISCONNECTED, 'Disconnected');
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose connect/disconnect for debugging
  window.__facConnector = { connect, disconnect, getState: () => connectionState };
})();
