(() => {
  'use strict';
  if (window.__hwxMonitorLoaded) return;
  window.__hwxMonitorLoaded = true;

  const CFG_KEY = 'hwx-monitor-config';
  const DEFAULTS = {
    showCpu: true, showRam: true, showDisk: true, showDiskIO: true, showNet: true,
    showLabels: true,
    cpuColor: '#6c8cff', ramColor: '#ff6b9d', diskColor: '#ffd166', diskIOColor: '#ffd166',
    netUpColor: '#06d6a0', netDownColor: '#ff6b9d',
    refreshMs: 2000,
  };
  const loadCfg = () => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG_KEY))); } catch (_) { return Object.assign({}, DEFAULTS); } };
  const saveCfg = c => { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (_) {} };

  let cfg = loadCfg();
  let stats = { cpu: null, ram: null, disk: null, diskIO: null, netRx: 0, netTx: 0 };
  let history = { cpu: [], ram: [], disk: [], diskIO: [], netRx: [], netTx: [] };
  let netScale = 1048576; // bytes/s that maps to 100% fill (adaptive, updated each poll)
  let el, canvas, ctx, popup, settingsPanel, pollTimer, lastErr = null;
  const cell = 18, gap = 3, maxHist = 60;
  const rd = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); };
  // IO detail label: compact K/M only (no "B/s" suffix), one decimal — mirrors fmtNet's K/M branches.
  const fmtIO = b => {
    if (b == null) return '—';
    const abs = Math.abs(b);
    if (abs < 1048576) return (b / 1024).toFixed(1) + 'K';
    return (b / 1048576).toFixed(1) + 'M';
  };
  // IO number: one decimal below 1 MB/s (0.5, 0.6…), integer MB/s above.
  const fmtIONum = b => {
    if (b == null) return '—';
    const mb = b / 1048576;
    return mb < 1 ? mb.toFixed(1) : Math.round(mb).toString();
  };
  // Net label: compact K/M (no "B/s" suffix).
  const fmtNet = b => {
    if (b == null) return '—';
    const abs = Math.abs(b);
    if (abs < 1024) return Math.round(b) + 'B';
    if (abs < 1048576) return (b / 1024).toFixed(1) + 'K';
    return (b / 1048576).toFixed(1) + 'M';
  };

  const getModules = () => {
    const m = [];
    if (cfg.showCpu) m.push({ key: 'cpu', label: 'CPU', value: stats.cpu, color: cfg.cpuColor });
    if (cfg.showRam) m.push({ key: 'ram', label: 'RAM', value: stats.ram, color: cfg.ramColor });
    if (cfg.showDisk) m.push({ key: 'disk', label: 'Dsk', value: stats.disk, color: cfg.diskColor });
    if (cfg.showDiskIO) m.push({ key: 'diskIO', label: 'IO', value: stats.diskIO != null ? Math.min(100, (stats.diskIO / 104857600) * 100) : null, color: cfg.diskIOColor, isIO: true, raw: stats.diskIO });
    if (cfg.showNet) m.push({ key: 'net', label: 'Net', rx: stats.netRx, tx: stats.netTx, color: cfg.netUpColor, colorDn: cfg.netDownColor });
    return m;
  };

  const draw = () => {
    const mods = getModules();
    const w = mods.length * cell + (mods.length - 1) * gap + 8;
    canvas.width = w; canvas.height = cell + 6;
    canvas.style.width = w + 'px'; canvas.style.height = (cell + 6) + 'px';
    if (!mods.length) return;

    mods.forEach((m, i) => {
      const x = 4 + i * (cell + gap), y = 2;
      rd(x, y, cell, cell, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fill();

      if (m.key === 'net') {
        const half = cell / 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(x, y + half); ctx.lineTo(x + cell, y + half); ctx.stroke();
        const txPct = Math.min(100, (m.tx / netScale) * 100);
        const fillUp = half * txPct / 100;
        if (fillUp > 0) { ctx.save(); rd(x, y, cell, cell, 3); ctx.clip(); ctx.fillStyle = m.color; ctx.globalAlpha = 0.7; ctx.fillRect(x, y + half - fillUp, cell, fillUp); ctx.globalAlpha = 1; ctx.restore(); }
        const rxPct = Math.min(100, (m.rx / netScale) * 100);
        const fillDn = half * rxPct / 100;
        if (fillDn > 0) { ctx.save(); rd(x, y, cell, cell, 3); ctx.clip(); ctx.fillStyle = m.colorDn; ctx.globalAlpha = 0.7; ctx.fillRect(x, y + half, cell, fillDn); ctx.globalAlpha = 1; ctx.restore(); }
        if (cfg.showLabels) { ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '6px sans-serif'; ctx.fillText(fmtNet(m.tx), x + cell / 2, y + half / 2); ctx.fillText(fmtNet(m.rx), x + cell / 2, y + half + half / 2); }
      } else {
        const v = m.value != null ? m.value : 0;
        const fillH = cell * v / 100;
        if (fillH > 0) { ctx.save(); rd(x, y, cell, cell, 3); ctx.clip(); ctx.fillStyle = m.color; ctx.fillRect(x, y + cell - fillH, cell, fillH); ctx.restore(); }
        if (cfg.showLabels) { ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 9px sans-serif'; ctx.fillText(m.value != null ? (m.isIO ? fmtIONum(m.raw) : Math.round(m.value).toString()) : '—', x + cell / 2, y + cell / 2); }
      }
      if (lastErr) { ctx.fillStyle = 'rgba(255,100,100,0.7)'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right'; ctx.fillText('⚠', x + cell - 1, y + cell / 2); }
    });
  };

  const fetchStats = async () => {
    try {
      const d = await api('/api/system/health', { timeoutToast: false, timeoutMs: 5000 });
      if (!d || d.available === false) throw new Error('unavailable');
      stats = {
        cpu: d.cpu?.percent ?? null,
        ram: d.memory?.percent ?? null,
        disk: d.disk?.percent ?? null,
        diskIO: d.disk?.io_bytes_per_sec ?? null,
        netRx: d.net?.rx_bytes_per_sec ?? 0,
        netTx: d.net?.tx_bytes_per_sec ?? 0,
      };
      ['cpu','ram','disk'].forEach(k => { if (stats[k] != null) { history[k].push(stats[k]); if (history[k].length > maxHist) history[k].shift(); } });
      if (stats.diskIO != null) { const ioPct = Math.min(100, (stats.diskIO / 104857600) * 100); history.diskIO.push(ioPct); if (history.diskIO.length > maxHist) history.diskIO.shift(); }
      history.netRx.push(stats.netRx); if (history.netRx.length > maxHist) history.netRx.shift();
      history.netTx.push(stats.netTx); if (history.netTx.length > maxHist) history.netTx.shift();
      // Adaptive net scale: 100% fill = 2x the recent peak, min 64 KB/s so low traffic stays visible.
      const peak = Math.max(1, ...history.netRx, ...history.netTx);
      netScale = Math.max(65536, peak * 2);
      lastErr = null;
    } catch (e) { lastErr = e; }
  };

  // Pack a W×H bitmap buffer into a width×height Braille string (U+2800+).
  const _encodeBraille = (buf, W, width, height) => {
    let out = '';
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        let bits = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
          if (buf[(cy * 4 + dy) * W + (cx * 2 + dx)]) bits |= (1 << (dy + dx * 3));
        }
        out += String.fromCharCode(0x2800 + bits);
      }
      out += '\n';
    }
    return out;
  };

  // Braille wave — absolute 0-100 scale (NOT normalized to local max)
  const wave = (data, width, height) => {
    if (!data || data.length < 2) return '';
    const W = width * 2, H = height * 4;
    const buf = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      const di = Math.floor(x * (data.length - 1) / Math.max(1, W - 1));
      const fillH = Math.floor(Math.max(0, Math.min(100, data[di])) * H / 100);
      for (let y = 0; y < fillH; y++) buf[(H - 1 - y) * W + x] = 1;
    }
    return _encodeBraille(buf, W, width, height);
  };

  // Net braille wave — one compact block: tx fills the TOP half up from the center line,
  // rx fills the BOTTOM half down from the center line (mirrors the widget's net cell).
  const waveNet = (txData, rxData, width, height) => {
    if (!txData || txData.length < 2) return '';
    const W = width * 2, H = height * 4, half = H / 2;
    const buf = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      const di = Math.floor(x * (txData.length - 1) / Math.max(1, W - 1));
      const txPct = Math.max(0, Math.min(100, (txData[di] / netScale) * 100));
      const rxPct = Math.max(0, Math.min(100, ((rxData[di] || 0) / netScale) * 100));
      let fillTx = Math.floor(txPct * half / 100), fillRx = Math.floor(rxPct * half / 100);
      if (txData[di] > 0 && fillTx === 0) fillTx = 1;
      if ((rxData[di] || 0) > 0 && fillRx === 0) fillRx = 1;
      for (let y = 0; y < fillTx; y++) buf[(half - 1 - y) * W + x] = 1;
      for (let y = 0; y < fillRx; y++) buf[(half + y) * W + x] = 1;
    }
    return _encodeBraille(buf, W, width, height);
  };

  const closePopup = () => { if (popup) { popup.remove(); popup = null; document.removeEventListener('pointerdown', onPopupOutside, true); } };

  const openPopup = () => {
    if (popup) { closePopup(); return; }
    popup = document.createElement('div');
    popup.id = 'hwx-monitor-popup';
    const rect = el.getBoundingClientRect();
    popup.style.top = (rect.bottom + 2) + 'px';
    popup.style.left = rect.left + 'px';
    popup.style.right = 'auto';
    popup.innerHTML = `<div class="monitor-popup-header"><span>System Monitor</span><button class="monitor-popup-close">✕</button></div><div class="monitor-popup-body" id="hwx-monitor-popup-body"></div><div class="monitor-popup-footer"><button class="monitor-btn-primary" id="hwx-monitor-popup-settings">Settings</button></div>`;
    document.body.appendChild(popup);
    renderPopupBody();
    popup.querySelector('.monitor-popup-close').onclick = closePopup;
    popup.querySelector('#hwx-monitor-popup-settings').onclick = () => { closePopup(); _openSettingsPanel(); };
    setTimeout(() => document.addEventListener('pointerdown', onPopupOutside, true), 50);
  };

  const renderPopupBody = () => {
    const body = popup?.querySelector('#hwx-monitor-popup-body');
    if (!body) return;
    body.innerHTML = '';
    const bw = 30, bh = 4;
    if (cfg.showCpu) body.appendChild(row('CPU', history.cpu, cfg.cpuColor, bw, bh));
    if (cfg.showRam) body.appendChild(row('RAM', history.ram, cfg.ramColor, bw, bh));
    if (cfg.showDisk) body.appendChild(row('Dsk', history.disk, cfg.diskColor, bw, bh));
    if (cfg.showDiskIO) body.appendChild(row('IO', history.diskIO, cfg.diskIOColor, bw, bh, stats.diskIO != null ? fmtIO(stats.diskIO) : null, stats.diskIO != null ? fmtIONum(stats.diskIO) : null));
    if (cfg.showNet) body.appendChild(rowNet(history.netTx, history.netRx, cfg.netUpColor, cfg.netDownColor, bw, bh));
  };

  const row = (label, data, color, w, h, extra, valOverride) => {
    const d = document.createElement('div'); d.className = 'monitor-popup-row';
    const val = valOverride != null ? valOverride : (data.length ? Math.round(data[data.length-1]) : '—');
    d.innerHTML = `<span class="monitor-popup-label">${label}</span><span class="monitor-popup-val">${val}${extra ? ' <em>' + extra + '</em>' : ''}</span>`;
    const pre = document.createElement('pre'); pre.className = 'monitor-popup-braille'; pre.style.color = color;
    pre.textContent = wave(data, w, h);
    d.appendChild(pre);
    return d;
  };

  const rowNet = (txData, rxData, colorUp, colorDn, w, h) => {
    const d = document.createElement('div'); d.className = 'monitor-popup-row';
    const txVal = txData.length ? fmtNet(txData[txData.length-1]) : '—';
    const rxVal = rxData.length ? fmtNet(rxData[rxData.length-1]) : '—';
    d.innerHTML = `<span class="monitor-popup-label">Net</span><span class="monitor-popup-val"><span class="monitor-popup-net-up" style="color:${colorUp}">${txVal}</span> <span class="monitor-popup-net-dn" style="color:${colorDn}">${rxVal}</span></span>`;
    // One compact block: tx in top half (up color), rx in bottom half (down color).
    const pre = document.createElement('pre'); pre.className = 'monitor-popup-braille';
    pre.setAttribute('aria-label', 'net up+down');
    const txt = waveNet(txData, rxData, w, h);
    const lines = txt.split('\n').filter((_, i) => i < h);
    const half = Math.ceil(h / 2);
    pre.innerHTML = `<span style="color:${colorUp}">${lines.slice(0, half).join('\n')}</span><span style="color:${colorDn}">\n${lines.slice(half).join('\n')}</span>`;
    d.appendChild(pre);
    return d;
  };

  const onPopupOutside = e => { if (popup && !popup.contains(e.target) && !el.contains(e.target)) closePopup(); };

  const _openSettingsPanel = () => {
    if (settingsPanel) return;
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'hwx-monitor-settings';
    const rect = el.getBoundingClientRect();
    settingsPanel.style.top = (rect.bottom + 2) + 'px';
    settingsPanel.style.left = rect.left + 'px';
    settingsPanel.style.right = 'auto';
    rebuildSettings();
    document.body.appendChild(settingsPanel);
    setTimeout(() => document.addEventListener('pointerdown', onSettingsOutside, true), 50);
  };

  const closeSettings = () => { if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; document.removeEventListener('pointerdown', onSettingsOutside, true); } };

  const onSettingsOutside = e => { if (settingsPanel && !settingsPanel.contains(e.target)) closeSettings(); };

  const rebuildSettings = () => {
    if (!settingsPanel) return;
    settingsPanel.innerHTML = '<h4>System Monitor</h4>';
    [['showCpu','CPU'],['showRam','RAM'],['showDisk','Disk'],['showDiskIO','Disk IO'],['showNet','Net']].forEach(([k,l]) => {
      const r = document.createElement('div'); r.className = 'monitor-setting-row';
      r.innerHTML = `<label>${l}</label><input type="checkbox" ${cfg[k]?'checked':''}>`;
      r.querySelector('input').onchange = e => { cfg[k] = e.target.checked; saveCfg(cfg); draw(); };
      settingsPanel.appendChild(r);
    });
    const lr = document.createElement('div'); lr.className = 'monitor-setting-row';
    lr.innerHTML = `<label>Labels</label><input type="checkbox" ${cfg.showLabels?'checked':''}>`;
    lr.querySelector('input').onchange = e => { cfg.showLabels = e.target.checked; saveCfg(cfg); draw(); };
    settingsPanel.appendChild(lr);
    [['cpuColor','CPU'],['ramColor','RAM'],['diskColor','Disk'],['diskIOColor','IO'],['netUpColor','Net ↑'],['netDownColor','Net ↓']].forEach(([k,l]) => {
      const r = document.createElement('div'); r.className = 'monitor-setting-row';
      r.innerHTML = `<label>${l}</label><input type="color" value="${cfg[k]}">`;
      r.querySelector('input').oninput = e => { cfg[k] = e.target.value; saveCfg(cfg); draw(); if (popup) renderPopupBody(); };
      settingsPanel.appendChild(r);
    });
    const rr = document.createElement('div'); rr.className = 'monitor-setting-row';
    rr.innerHTML = `<label>Refresh</label><input type="range" min="500" max="5000" step="250" value="${cfg.refreshMs}"><span>${(cfg.refreshMs/1000).toFixed(1)}s</span>`;
    rr.querySelector('input').oninput = e => { cfg.refreshMs = parseFloat(e.target.value); rr.querySelector('span').textContent = (cfg.refreshMs/1000).toFixed(1)+'s'; saveCfg(cfg); startPoll(); };
    settingsPanel.appendChild(rr);
    const b = document.createElement('button'); b.className = 'monitor-btn'; b.textContent = 'Reset Defaults';
    b.onclick = () => { Object.assign(cfg, DEFAULTS); saveCfg(cfg); rebuildSettings(); draw(); startPoll(); };
    settingsPanel.appendChild(b);
  };

  const startPoll = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(async () => { await fetchStats(); draw(); if (popup) renderPopupBody(); }, cfg.refreshMs); };

  const init = () => {
    const inner = document.querySelector('.app-titlebar-inner');
    if (!inner) { setTimeout(init, 300); return; }
    el = document.createElement('div'); el.id = 'hwx-monitor-titlebar';
    canvas = document.createElement('canvas'); canvas.id = 'hwx-monitor-canvas';
    el.appendChild(canvas);
    const sub = inner.querySelector('.app-titlebar-sub');
    if (sub && sub.nextSibling) inner.insertBefore(el, sub.nextSibling); else inner.appendChild(el);
    ctx = canvas.getContext('2d');
    canvas.onclick = e => { e.preventDefault(); e.stopPropagation(); openPopup(); };
    fetchStats().then(() => { draw(); startPoll(); });
    window.HermesSystemMonitor = { version: '0.8.1', getStats: () => Object.assign({}, stats), getConfig: () => Object.assign({}, cfg), setConfig: p => { Object.assign(cfg, p); saveCfg(cfg); draw(); }, destroy: () => { if (pollTimer) clearInterval(pollTimer); closePopup(); closeSettings(); if (el) el.remove(); window.__hwxMonitorLoaded = false; delete window.HermesSystemMonitor; } };
  };

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once: true }) : setTimeout(init, 500);
})();
