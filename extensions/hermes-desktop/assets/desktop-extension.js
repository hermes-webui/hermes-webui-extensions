(function () {
  'use strict';

  if (window.__HERMES_DESKTOP_LOADED__) return;
  window.__HERMES_DESKTOP_LOADED__ = true;

  var EXT_ID = 'hermes-desktop';
  var CFG = {
    sidecar: 'http://127.0.0.1:17887',
    novncPort: 6080,
    pollMs: 3000,
    panelId: 'hermes-desktop-panel',
    btnId: 'hermes-desktop-btn'
  };

  var state = {
    sidecarOk: false,
    containerRunning: false,
    panelOpen: false
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
          '<span>🐧 Hermes Desktop</span>' +
          '<button class="hd-close-btn" id="hd-close">&times;</button>' +
        '</div>' +
        '<div class="hd-panel-body" id="hd-body">' +
          '<div class="hd-status" id="hd-status">Checking sidecar…</div>' +
          '<div class="hd-controls" id="hd-controls"></div>' +
          '<div class="hd-desktop-wrap" id="hd-desktop-wrap" style="display:none">' +
            '<iframe id="hd-vnc-frame" src="" allow="clipboard-read; clipboard-write" ' +
              'style="width:100%;height:100%;border:none;min-height:480px"></iframe>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panel);
      el('hd-close').onclick = closePanel;
    }
    return panel;
  }

  function openPanel() {
    var panel = buildPanel();
    panel.style.display = 'block';
    state.panelOpen = true;
    refreshStatus();
    if (state.containerRunning) showDesktop();
  }

  function closePanel() {
    var panel = el(CFG.panelId);
    if (panel) panel.style.display = 'none';
    state.panelOpen = false;
  }

  function showDesktop() {
    var wrap = el('hd-desktop-wrap');
    var frame = el('hd-vnc-frame');
    if (wrap && frame) {
      frame.src = 'http://127.0.0.1:' + CFG.novncPort + '/vnc.html';
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

  function sidecarAction(action) {
    return fetchSidecar('/container/' + action, { method: 'POST' });
  }

  // ---- UI updates ----

  function refreshStatus() {
    var st = el('hd-status');
    var ct = el('hd-controls');
    if (!st || !ct) return;

    checkHealth().then(function (data) {
      if (!state.sidecarOk) {
        st.innerHTML = '<span class="hd-status-off">&#x26A0; Sidecar not running</span>';
        ct.innerHTML = '<p>Start the Hermes Desktop sidecar:</p><pre>cd hermes-desktop && python3 sidecar/sidecar.py</pre>';
        hideDesktop();
      } else if (!state.containerRunning) {
        st.innerHTML = '<span class="hd-status-warn">&#x23F3; Desktop container not running</span>';
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
        st.innerHTML = '<span class="hd-status-on">&#x2705; Desktop running</span>';
        ct.innerHTML =
          '<button class="hd-btn hd-btn-stop" id="hd-stop-btn">Stop Desktop</button>';
        el('hd-stop-btn').onclick = function () {
          sidecarAction('stop').then(function () {
            hideDesktop();
            setTimeout(refreshStatus, 2000);
          });
        };
        if (state.panelOpen) showDesktop();
      }
    });
  }

  // ---- Sidebar button ----

  function addSidebarButton() {
    if (el(CFG.btnId)) return;

    var btn = cr('button', 'hd-sidebar-btn', '🐧');
    btn.id = CFG.btnId;
    btn.title = 'Hermes Desktop — Linux desktop in a panel';
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

  // ---- Init ----

  function init() {
    addSidebarButton();
    buildPanel();

    // Poll sidecar periodically
    setInterval(function () {
      if (state.panelOpen) refreshStatus();
    }, CFG.pollMs);

    // Initial health check
    checkHealth().then(function (data) {
      console.log('[Hermes Desktop] Sidecar status:', data);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
