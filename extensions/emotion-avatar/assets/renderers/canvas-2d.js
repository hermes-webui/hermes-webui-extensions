// Renderer: 2D Canvas SVG path-based character
// Subscribes to 'hermes:avatar:expression' event from pipeline
// Does NOT do its own emotion detection — that's in inputs/
(function() {
  'use strict';
  if (__ea._rendererCanvas2DLoaded) return; __ea._rendererCanvas2DLoaded = true;

  __ea.renderer = {};

  var PRESETS = __ea.PRESETS.definitions;
  var PRESET_NAMES = __ea.PRESETS.list;
  var visemes = __ea.visemes;

  var CFG_KEY = 'ea-canvas-2d-config';
  var PRESET_KEY = 'ea-canvas-2d-preset';
  var currentPreset = localStorage.getItem(PRESET_KEY) || 'pixel';
  if (!PRESETS[currentPreset]) currentPreset = 'pixel';

  /* Path cache — build Path2D objects once */
  var pathCache = {};
  function buildPathCache(name) {
    var p = PRESETS[name];
    if (!p) return;
    pathCache = {};
    Object.keys(p.paths).forEach(function(key) {
      try { pathCache[key] = new Path2D(p.paths[key]); } catch(_) { pathCache[key] = null; }
    });
    if (p.mouthPaths) {
      Object.keys(p.mouthPaths).forEach(function(key) {
        try { pathCache['mouth_' + key] = new Path2D(p.mouthPaths[key]); } catch(_) { pathCache['mouth_' + key] = null; }
      });
    }
  }
  buildPathCache(currentPreset);

  /* Config */
  function defaults(p) { var c = PRESETS[p].colors; var d = {}; Object.keys(c).forEach(function(k){d[k]=c[k];}); d.preset = p; return d; }
  function loadCfg() { try { var r = localStorage.getItem(CFG_KEY); if (r) return Object.assign(defaults(currentPreset), JSON.parse(r), {preset:currentPreset}); } catch(_){} return defaults(currentPreset); }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch(_){} }
  var cfg = loadCfg();

  function switchPreset(name) {
    if (!PRESETS[name] || name === currentPreset) return;
    currentPreset = name;
    localStorage.setItem(PRESET_KEY, name);
    var d = defaults(name);
    Object.keys(d).forEach(function(k) { if (cfg[k] === undefined) cfg[k] = d[k]; });
    cfg.preset = name;
    saveCfg(cfg);
    buildPathCache(name);
    if (settingsPanel) rebuildSettingsPanel();
  }

  /* Mouse tracking */
  var mouseX = 96, mouseY = 96, targetFloatX = 0, targetFloatY = 0, currentFloatX = 0, currentFloatY = 0;
  var isHovering = false, avoidRunning = false, avoidTargetX = 0, avoidTargetY = 0;
  var posOffsetX = 0, posOffsetY = 0;

  /* Expression state */
  var currentExpr = 'idle', targetExpr = 'idle', tween = 0;
  var TWEEN_SPEED = 0.08;

  /* Animation */
  var blinkTimer = 0, blinkPhase = 0, mouthPhase = 0, time = 0;
  var overlay = null, canvas = null, ctx = null, rafId = null, settingsPanel = null;
  var mouseTrackingEnabled = true;
  var titlebarBtn = null;

  /* DOM */
  function setupDOM() {
    if (document.getElementById('hwx-emotion-avatar-overlay')) return true;
    overlay = document.createElement('div');
    overlay.id = 'hwx-emotion-avatar-overlay';
    canvas = document.createElement('canvas');
    canvas.id = 'hwx-emotion-avatar-canvas';
    canvas.width = 192; canvas.height = 192;
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    ctx = canvas.getContext('2d');

    document.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseenter', function(){ isHovering = true; });
    canvas.addEventListener('mouseleave', function(){ isHovering = false; });
    canvas.addEventListener('mousedown', function(e){
      var vw = window.innerWidth, vh = window.innerHeight;
      var a = Math.random() * Math.PI * 2;
      avoidTargetX = posOffsetX + Math.cos(a) * 250;
      avoidTargetY = posOffsetY + Math.sin(a) * 180;
      avoidTargetX = Math.max(-vw/2, Math.min(vw/2, avoidTargetX));
      avoidTargetY = Math.max(-vh/2, Math.min(vh/2, avoidTargetY));
      avoidRunning = true;
      __ea.pipe.set('surprised', 'agent');
      setTimeout(function(){ __ea.pipe.clear('agent'); }, 1200);
      e.stopPropagation();
    });
    canvas.addEventListener('dblclick', function(e){ e.stopPropagation(); toggleSettings(); });
    applyPosition();
    return true;
  }

  function onMouseMove(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    var vw = window.innerWidth, vh = window.innerHeight;
    mouseX = ((e.clientX - vw/2) / (vw/2)) || 0; mouseX = Math.max(-1,Math.min(1,mouseX));
    mouseY = ((e.clientY - vh/2) / (vh/2)) || 0; mouseY = Math.max(-1,Math.min(1,mouseY));

    var dx = e.clientX - cx, dy = e.clientY - cy;
    var dist = Math.sqrt(dx*dx+dy*dy), avoidRadius = 120, maxFlee = 140;
    if (dist < avoidRadius && dist > 5) {
      var intensity = Math.max(0.1, 1 - dist/avoidRadius);
      avoidTargetX = posOffsetX - (dx/dist) * maxFlee * intensity;
      avoidTargetY = posOffsetY - (dy/dist) * maxFlee * intensity;
      avoidTargetX = Math.max(-vw/2,Math.min(vw/2,avoidTargetX));
      avoidTargetY = Math.max(-vh/2,Math.min(vh/2,avoidTargetY));
      if (!avoidRunning) { avoidRunning = true; __ea.pipe.set('surprised','agent'); setTimeout(function(){__ea.pipe.clear('agent');},800); }
    } else if (dist >= avoidRadius + 40) { avoidRunning = false; }
  }

  function applyPosition() {
    if (!overlay) return;
    posOffsetX += ((avoidRunning ? avoidTargetX : 0) - posOffsetX) * (avoidRunning ? 0.15 : 0.06);
    posOffsetY += ((avoidRunning ? avoidTargetY : 0) - posOffsetY) * (avoidRunning ? 0.15 : 0.06);
    var tx = posOffsetX, ty = posOffsetY, br = 24, bb = 120;
    overlay.style.right = Math.max(0, br - tx) + 'px';
    overlay.style.bottom = Math.max(0, bb - ty) + 'px';
    if (tx > br + 50) { overlay.style.right = ''; overlay.style.left = Math.max(0, tx - br) + 'px'; }
    else { overlay.style.left = ''; }
  }

  /* Rendering */
  function render() {
    if (!ctx) return;
    ctx.clearRect(0,0,192,192);
    targetFloatX = mouseX * 3; targetFloatY = mouseY * 3;
    currentFloatX += (targetFloatX - currentFloatX) * 0.08;
    currentFloatY += (targetFloatY - currentFloatY) * 0.08;
    ctx.save(); ctx.translate(currentFloatX, currentFloatY);

    var p = PRESETS[currentPreset]; if (!p) { ctx.restore(); return; }
    var c = cfg;
    var e = targetExpr;
    if (tween < 1 && currentExpr !== targetExpr) { e = tween > 0.5 ? targetExpr : currentExpr; }

    var cache = pathCache;
    function F(k,col) { var p=cache[k]; if(p){ctx.fillStyle=col;ctx.fill(p);} }
    function S(k,col,w) { var p=cache[k]; if(p){ctx.strokeStyle=col;ctx.lineWidth=w||2;ctx.lineCap='round';ctx.stroke(p);} }

    var pupilMax = 4, px = mouseX * pupilMax, py = mouseY * pupilMax * 0.5;

    try {
      if (currentPreset === 'yuki') { F('body',c.body); F('tail',c.blush||'rgba(200,220,255,0.3)'); }
      else if (currentPreset === 'monster') { F('head',c.skin); F('hornL',c.horn); F('hornR',c.horn); F('brow',c.accent); S('jaw',c.accent,3); }
      else if (currentPreset === 'robot') { F('head',c.body); F('face',c.face); S('antenna',c.antenna,3); F('antennaBall',c.accent); F('earBoltL',c.accent); F('earBoltR',c.accent); }
      else { F('head',c.skin||c.fur||c.body); }
      if (currentPreset === 'neko') { F('earL',c.ears);F('earR',c.ears);F('earInnerL',c.earInner);F('earInnerR',c.earInner); }
      if (currentPreset === 'pixel') { F('hair',c.hair);F('bangs',c.hair); }
      if (currentPreset === 'yuki') { F('blushL',c.blush||'rgba(176,196,232,0.35)');F('blushR',c.blush||'rgba(176,196,232,0.35)'); }
      else if (currentPreset === 'pixel' && (e==='happy'||e==='surprised')) { ctx.fillStyle=c.cheek||'rgba(255,150,120,0.3)'; ctx.beginPath();ctx.ellipse(72,108,8,5,0,0,Math.PI*2);ctx.fill(); ctx.beginPath();ctx.ellipse(120,108,8,5,0,0,Math.PI*2);ctx.fill(); }
      F('eyeWhiteL','#FFF');F('eyeWhiteR','#FFF');
      if (blinkPhase>0.01&&blinkPhase<0.9) { ctx.strokeStyle='#999';ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(66,84);ctx.lineTo(94,84);ctx.stroke(); ctx.beginPath();ctx.moveTo(98,84);ctx.lineTo(126,84);ctx.stroke(); ctx.restore();return; }
      F('irisL',c.iris||'#3A3A3A');F('irisR',c.iris||'#3A3A3A');
      if (mouseTrackingEnabled && cache.pupilL) { ctx.save();ctx.translate(px,py);ctx.fillStyle='#000';ctx.fill(cache.pupilL);ctx.restore(); ctx.save();ctx.translate(px,py);ctx.fillStyle='#000';ctx.fill(cache.pupilR);ctx.restore(); }
      else { F('pupilL','#000');F('pupilR','#000'); }
      F('highlightL','rgba(255,255,255,0.9)');F('highlightR','rgba(255,255,255,0.9)');
      if (currentPreset==='neko') F('nose',c.nose);
      if (currentPreset==='neko') { ctx.strokeStyle=c.whisker;ctx.lineWidth=1.2;ctx.lineCap='round';['whiskerL1','whiskerL2','whiskerL3','whiskerR1','whiskerR2','whiskerR3'].forEach(function(k){if(cache[k])ctx.stroke(cache[k]);}); }
      var mouthKey = 'mouth_' + e;
      if (!cache[mouthKey]) mouthKey = 'mouth_idle';
      if (cache[mouthKey]) {
        if (e==='surprised') { ctx.fillStyle=c.mouth||'#C96B6B';ctx.fill(cache[mouthKey]); }
        else if (e==='speaking') { var o=0.3+Math.abs(Math.sin(mouthPhase))*0.7; ctx.strokeStyle=c.mouth||'#C96B6B';ctx.lineWidth=2+o*3;ctx.lineCap='round';ctx.stroke(cache[mouthKey]); }
        else { ctx.strokeStyle=c.mouth||'#C96B6B';ctx.lineWidth=2;ctx.lineCap='round';ctx.stroke(cache[mouthKey]); }
      }
    } catch(_) {}
    ctx.restore();
  }

  function animate(timestamp) {
    time = timestamp;
    if (tween < 1) tween = Math.min(1, tween + TWEEN_SPEED);
    blinkTimer += 16;
    if (blinkTimer > 3000 + Math.random() * 2000) { blinkTimer = 0; blinkPhase = 0.01; }
    if (blinkPhase > 0) { blinkPhase += 0.08; if (blinkPhase >= 2) blinkPhase = 0; }
    if (targetExpr === 'speaking') { mouthPhase += 0.25; } else { mouthPhase = 0; }
    applyPosition();
    render();
    rafId = requestAnimationFrame(animate);
  }

  /* Settings */
  var S_btn = 'background:var(--accent-bg,#333);border:1px solid var(--border2,#555);border-radius:6px;color:var(--text,#ddd);cursor:pointer;font-size:11px;';
  var S_label = 'font-weight:600;margin-bottom:6px;font-size:13px';
  var S_inp = 'width:36px;height:24px;border:1px solid var(--border2,#555);border-radius:4px;padding:0;cursor:pointer;background:none';

  function closeSettings() { if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; } document.removeEventListener('pointerdown', onOutsideClick, true); }
  function onOutsideClick(ev) { if (settingsPanel && !settingsPanel.contains(ev.target) && ev.target !== canvas && ev.target !== titlebarBtn && !(titlebarBtn && titlebarBtn.contains(ev.target))) closeSettings(); }
  function rebuildSettingsPanel() { if (!settingsPanel) return; settingsPanel.innerHTML = ''; buildSettingsContent(settingsPanel); }

  function buildSettingsContent(el) {
    var label = el.appendChild(document.createElement('div')); label.style.cssText = S_label; label.textContent = 'Character';
    var sel = el.appendChild(document.createElement('select')); sel.style.cssText = 'width:100%;padding:4px;margin-bottom:8px;background:var(--code-bg,#333);color:var(--text,#ddd);border:1px solid var(--border2,#555);border-radius:4px;font-size:12px';
    PRESET_NAMES.forEach(function(n){ var o=sel.appendChild(document.createElement('option')); o.value=n; o.textContent=PRESETS[n].name; if(n===currentPreset)o.selected=true; });
    sel.addEventListener('change',function(){switchPreset(this.value);});
    var title = el.appendChild(document.createElement('div')); title.style.cssText = S_label+';margin-top:4px'; title.textContent = 'Colors';
    var cl = PRESETS[currentPreset].colorLabels || {};
    Object.keys(cl).forEach(function(k){
      var w = el.appendChild(document.createElement('label')); w.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:6px'; w.textContent=cl[k]+' ';
      var i = w.appendChild(document.createElement('input')); i.type='color';i.dataset.key=k;i.value=cfg[k]||PRESETS[currentPreset].colors[k]||'#888';i.style.cssText=S_inp;
      i.addEventListener('input',function(){cfg[this.dataset.key]=this.value;saveCfg(cfg);});
    });
    var br = el.appendChild(document.createElement('div')); br.style.cssText='margin-top:8px;display:flex;gap:6px';
    var rb = br.appendChild(document.createElement('button')); rb.textContent='Reset Colors'; rb.style.cssText=S_btn+'padding:4px 10px;flex:1'; rb.addEventListener('click',function(){resetColors();});
    var tr = el.appendChild(document.createElement('div')); tr.style.cssText='display:flex;gap:4px;margin-top:6px';
    var eb = tr.appendChild(document.createElement('button')); eb.textContent=mouseTrackingEnabled?'👀 Track ✓':'👀 Static'; eb.style.cssText=S_btn+'padding:4px 8px;flex:1';
    eb.addEventListener('click',function(){mouseTrackingEnabled=!mouseTrackingEnabled;eb.textContent=mouseTrackingEnabled?'👀 Track ✓':'👀 Static';});
  }

  function resetColors() { var d = defaults(currentPreset); Object.keys(d).forEach(function(k){cfg[k]=d[k];}); cfg.preset=currentPreset; saveCfg(cfg); if(settingsPanel)rebuildSettingsPanel(); }

  function ensureTitlebarButton() {
    if (titlebarBtn) return titlebarBtn;
    var tb = document.querySelector('.app-titlebar'); if (!tb) return null;
    var rel = document.getElementById('btnReload');
    var btn = document.createElement('button'); btn.id='hwx-avatar-titlebar-btn'; btn.type='button'; btn.title='Avatar settings'; btn.setAttribute('aria-label','Avatar settings'); btn.textContent='⚙';
    btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();toggleSettings(btn);});
    if (rel && rel.parentNode) { rel.parentNode.insertBefore(btn, rel); } else { tb.appendChild(btn); }
    titlebarBtn = btn; return btn;
  }

  function toggleSettings(anchor) {
    if (settingsPanel) { closeSettings(); return; }
    settingsPanel = document.createElement('div'); settingsPanel.id='hwx-avatar-settings'; buildSettingsContent(settingsPanel);
    document.body.appendChild(settingsPanel);
    var ref = anchor || titlebarBtn || overlay; var r = ref.getBoundingClientRect();
    settingsPanel.style.left = Math.max(8, r.left-140) + 'px'; settingsPanel.style.top = (r.bottom+6) + 'px';
    document.addEventListener('pointerdown', onOutsideClick, true);
  }

  /* Pipeline subscriber */
  function onExpressionChange(e) {
    if (e.detail && e.detail.expression) {
      var expr = e.detail.expression;
      if (expr !== targetExpr) { currentExpr = targetExpr; targetExpr = expr; tween = 0; }
    }
  }

  /* Public API */
  function start() {
    if (!setupDOM()) return;
    window.addEventListener('hermes:avatar:expression', onExpressionChange);
    rafId = requestAnimationFrame(animate);
    ensureTitlebarButton();
    return true;
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('hermes:avatar:expression', onExpressionChange);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (settingsPanel) settingsPanel.remove();
    if (titlebarBtn && titlebarBtn.parentNode) titlebarBtn.parentNode.removeChild(titlebarBtn);
    document.removeEventListener('mousemove', onMouseMove);
  }

  __ea.renderer.canvas2d = {
    start: start,
    stop: stop,
    switchPreset: switchPreset,
    resetColors: resetColors,
    openSettings: toggleSettings,
    setMouseTracking: function(en) { mouseTrackingEnabled = en; },
    getConfig: function() { return Object.assign({}, cfg); },
    setConfig: function(p) { cfg = Object.assign({}, cfg, p); saveCfg(cfg); },
    getExpression: function() { return { current: currentExpr, target: targetExpr, tween: tween }; },
    setExpression: function(e) { __ea.pipe.set(e, 'external'); },
    show: function() { if (overlay) overlay.style.display = ''; },
    hide: function() { if (overlay) overlay.style.display = 'none'; },
  };
})();
