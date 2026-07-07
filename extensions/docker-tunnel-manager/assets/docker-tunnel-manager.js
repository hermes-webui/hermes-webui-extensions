(() => {
  'use strict';

  // ── Docker & Tunnel Manager — Hermes WebUI Extension ─────────────
  // Adds a rail button + overlay for Docker containers, images, system
  // usage, and Cloudflare tunnel status/health.
  //
  // Pure DOM injection, no backend deps beyond the sidecar on :17900.
  // Uses HermesExtensionSettings when available (legacy localStorage fallback).

  const EXT = 'docker-tunnel-manager';
  if (window.__hermesDtmLoaded) return;
  window.__hermesDtmLoaded = true;

  /* ── Constants ─────────────────────────────────────────────────── */

  const SIDECAR_ORIGIN = 'http://127.0.0.1:17900';
  const RAIL_BTN_ID = 'hwxDtmRailBtn';
  const OVERLAY_ID = 'hwxDtmOverlay';

  let overlayOpen = false;
  let activeTab = 'containers';
  let refreshTimer = null;
  let pendingActions = new Set();

  /* ── Settings helpers ──────────────────────────────────────────── */

  function loadCfg() {
    try {
      const api = window.HermesExtensionSettings;
      if (api && typeof api.settingsForExtension === 'function') {
        const s = api.settingsForExtension(EXT);
        if (s && s.supported) {
          return {
            autoRefresh: s.get('autoRefresh') !== false,
            refreshInterval: parseInt(s.get('refreshInterval') || '15', 10) || 15,
            sidecarPort: parseInt(s.get('sidecarPort') || '17900', 10) || 17900,
          };
        }
      }
    } catch (_) {}
    // Legacy localStorage fallback
    try {
      const raw = localStorage.getItem('hermes-ext-dtm-cfg');
      if (raw) {
        const c = JSON.parse(raw);
        return {
          autoRefresh: c.autoRefresh !== false,
          refreshInterval: parseInt(c.refreshInterval || '15', 10) || 15,
          sidecarPort: parseInt(c.sidecarPort || '17900', 10) || 17900,
        };
      }
    } catch (_) {}
    return { autoRefresh: true, refreshInterval: 15, sidecarPort: 17900 };
  }

  function apiUrl(path) {
    const port = loadCfg().sidecarPort;
    return `http://127.0.0.1:${port}${path}`;
  }

  /* ── HTTP helpers ──────────────────────────────────────────────── */

  async function apiGet(path) {
    const res = await fetch(apiUrl(path), { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path) {
    const res = await fetch(apiUrl(path), { method: 'POST', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ── Toast notifications ───────────────────────────────────────── */

  function showToast(msg, type) {
    const existing = document.querySelector('.hwx-dtm-toast');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'hwx-dtm-toast' + (type === 'error' ? ' hwx-dtm-toast-error' : type === 'success' ? ' hwx-dtm-toast-success' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  /* ── Confirm dialog ────────────────────────────────────────────── */

  function showConfirm(title, body) {
    return new Promise((resolve) => {
      const dlg = document.createElement('div');
      dlg.className = 'hwx-dtm-dlg';
      dlg.innerHTML = `
        <div class="hwx-dtm-dlg-card">
          <div class="hwx-dtm-dlg-title">${t(title)}</div>
          <div class="hwx-dtm-dlg-body">${t(body)}</div>
          <div class="hwx-dtm-dlg-actions">
            <button class="hwx-dtm-bar-btn hwx-dtm-dlg-cancel">Cancel</button>
            <button class="hwx-dtm-bar-btn danger hwx-dtm-dlg-confirm">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector('.hwx-dtm-dlg-cancel').onclick = () => { dlg.remove(); resolve(false); };
      dlg.querySelector('.hwx-dtm-dlg-confirm').onclick = () => { dlg.remove(); resolve(true); };
      dlg.onclick = (e) => { if (e.target === dlg) { dlg.remove(); resolve(false); } };
    });
  }

  function t(s) { return s.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ── DOM builders ──────────────────────────────────────────────── */

  function statusDot(state) {
    const cls = ['running', 'exited', 'paused', 'restarting', 'created', 'removing'].includes(state) ? state : 'exited';
    return `<span class="hwx-dtm-dot ${cls}"></span>`;
  }

  function healthClass(status) {
    if (status === 'ok' || status === 'authed') return 'hwx-dtm-health-ok';
    if (status === 'redirect') return 'hwx-dtm-health-warn';
    return 'hwx-dtm-health-err';
  }

  function spinner() {
    return '<span class="hwx-dtm-spinner"></span>';
  }

  function actionBtn(label, action, cid, extra) {
    const id = `dtm-act-${action}-${cid}-${Math.random().toString(36).slice(2, 6)}`;
    const cls = 'hwx-dtm-act' + (extra === 'danger' ? ' danger' : '');
    return `<button class="${cls}" id="${id}" data-action="${action}" data-cid="${cid}">${label}</button>`;
  }

  /* ── Tab rendering ─────────────────────────────────────────────── */

  function showLoading(container) {
    container.innerHTML = '<div class="hwx-dtm-loading"><span class="hwx-dtm-spinner-big"></span> Loading…</div>';
  }

  function showError(container, msg) {
    container.innerHTML = `<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">⚠</div><div class="hwx-dtm-empty-text">${t(msg)}</div></div>`;
  }

  async function renderContainers(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/containers');
      if (!data.containers || data.containers.length === 0) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">🐳</div><div class="hwx-dtm-empty-text">No containers</div></div>';
        return;
      }
      let html = '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th></th><th>Name</th><th>Image</th><th>Ports</th><th>Status</th><th>CPU</th><th>Mem</th><th></th></tr></thead><tbody>';
      for (const c of data.containers) {
        const isBusy = pendingActions.has(c.id);
        html += `<tr>
          <td>${statusDot(c.state)}</td>
          <td class="hwx-dtm-name">${t(c.name)}</td>
          <td class="hwx-dtm-mono">${t(c.image)}</td>
          <td style="font-size:11px;color:var(--muted,#888)">${t(c.ports || '—')}</td>
          <td>${t(c.status)}</td>
          <td>${c.cpu_pct != null ? c.cpu_pct + '%' : '—'}</td>
          <td>${c.mem_human || '—'}</td>
          <td class="hwx-dtm-action-cell">${isBusy ? spinner() :
            (c.state === 'running' ? actionBtn('■ Stop', 'stop', c.id, 'danger') + ' ' + actionBtn('↻ Restart', 'restart', c.id) :
             actionBtn('▶ Start', 'start', c.id))}
          </td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      container.innerHTML = html;
      wireActions(container);
    } catch (e) {
      showError(container, 'Sidecar unreachable on port 17900. Is the sidecar running?');
    }
  }

  async function renderImages(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/images');
      if (!data.images || data.images.length === 0) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">🖼</div><div class="hwx-dtm-empty-text">No images</div></div>';
        return;
      }
      let html = `<div style="margin-bottom:10px;font-size:12px;color:var(--muted,#888)">${data.count} images — ${t(data.total_size_human)} total</div>`;
      html += '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th>Repository</th><th>Tag</th><th>Size</th><th>Containers</th></tr></thead><tbody>';
      for (const img of data.images) {
        const tag = img.tags && img.tags[0] ? img.tags[0] : '<none>:<none>';
        const [repo, ver] = tag.includes(':') ? tag.split(':') : [tag, 'latest'];
        html += `<tr>
          <td class="hwx-dtm-name">${t(repo)}</td>
          <td class="hwx-dtm-mono">${t(ver)}</td>
          <td>${t(img.size_human)}</td>
          <td>${img.containers}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      container.innerHTML = html;
    } catch (e) {
      showError(container, 'Sidecar unreachable');
    }
  }

  async function renderSystem(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/system/df');
      if (!data.layers_size && !data.images) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">💾</div><div class="hwx-dtm-empty-text">No data</div></div>';
        return;
      }
      const maxSize = Math.max(
        (data.images && data.images.size) || 0,
        (data.containers && data.containers.size) || 0,
        (data.volumes && data.volumes.size) || 0,
        (data.build_cache && data.build_cache.size) || 0,
        1
      );
      const cats = ['images', 'containers', 'volumes', 'build_cache'];
      const labels = { images: 'Images', containers: 'Containers', volumes: 'Volumes', build_cache: 'Build Cache' };
      let html = `<div style="margin-bottom:12px;font-size:12px;color:var(--muted,#888)">Layers cache: ${t(data.layers_human)}</div>`;
      for (const cat of cats) {
        const d = data[cat];
        if (!d) continue;
        const pct = Math.round((d.size / maxSize) * 100);
        const reclaimPct = d.reclaimable ? Math.round((d.reclaimable / d.size) * 100) : 0;
        html += `<div class="hwx-dtm-df-row">
          <div class="hwx-dtm-df-label">${labels[cat]}</div>
          <div class="hwx-dtm-df-bar-wrap">
            <div class="hwx-dtm-df-bar active-size" style="width:${Math.max(pct, 2)}%"></div>
            ${reclaimPct > 0 ? `<div class="hwx-dtm-df-bar-reclaim" style="width:${reclaimPct}%"></div>` : ''}
          </div>
          <div class="hwx-dtm-df-num">${t(d.size_human)}${d.reclaimable ? ' (' + t(d.reclaimable_human) + ' reclaim)' : ''}</div>
        </div>`;
      }
      container.innerHTML = html;
    } catch (e) {
      showError(container, 'Sidecar unreachable');
    }
  }

  async function renderTunnel(container) {
    showLoading(container);
    try {
      const [tunData, healthData] = await Promise.all([
        apiGet('/api/tunnels').catch(() => ({ tunnels: [] })),
        apiGet('/api/tunnels/health').catch(() => ({ routes: [] })),
      ]);

      const tun = tunData.tunnels && tunData.tunnels[0];
      if (!tun) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">🔒</div><div class="hwx-dtm-empty-text">No tunnel data. Is cloudflared installed?</div></div>';
        return;
      }

      let html = '<div style="margin-bottom:12px">';
      // Tunnel header
      html += `<div style="font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text,#fff)">${t(tun.name)}</div>`;
      html += `<div class="hwx-dtm-tunnel-id">${t(tun.id || '—')}</div>`;
      html += `<div style="font-size:12px;margin-top:4px;color:var(--muted,#888)">${tun.connector_count || tun.connectors.length} connector${(tun.connector_count || tun.connectors.length) !== 1 ? 's' : ''} · ${tun.connectors.length > 0 ? tun.connectors[0].age : 'N/A'} old</div>`;
      html += '</div>';

      // Health routes
      if (healthData.routes && healthData.routes.length > 0) {
        html += `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#888);margin-bottom:6px">Ingress Health <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:11px">(checked ${t(healthData.checked_at || '')})</span></div>`;
        html += '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th>Hostname</th><th>Backend</th><th>Status</th><th>Code</th><th>Latency</th></tr></thead><tbody>';
        for (const r of healthData.routes) {
          html += `<tr>
            <td class="hwx-dtm-name">${t(r.hostname)}</td>
            <td class="hwx-dtm-mono">${t(r.service)}</td>
            <td class="${healthClass(r.status)}" style="font-weight:600">${r.status}</td>
            <td class="hwx-dtm-mono">${r.http_code || '—'}</td>
            <td class="hwx-dtm-mono">${r.latency ? r.latency + 's' : '—'}</td>
          </tr>`;
        }
        html += '</tbody></table></div>';
      } else {
        html += '<div style="font-size:12px;color:var(--muted,#888);margin-bottom:8px">No health data</div>';
      }

      // Logs toggle
      html += `<div style="margin-top:12px"><button class="hwx-dtm-bar-btn hwx-dtm-toggle-logs">Show tunnel logs</button></div>`;
      html += '<div class="hwx-dtm-logs" id="hwxDtmLogs" style="display:none;margin-top:8px"></div>';

      container.innerHTML = html;

      // Wire log toggle
      const logBtn = container.querySelector('.hwx-dtm-toggle-logs');
      const logDiv = container.querySelector('#hwxDtmLogs');
      if (logBtn && logDiv) {
        logBtn.onclick = async () => {
          if (logDiv.style.display === 'none') {
            logDiv.style.display = 'block';
            logDiv.textContent = 'Loading…';
            logBtn.textContent = 'Hide tunnel logs';
            try {
              const logData = await apiGet('/api/tunnels/logs?lines=50');
              logDiv.textContent = logData.logs || 'No logs';
            } catch (_) {
              logDiv.textContent = 'Failed to fetch logs';
            }
          } else {
            logDiv.style.display = 'none';
            logBtn.textContent = 'Show tunnel logs';
          }
        };
      }
    } catch (e) {
      showError(container, 'Sidecar unreachable');
    }
  }

  /* ── Wire action buttons ───────────────────────────────────────── */

  function wireActions(container) {
    container.querySelectorAll('.hwx-dtm-act[data-action]').forEach(btn => {
      btn.onclick = async () => {
        const action = btn.dataset.action;
        const cid = btn.dataset.cid;
        if (!action || !cid) return;

        if (action === 'stop') {
          const ok = await showConfirm('Stop Container', `Are you sure you want to stop container <strong>${t(cid)}</strong>?`);
          if (!ok) return;
        }

        pendingActions.add(cid);
        btn.outerHTML = spinner();
        try {
          await apiPost(`/api/containers/${cid}/${action}`);
          showToast(`${action}ed container ${cid}`, 'success');
        } catch (e) {
          showToast(`${action} failed: ${e.message}`, 'error');
        }
        pendingActions.delete(cid);
        refreshTab();
      };
    });
  }

  /* ── Tab switching ─────────────────────────────────────────────── */

  const tabRenderers = {
    containers: renderContainers,
    images: renderImages,
    system: renderSystem,
    tunnel: renderTunnel,
  };

  function refreshTab() {
    const body = document.querySelector('.hwx-dtm-body');
    const tab = activeTab;
    if (!body || !tabRenderers[tab]) return;
    tabRenderers[tab](body);
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.hwx-dtm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    refreshTab();
  }

  /* ── Auto-refresh ──────────────────────────────────────────────── */

  function startAutoRefresh() {
    stopAutoRefresh();
    const cfg = loadCfg();
    if (cfg.autoRefresh && cfg.refreshInterval > 0) {
      refreshTimer = setInterval(() => {
        if (overlayOpen) refreshTab();
      }, cfg.refreshInterval * 1000);
    }
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  /* ── Overlay lifecycle ─────────────────────────────────────────── */

  function buildOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'hwx-dtm-overlay';
    overlay.innerHTML = `
      <div class="hwx-dtm-bar">
        <div class="hwx-dtm-bar-title">🐳 DTM</div>
        <div class="hwx-dtm-tabs">
          <button class="hwx-dtm-tab active" data-tab="containers">Containers</button>
          <button class="hwx-dtm-tab" data-tab="images">Images</button>
          <button class="hwx-dtm-tab" data-tab="system">System</button>
          <button class="hwx-dtm-tab" data-tab="tunnel">Tunnel</button>
        </div>
        <button class="hwx-dtm-bar-btn hwx-dtm-refresh-btn">↻</button>
        <button class="hwx-dtm-bar-btn hwx-dtm-close">✕</button>
      </div>
      <div class="hwx-dtm-body"></div>`;

    document.body.appendChild(overlay);

    // Wire tab clicks
    overlay.querySelectorAll('.hwx-dtm-tab').forEach(tab => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });

    // Wire refresh
    overlay.querySelector('.hwx-dtm-refresh-btn').onclick = refreshTab;

    // Wire close
    overlay.querySelector('.hwx-dtm-close').onclick = closeOverlay;

    return overlay;
  }

  function openOverlay() {
    if (overlayOpen) return;
    overlayOpen = true;
    const overlay = buildOverlay();
    overlay.style.display = 'flex';
    document.getElementById(RAIL_BTN_ID).classList.add('active');
    refreshTab();
    startAutoRefresh();
  }

  function closeOverlay() {
    if (!overlayOpen) return;
    overlayOpen = false;
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.style.display = 'none';
    const btn = document.getElementById(RAIL_BTN_ID);
    if (btn) btn.classList.remove('active');
    stopAutoRefresh();
  }

  /* ── Rail button ───────────────────────────────────────────────── */

  function addRailButton() {
    if (document.getElementById(RAIL_BTN_ID)) return;

    const rail = document.querySelector('.rail');
    if (!rail) {
      // Retry on DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addRailButton);
      } else {
        setTimeout(addRailButton, 500);
      }
      return;
    }

    const btn = document.createElement('button');
    btn.id = RAIL_BTN_ID;
    btn.className = 'rail-btn';  // reuse existing rail-btn class
    btn.title = 'Docker & Tunnel Manager';
    btn.innerHTML = '🐳';
    btn.style.fontSize = '18px';
    btn.style.lineHeight = '1';

    const firstBtn = rail.querySelector('.rail-btn');
    if (firstBtn) {
      rail.insertBefore(btn, firstBtn);
    } else {
      rail.appendChild(btn);
    }

    btn.onclick = () => {
      if (overlayOpen) closeOverlay();
      else openOverlay();
    };
  }

  /* ── Init ──────────────────────────────────────────────────────── */

  function init() {
    addRailButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
