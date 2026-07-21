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

  // Sidecar proxy path — the WebUI backend proxies to 127.0.0.1:17900
  // so the extension works both locally and through Cloudflare tunnels.
  const SIDECAR_PROXY = '/api/extensions/docker-tunnel-manager/sidecar';
  const RAIL_BTN_ID = 'hwxDtmRailBtn';
  const OVERLAY_ID = 'hwxDtmOverlay';

  let overlayOpen = false;
  let activeTab = 'containers';
  let refreshTimer = null;
  let pendingActions = new Set();
  let logPollTimer = null;
  let activeLogCid = null;

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
          };
        }
      }
    } catch (_) {}
    return { autoRefresh: true, refreshInterval: 15 };
  }

  function apiUrl(path) {
    return SIDECAR_PROXY + path;
  }

  /* ── HTTP helpers ──────────────────────────────────────────────── */

  async function apiGet(path) {
    const res = await fetch(apiUrl(path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path) {
    const res = await fetch(apiUrl(path), { method: 'POST' });
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
      showError(container, 'Docker/Tunnel sidecar unreachable. Ensure the sidecar is running.');
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
      showError(container, `Sidecar error: ${e.message || e}`);
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
      showError(container, `Sidecar error: ${e.message || e}`);
    }
  }

  async function renderTunnel(container) {
    showLoading(container);
    try {
      const tunData = await apiGet('/api/tunnels').catch(() => ({ tunnels: [] }));
      const tun = tunData.tunnels && tunData.tunnels[0];
      if (!tun) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">🔒</div><div class="hwx-dtm-empty-text">No tunnel data. Is cloudflared installed?</div></div>';
        return;
      }

      let html = '<div style="margin-bottom:12px">';
      // Tunnel header
      const cc = tun.connector_count != null ? tun.connector_count : (tun.connectors ? tun.connectors.length : 0);
      html += `<div style="font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text,#fff)">${t(tun.name)}</div>`;
      html += `<div class="hwx-dtm-tunnel-id">${t(tun.id || '—')}</div>`;
      html += `<div style="font-size:12px;margin-top:4px;color:var(--muted,#888)">${cc} connector${cc !== 1 ? 's' : ''}</div>`;
      html += '</div>';

      // Ingress routes (from tunnel info — instant)
      const ingress = tun.ingress || [];
      if (ingress.length > 0) {
        html += `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#888);margin-bottom:6px">Ingress Routes (${ingress.length})</div>`;
        html += '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th>Hostname</th><th>Backend</th></tr></thead><tbody>';
        for (const r of ingress) {
          html += `<tr>
            <td class="hwx-dtm-name">${t(r.hostname)}</td>
            <td class="hwx-dtm-mono">${t(r.service || '—')}</td>
          </tr>`;
        }
        html += '</tbody></table></div>';
      }

      // Health (lazy-loaded — non-blocking)
      html += `<div id="hwxDtmHealth" style="margin-top:12px;font-size:12px;color:var(--muted,#888)">Checking ingress health…</div>`;

      // Logs toggle
      html += `<div style="margin-top:12px"><button class="hwx-dtm-bar-btn hwx-dtm-toggle-logs">Show tunnel logs</button></div>`;
      html += '<div class="hwx-dtm-logs" id="hwxDtmLogs" style="display:none;margin-top:8px"></div>';

      container.innerHTML = html;

      // Lazy health fetch (does not block render)
      apiGet('/api/tunnels/health')
        .then(healthData => {
          const hd = container.querySelector('#hwxDtmHealth');
          if (!hd) return;
          const routes = healthData.routes || [];
          if (routes.length === 0) {
            hd.innerHTML = 'No health data';
            return;
          }
          let h = `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#888);margin-bottom:6px">Ingress Health <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:11px">(checked ${t(healthData.checked_at || '')})</span></div>`;
          h += '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th>Hostname</th><th>Backend</th><th>Status</th><th>Code</th><th>Latency</th></tr></thead><tbody>';
          for (const r of routes) {
            h += `<tr>
              <td class="hwx-dtm-name">${t(r.hostname)}</td>
              <td class="hwx-dtm-mono">${t(r.service)}</td>
              <td class="${healthClass(r.status)}" style="font-weight:600">${r.status}</td>
              <td class="hwx-dtm-mono">${r.http_code || '—'}</td>
              <td class="hwx-dtm-mono">${r.latency ? r.latency + 's' : '—'}</td>
            </tr>`;
          }
          h += '</tbody></table></div>';
          hd.outerHTML = h;
        })
        .catch(() => {
          const hd = container.querySelector('#hwxDtmHealth');
          if (hd) hd.innerHTML = 'Health check failed';
        });

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
      showError(container, `Sidecar error: ${e.message || e}`);
    }
  }

  /* ── Log polling ────────────────────────────────────────────────── */

  async function renderVolumes(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/volumes');
      if (!data.volumes || data.volumes.length === 0) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">📦</div><div class="hwx-dtm-empty-text">No volumes</div></div>';
        return;
      }
      let html = '<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px">';
      html += `<span style="font-size:12px;color:var(--muted,#888)">${data.volumes.length} volume${data.volumes.length !== 1 ? 's' : ''}</span>`;
      html += '<button class="hwx-dtm-bar-btn danger" id="hwxDtmPruneVol">Prune unused</button>';
      html += '</div>';
      html += '<div class="hwx-dtm-table-wrap"><table class="hwx-dtm-table"><thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th>Size</th><th>Containers</th><th></th></tr></thead><tbody>';
      for (const v of data.volumes) {
        html += `<tr>
          <td class="hwx-dtm-name">${t(v.name)}</td>
          <td class="hwx-dtm-mono">${t(v.driver || 'local')}</td>
          <td class="hwx-dtm-mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t(v.mountpoint || '')}">${t(v.mountpoint || '—')}</td>
          <td>${t(v.size_human || '—')}</td>
          <td>${v.containers && v.containers.length ? t(v.containers.join(', ')) : '—'}</td>
          <td class="hwx-dtm-action-cell"><button class="hwx-dtm-act danger" data-action="delvol" data-volname="${t(v.name)}">Delete</button></td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      container.innerHTML = html;

      // Prune button
      const pruneBtn = container.querySelector('#hwxDtmPruneVol');
      if (pruneBtn) {
        pruneBtn.onclick = async () => {
          const ok = await showConfirm('Prune Volumes', 'Remove all unused local volumes?');
          if (!ok) return;
          pruneBtn.disabled = true;
          pruneBtn.textContent = 'Pruning…';
          try {
            const res = await apiPost('/api/volumes/prune');
            showToast(res.message || 'Volumes pruned', 'success');
          } catch (e) {
            showToast('Prune failed: ' + e.message, 'error');
          }
          pruneBtn.disabled = false;
          pruneBtn.textContent = 'Prune unused';
          refreshTab();
        };
      }

      // Delete buttons
      container.querySelectorAll('.hwx-dtm-act[data-action="delvol"]').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.volname;
          const ok = await showConfirm('Delete Volume', `Are you sure you want to delete volume <strong>${t(name)}</strong>?`);
          if (!ok) return;
          btn.outerHTML = spinner();
          try {
            await apiPost(`/api/volumes/${encodeURIComponent(name)}/delete`);
            showToast(`Deleted volume ${name}`, 'success');
          } catch (e) {
            showToast(`Delete failed: ${e.message}`, 'error');
          }
          refreshTab();
        };
      });
    } catch (e) {
      showError(container, `Sidecar error: ${e.message || e}`);
    }
  }

  /* ── Compose tab ────────────────────────────────────────────────── */

  async function renderCompose(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/compose');
      if (!data.projects || data.projects.length === 0) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">📋</div><div class="hwx-dtm-empty-text">No compose projects found</div></div>';
        return;
      }
      let html = '';
      for (const proj of data.projects) {
        const projectName = proj.project || 'unknown';
        html += `<div class="hwx-dtm-compose-card">
          <div class="hwx-dtm-compose-header">📋 ${t(projectName)}</div>
          <div class="hwx-dtm-compose-body">
            <span>Containers: <b>${proj.running_count || 0}/${proj.container_count || 0}</b></span>
            <span>Services: <b>${proj.services && proj.services.length ? t(proj.services.join(', ')) : '—'}</b></span>
          </div>
        </div>`;
      }
      container.innerHTML = html;
    } catch (e) {
      showError(container, `Compose error: ${e.message || e}`);
    }
  }

  /* ── Logs tab ───────────────────────────────────────────────────── */

  async function renderLogs(container) {
    showLoading(container);
    try {
      const data = await apiGet('/api/containers');
      const containers = data.containers || [];
      if (containers.length === 0) {
        container.innerHTML = '<div class="hwx-dtm-empty"><div class="hwx-dtm-empty-icon">📜</div><div class="hwx-dtm-empty-text">No containers available for logs</div></div>';
        return;
      }
      // Build container selector + controls
      let opts = '';
      for (const c of containers) {
        opts += `<option value="${t(c.id)}">${t(c.name)}</option>`;
      }
      let html = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select class="hwx-dtm-logs-select" id="hwxDtmLogsSelect" style="background:var(--surface,#181825);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:6px;padding:6px 10px;font-size:12px;flex:1;min-width:160px">${opts}</select>
        <button class="hwx-dtm-bar-btn" id="hwxDtmLogsToggle" style="white-space:nowrap">Live: ON</button>
        <button class="hwx-dtm-bar-btn" id="hwxDtmLogsClear">Clear</button>
        <span style="font-size:11px;color:var(--muted,#888);margin-left:4px" id="hwxDtmLogsStatus"></span>
      </div>
      <div class="hwx-dtm-logs" id="hwxDtmLogsDisplay" style="height:400px;overflow-y:auto;background:var(--surface,#181825);border:1px solid var(--border,#333);border-radius:6px;padding:10px;font-family:monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all"></div>`;
      container.innerHTML = html;

      const select = container.querySelector('#hwxDtmLogsSelect');
      const display = container.querySelector('#hwxDtmLogsDisplay');
      const toggleBtn = container.querySelector('#hwxDtmLogsToggle');
      const clearBtn = container.querySelector('#hwxDtmLogsClear');
      const statusEl = container.querySelector('#hwxDtmLogsStatus');

      let live = true;

      async function pollLogs(cid) {
        try {
          const logData = await apiGet(`/api/containers/${encodeURIComponent(cid)}/logs?tail=200`);
          if (!live) return;
          if (logData && logData.logs) {
            display.textContent = logData.logs.join('\n');
            statusEl.textContent = `${logData.count} lines`;
            display.scrollTop = display.scrollHeight;
          }
        } catch (e) {
          statusEl.textContent = 'Error fetching logs';
          statusEl.style.color = 'var(--red,#f38ba8)';
          return;
        }
        if (live) {
          logPollTimer = setTimeout(() => pollLogs(activeLogCid), 3000);
        }
      }

      function startPolling(cid) {
        stopPolling();
        activeLogCid = cid;
        logPollTimer = setTimeout(() => pollLogs(cid), 0);
      }

      function stopPolling() {
        if (logPollTimer) {
          clearTimeout(logPollTimer);
          logPollTimer = null;
        }
      }

      select.onchange = () => {
        startPolling(select.value);
      };

      toggleBtn.onclick = () => {
        live = !live;
        toggleBtn.textContent = live ? 'Live: ON' : 'Live: OFF';
        if (live) {
          startPolling(select.value);
        } else {
          stopPolling();
          statusEl.textContent = 'Paused';
          statusEl.style.color = 'var(--muted,#888)';
        }
      };

      clearBtn.onclick = () => { display.textContent = ''; };

      // Auto-start polling on first container
      startPolling(select.value);
    } catch (e) {
      showError(container, `Sidecar error: ${e.message || e}`);
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
    volumes: renderVolumes,
    compose: renderCompose,
    logs: renderLogs,
  };

  function refreshTab() {
    const body = document.querySelector('.hwx-dtm-body');
    const tab = activeTab;
    if (!body || !tabRenderers[tab]) return;
    tabRenderers[tab](body);
  }

  function switchTab(tab) {
    if (activeTab === 'logs') stopPolling();
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
          <button class="hwx-dtm-tab" data-tab="volumes">Volumes</button>
          <button class="hwx-dtm-tab" data-tab="compose">Compose</button>
          <button class="hwx-dtm-tab" data-tab="logs">Logs</button>
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
    stopPolling();
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
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="2"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2"/>
      <line x1="12" y1="12" x2="12" y2="20"/>
      <line x1="9" y1="15" x2="15" y2="15"/>
    </svg>`;
    btn.style.fontSize = '';
    btn.style.lineHeight = '';

    const themeBtn = document.getElementById('hwxThemeCreatorRailBtn');
    const spacer = rail.querySelector('.rail-spacer');
    if (themeBtn && themeBtn.nextSibling) {
      // Insert just after theme-creator (beneath it, above spacer).
      rail.insertBefore(btn, themeBtn.nextSibling);
    } else if (spacer) {
      // Fallback: just after the spacer if theme-creator isn't present.
      rail.insertBefore(btn, spacer.nextSibling);
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
