(() => {
  'use strict';
  const EXT = 'emotion-avatar';
  if (window.__hwxEmotionAvatarLoaded) return;
  window.__hwxEmotionAvatarLoaded = true;

  /* ── Config ─────────────────────────────────────────────────────────────── */
  const CFG_KEY = 'hwx-emotion-avatar-config';
  const PRESET_KEY = 'hwx-emotion-avatar-preset';

  /* ── SVG path-based characters (192×192 coordinate system) ──────────────── */
  const PRESETS = {
    pixel: {
      name: 'Pixel',
      colors: { skin:'#FFDDC4', hair:'#5C3D2E', iris:'#6B4F3A', mouth:'#E07070', cheek:'rgba(255,150,120,0.3)' },
      colorLabels: { skin:'Skin', hair:'Hair', iris:'Iris', mouth:'Mouth' },
      paths: {
        head: 'M96,36 C136,36 160,66 160,100 C160,134 136,160 96,160 C56,160 32,134 32,100 C32,66 56,36 96,36 Z',
        hair: 'M96,36 C130,36 152,54 156,78 C150,66 130,52 96,48 C62,52 42,66 36,78 C40,54 62,36 96,36 Z M40,78 C38,90 38,100 40,106 C38,86 42,72 48,64 Q44,70 40,78 Z M152,78 C154,90 154,100 152,106 C154,86 150,72 144,64 Q148,70 152,78 Z M52,58 Q64,44 96,42 Q128,44 140,58 Q120,48 96,46 Q72,48 52,58 Z',
        bangs: 'M56,60 Q76,46 96,44 Q116,46 136,60 Q140,68 136,74 Q116,62 96,60 Q76,62 56,74 Q52,68 56,60 Z',
        eyeWhiteL: 'M66,84 A14,16 0 1,0 94,84 A14,16 0 1,0 66,84 Z',
        eyeWhiteR: 'M98,84 A14,16 0 1,0 126,84 A14,16 0 1,0 98,84 Z',
        irisL: 'M72,86 A8,9 0 1,0 88,86 A8,9 0 1,0 72,86 Z',
        irisR: 'M104,86 A8,9 0 1,0 120,86 A8,9 0 1,0 104,86 Z',
        pupilL: 'M78,86 A4,4 0 1,0 86,86 A4,4 0 1,0 78,86 Z',
        pupilR: 'M110,86 A4,4 0 1,0 118,86 A4,4 0 1,0 110,86 Z',
        highlightL: 'M74,80 A2.5,2.5 0 1,0 79,80 A2.5,2.5 0 1,0 74,80 Z',
        highlightR: 'M106,80 A2.5,2.5 0 1,0 111,80 A2.5,2.5 0 1,0 106,80 Z',
      },
      mouthPaths: {
        idle: 'M86,120 Q96,124 106,120',
        happy: 'M82,118 Q96,130 110,118',
        speaking: 'M86,118 Q96,126 106,118',
        thinking: 'M90,118 Q96,114 102,118',
        surprised: 'M92,116 A6,6 0 1,0 100,116 Z',
      }
    },
    neko: {
      name: 'Neko',
      colors: { fur:'#F5DEB3', ears:'#E8C8A0', earInner:'#F0A0A0', iris:'#6B8E23', nose:'#F08A8A', mouth:'#D06060', whisker:'#AAAAAA' },
      colorLabels: { fur:'Fur', ears:'Ears', iris:'Iris', nose:'Nose', mouth:'Mouth' },
      paths: {
        head: 'M96,34 C138,34 162,66 162,102 C162,138 138,162 96,162 C54,162 30,138 30,102 C30,66 54,34 96,34 Z',
        earL: 'M40,70 L22,24 L68,52 Z', earR: 'M152,70 L170,24 L124,52 Z',
        earInnerL: 'M44,64 L32,32 L64,54 Z', earInnerR: 'M148,64 L160,32 L128,54 Z',
        eyeWhiteL: 'M64,84 A13,15 0 1,0 90,84 A13,15 0 1,0 64,84 Z',
        eyeWhiteR: 'M102,84 A13,15 0 1,0 128,84 A13,15 0 1,0 102,84 Z',
        irisL: 'M70,86 A7,8 0 1,0 84,86 A7,8 0 1,0 70,86 Z',
        irisR: 'M108,86 A7,8 0 1,0 122,86 A7,8 0 1,0 108,86 Z',
        pupilL: 'M75,86 A3,3 0 1,0 81,86 A3,3 0 1,0 75,86 Z',
        pupilR: 'M113,86 A3,3 0 1,0 119,86 A3,3 0 1,0 113,86 Z',
        highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
        highlightR: 'M110,80 A2,2 0 1,0 114,80 A2,2 0 1,0 110,80 Z',
        nose: 'M93,100 L96,104 L99,100 Z',
        whiskerL1: 'M58,98 L34,94', whiskerL2: 'M58,102 L34,102', whiskerL3: 'M58,106 L34,110',
        whiskerR1: 'M134,98 L158,94', whiskerR2: 'M134,102 L158,102', whiskerR3: 'M134,106 L158,110',
      },
      mouthPaths: {
        idle: 'M88,112 Q96,116 104,112', happy: 'M84,110 Q96,122 108,110',
        speaking: 'M88,110 Q96,118 104,110', thinking: 'M90,112 Q96,108 102,112',
        surprised: 'M92,108 A5,5 0 1,0 100,108 Z',
      }
    },
    yuki: {
      name: 'Yuki', colors: { body:'#F0F4FF', iris:'#4A6FA5', mouth:'#7799CC', accent:'#B0C4E8', blush:'rgba(176,196,232,0.35)' },
      colorLabels: { body:'Body', iris:'Iris', mouth:'Mouth', accent:'Accent' },
      paths: {
        body: 'M96,30 C140,30 160,66 160,104 C160,140 140,170 96,170 C52,170 32,140 32,104 C32,66 52,30 96,30 Z',
        tail: 'M60,148 Q30,172 50,190 Q70,200 90,180 Q110,200 130,190 Q150,172 120,148',
        eyeWhiteL: 'M68,84 A11,13 0 1,0 90,84 A11,13 0 1,0 68,84 Z',
        eyeWhiteR: 'M102,84 A11,13 0 1,0 124,84 A11,13 0 1,0 102,84 Z',
        irisL: 'M74,86 A6,7 0 1,0 86,86 A6,7 0 1,0 74,86 Z',
        irisR: 'M108,86 A6,7 0 1,0 120,86 A6,7 0 1,0 108,86 Z',
        pupilL: 'M78,86 A2.5,2.5 0 1,0 83,86 A2.5,2.5 0 1,0 78,86 Z',
        pupilR: 'M112,86 A2.5,2.5 0 1,0 117,86 A2.5,2.5 0 1,0 112,86 Z',
        highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
        highlightR: 'M106,80 A2,2 0 1,0 110,80 A2,2 0 1,0 106,80 Z',
        blushL: 'M56,100 A8,5 0 1,0 72,100 A8,5 0 1,0 56,100 Z',
        blushR: 'M120,100 A8,5 0 1,0 136,100 A8,5 0 1,0 120,100 Z',
      },
      mouthPaths: {
        idle: 'M90,112 Q96,114 102,112', happy: 'M86,110 Q96,120 106,110',
        speaking: 'M88,110 Q96,117 104,110', thinking: 'M92,112 Q96,108 100,112',
        surprised: 'M92,108 A5,5 0 1,0 100,108 Z',
      }
    },
    robot: {
      name: 'Robot', colors: { body:'#A0A8B8', face:'#C8D0D8', iris:'#00DDFF', accent:'#FF8800', mouth:'#666', antenna:'#CCC' },
      colorLabels: { body:'Body', face:'Face', iris:'Eyes', accent:'Accent', mouth:'Mouth' },
      paths: {
        head: 'M36,46 L156,46 L156,144 L36,144 Z', face: 'M50,60 L142,60 L142,130 L50,130 Z',
        antenna: 'M96,46 L96,26', antennaBall: 'M96,22 A5,5 0 1,0 96,23',
        earBoltL: 'M34,100 A5,5 0 1,0 34,101', earBoltR: 'M158,100 A5,5 0 1,0 158,101',
        eyeWhiteL: 'M64,84 A12,10 0 1,0 88,84 A12,10 0 1,0 64,84 Z',
        eyeWhiteR: 'M104,84 A12,10 0 1,0 128,84 A12,10 0 1,0 104,84 Z',
        irisL: 'M70,86 A8,7 0 1,0 86,86 A8,7 0 1,0 70,86 Z',
        irisR: 'M110,86 A8,7 0 1,0 126,86 A8,7 0 1,0 110,86 Z',
        pupilL: 'M76,86 A3,3 0 1,0 82,86 A3,3 0 1,0 76,86 Z',
        pupilR: 'M116,86 A3,3 0 1,0 122,86 A3,3 0 1,0 116,86 Z',
        highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
        highlightR: 'M112,80 A2,2 0 1,0 116,80 A2,2 0 1,0 112,80 Z',
      },
      mouthPaths: {
        idle: 'M82,118 Q96,122 110,118', happy: 'M82,116 L110,116',
        speaking: 'M82,116 Q96,124 110,116', thinking: 'M86,118 Q96,112 106,118',
        surprised: 'M88,114 A8,4 0 1,0 104,114 Z',
      }
    },
    monster: {
      name: 'Monster', colors: { skin:'#6B8E4E', horn:'#4A3520', iris:'#FF4400', mouth:'#330000', tooth:'#FFFFF0', accent:'#8B4513' },
      colorLabels: { skin:'Skin', horn:'Horns', iris:'Eyes', mouth:'Mouth', accent:'Accent' },
      paths: {
        head: 'M96,32 C144,32 164,66 164,104 C164,142 144,166 96,166 C48,166 28,142 28,104 C28,66 48,32 96,32 Z',
        hornL: 'M50,60 Q38,18 70,28 Q64,42 58,56 Z', hornR: 'M142,60 Q154,18 122,28 Q128,42 134,56 Z',
        brow: 'M40,90 Q96,72 152,90 Q152,78 96,64 Q40,78 40,90 Z', jaw: 'M44,108 Q96,152 148,108',
        eyeWhiteL: 'M68,86 A10,8 0 1,0 88,86 A10,8 0 1,0 68,86 Z',
        eyeWhiteR: 'M104,86 A10,8 0 1,0 124,86 A10,8 0 1,0 104,86 Z',
        irisL: 'M74,86 A5,5 0 1,0 84,86 A5,5 0 1,0 74,86 Z',
        irisR: 'M110,86 A5,5 0 1,0 120,86 A5,5 0 1,0 110,86 Z',
        pupilL: 'M78,86 A2.5,2.5 0 1,0 83,86 A2.5,2.5 0 1,0 78,86 Z',
        pupilR: 'M114,86 A2.5,2.5 0 1,0 119,86 A2.5,2.5 0 1,0 114,86 Z',
        highlightL: 'M72,82 A1.5,1.5 0 1,0 75,82 A1.5,1.5 0 1,0 72,82 Z',
        highlightR: 'M108,82 A1.5,1.5 0 1,0 111,82 A1.5,1.5 0 1,0 108,82 Z',
      },
      mouthPaths: {
        idle: 'M82,126 Q96,132 110,126', happy: 'M78,126 Q96,140 114,126',
        speaking: 'M80,124 Q96,132 112,124', thinking: 'M86,128 Q96,120 106,128',
        surprised: 'M90,122 A8,6 0 1,0 102,122 Z',
      }
    },
  };

  const PRESET_NAMES = Object.keys(PRESETS);
  let currentPreset = localStorage.getItem(PRESET_KEY) || 'pixel';
  if (!PRESETS[currentPreset]) currentPreset = 'pixel';

  let pathCache = {};
  function buildPathCache(presetName) {
    const p = PRESETS[presetName];
    if (!p) return;
    const cache = {};
    Object.keys(p.paths).forEach(function(key) {
      try { cache[key] = new Path2D(p.paths[key]); } catch(e) { cache[key] = null; }
    });
    if (p.mouthPaths) {
      Object.keys(p.mouthPaths).forEach(function(key) {
        try { cache['mouth_' + key] = new Path2D(p.mouthPaths[key]); } catch(e) { cache['mouth_' + key] = null; }
      });
    }
    pathCache = cache;
  }
  buildPathCache(currentPreset);

  function presetDefaults(p) {
    var c = PRESETS[p] ? PRESETS[p].colors : PRESETS.pixel.colors;
    var d = {};
    Object.keys(c).forEach(function(k) { d[k] = c[k]; });
    d.preset = p;
    return d;
  }

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) return Object.assign(presetDefaults(currentPreset), JSON.parse(raw), {preset: currentPreset});
    } catch(_) {}
    return presetDefaults(currentPreset);
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch(_) {}
  }

  let cfg = loadCfg();

  function switchPreset(name) {
    if (!PRESETS[name] || name === currentPreset) return;
    currentPreset = name;
    localStorage.setItem(PRESET_KEY, name);
    var d = presetDefaults(name);
    Object.keys(d).forEach(function(k) { if (cfg[k] === undefined) cfg[k] = d[k]; });
    cfg.preset = name;
    saveCfg(cfg);
    buildPathCache(name);
    if (settingsPanel) rebuildSettingsPanel();
  }

  function resetColors() {
    var d = presetDefaults(currentPreset);
    Object.keys(d).forEach(function(k) { cfg[k] = d[k]; });
    cfg.preset = currentPreset;
    saveCfg(cfg);
    if (settingsPanel) rebuildSettingsPanel();
  }

  /* ── Mouse tracking ────────────────────────────────────────────────────── */
  let mouseX = 96, mouseY = 96;
  let targetFloatX = 0, targetFloatY = 0;
  let currentFloatX = 0, currentFloatY = 0;
  let isHovering = false;
  let avoidRunning = false;
  let avoidTargetX = 0, avoidTargetY = 0;

  let currentExpr = 'idle', targetExpr = 'idle', tween = 0;
  const TWEEN_SPEED = 0.08;
  let blinkTimer = 0, blinkPhase = 0, mouthPhase = 0, time = 0;
  let overlay = null, canvas = null, ctx = null, observer = null, rafId = null, settingsPanel = null;
  let posOffsetX = 0, posOffsetY = 0;
  let mouseTrackingEnabled = true;
  let titlebarBtn = null;

  function setupDOM() {
    if (document.getElementById('hwx-emotion-avatar-overlay')) return true;
    overlay = document.createElement('div');
    overlay.id = 'hwx-emotion-avatar-overlay';
    canvas = document.createElement('canvas');
    canvas.id = 'hwx-emotion-avatar-canvas';
    canvas.width = 192;
    canvas.height = 192;
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    ctx = canvas.getContext('2d');

    document.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseenter', function() { isHovering = true; });
    canvas.addEventListener('mouseleave', function() { isHovering = false; });

    canvas.addEventListener('mousedown', function(e) {
      var vw = window.innerWidth, vh = window.innerHeight;
      var angle = Math.random() * Math.PI * 2;
      avoidTargetX = posOffsetX + Math.cos(angle) * 250;
      avoidTargetY = posOffsetY + Math.sin(angle) * 180;
      avoidTargetX = Math.max(-vw/2, Math.min(vw/2, avoidTargetX));
      avoidTargetY = Math.max(-vh/2, Math.min(vh/2, avoidTargetY));
      avoidRunning = true;
      setExpression('surprised');
      e.stopPropagation();
    });

    canvas.addEventListener('dblclick', function(e) { e.stopPropagation(); toggleSettings(); });
    applyPosition();
    return true;
  }

  function onMouseMove(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var vw = window.innerWidth, vh = window.innerHeight;
    mouseX = ((e.clientX - vw/2) / (vw/2)) || 0;
    mouseY = ((e.clientY - vh/2) / (vh/2)) || 0;
    mouseX = Math.max(-1, Math.min(1, mouseX));
    mouseY = Math.max(-1, Math.min(1, mouseY));

    var dx = e.clientX - cx, dy = e.clientY - cy;
    var dist = Math.sqrt(dx*dx + dy*dy);
    var avoidRadius = 120, maxFlee = 140;
    if (dist < avoidRadius && dist > 5) {
      var intensity = Math.max(0.1, 1 - (dist / avoidRadius));
      avoidTargetX = posOffsetX - (dx / dist) * maxFlee * intensity;
      avoidTargetY = posOffsetY - (dy / dist) * maxFlee * intensity;
      avoidTargetX = Math.max(-vw/2, Math.min(vw/2, avoidTargetX));
      avoidTargetY = Math.max(-vh/2, Math.min(vh/2, avoidTargetY));
      if (!avoidRunning) { avoidRunning = true; setExpression('surprised'); }
    } else if (dist >= avoidRadius + 40) {
      avoidRunning = false;
    }
  }

  function applyPosition() {
    if (!overlay) return;
    if (avoidRunning) {
      posOffsetX += (avoidTargetX - posOffsetX) * 0.15;
      posOffsetY += (avoidTargetY - posOffsetY) * 0.15;
    } else {
      posOffsetX += (0 - posOffsetX) * 0.06;
      posOffsetY += (0 - posOffsetY) * 0.06;
    }
    var targetX = posOffsetX, targetY = posOffsetY;
    var baseRight = 24, baseBottom = 120;
    overlay.style.right = Math.max(0, baseRight - targetX) + 'px';
    overlay.style.bottom = Math.max(0, baseBottom - targetY) + 'px';
    if (targetX > baseRight + 50) {
      overlay.style.right = '';
      overlay.style.left = Math.max(0, targetX - baseRight) + 'px';
    } else {
      overlay.style.left = '';
    }
  }

  /* ── Drawing ───────────────────────────────────────────────────────────── */
  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, 192, 192);
    var floatStrength = 3;
    targetFloatX = mouseX * floatStrength;
    targetFloatY = mouseY * floatStrength;
    currentFloatX += (targetFloatX - currentFloatX) * 0.08;
    currentFloatY += (targetFloatY - currentFloatY) * 0.08;

    ctx.save();
    ctx.translate(currentFloatX, currentFloatY);

    var p = PRESETS[currentPreset];
    if (!p) return;
    var c = cfg;
    var e = targetExpr;
    if (tween < 1 && currentExpr !== targetExpr) {
      e = tween > 0.5 ? targetExpr : currentExpr;
    }

    var cache = pathCache;
    function F(key, color) { var p = cache[key]; if (p) { ctx.fillStyle = color; ctx.fill(p); } }
    function S(key, color, w) { var p = cache[key]; if (p) { ctx.strokeStyle = color; ctx.lineWidth = w || 2; ctx.lineCap = 'round'; ctx.stroke(p); } }

    var pupilMax = 4;
    var px = mouseX * pupilMax, py = mouseY * pupilMax * 0.5;

    try {
      if (currentPreset === 'yuki') {
        F('body', c.body); F('tail', c.blush || 'rgba(200,220,255,0.3)');
      } else if (currentPreset === 'monster') {
        F('head', c.skin); F('hornL', c.horn); F('hornR', c.horn);
        F('brow', c.accent); S('jaw', c.accent, 3);
      } else if (currentPreset === 'robot') {
        F('head', c.body); F('face', c.face); S('antenna', c.antenna, 3);
        F('antennaBall', c.accent); F('earBoltL', c.accent); F('earBoltR', c.accent);
      } else {
        F('head', c.skin || c.fur || c.body);
      }
      if (currentPreset === 'neko') {
        F('earL', c.ears); F('earR', c.ears);
        F('earInnerL', c.earInner); F('earInnerR', c.earInner);
      }
      if (currentPreset === 'pixel') {
        F('hair', c.hair); F('bangs', c.hair);
      }
      if (currentPreset === 'yuki') {
        F('blushL', c.blush || 'rgba(176,196,232,0.35)');
        F('blushR', c.blush || 'rgba(176,196,232,0.35)');
      } else if (currentPreset === 'pixel' && (e === 'happy' || e === 'surprised')) {
        ctx.fillStyle = c.cheek || 'rgba(255,150,120,0.3)';
        ctx.beginPath(); ctx.ellipse(72,108,8,5,0,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(120,108,8,5,0,0,Math.PI*2); ctx.fill();
      }
      F('eyeWhiteL', '#FFF'); F('eyeWhiteR', '#FFF');
      if (blinkPhase > 0.01 && blinkPhase < 0.9) {
        ctx.strokeStyle = '#999'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(66,84); ctx.lineTo(94,84); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(98,84); ctx.lineTo(126,84); ctx.stroke();
        ctx.restore(); return;
      }
      F('irisL', c.iris || '#3A3A3A'); F('irisR', c.iris || '#3A3A3A');
      if (mouseTrackingEnabled && cache.pupilL) {
        ctx.save(); ctx.translate(px, py);
        ctx.fillStyle = '#000'; ctx.fill(cache.pupilL); ctx.restore();
        ctx.save(); ctx.translate(px, py);
        ctx.fillStyle = '#000'; ctx.fill(cache.pupilR); ctx.restore();
      } else {
        F('pupilL', '#000'); F('pupilR', '#000');
      }
      F('highlightL', 'rgba(255,255,255,0.9)'); F('highlightR', 'rgba(255,255,255,0.9)');
      if (currentPreset === 'neko') F('nose', c.nose);
      if (currentPreset === 'neko') {
        ctx.strokeStyle = c.whisker; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
        ['whiskerL1','whiskerL2','whiskerL3','whiskerR1','whiskerR2','whiskerR3'].forEach(function(k) {
          if (cache[k]) ctx.stroke(cache[k]);
        });
      }
      var mouthKey = 'mouth_' + e;
      if (!cache[mouthKey]) mouthKey = 'mouth_idle';
      if (cache[mouthKey]) {
        if (e === 'surprised') {
          ctx.fillStyle = c.mouth || '#C96B6B'; ctx.fill(cache[mouthKey]);
        } else if (e === 'speaking') {
          var o = 0.3 + Math.abs(Math.sin(mouthPhase)) * 0.7;
          ctx.strokeStyle = c.mouth || '#C96B6B'; ctx.lineWidth = 2 + o * 3;
          ctx.lineCap = 'round'; ctx.stroke(cache[mouthKey]);
        } else {
          ctx.strokeStyle = c.mouth || '#C96B6B'; ctx.lineWidth = 2;
          ctx.lineCap = 'round'; ctx.stroke(cache[mouthKey]);
        }
      }
    } catch(_) {}
    ctx.restore();
  }

  /* ── Expression ────────────────────────────────────────────────────────── */
  function setExpression(expr) {
    if (expr === targetExpr) return;
    currentExpr = targetExpr;
    targetExpr = expr;
    tween = 0;
    emit(expr, 'internal');
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

  /* ── Emotion Bridge (sources → expression) ─────────────────────────────── */
  var ebLastExpression = null;

  function emit(expression, source) {
    window.__avatarExpression = expression;
    window.dispatchEvent(new CustomEvent('hermes:avatar:expression', {
      detail: { expression: expression, source: source || 'internal', timestamp: Date.now() }
    }));
  }

  function pollAgentState() {
    try {
      if (window.speechSynthesis && window.speechSynthesis.speaking) return 'speaking';
      if (typeof S !== 'undefined' && S) {
        if (S.busy || (S.session && S.session.active_stream_id) || S.activeStreamId) return 'thinking';
      }
      if (typeof INFLIGHT === 'object' && INFLIGHT) {
        for (var sid in INFLIGHT) { if (Object.prototype.hasOwnProperty.call(INFLIGHT, sid)) return 'thinking'; }
      }
      if (typeof _allSessions !== 'undefined' && Array.isArray(_allSessions)) {
        for (var i = 0; i < _allSessions.length; i++) {
          var s = _allSessions[i];
          if (s && (s.is_streaming || s.active_stream_id)) return 'thinking';
        }
      }
    } catch(_) {}
    return 'idle';
  }

  function scanLLMTags() {
    var msgs = document.querySelectorAll('.message-content, .assistant-message, [class*="message"]');
    if (!msgs.length) return null;
    var text = msgs[msgs.length - 1].textContent || '';
    var m = text.match(/\[(\w+)\]/g);
    if (m) return m[m.length - 1].replace(/[\[\]]/g, '').toLowerCase();
    return null;
  }

  function handleFACEmotion(e) {
    if (e.detail && e.detail.emotion) {
      setExpression(e.detail.emotion);
    }
  }

  function handleExternal(e) {
    if (e.detail && e.detail.expression) {
      setExpression(e.detail.expression);
    }
  }

  /* ── Emotion poll loop ─────────────────────────────────────────────────── */
  var ebPollTimer = null, ebScanTimer = null;
  var ebLastAgent = 'idle', ebLastLLM = null;
  var ebFacOverride = false;

  function ebStart() {
    ebPollTimer = setInterval(function() {
      var state = pollAgentState();
      if (state !== ebLastAgent || ebLastAgent !== targetExpr) {
        ebLastAgent = state;
        if (!ebFacOverride) setExpression(state);
      }
    }, 300);

    ebScanTimer = setInterval(function() {
      var tag = scanLLMTags();
      if (tag && tag !== ebLastLLM && ['happy','sad','surprised','confused','thinking','excited','angry','worried'].indexOf(tag) >= 0) {
        ebLastLLM = tag;
        ebFacOverride = false;
        setExpression(tag);
      }
    }, 2000);
  }

  function ebStop() {
    if (ebPollTimer) { clearInterval(ebPollTimer); ebPollTimer = null; }
    if (ebScanTimer) { clearInterval(ebScanTimer); ebScanTimer = null; }
  }

  /* ── Settings panel ────────────────────────────────────────────────────── */
  var S_btn = 'background:var(--accent-bg,#333);border:1px solid var(--border2,#555);border-radius:6px;color:var(--text,#ddd);cursor:pointer;font-size:11px;';
  var S_label = 'font-weight:600;margin-bottom:6px;font-size:13px';
  var S_inp = 'width:36px;height:24px;border:1px solid var(--border2,#555);border-radius:4px;padding:0;cursor:pointer;background:none';

  function closeSettings() {
    if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; }
    document.removeEventListener('pointerdown', onOutsideClick, true);
  }
  function onOutsideClick(ev) {
    if (settingsPanel && !settingsPanel.contains(ev.target) && ev.target !== canvas && ev.target !== titlebarBtn && !(titlebarBtn && titlebarBtn.contains(ev.target))) closeSettings();
  }
  function rebuildSettingsPanel() {
    if (!settingsPanel) return;
    settingsPanel.innerHTML = '';
    buildSettingsContent(settingsPanel);
  }

  function buildSettingsContent(el) {
    var preset = PRESETS[currentPreset];
    var label = el.appendChild(document.createElement('div'));
    label.style.cssText = S_label;
    label.textContent = 'Character';
    var sel = el.appendChild(document.createElement('select'));
    sel.style.cssText = 'width:100%;padding:4px;margin-bottom:8px;background:var(--code-bg,#333);color:var(--text,#ddd);border:1px solid var(--border2,#555);border-radius:4px;font-size:12px';
    PRESET_NAMES.forEach(function(name) {
      var opt = sel.appendChild(document.createElement('option'));
      opt.value = name; opt.textContent = PRESETS[name].name;
      if (name === currentPreset) opt.selected = true;
    });
    sel.addEventListener('change', function() { switchPreset(this.value); });
    var title = el.appendChild(document.createElement('div'));
    title.style.cssText = S_label + ';margin-top:4px';
    title.textContent = 'Colors';
    var cl = preset.colorLabels || {};
    Object.keys(cl).forEach(function(key) {
      var wrap = el.appendChild(document.createElement('label'));
      wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px';
      wrap.textContent = cl[key] + ' ';
      var inp = wrap.appendChild(document.createElement('input'));
      inp.type = 'color'; inp.dataset.key = key;
      inp.value = cfg[key] || preset.colors[key] || '#888';
      inp.style.cssText = S_inp;
      inp.addEventListener('input', function() {
        cfg[this.dataset.key] = this.value;
        saveCfg(cfg);
      });
    });
    var btnRow = el.appendChild(document.createElement('div'));
    btnRow.style.cssText = 'margin-top:8px;display:flex;gap:6px';
    var resetBtn = btnRow.appendChild(document.createElement('button'));
    resetBtn.textContent = 'Reset Colors';
    resetBtn.style.cssText = S_btn + 'padding:4px 10px;flex:1';
    resetBtn.addEventListener('click', function() { resetColors(); });
    var trackRow = el.appendChild(document.createElement('div'));
    trackRow.style.cssText = 'display:flex;gap:4px;margin-top:6px';
    var eyeBtn = trackRow.appendChild(document.createElement('button'));
    eyeBtn.textContent = mouseTrackingEnabled ? '👀 Track ✓' : '👀 Static';
    eyeBtn.style.cssText = S_btn + 'padding:4px 8px;flex:1';
    eyeBtn.addEventListener('click', function() {
      mouseTrackingEnabled = !mouseTrackingEnabled;
      eyeBtn.textContent = mouseTrackingEnabled ? '👀 Track ✓' : '👀 Static';
    });
  }

  function ensureTitlebarButton() {
    if (titlebarBtn) return titlebarBtn;
    var titlebar = document.querySelector('.app-titlebar');
    if (!titlebar) return null;
    var reload = document.getElementById('btnReload');
    var btn = document.createElement('button');
    btn.id = 'hwx-avatar-titlebar-btn';
    btn.type = 'button';
    btn.title = 'Avatar settings';
    btn.setAttribute('aria-label', 'Avatar settings');
    btn.textContent = '⚙';
    btn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); toggleSettings(btn); });
    if (reload && reload.parentNode) {
      reload.parentNode.insertBefore(btn, reload);
    } else {
      titlebar.appendChild(btn);
    }
    titlebarBtn = btn;
    return btn;
  }

  function toggleSettings(anchor) {
    if (settingsPanel) { closeSettings(); return; }
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'hwx-avatar-settings';
    buildSettingsContent(settingsPanel);
    document.body.appendChild(settingsPanel);
    var ref = anchor || titlebarBtn || overlay;
    var r = ref.getBoundingClientRect();
    settingsPanel.style.left = Math.max(8, r.left - 140) + 'px';
    settingsPanel.style.top = (r.bottom + 6) + 'px';
    document.addEventListener('pointerdown', onOutsideClick, true);
  }

  /* ── Install ───────────────────────────────────────────────────────────── */
  function install(attempt) {
    attempt = attempt || 0;
    if (!setupDOM()) {
      if (attempt < 60) { setTimeout(function() { install(attempt + 1); }, 200); }
      return;
    }

    pollAgentState();
    setExpression('idle');
    setInterval(function() {
      var state = pollAgentState();
      setExpression(state);
    }, 500);
    rafId = requestAnimationFrame(animate);

    ensureTitlebarButton();

    // Emotion bridge listeners
    window.addEventListener('hermes:fac:emotion', handleFACEmotion);
    window.addEventListener('hermes:avatar:emotion', handleExternal);
    ebStart();

    // Public API
    window.HermesEmotionAvatar = {
      version: '0.5.0',
      getExpression: function() { return { current: currentExpr, target: targetExpr, tween: tween }; },
      setExpression: function(e) { setExpression(e); },
      hide: function() { if (overlay) overlay.style.display = 'none'; },
      show: function() { if (overlay) overlay.style.display = ''; },
      getConfig: function() { return Object.assign({}, cfg); },
      setConfig: function(partial) { cfg = Object.assign({}, cfg, partial); saveCfg(cfg); },
      resetConfig: function() { resetColors(); },
      openSettings: toggleSettings,
      switchPreset: switchPreset,
      setMouseTracking: function(en) { mouseTrackingEnabled = en; },
      emotionBridge: {
        emit: emit,
        emitDirectly: function(expr, src) { setExpression(expr); emit(expr, src); },
      },
      destroy: function() {
        if (rafId) cancelAnimationFrame(rafId);
        if (observer) observer.disconnect();
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (settingsPanel) settingsPanel.remove();
        if (titlebarBtn && titlebarBtn.parentNode) titlebarBtn.parentNode.removeChild(titlebarBtn);
        document.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('hermes:fac:emotion', handleFACEmotion);
        window.removeEventListener('hermes:avatar:emotion', handleExternal);
        ebStop();
        window.__hwxEmotionAvatarLoaded = false;
        delete window.HermesEmotionAvatar;
      }
    };

    // Legacy bridge compat
    window.__emotionBridge = { emit: emit, enable: function(){}, disable: function(){}, enabled: function(){ return true; }, status: function(){ return 'connected'; }, current: function(){ return targetExpr; } };

    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { install(); }, { once: true });
  } else {
    setTimeout(install, 1000);
  }
})();
