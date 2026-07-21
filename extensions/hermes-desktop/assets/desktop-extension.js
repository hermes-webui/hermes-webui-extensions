(function () {
  'use strict';

  if (window.__HERMES_DESKTOP_LOADED__) return;
  window.__HERMES_DESKTOP_LOADED__ = true;

  var EXT_ID = 'hermes-desktop';
  var CFG = {
    sidecar: 'http://127.0.0.1:17887',
    novncContainer: 6901,
    novncHost: 6081,
    pollMs: 3000,
    panelId: 'hermes-desktop-panel',
    btnId: 'hermes-desktop-btn',
    storageKey: 'hermes-desktop:target'
  };

  var TARGETS = {
    container: { label: 'Container (Xfce :1)', port: CFG.novncContainer, display: ':1', desc: 'Full XFCE desktop in Docker container' },
    host: { label: 'Host (Xvfb :0)', port: CFG.novncHost, display: ':0', desc: 'Host Xvfb framebuffer — lightweight' }
  };

  var state = {
    sidecarOk: false,
    containerRunning: false,
    panelOpen: false,
    target: localStorage.getItem(CFG.storageKey) || 'container',
    cuaStatus: { host: 'unknown', container: 'unknown' },
    transcriptOpen: false
  };

  // ---- DOM helpers ----

  function el(id) { return document.getElementById(id); }
  function cr(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ---- Panel ----

  function buildPanel() {
    var panel = el(CFG.panelId);
    if (!panel) {
      panel = cr('div', 'hd-panel', '');
      panel.id = CFG.panelId;
      panel.innerHTML =
        '<div class="hd-panel-header">' +
          '<span>\u{1F427} Hermes Desktop</span>' +
          '<div class="hd-header-actions">' +
            '<button class="hd-header-btn" id="hd-settings-btn" title="Settings">\u2699</button>' +
            '<button class="hd-close-btn" id="hd-close">&times;</button>' +
          '</div>' +
        '</div>' +
        '<div class="hd-panel-body" id="hd-body">' +
          '<div class="hd-status" id="hd-status">Checking sidecar\u2026</div>' +
          '<div class="hd-controls" id="hd-controls"></div>' +
          '<div class="hd-desktop-wrap" id="hd-desktop-wrap" style="display:none">' +
            '<iframe id="hd-vnc-frame" src="" allow="clipboard-read; clipboard-write" ' +
              'style="width:100%;height:100%;border:none;min-height:420px"></iframe>' +
          '</div>' +
          '<div class="hd-transcript" id="hd-transcript" style="display:none">' +
            '<div class="hd-transcript-header">' +
              '<span>Agent Transcript</span>' +
              '<button class="hd-header-btn" id="hd-transcript-close" title="Close">&times;</button>' +
            '</div>' +
            '<div class="hd-transcript-body" id="hd-transcript-body"></div>' +
          '</div>' +
        '</div>' +
        '<div class="hd-settings-overlay" id="hd-settings" style="display:none">' +
          '<div class="hd-settings-panel">' +
            '<div class="hd-settings-header">' +
              '<span>\u2699 Settings</span>' +
              '<button class="hd-header-btn" id="hd-settings-close" title="Close">&times;</button>' +
            '</div>' +
            '<div class="hd-settings-body">' +
              '<div class="hd-setting-group">' +
                '<h4>Computer Use Target</h4>' +
                '<p class="hd-setting-desc">Which display the agent drives via <code>computer_use</code> tool.</p>' +
                '<div class="hd-target-options" id="hd-target-options"></div>' +
              '</div>' +
              '<div class="hd-setting-group">' +
                '<h4>Computer Use Status</h4>' +
                '<div id="hd-cua-status">' +
                  '<div class="hd-cua-row"><span>Host (Xvfb :0):</span><span class="hd-cua-dot hd-cua-unknown" id="cua-host-status">unknown</span></div>' +
                  '<div class="hd-cua-row"><span>Container (Xfce :1):</span><span class="hd-cua-dot hd-cua-unknown" id="cua-container-status">unknown</span></div>' +
                '</div>' +
              '</div>' +
              '<div class="hd-setting-group">' +
                '<h4>Transcript</h4>' +
                '<label class="hd-toggle-label">' +
                  '<input type="checkbox" id="hd-transcript-toggle"> ' +
                  'Show agent transcript in panel' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panel);
      el('hd-close').onclick = closePanel;
      el('hd-settings-btn').onclick = toggleSettings;
      el('hd-settings-close').onclick = toggleSettings;
      el('hd-transcript-close').onclick = toggleTranscript;
      buildTargetOptions();
    }
    return panel;
  }

  function buildTargetOptions() {
    var container = el('hd-target-options');
    if (!container) return;
    container.innerHTML = '';
    Object.keys(TARGETS).forEach(function (key) {
      var t = TARGETS[key];
      var opt = cr('div', 'hd-target-option' + (key === state.target ? ' hd-target-active' : ''));
      opt.setAttribute('data-target', key);
      opt.innerHTML =
        '<div class="hd-target-radio">' +
          '<span class="hd-target-dot"></span>' +
        '</div>' +
        '<div class="hd-target-info">' +
          '<div class="hd-target-label">' + t.label + '</div>' +
          '<div class="hd-target-desc">' + t.desc + '</div>' +
        '</div>';
      opt.onclick = function () {
        setTarget(key);
        refreshStatus();
      };
      container.appendChild(opt);
    });
  }

  function openPanel() {
    var panel = buildPanel();
    panel.style.display = 'flex';
    state.panelOpen = true;
    document.body.classList.add('hd-panel-open');
    refreshStatus();
    if (state.containerRunning) showDesktop();
  }

  function closePanel() {
    var panel = el(CFG.panelId);
    if (panel) panel.style.display = 'none';
    state.panelOpen = false;
    document.body.classList.remove('hd-panel-open');
  }

  function toggleSettings() {
    var s = el('hd-settings');
    if (s) s.style.display = s.style.display === 'none' ? 'block' : 'none';
  }

  function toggleTranscript() {
    state.transcriptOpen = !state.transcriptOpen;
    var t = el('hd-transcript');
    if (t) t.style.display = state.transcriptOpen ? 'block' : 'none';
  }

  function setTarget(key) {
    state.target = key;
    localStorage.setItem(CFG.storageKey, key);
    // Update radio styles
    var opts = document.querySelectorAll('.hd-target-option');
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('hd-target-active', opts[i].getAttribute('data-target') === key);
    }
    hideDesktop();
  }

  function showDesktop() {
    var wrap = el('hd-desktop-wrap');
    var frame = el('hd-vnc-frame');
    if (wrap && frame) {
      var port = TARGETS[state.target] ? TARGETS[state.target].port : CFG.novncContainer;
      frame.src = 'http://127.0.0.1:' + port + '/vnc.html';
      wrap.style.display = 'block';
    }
  }

  function hideDesktop() {
    var wrap = el('hd-desktop-wrap');
    var frame = el('hd-vnc-frame');
    if (wrap) wrap.style.display = 'none';
    if (frame) frame.src = '';
  }

  // ---- Sidecar API ----

  function fetchSidecar(path, opts) {
    return fetch(CFG.sidecar + path, opts || {})
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'sidecar unreachable' }; });
  }

  function checkHealth() {
    return fetchSidecar('/health').then(function (data) {
      state.sidecarOk = !!(data && data.ok);
      state.containerRunning = !!(data && data.container === 'running');
      return data;
    });
  }

  function checkCuaStatus() {
    return fetchSidecar('/cua/status').then(function (data) {
      if (data && data.ok) {
        state.cuaStatus = {
          host: data.host || 'unknown',
          container: data.container || 'unknown'
        };
      }
      return data;
    }).catch(function () {
      state.cuaStatus = { host: 'unknown', container: 'unknown' };
    });
  }

  function sidecarAction(action) {
    return fetchSidecar('/container/' + action, { method: 'POST' });
  }

  // ---- UI updates ----

  function renderCuaStatus() {
    var hostEl = el('cua-host-status');
    var contEl = el('cua-container-status');
    if (hostEl) {
      hostEl.textContent = state.cuaStatus.host;
      hostEl.className = 'hd-cua-dot hd-cua-' + state.cuaStatus.host;
    }
    if (contEl) {
      contEl.textContent = state.cuaStatus.container;
      contEl.className = 'hd-cua-dot hd-cua-' + state.cuaStatus.container;
    }
  }

  function refreshStatus() {
    var st = el('hd-status');
    var ct = el('hd-controls');
    if (!st || !ct) return;

    checkHealth().then(function (data) {
      checkCuaStatus().then(renderCuaStatus);

      if (!state.sidecarOk) {
        st.innerHTML = '<span class="hd-status-off">\u26A0 Sidecar not running</span>';
        ct.innerHTML = '<p>Start the Hermes Desktop sidecar:</p><pre>python3 sidecar/sidecar.py</pre>';
        hideDesktop();
      } else if (!state.containerRunning) {
        st.innerHTML = '<span class="hd-status-warn">\u23F3 Desktop container not running</span>';
        ct.innerHTML =
          '<button class="hd-btn hd-btn-start" id="hd-start-btn">Start Desktop</button>' +
          '<p class="hd-hint">Launches the XFCE desktop container (first start may take 1-2 min to pull image)</p>';
        el('hd-start-btn').onclick = function () {
          sidecarAction('start').then(function () {
            setTimeout(refreshStatus, 3000);
          });
        };
        hideDesktop();
      } else {
        var targetName = TARGETS[state.target] ? TARGETS[state.target].label : 'Container (Xfce :1)';
        st.innerHTML = '<span class="hd-status-on">\u2705 Desktop running</span>' +
          ' <span class="hd-target-badge">' + targetName + '</span>';
        ct.innerHTML =
          '<button class="hd-btn hd-btn-stop" id="hd-stop-btn">Stop Desktop</button>' +
          '<button class="hd-btn hd-btn-transcript" id="hd-transcript-btn">\u{1F4AC} Transcript</button>';
        el('hd-stop-btn').onclick = function () {
          sidecarAction('stop').then(function () {
            hideDesktop();
            setTimeout(refreshStatus, 2000);
          });
        };
        el('hd-transcript-btn').onclick = toggleTranscript;
        if (state.panelOpen) showDesktop();
      }
    });
  }

  // ---- Transcript via renderTranscript hook ----

  function tryRenderTranscript() {
    if (!state.transcriptOpen) return;
    var body = el('hd-transcript-body');
    if (!body) return;

    // Use the WebUI's renderTranscript if available (added by PR #5508)
    if (typeof window.renderTranscript === 'function' &&
        typeof window.__S !== 'undefined' && window.__S && window.__S.messages) {
      window.renderTranscript(body, window.__S.messages, { skipEmpty: true });
    } else {
      body.innerHTML = '<p class="hd-hint">Agent transcript will appear here when available. Requires WebUI core hooks (PR #5508).</p>';
    }
  }

  // ---- Sidebar button ----

  function addSidebarButton() {
    if (el(CFG.btnId)) return;

    var btn = cr('button', 'hd-sidebar-btn', '\u{1F427}');
    btn.id = CFG.btnId;
    btn.title = 'Hermes Desktop \u2014 Linux desktop in a panel';
    btn.onclick = function () {
      if (state.panelOpen) { closePanel(); } else { openPanel(); }
      btn.classList.toggle('hd-active', state.panelOpen);
    };

    // Try to add to sidebar nav, fallback to floating button
    var sidebar = document.querySelector('[class*="sidebar"] nav') ||
                  document.querySelector('.app-sidebar nav') ||
                  document.querySelector('#sessionSidebar');
    if (sidebar) {
      sidebar.appendChild(btn);
    } else {
      btn.classList.add('hd-sidebar-btn--float');
      document.body.appendChild(btn);
    }
  }

  // Hook into renderTranscript when WebUI broadcasts it
  function hookRenderTranscript() {
    // The WebUI exposes these globals after PR #5508 lands
    Object.defineProperty(window, 'renderTranscript', {
      configurable: true,
      set: function (fn) {
        // Store the real implementation
        window.__renderTranscriptImpl = fn;
        // If panel is open, re-render
        if (state.transcriptOpen) tryRenderTranscript();
      },
      get: function () {
        return window.__renderTranscriptImpl || function () {};
      }
    });

    // Also hook session open so we can re-render on navigation
    if (typeof window.registerHermesSessionOpenHandler === 'function') {
      window.registerHermesSessionOpenHandler(function (sid, data, phase) {
        if (phase && phase.loaded && state.transcriptOpen) {
          setTimeout(tryRenderTranscript, 100);
        }
      });
    }

    // Poll for transcript updates when open
    setInterval(function () {
      if (state.transcriptOpen) tryRenderTranscript();
    }, 2000);
  }

  // ---- Init ----

  function init() {
    addSidebarButton();
    buildPanel();
    hookRenderTranscript();

    // Restore transcript toggle state
    var toggle = el('hd-transcript-toggle');
    if (toggle) {
      toggle.checked = state.transcriptOpen;
      toggle.onchange = function () { state.transcriptOpen = toggle.checked; };
    }

    // Poll sidecar + cua status periodically
    setInterval(function () {
      if (state.panelOpen) refreshStatus();
    }, CFG.pollMs);

    // Initial health check
    checkHealth().then(function (data) {
      checkCuaStatus().then(renderCuaStatus);
      console.log('[Hermes Desktop] Sidecar status:', data);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
