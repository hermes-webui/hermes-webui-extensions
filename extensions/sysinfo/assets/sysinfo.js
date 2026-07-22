/* System Info — Insights add-on cards: internet speed test + Docker
   containers, rendered right under the native System-health panel. All data
   comes from the extension's loopback sidecar through the consented proxy;
   no core code or native endpoints are touched, so WebUI / Agent updates
   can never break it (worst case: reinstall the extension).
   Docker: live stats, compose-project grouping with custom display names,
   start/stop/restart per container or per stack, image-update checks and
   one-click updates (single, stack, or all — dependency-first).
   Speed test: on-demand runs + optional auto-schedule (every N hours or
   daily at HH:MM), last reading persisted server-side. */
(function () {
  'use strict';
  if (window.__sysinfo) return; window.__sysinfo = true;
  var EXT = 'sysinfo';
  var BASE = '/api/extensions/' + EXT + '/sidecar';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var showToast = (typeof window.showToast === 'function') ? window.showToast : function () {};

  // Consent is granted by the user in Settings -> Extensions; we NEVER auto-grant
  // it. Core reports sidecar consent under TOP-LEVEL `status.sidecars`. This card
  // controls Docker, so require BOTH proxy.available AND proxy.consented, matched
  // by id. FAIL CLOSED when the record is absent. Also surface proxy.posture so
  // the auth-off ("local_unprotected") case names the full remedy.
  function sidecarStatus() {
    return fetch('/api/extensions/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var list = (d && Array.isArray(d.sidecars)) ? d.sidecars : [];
        var me = null;
        for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === EXT) { me = list[i]; break; } }
        if (!me) return { consented: false, posture: '', found: false };
        var p = me.proxy || {};
        return { consented: (p.available === true && p.consented === true),
                 posture: p.posture || '', found: true };
      }).catch(function () { return { consented: false, posture: '', found: false }; });
  }

  // Minimal fetch wrapper matching the call-shape the ported code expects:
  // api(path, {method, body, timeoutMs}) -> parsed JSON, throws on !ok.
  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body) { init.body = opts.body; init.headers['Content-Type'] = 'application/json'; }
    var timer = null;
    if (opts.timeoutMs) {
      var ctrl = new AbortController();
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs);
    }
    try {
      var r = await fetch(BASE + path, init);
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok && !(d && d.error)) throw new Error('HTTP ' + r.status);
      return d;
    } finally { if (timer) clearTimeout(timer); }
  }

  // ── Card injection: right after the native System-health panel ─────────
  var CARD_HTML =
    '<div class="mc-speedtest" id="mcSpeedtest">' +
      '<button type="button" class="mc-docker-toggle" id="mcSpeedtestToggle" onclick="mcSpeedtestToggle()" aria-expanded="false">' +
        '<span class="mc-docker-toggle-chevron" aria-hidden="true">\u25b8</span>' +
        '<span class="insights-card-title" style="margin:0">Speed test</span>' +
        '<span class="mc-docker-toggle-count" id="mcSpeedtestWhen"></span>' +
      '</button>' +
      '<div class="mc-speedtest-body" id="mcSpeedtestBody" hidden>' +
        '<div class="mc-speedtest-head">' +
          '<button type="button" class="mc-speedtest-btn" id="mcSpeedtestBtn" onclick="mcRunSpeedtest()">Run test</button>' +
          '<button type="button" class="mc-speedtest-auto" id="mcSpeedtestAutoBtn" onclick="mcSpeedtestAutoConfig()" title="Schedule automatic speed tests">Auto: Off</button>' +
        '</div>' +
        '<div class="mc-speedtest-metrics">' +
          '<div class="mc-speedtest-row">' +
            '<span class="mc-speedtest-dir" title="Download">\u2193</span>' +
            '<div class="mc-speedtest-bar mc-speedtest-bar-down"><div class="mc-speedtest-fill" id="mcStDownBar"></div></div>' +
            '<span class="mc-speedtest-num"><b id="mcStDown">\u2014</b> <i>Mbps</i></span>' +
          '</div>' +
          '<div class="mc-speedtest-row">' +
            '<span class="mc-speedtest-dir" title="Upload">\u2191</span>' +
            '<div class="mc-speedtest-bar mc-speedtest-bar-up"><div class="mc-speedtest-fill" id="mcStUpBar"></div></div>' +
            '<span class="mc-speedtest-num"><b id="mcStUp">\u2014</b> <i>Mbps</i></span>' +
          '</div>' +
          '<div class="mc-speedtest-ping">ping <b id="mcStPing">\u2014</b> ms</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="system-health-docker" id="systemHealthDocker" hidden>' +
      '<div class="mc-docker-toprow">' +
        '<button type="button" class="mc-docker-toggle" id="systemHealthDockerToggle" onclick="mcDockerToggle()" aria-expanded="false">' +
          '<span class="mc-docker-toggle-chevron" aria-hidden="true">\u25b8</span>' +
          '<span class="insights-card-title" style="margin:0">Docker</span>' +
          '<span class="mc-docker-toggle-count" id="systemHealthDockerCount">0/0</span>' +
        '</button>' +
        // Real button, OUTSIDE the collapse toggle — keyboard-reachable and not nested
        // interactive content (it triggers the destructive "update all").
        '<button type="button" class="mc-docker-update-pill" id="mcDockerUpdatePill" hidden onclick="mcDockerUpdateAll()" title="Update everything, dependency-first" aria-label="Update all containers, dependency-first"></button>' +
        '<span class="mc-docker-update-when" id="mcDockerUpdateWhen"></span>' +
        '<button type="button" class="mc-docker-checkupd" id="mcDockerCheckUpdBtn" onclick="mcDockerCheckUpdates(this)">\u27f3 Check updates</button>' +
      '</div>' +
      '<div class="mc-docker-list" id="systemHealthDockerList" hidden></div>' +
    '</div>';

  function _siEnsureCard() {
    if (document.getElementById('siSysinfoCard')) return true;
    var anchor = document.getElementById('systemHealthPanel');
    if (!anchor || !anchor.parentNode) return false;
    var card = document.createElement('section');
    card.className = 'insights-card si-sysinfo-card';
    card.id = 'siSysinfoCard';
    card.setAttribute('aria-label', 'Speed test and Docker containers');
    card.innerHTML = CARD_HTML;
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    if (typeof mcLoadLastSpeedtest === 'function') mcLoadLastSpeedtest();
    return true;
  }

  // Docker data poll — the extension's replacement for the fork\'s core
  // system-health payload. Fetches inventory+stats from the sidecar and
  // feeds the ported card renderer.
  var _siPollBusy = false;
  var _siConsent = null;
  async function _siPollDocker() {
    if (_siConsent === false || _siPollBusy || !document.getElementById('siSysinfoCard')) return;
    // Don't shell `docker stats` when nobody's looking — gate on the tab being
    // visible AND Insights actually showing (mirrors core's own health poll).
    if (document.visibilityState !== 'visible') return;
    if (!document.querySelector('main.showing-insights')) return;
    _siPollBusy = true;
    try {
      var d = await api('/api/system/docker');
      if (d && d.docker) _mcRenderDockerCard(d);
    } catch (_) {} finally { _siPollBusy = false; }
  }

  function _stAgoShort(epoch){
  const s = Math.max(0, Math.floor(Date.now()/1000 - Number(epoch)));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function _stCountUp(el, target){
  if (!el) return;
  // Respect reduced-motion: skip the 700ms tween and set the final value at once
  // (the CSS media query already stops the bar animation; the JS must match).
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = target.toFixed(1);
    return;
  }
  const start = parseFloat(el.textContent) || 0, t0 = performance.now(), dur = 700;
  (function step(now){
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = (start + (target - start) * (1 - Math.pow(1 - p, 3))).toFixed(1);
    if (p < 1) requestAnimationFrame(step); else el.textContent = target.toFixed(1);
  })(performance.now());
}
function _renderSpeedtest(d){
  if (!d || (!d.download_mbps && !d.upload_mbps)) return;
  const down = Number(d.download_mbps)||0, up = Number(d.upload_mbps)||0, ping = Number(d.ping_ms)||0;
  const max = Math.max(down, up, 1);
  _stCountUp($('mcStDown'), down); _stCountUp($('mcStUp'), up);
  const pe = $('mcStPing'); if (pe) pe.textContent = ping ? ping.toFixed(0) : '—';
  const db = $('mcStDownBar'); if (db) db.style.width = (down/max*100).toFixed(1) + '%';
  const ub = $('mcStUpBar'); if (ub) ub.style.width = (up/max*100).toFixed(1) + '%';
  const w = $('mcSpeedtestWhen'); if (w) w.textContent = d.tested_at ? ('last run ' + _stAgoShort(d.tested_at) + (d.server ? ' · ' + d.server : '')) : '';
}
// Collapsible speed test (like Docker). Fetches the last reading lazily on first
// expand — keeps it out of the initial Insight load.
window.mcSpeedtestToggle = function(){
  const body = $('mcSpeedtestBody'), tog = $('mcSpeedtestToggle');
  if (!body) return;
  const opening = body.hidden;
  body.hidden = !opening;
  if (tog) {
    tog.setAttribute('aria-expanded', String(opening));
    const ch = tog.querySelector('.mc-docker-toggle-chevron'); if (ch) ch.textContent = opening ? '▾' : '▸';
  }
  if (opening && typeof mcLoadLastSpeedtest === 'function') mcLoadLastSpeedtest();
  if (opening && typeof mcLoadSpeedtestAuto === 'function') mcLoadSpeedtestAuto();
};
window.mcLoadLastSpeedtest = async function(){
  try { const d = await api('/api/system/speedtest'); if (d && (d.download_mbps || d.upload_mbps)) _renderSpeedtest(d); } catch(_){}
};
window.mcRunSpeedtest = async function(){
  const btn = $('mcSpeedtestBtn'), when = $('mcSpeedtestWhen');
  if (btn) { btn.disabled = true; btn.classList.add('mc-speedtest-running'); }
  if (when) when.textContent = 'testing…';
  try {
    // A run takes ~15-40s — longer than the core sidecar-proxy's hard 10s cap,
    // so we can't wait on it synchronously (that's the "HTTP 502" people saw).
    // POST kicks off a background run and returns immediately (202); then we
    // poll the fast GET until it reports {running:false}.
    const kick = await api('/api/system/speedtest', { method: 'POST', timeoutMs: 12000 });
    if (kick && kick.error) { if (when) when.textContent = 'failed: ' + kick.error; return; }
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(function(r){ setTimeout(r, 3000); });
      let s;
      try { s = await api('/api/system/speedtest', { timeoutMs: 12000 }); }
      catch(_) { continue; }              // transient proxy hiccup — keep polling
      if (s && s.running) continue;       // still going
      if (s && s.error) { if (when) when.textContent = 'failed: ' + s.error; return; }
      if (s && (s.download_mbps || s.upload_mbps)) { _renderSpeedtest(s); return; }
      if (when) when.textContent = 'no result';
      return;
    }
    if (when) when.textContent = 'timed out';
  } catch(e) { if (when) when.textContent = 'failed: ' + ((e && e.message) || 'error'); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('mc-speedtest-running'); } }
};

// Auto-schedule speed tests: every N hours, or daily at HH:MM. Backend runs the
// test on a daemon thread (sidecar/sysinfo.py _st_auto_loop) and persists the
// reading like a manual run, so the card shows it next open.
function _mcSpeedtestAutoLabel(cfg){
  const b = $('mcSpeedtestAutoBtn'); if (!b) return;
  const on = cfg && (cfg.interval_minutes > 0 || cfg.at_time);
  if (cfg && cfg.interval_minutes > 0){ const m = cfg.interval_minutes; b.textContent = 'Auto: ' + (m % 60 === 0 ? (m/60 + 'h') : (m + 'm')); }
  else if (cfg && cfg.at_time){ b.textContent = 'Auto: ' + cfg.at_time; }
  else b.textContent = 'Auto: Off';
  b.style.color = on ? 'var(--success, #3fb950)' : '';
}
window.mcLoadSpeedtestAuto = async function(){
  try { const r = await api('/api/system/speedtest/auto'); window._mcSpeedtestAuto = r; _mcSpeedtestAutoLabel(r); } catch(_){}
};
window.mcSpeedtestAutoConfig = function(){
  const cur = window._mcSpeedtestAuto || { interval_minutes: 0, at_time: '' };
  const mode = cur.interval_minutes > 0 ? 'interval' : (cur.at_time ? 'daily' : 'off');
  const hrs = cur.interval_minutes > 0 ? (cur.interval_minutes / 60) : '';
  const inputCss = 'background:var(--surface, #1c2130);color:var(--text, #e6e8ee);border:1px solid var(--border, #2a2f3a);border-radius:6px;padding:3px 6px';
  const btnCss = 'padding:6px 14px;border-radius:8px;border:1px solid var(--border, #2a2f3a);background:var(--surface, #1c2130);color:var(--text, #e6e8ee);cursor:pointer;min-height:24px';
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
  ov.innerHTML = `
    <div role="dialog" aria-label="Automatic speed test" style="background:var(--surface, #151823);border:1px solid var(--border, #2a2f3a);border-radius:12px;padding:18px 20px;min-width:320px;color:var(--text, #e6e8ee);font-size:14px">
      <div style="font-weight:600;margin-bottom:12px">⚡ Automatic speed test</div>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="radio" name="stauto" value="off" ${mode==='off'?'checked':''}> Off</label>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="radio" name="stauto" value="interval" ${mode==='interval'?'checked':''}> Every <input id="stAutoHrs" type="number" min="1" max="168" step="1" value="${hrs||6}" style="width:64px;${inputCss}"> hours</label>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="radio" name="stauto" value="daily" ${mode==='daily'?'checked':''}> Daily at <input id="stAutoTime" type="time" value="${cur.at_time||'03:00'}" style="${inputCss}"></label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="stAutoCancel" style="${btnCss}">Cancel</button>
        <button id="stAutoSave" style="${btnCss};border-color:var(--accent, #3a7);color:var(--accent, #3a7)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  // Remember the trigger so focus returns to it on close (a11y).
  const _prevFocus = document.activeElement;
  const _focusables = () => Array.from(ov.querySelectorAll('input,button,[tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.disabled && el.offsetParent !== null);
  // Escape closes; Tab is trapped inside the dialog (wraps at both ends).
  const _onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = _focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', _onKey);
  (ov.querySelector('input,button') || {}).focus?.();
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', _onKey);
    if (_prevFocus && typeof _prevFocus.focus === 'function') { try { _prevFocus.focus(); } catch (_) {} }
  };
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#stAutoCancel').onclick = close;
  ov.querySelector('#stAutoSave').onclick = async () => {
    const m = (ov.querySelector('input[name=stauto]:checked') || {}).value;
    const body = { interval_minutes: 0, at_time: '' };
    if (m === 'interval'){ const h = parseFloat(ov.querySelector('#stAutoHrs').value) || 0; body.interval_minutes = Math.max(1, Math.round(h * 60)); }
    else if (m === 'daily'){ body.at_time = ov.querySelector('#stAutoTime').value || ''; }
    try { const r = await api('/api/system/speedtest/auto', { method: 'POST', body: JSON.stringify(body) }); window._mcSpeedtestAuto = r; _mcSpeedtestAutoLabel(r); } catch(_){}
    close();
  };
};

// extend the existing system-health renderer (in ui.js) to also
// render Docker containers when present. ui.js calls renderSystemHealth(payload)
// on its poll cycle; we hook a post-render Docker pass off the same panel.
// docker row gets a live status dot (green/pulse for
// running, amber for paused/restarting, red for exited/dead/created) and
// Start/Stop/Restart buttons. Buttons hit POST /api/system/docker/action
// with the container id; success triggers an immediate poll so the dot
// reflects the new state without waiting for the next 5s tick.
//
// wrapped in a collapsible section with a
// running/total count badge. Default = collapsed; localStorage remembers
// the user's preference under 'mc.docker.expanded'.
function _mcDockerExpanded() {
  return localStorage.getItem('mc.docker.expanded') === '1';
}
function _mcApplyDockerCollapseState() {
  const toggle = document.getElementById('systemHealthDockerToggle');
  const list = document.getElementById('systemHealthDockerList');
  const chev = toggle && toggle.querySelector('.mc-docker-toggle-chevron');
  const expanded = _mcDockerExpanded();
  if (list) list.hidden = !expanded;
  const bar = document.getElementById('mcDockerUpdateBar');
  if (bar) bar.hidden = !expanded;
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (chev) chev.textContent = expanded ? '▾' : '▸';
}
window.mcDockerToggle = function() {
  const next = !_mcDockerExpanded();
  try { localStorage.setItem('mc.docker.expanded', next ? '1' : '0'); } catch (_) {}
  _mcApplyDockerCollapseState();
};

// docker compose-stack grouping. Containers are grouped by their
// `com.docker.compose.project` label into collapsible sub-sections; each group
// can be renamed (custom label persisted server-side via /api/system/docker/groups
// so it sticks across devices). Plain `docker run` containers fall under
// "Ungrouped" at the bottom.
let _mcDockerGroupNames = {};        // compose project -> custom label
let _mcDockerContainerNames = {};    // container name -> custom label
let _mcDockerGroupNamesLoaded = false;
let _mcLastDockerPayload = null;
let _mcDockerGroupOrder = [];        // render-order keys, referenced by index from inline handlers
let _mcDockerUpdates = {};           // container name -> update-check result (on demand)

function _mcApplyDockerNameMaps(d) {
  if (!d) return;
  if (d.renames) _mcDockerGroupNames = d.renames;
  if (d.containers) _mcDockerContainerNames = d.containers;
}
async function _mcLoadDockerGroupNames() {
  try { _mcApplyDockerNameMaps(await api('/api/system/docker/groups')); } catch (_) {}
  _mcDockerGroupNamesLoaded = true;
  if (_mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload);
}
function _mcGroupLabel(key) {
  return _mcDockerGroupNames[key] || key || 'Ungrouped';
}
function _mcGroupExpanded(key) {
  const v = localStorage.getItem('mc.docker.group.' + key);
  return v === null ? true : v === '1';   // default expanded
}
window.mcDockerGroupToggle = function(idx) {
  const key = _mcDockerGroupOrder[idx]; if (key === undefined) return;
  const next = !_mcGroupExpanded(key);
  try { localStorage.setItem('mc.docker.group.' + key, next ? '1' : '0'); } catch (_) {}
  if (_mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload);
};
window.mcDockerRenameGroup = async function(idx, ev) {
  if (ev) ev.stopPropagation();
  const key = _mcDockerGroupOrder[idx]; if (key === undefined) return;
  const current = _mcDockerGroupNames[key] || '';
  const name = await showPromptDialog({ title:'Rename group', message:'Group display name (blank = reset to "' + (key || 'Ungrouped') + '"):', value:current, confirmLabel:'Save' });
  if (name === null) return;   // cancelled
  try {
    _mcApplyDockerNameMaps(await api('/api/system/docker/groups', { method: 'POST', body: JSON.stringify({ project: key, name: name.trim() }) }));
  } catch (_) {}
  if (_mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload);
};
// per-container display-name override (keyed by real container name; the
// label is cosmetic only — it does NOT rename the actual docker container).
window.mcDockerRenameContainer = async function(name, ev) {
  if (ev) ev.stopPropagation();
  document.querySelectorAll('.mc-docker-menu').forEach(m => { m.hidden = true; });
  if (!name) return;
  const current = _mcDockerContainerNames[name] || '';
  const label = await showPromptDialog({ title:'Rename container', message:'Display name for "' + name + '" (blank = reset to real name):', value:current, confirmLabel:'Save' });
  if (label === null) return;   // cancelled
  try {
    _mcApplyDockerNameMaps(await api('/api/system/docker/groups', { method: 'POST', body: JSON.stringify({ container: name, name: label.trim() }) }));
  } catch (_) {}
  if (_mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload);
};

function _mcDockerRowHtml(c) {
  const state = (c.state || '').toLowerCase();
  const isRunning = state === 'running';
  const isTransitioning = state === 'paused' || state === 'restarting';
  const dotCls = isRunning ? 'mc-docker-dot mc-docker-dot--ok'
               : isTransitioning ? 'mc-docker-dot mc-docker-dot--warn'
               : 'mc-docker-dot mc-docker-dot--err';
  const dotTitle = c.status || state || 'unknown';
  const cid = String(c.id || '').replace(/"/g, '');
  const realName = c.name || '(unnamed)';
  const cname = String(c.name || '').replace(/['"\\]/g, '');   // docker names are safe; strip just in case
  const override = _mcDockerContainerNames[c.name];
  const displayName = override || realName;
  // when overridden, surface the real name in the tooltip + a subtle marker
  const renamedTag = override ? `<span class="mc-docker-svc" title="real name: ${esc(realName)}">✎</span>` : '';
  const canStart = !isRunning;
  const canStop = isRunning || isTransitioning;
  const canRestart = isRunning || isTransitioning;
  // compose service name identifies the container's role within its stack
  const svc = c.compose_service ? `<span class="mc-docker-svc">${esc(c.compose_service)}</span>` : '';
  // image-update state (populated on demand by mcDockerCheckUpdates)
  const upd = _mcDockerUpdates[c.name];
  const hasUpdate = !!(upd && upd.update_available);
  const updBadge = hasUpdate
    ? `<span class="mc-docker-updbadge" title="${esc(upd.note || 'update available')}">update</span>` : '';
  const updItem = (upd && upd.compose_service) && hasUpdate
    ? `<button type="button" role="menuitem" class="mc-docker-mi mc-docker-mi--update"
                    onclick="mcDockerUpdate('${esc(cid)}', this)">⬆ Update</button>` : '';
  const nameTitle = (override ? realName + '\n  ' : '') + (c.id || '') + '\n  ' + (c.image || '') + '\n  ' + (c.status || '');
  return `
      <div class="mc-docker-row" data-docker-id="${esc(cid)}">
        <span class="${dotCls}" title="${esc(dotTitle)}" aria-label="${esc(dotTitle)}"></span>
        <span class="mc-docker-name" title="${esc(nameTitle)}"><span class="mc-docker-name-text">${esc(displayName)}${renamedTag}${svc}</span>${updBadge}</span>
        <span class="mc-docker-cell">CPU ${esc(c.cpu_percent || '—')}</span>
        <span class="mc-docker-cell">RAM ${esc(c.mem_percent || '—')}</span>
        <span class="mc-docker-cell mc-docker-cell--wide">${esc(c.mem_usage || '—')}</span>
        <span class="mc-docker-actions">
          <button type="button" class="mc-docker-kebab" aria-haspopup="menu" aria-expanded="false"
                  title="Container actions" aria-label="Container actions" onclick="mcDockerMenu(this, event)">⋮</button>
          <div class="mc-docker-menu" role="menu" hidden>
            <button type="button" role="menuitem" class="mc-docker-mi mc-docker-mi--start" ${canStart ? '' : 'disabled'}
                    onclick="mcDockerAction('${esc(cid)}', 'start', this)">▶ Start</button>
            <button type="button" role="menuitem" class="mc-docker-mi mc-docker-mi--restart" ${canRestart ? '' : 'disabled'}
                    onclick="mcDockerAction('${esc(cid)}', 'restart', this)">↻ Restart</button>
            <button type="button" role="menuitem" class="mc-docker-mi mc-docker-mi--stop" ${canStop ? '' : 'disabled'}
                    onclick="mcDockerAction('${esc(cid)}', 'stop', this)">■ Stop</button>
            ${updItem}
            <button type="button" role="menuitem" class="mc-docker-mi mc-docker-mi--rename"
                    onclick="mcDockerRenameContainer('${esc(cname)}', event)">✎ Rename</button>
          </div>
        </span>
      </div>`;
}

function _mcRenderDockerCard(payload) {
  const wrap = document.getElementById('systemHealthDocker');
  const list = document.getElementById('systemHealthDockerList');
  const countEl = document.getElementById('systemHealthDockerCount');
  if (!wrap || !list) return;
  const docker = payload && payload.docker;
  _mcLastDockerPayload = payload;
  _mcDockerRestoreUpdates();   // bring back a previous check's badges/pill (persists across refresh)
  if (!_mcDockerGroupNamesLoaded) _mcLoadDockerGroupNames();   // fire once; re-renders on resolve
  if (docker && docker.available && Array.isArray(docker.containers) && docker.containers.length) {
    wrap.hidden = false;
    const total = docker.containers.length;
    const running = docker.containers.filter(c => (c.state || '').toLowerCase() === 'running').length;
    if (countEl) countEl.textContent = `${running}/${total}`;
    _mcApplyDockerCollapseState();
    _mcDockerSyncUpdatePill();

    // Don't rebuild the list while a container kebab menu is open — the ~2s
    // poll's innerHTML replace would close it before the user can pick an
    // action. The header count above still updates; the next poll after the
    // menu closes refreshes the rows. (_mcDockerGroupOrder is left untouched so
    // the open menu's onclick indices keep matching the rendered DOM.)
    if (list.querySelector('.mc-docker-menu:not([hidden])')) return;

    // Group by compose project (first-appearance order; ungrouped sinks last).
    const order = [];
    const byKey = {};
    docker.containers.forEach(c => {
      const k = (c.compose_project || '').trim();
      if (!(k in byKey)) { byKey[k] = []; order.push(k); }
      byKey[k].push(c);
    });
    order.sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
    _mcDockerGroupOrder = order;

    list.innerHTML = order.map((key, idx) => {
      const items = byKey[key];
      const gTotal = items.length;
      const gRunning = items.filter(c => (c.state || '').toLowerCase() === 'running').length;
      const gDot = gRunning === gTotal ? 'mc-docker-dot--ok' : gRunning === 0 ? 'mc-docker-dot--err' : 'mc-docker-dot--warn';
      const expanded = _mcGroupExpanded(key);
      // Roll-up: how many containers in this stack have an image update — shown on
      // the stack header so it's visible without expanding the group.
      const gUpd = items.filter(c => { const u = _mcDockerUpdates[c.name]; return u && u.update_available; }).length;
      const _bu = window._mcBulkUpdating;
      const _stackBusy = _bu && _bu.running && (_bu.scope === 'all' || _bu.project === key);
      const gUpdBadge = _stackBusy
        ? `<span class="mc-docker-group-upd mc-docker-upd-busy" title="Updating…">⟳ ${_bu.done||0}/${_bu.total||'?'}</span>`
        : (gUpd
          ? `<button type="button" class="mc-docker-group-upd" title="Update this stack — ${gUpd} image update${gUpd === 1 ? '' : 's'}, dependency-first" onclick="event.stopPropagation();mcDockerUpdateStack(${idx}, this)">⬆ ${gUpd}</button>` : '');
      const rows = items.map(_mcDockerRowHtml).join('');
      // Stack-level controls (rename + Start/Restart/Stop all) only make sense
      // for real compose stacks — the synthetic "Ungrouped" bucket gets none.
      const isStack = key !== '';
      // Visible per-stack controls: rename + Start all / Restart all / Stop all.
      const controls = isStack ? `
          <button type="button" class="mc-docker-group-rename" title="Rename group"
                  aria-label="Rename group" onclick="event.stopPropagation();mcDockerRenameGroup(${idx}, event)">✎</button>
          <span class="mc-docker-group-actions">
            <button type="button" class="mc-docker-startall" title="Start all in this stack"
                    aria-label="Start all" onclick="event.stopPropagation();mcDockerGroupAction(${idx}, 'start', this)">▶</button>
            <button type="button" class="mc-docker-restartall" title="Restart all in this stack"
                    aria-label="Restart all" onclick="event.stopPropagation();mcDockerGroupAction(${idx}, 'restart', this)">↻</button>
            <button type="button" class="mc-docker-stopall" title="Stop all in this stack"
                    aria-label="Stop all" onclick="event.stopPropagation();mcDockerGroupAction(${idx}, 'stop', this)">■</button>
          </span>` : '';
      return `
      <div class="mc-docker-group">
        <div class="mc-docker-group-hd" role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"
             onclick="mcDockerGroupToggle(${idx})"
             onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===event.currentTarget){event.preventDefault();mcDockerGroupToggle(${idx});}">
          <span class="mc-docker-group-chev">${expanded ? '▾' : '▸'}</span>
          <span class="mc-docker-dot ${gDot}" aria-hidden="true"></span>
          <span class="mc-docker-group-name">${esc(_mcGroupLabel(key))}</span>
          <span class="mc-docker-group-count">${gRunning}/${gTotal}</span>
          ${gUpdBadge}
          ${controls}
        </div>
        <div class="mc-docker-group-body" ${expanded ? '' : 'hidden'}>${rows}</div>
      </div>`;
    }).join('');
  } else if (docker && docker.available && Array.isArray(docker.containers)
             && !docker.containers.length && docker.allowlist_configured === false) {
    // Available but the operator hasn't opted any containers in (deny-by-default
    // on a host-control surface). Guide them instead of showing a blank card.
    wrap.hidden = false;
    if (countEl) countEl.textContent = '0/0';
    list.innerHTML = '<div class="mc-docker-empty-hint" style="padding:12px;color:var(--muted);font-size:12px;line-height:1.5">'
      + 'No containers are shown yet — this card is <strong>deny-by-default</strong>. Opt stacks in by setting '
      + '<code>MC_DOCKER_NAME_ALLOW</code> (comma-separated name prefixes) or <code>MC_DOCKER_WORKDIR_PREFIX</code> '
      + 'on the sidecar service, or <code>MC_DOCKER_SHOW_ALL=1</code> to show everything, then restart it.</div>';
  } else {
    wrap.hidden = true;
    list.innerHTML = '';
  }
}
window._mcRenderDockerCard = _mcRenderDockerCard;

// docker container action handler. POSTs to /api/system/docker/action,
// triggers an immediate system-health re-poll on success so the UI reflects
// the new state without the 5s lag.
// toggle the per-container kebab (⋮) action menu — closes any other open
// menu + closes on outside click. Same dropdown on mobile/iPad/desktop.
window.mcDockerMenu = function(btn, ev) {
  if (ev) ev.stopPropagation();
  const menu = btn.nextElementSibling;
  const wasOpen = menu && !menu.hidden;
  document.querySelectorAll('.mc-docker-menu').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.mc-docker-kebab[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (menu && !wasOpen) {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Focus the first enabled item so keyboard users land inside the menu.
    const first = menu.querySelector('[role="menuitem"]:not([disabled])');
    if (first) { try { first.focus(); } catch (_) {} }
    const teardown = () => {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const close = (e) => { if (!menu.contains(e.target) && e.target !== btn) teardown(); };
    // Escape closes the menu and returns focus to the kebab trigger.
    const onKey = (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        e.preventDefault(); teardown(); try { btn.focus(); } catch (_) {}
      }
    };
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }
};

// Container action / group action / single update all run as serialized
// background jobs now (they can exceed the ~10s proxy timeout). After the POST
// returns 202 {id}, poll op-status until THIS job (matched by id) finishes,
// tolerating transient errors, and return its result. Throws on busy/timeout.
async function _mcPollDockerOp(startResp, r) {
  if (r.status === 409 || (startResp && startResp.error === 'busy')) {
    throw new Error('another Docker operation is already running');
  }
  if (!r.ok && r.status !== 202) throw new Error((startResp && startResp.error) || ('HTTP ' + r.status));
  const myId = startResp && startResp.id;
  for (let i = 0; i < 480; i++) {            // ~16min at 2s (single update ≤900s)
    await new Promise(res => setTimeout(res, 2000));
    let s = null;
    try {
      const pr = await fetch(BASE + '/api/system/docker/op-status', { credentials: 'same-origin' });
      if (pr.ok) s = await pr.json();
    } catch (_) { continue; }                // tolerate a transient proxy error
    if (!s) continue;
    if (s.id === myId && !s.running) return s.result || { ok: true };
    if (typeof s.id === 'number' && s.id > myId) return { ok: true };  // ours finished; another started
  }
  throw new Error('operation timed out');
}

window.mcDockerAction = async function(cid, action, btnEl) {
  // Close the kebab menu the item lives in (the card re-renders after the poll).
  const _menu = btnEl && btnEl.closest('.mc-docker-menu');
  if (_menu) _menu.hidden = true;
  if (btnEl) btnEl.disabled = true;
  const row = btnEl && btnEl.closest('.mc-docker-row');
  if (row) row.classList.add('mc-docker-row--busy');
  try {
    const r = await fetch(BASE + '/api/system/docker/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ container_id: cid, action }),
    });
    const startResp = await r.json().catch(() => ({}));
    let data;
    try { data = await _mcPollDockerOp(startResp, r); }
    catch (e) {
      if (typeof showToast === 'function') showToast(`Docker ${action} failed: ${e.message}`, undefined, 'error');
      else if (window.showStatusToast) window.showStatusToast(`Docker ${action} failed: ${e.message}`);
      return;
    }
    if (!data || data.ok === false) {
      const msg = data && data.error ? data.error : 'failed';
      if (typeof showToast === 'function') showToast(`Docker ${action} failed: ${msg}`, undefined, 'error');
      else if (window.showStatusToast) window.showStatusToast(`Docker ${action} failed: ${msg}`);
      return;
    }
    // Force an immediate re-poll so the status dot updates without waiting
    // for the next 5s tick.
    if (typeof _siPollDocker === 'function') {
      try { await _siPollDocker(); } catch (_) {}
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`Docker ${action} failed: ${e.message}`, undefined, 'error');
  } finally {
    if (row) row.classList.remove('mc-docker-row--busy');
    // btnEl may be re-rendered after the poll; if it survived, re-enable.
    if (btnEl) btnEl.disabled = false;
  }
};

// stack-level action — start/restart/stop EVERY container in a compose
// project in one server call (/api/system/docker/group-action). Stop/restart
// confirm first since they take down the whole stack.
window.mcDockerGroupAction = async function(idx, action, btnEl) {
  const key = _mcDockerGroupOrder[idx]; if (key === undefined) return;
  const menu = btnEl && btnEl.closest('.mc-docker-menu');
  if (menu) menu.hidden = true;
  if (!key) {
    if (typeof showToast === 'function') showToast("Ungrouped containers can't be controlled as a stack", undefined, 'error');
    return;
  }
  const label = _mcGroupLabel(key);
  if ((action === 'stop' || action === 'restart') && typeof showConfirmDialog === 'function') {
    const verb = action === 'stop' ? 'Stop' : 'Restart';
    const ok = await showConfirmDialog({
      title: `${verb} stack “${label}”?`,
      message: `This will ${action} every container in this stack.`,
      confirmLabel: `${verb} all`,
      danger: action === 'stop',
      focusCancel: action === 'stop',
    });
    if (!ok) return;
  }
  try {
    const r = await fetch(BASE + '/api/system/docker/group-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ project: key, action }),
    });
    const startResp = await r.json().catch(() => ({}));
    let data;
    try { data = await _mcPollDockerOp(startResp, r); }
    catch (e) {
      if (typeof showToast === 'function') showToast(`Stack ${action} failed: ${e.message}`, undefined, 'error');
      return;
    }
    if (!data || data.ok === false) {
      const msg = data && data.error ? data.error : 'failed';
      if (typeof showToast === 'function') showToast(`Stack ${action} failed: ${msg}`, undefined, 'error');
    } else if (typeof showToast === 'function') {
      showToast(`Stack “${label}”: ${action} → ${data.count || 0} container(s)`);
    }
    if (typeof _siPollDocker === 'function') { try { await _siPollDocker(); } catch (_) {} }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`Stack ${action} failed: ${e.message}`, undefined, 'error');
  }
};

// reflect the header "N updates" pill from the current _mcDockerUpdates map.
// Bulk image updates (dependency-first). The backend runs pull+recreate on a
// daemon thread; we POST to start, then poll status → progress toasts → re-check.
async function _mcBulkUpdatePoll(label){
  // Progress is shown by the inline done/total header (via _mcBulkUpdating +
  // _mcRefreshDockerBusy), NOT the singleton toast — replacing the app toast
  // every 3s for minutes would suppress unrelated notifications. Toast only on
  // completion/failure (the caller toasts on start). Tolerate transient proxy
  // errors until a bounded deadline rather than aborting on the first one.
  let fails = 0;
  const deadline = Date.now() + 16 * 60 * 1000;   // ~16min ceiling
  for(;;){
    let s;
    try { s = await api('/api/system/docker/update-bulk'); fails = 0; }
    catch(_) {
      if (++fails > 20 || Date.now() > deadline) {
        showToast(`${label} — lost track of the update (it may still be running)`, undefined, 'error');
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    if (s) {
      window._mcBulkUpdating = s.running ? s : null;
      _mcRefreshDockerBusy();
      if (!s.running) {
        const okN = (s.results||[]).filter(r=>r.ok).length;
        const failN = (s.results||[]).filter(r=>!r.ok).length;
        showToast(`${label} — ${okN} updated${failN ? ', ' + failN + ' failed' : ''}`, undefined, failN ? 'error' : 'info');
        break;
      }
    }
    if (Date.now() > deadline) { showToast(`${label} — timed out`, undefined, 'error'); break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  window._mcBulkUpdating = null;
  try { if (typeof mcDockerCheckUpdates === 'function') await mcDockerCheckUpdates(); } catch(_){}
  _mcRefreshDockerBusy();
}
window.mcDockerUpdateStack = async function(idx, btn){
  // idx (not the raw label) is passed in from the render so a crafted compose
  // project name can never reach the inline onclick string. Resolve it here.
  const project = _mcDockerGroupOrder[idx]; if (project === undefined) return;
  const _ok = (typeof showConfirmDialog === 'function') ? await showConfirmDialog({ title:'Update stack', message:`Update the "${project}" stack now? Its updatable images will be pulled and the containers recreated (dependency-first).`, confirmLabel:'Update', danger:true }) : true;
  if (!_ok) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/system/docker/update-bulk', { method:'POST', body: JSON.stringify({ scope:'stack', project }) });
    if (r && r.error) { showToast('Update failed: ' + r.error, undefined, 'error'); return; }
    if (r && r.started === false) { showToast('Nothing to update in this stack', undefined, 'info'); return; }
    showToast(`Updating ${project} — ${r.total} image${r.total===1?'':'s'}…`, undefined, 'info');
    window._mcBulkUpdating = { running: true, scope: 'stack', project, done: 0, total: r.total || 0 };
    _mcRefreshDockerBusy();
    _mcBulkUpdatePoll(project);
  } catch(e) { showToast('Update failed: ' + ((e && e.message)||'error'), undefined, 'error'); }
  finally { if (btn) btn.disabled = false; }
};
window.mcDockerUpdateAll = async function(){
  const _ok = (typeof showConfirmDialog === 'function') ? await showConfirmDialog({ title:'Update all stacks', message:'Update ALL stacks now? Every stack with an available update will be pulled and recreated, dependency-first (data stores → infra → apps). Affected services briefly restart.', confirmLabel:'Update all', danger:true }) : true;
  if (!_ok) return;
  try {
    const r = await api('/api/system/docker/update-bulk', { method:'POST', body: JSON.stringify({ scope:'all' }) });
    if (r && r.error) { showToast('Update failed: ' + r.error, undefined, 'error'); return; }
    if (r && r.started === false) { showToast('Nothing to update', undefined, 'info'); return; }
    showToast(`Updating all — ${r.total} image${r.total===1?'':'s'}, dependency-first…`, undefined, 'info');
    window._mcBulkUpdating = { running: true, scope: 'all', project: '', done: 0, total: r.total || 0 };
    _mcRefreshDockerBusy();
    _mcBulkUpdatePoll('Update all');
  } catch(e) { showToast('Update failed: ' + ((e && e.message)||'error'), undefined, 'error'); }
};
function _mcDockerSyncUpdatePill() {
  const pill = document.getElementById('mcDockerUpdatePill');
  if (!pill) return;
  const bu = window._mcBulkUpdating;
  if (bu && bu.running && bu.scope === 'all') {
    pill.hidden = false;
    pill.disabled = true;
    pill.className = 'mc-docker-update-pill mc-docker-upd-busy';
    pill.textContent = `⟳ updating ${bu.done||0}/${bu.total||'?'}`;
    return;
  }
  const n = Object.values(_mcDockerUpdates).filter(u => u && u.update_available).length;
  if (n > 0) {
    // Updates available → green + actionable ("Update all (N)").
    pill.hidden = false;
    pill.disabled = false;
    pill.className = 'mc-docker-update-pill mc-docker-has-updates';
    pill.textContent = `⬆ Update all (${n})`;
    pill.title = `Update all ${n} — dependency-first`;
  } else if (_mcDockerCheckedAt) {
    // Checked, nothing to update → greyed-out, non-actionable update icon
    // (not a hidden/empty pill leaking as a weird circle).
    pill.hidden = false;
    pill.disabled = true;
    pill.className = 'mc-docker-update-pill';
    pill.textContent = '⬆';
    pill.title = 'All container images up to date';
  } else {
    // Not checked yet → show nothing until "Check updates" runs.
    pill.hidden = true;
    pill.disabled = true;
    pill.className = 'mc-docker-update-pill';
    pill.textContent = '';
  }
}
// Re-paint the busy spinner on the pill + stack badges from window._mcBulkUpdating.
function _mcRefreshDockerBusy() {
  try { _mcDockerSyncUpdatePill(); } catch(_){}
  try { if (typeof _mcLastDockerPayload !== 'undefined' && _mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload); } catch(_){}
}

// Update-check results are SERVER-side state (persisted by the sidecar), so
// every device shows the same badges and the same "checked Xm ago". The old
// localStorage copy made desktop and phone disagree — never bring it back.
let _mcDockerUpdatesRestored = false, _mcDockerCheckedAt = 0;
function _mcDockerApplyUpdatesData(data) {
  _mcDockerUpdates = {};
  ((data && data.containers) || []).forEach(c => { if (c && c.name) _mcDockerUpdates[c.name] = c; });
  _mcDockerCheckedAt = data && data.checked_at ? Math.round(data.checked_at * 1000) : 0;
  _mcDockerSyncUpdatePill();
  _mcDockerShowWhen();
  if (_mcLastDockerPayload) _mcRenderDockerCard(_mcLastDockerPayload);
}
function _mcDockerRestoreUpdates() {
  if (_mcDockerUpdatesRestored) return;
  _mcDockerUpdatesRestored = true;
  // Plain GET = the sidecar's last persisted check; it never sweeps registries.
  fetch(BASE + '/api/system/docker/updates', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d && d.available && !d.never_checked) _mcDockerApplyUpdatesData(d); })
    .catch(() => {});
}
function _mcDockerShowWhen() {
  const whenEl = document.getElementById('mcDockerUpdateWhen');
  if (!whenEl) return;
  const n = Object.values(_mcDockerUpdates).filter(u => u && u.update_available).length;
  if (!_mcDockerCheckedAt && !n) { return; }   // nothing to show (preserve a fresh "just now")
  if (!_mcDockerCheckedAt) return;
  const mins = Math.round((Date.now() - _mcDockerCheckedAt) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  whenEl.textContent = (n > 0 ? `${n} update${n === 1 ? '' : 's'} · ` : 'up to date · ') + `checked ${ago}`;
}

// on-demand image-update check. Compares each container's local image digest
// against the registry (GET /api/system/docker/updates) and flags containers with a
// newer image. Network-bound, so it's a button — never the 2s health stream.
window.mcDockerCheckUpdates = async function(btn) {
  const whenEl = document.getElementById('mcDockerUpdateWhen');
  if (btn) { btn.disabled = true; btn.classList.add('mc-docker-checkupd--busy'); btn.textContent = '⟳ Checking…'; }
  if (whenEl) whenEl.textContent = '';
  try {
    // Kick off the background registry sweep (returns immediately), then poll the
    // fast GET until it finishes — the sweep can exceed the core proxy's 10s cap.
    let r = await fetch(BASE + '/api/system/docker/updates?refresh=1', { credentials: 'same-origin' });
    let data = await r.json().catch(() => ({}));
    if (!data || !data.available) {
      const msg = (data && data.reason) ? data.reason : ('HTTP ' + r.status);
      if (typeof showToast === 'function') showToast(`Update check unavailable: ${msg}`, undefined, 'error');
      if (whenEl) whenEl.textContent = 'check failed';
      return;
    }
    const deadline = Date.now() + 120000;
    while (data.sweeping && Date.now() < deadline) {
      if (whenEl) whenEl.textContent = 'checking…';
      await new Promise(res => setTimeout(res, 3000));
      try {
        r = await fetch(BASE + '/api/system/docker/updates', { credentials: 'same-origin' });
        data = await r.json().catch(() => data);
      } catch (_) { /* transient proxy hiccup — keep polling */ }
    }
    _mcDockerApplyUpdatesData(data);   // apply whatever badges we have so far
    if (data.sweeping) {
      // The deadline expired while the sweep is STILL running — never stamp
      // "checked just now" on partial/stale data; report that it's still going.
      if (whenEl) whenEl.textContent = 'still checking… (taking longer than usual)';
      if (typeof showToast === 'function') showToast('Update check is still running — check back shortly', undefined, 'info');
      return;
    }
    const n = data.updatable || 0;
    const rl = data.rate_limited || 0;
    const rlNote = rl > 0 ? ` · ${rl} rate-limited by Docker Hub` : '';
    if (whenEl) whenEl.textContent = (n > 0
      ? `${n} update${n === 1 ? '' : 's'} available · just now`
      : 'all up to date · just now') + rlNote;
    if (typeof showToast === 'function') {
      if (rl > 0) {
        showToast(`${n} update${n === 1 ? '' : 's'} found · ${rl} image${rl === 1 ? '' : 's'} couldn't be checked — Docker Hub rate limit hit. Run "docker login" to raise it.`, undefined, rl ? 'error' : undefined);
      } else {
        showToast(n > 0 ? `${n} container image update${n === 1 ? '' : 's'} available` : 'All container images are up to date');
      }
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`Update check failed: ${e.message}`, undefined, 'error');
    if (whenEl) whenEl.textContent = 'check failed';
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('mc-docker-checkupd--busy'); btn.textContent = '⟳ Check updates'; }
  }
};

// pull the newest image for one compose-managed container and recreate just
// that service, then report the resulting version. Confirms first — a recreate
// briefly takes the container down.
window.mcDockerUpdate = async function(cid, btnEl) {
  const menu = btnEl && btnEl.closest('.mc-docker-menu');
  if (menu) menu.hidden = true;
  const row = btnEl && btnEl.closest('.mc-docker-row');
  const nm = row ? (row.querySelector('.mc-docker-name')?.textContent || '').trim() : cid;
  if (typeof showConfirmDialog === 'function') {
    const ok = await showConfirmDialog({
      title: `Update “${nm}”?`,
      message: 'Pulls the newest image and recreates this container — it will be briefly unavailable while it restarts.',
      confirmLabel: 'Pull & update',
    });
    if (!ok) return;
  }
  if (row) row.classList.add('mc-docker-row--busy');
  if (typeof showToast === 'function') showToast(`Updating “${nm}” — pulling image…`);
  try {
    const r = await fetch(BASE + '/api/system/docker/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ container_id: cid }),
    });
    const startResp = await r.json().catch(() => ({}));
    let data;
    try { data = await _mcPollDockerOp(startResp, r); }
    catch (e) {
      if (typeof showToast === 'function') showToast(`Update failed: ${e.message}`, undefined, 'error');
      return;
    }
    if (!data || data.ok === false) {
      const msg = data && data.error ? data.error : 'failed';
      if (typeof showToast === 'function') showToast(`Update failed: ${msg}`, undefined, 'error');
      return;
    }
    // Clear this container's update flag; report the new version/digest.
    if (data.name && _mcDockerUpdates[data.name]) delete _mcDockerUpdates[data.name];
    _mcDockerSyncUpdatePill();
    const ver = data.version ? `v${data.version}` : (data.new_digest || 'latest');
    const verb = data.changed ? `updated → ${ver}` : 'already on the latest image';
    if (typeof showToast === 'function') showToast(`“${nm}” ${verb}`);
    if (typeof _siPollDocker === 'function') { try { await _siPollDocker(); } catch (_) {} }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`Update failed: ${e.message}`, undefined, 'error');
  } finally {
    if (row) row.classList.remove('mc-docker-row--busy');
  }
};

  // ── Boot: wait for the Insights panel, keep the card fresh ─────────────
  function _siTick() {
    sidecarStatus().then(function (st) {
      var ok = st.consented;
      var prev = _siConsent; _siConsent = ok;
      if (ok && prev === false) { var old = document.getElementById('siSysinfoCard'); if (old) old.remove(); }
      if (!_siEnsureCard()) return;
      if (!ok) {
        var card = document.getElementById('siSysinfoCard');
        // token-v1 fails closed with 403 while WebUI auth is off \u2014 name the full
        // remedy (password FIRST, then approve) in that posture.
        var msg = (st.posture === 'local_unprotected')
          ? 'System&nbsp;Info is blocked while WebUI has no password. Enable <strong>Settings&nbsp;\u2192&nbsp;Password</strong>, then approve the sidecar under <strong>Settings&nbsp;\u2192&nbsp;Extensions</strong>.'
          : 'Approve the System&nbsp;Info sidecar in <strong>Settings&nbsp;\u2192&nbsp;Extensions</strong> to show speedtest &amp; Docker.';
        if (card) card.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px">' + msg + '</div>';
        return;
      }
      _siPollDocker();
    });
  }
  function init() {
    _siTick();
    if ('MutationObserver' in window) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var nodes = muts[i].addedNodes || [];
          for (var k = 0; k < nodes.length; k++) {
            var n = nodes[k];
            if (!(n instanceof Element)) continue;
            if ((n.id === 'systemHealthPanel') || (n.querySelector && n.querySelector('#systemHealthPanel'))) {
              _siTick();
              return;
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
    setInterval(_siPollDocker, 20000);   // live stats while the card is on-screen
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
