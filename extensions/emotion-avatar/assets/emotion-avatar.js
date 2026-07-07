// Bootstrap: starts all modules, manages model/renderer switching, handles file import
(function() {
  'use strict';
  if (window.__hwxEmotionAvatarLoaded) return;
  window.__hwxEmotionAvatarLoaded = true;

  var activeRenderer = null;
  var overlay = null;
  var canvas = null;
  var settingsPanel = null;
  var titlebarBtn = null;
  var SIZE_KEY = 'ea-avatar-size';

  function getSize() {
    var v = parseInt(localStorage.getItem(SIZE_KEY)) || 96;
    if (v < 48) v = 48; if (v > 192) v = 192;
    return v;
  }

  function applySize(v) {
    if (canvas) { canvas.style.width = v + 'px'; canvas.style.height = v + 'px'; }
    localStorage.setItem(SIZE_KEY, '' + v);
  }

  function install() {
    if (!document.getElementById('hwx-emotion-avatar-overlay')) {
      overlay = document.createElement('div');
      overlay.id = 'hwx-emotion-avatar-overlay';
      canvas = document.createElement('div');
      canvas.id = 'hwx-emotion-avatar-canvas';
      overlay.appendChild(canvas);
      document.body.appendChild(overlay);
    } else {
      overlay = document.getElementById('hwx-emotion-avatar-overlay');
      canvas = document.getElementById('hwx-emotion-avatar-canvas');
    }
    applySize(getSize());
    __ea.pipe.pulse('idle', 'idle');
    if (__ea.inputAgent) __ea.inputAgent.start();
    if (__ea.inputLLM) __ea.inputLLM.start();
    if (__ea.inputFAC) __ea.inputFAC.start();
    switchRenderer(__ea.modelManager.getActiveModel());
    ensureTitlebarButton();
  }

  function switchRenderer(modelDef) {
    var type = modelDef ? modelDef.type : 'preset';
    var renderer;
    switch (type) {
      case 'preset': renderer = __ea.renderer.canvas2d; break;
      case 'live2d': renderer = __ea.renderer.live2d; break;
      case 'spine': renderer = __ea.renderer.spine; break;
      default: renderer = __ea.renderer.canvas2d;
    }
    if (!renderer) renderer = __ea.renderer.canvas2d;
    if (activeRenderer && activeRenderer.stop) activeRenderer.stop();
    if (canvas) canvas.innerHTML = '';
    activeRenderer = renderer;
    if (renderer && renderer.start) {
      renderer.start(canvas);
      if (modelDef && modelDef.url && renderer.loadModel) {
        renderer.loadModel(modelDef.url).catch(function(){});
      }
    }
  }

  function ensureTitlebarButton() {
    if (titlebarBtn) return titlebarBtn;
    var tb = document.querySelector('.app-titlebar'); if (!tb) return null;
    var rel = document.getElementById('btnReload');
    var btn = document.createElement('button');
    btn.id = 'hwx-avatar-titlebar-btn'; btn.type = 'button';
    btn.title = 'Avatar settings'; btn.setAttribute('aria-label','Avatar settings'); btn.textContent = '⚙';
    btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();toggleSettings(btn);});
    if (rel && rel.parentNode) rel.parentNode.insertBefore(btn,rel); else tb.appendChild(btn);
    titlebarBtn = btn; return btn;
  }

  function toggleSettings(anchor) {
    if (settingsPanel) { closeSettings(); return; }
    settingsPanel = document.createElement('div'); settingsPanel.id = 'hwx-avatar-settings';
    buildSettingsContent(settingsPanel);
    document.body.appendChild(settingsPanel);
    var ref = anchor || titlebarBtn || overlay;
    var r = ref.getBoundingClientRect();
    settingsPanel.style.left = Math.max(8, r.left - 160) + 'px';
    settingsPanel.style.top = (r.bottom + 6) + 'px';
    document.addEventListener('pointerdown', onOutsideClick, true);
  }

  function closeSettings() {
    if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; }
    document.removeEventListener('pointerdown', onOutsideClick, true);
  }

  function onOutsideClick(ev) {
    if (settingsPanel && !settingsPanel.contains(ev.target) &&
        ev.target !== titlebarBtn && !(titlebarBtn && titlebarBtn.contains(ev.target)))
      closeSettings();
  }

  function buildSettingsContent(el) {
    el.innerHTML = '';

    // === Model selector ===
    (function(){
      var ml = el.appendChild(document.createElement('div'));
      ml.style.cssText = section; ml.textContent = 'Model';
      var allModels = __ea.modelManager.getAll();
      var activeId = __ea.modelManager.getActive();
      var sel = el.appendChild(document.createElement('select'));
      sel.style.cssText = selectCss;
      allModels.forEach(function(m){
        var o = sel.appendChild(document.createElement('option'));
        o.value = m.id;
        var label = m.name;
        if (m.type==='preset') label += ' ★';
        else if (m.type==='live2d') label += ' [Live2D]';
        else if (m.type==='spine') label += ' [Spine]';
        o.textContent = label;
        if (m.id===activeId) o.selected = true;
      });
      sel.addEventListener('change',function(){
        var id = this.value;
        var all = __ea.modelManager.getAll();
        for (var i=0;i<all.length;i++) {
          if (all[i].id===id) {
            __ea.modelManager.setActive(id);
            switchRenderer(all[i]);
            break;
          }
        }
      });
    })();

    // === Size slider ===
    (function(){
      var saved = getSize();
      var ds = el.appendChild(document.createElement('div'));
      ds.style.cssText = section + ';margin-top:8px';
      ds.textContent = 'Size';
      var sizeRow = el.appendChild(document.createElement('div'));
      sizeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
      var slider = sizeRow.appendChild(document.createElement('input'));
      slider.type = 'range'; slider.min = '48'; slider.max = '192'; slider.step = '8';
      slider.value = '' + saved; slider.style.cssText = 'flex:1';
      var sizeLabel = sizeRow.appendChild(document.createElement('span'));
      sizeLabel.style.cssText = 'font-size:12px;min-width:36px;text-align:right';
      sizeLabel.textContent = saved + 'px';
      slider.addEventListener('input',function(){
        var v = parseInt(this.value);
        sizeLabel.textContent = v + 'px';
        applySize(v);
      });
    })();

    // === Import section ===
    (function(){
      var im = el.appendChild(document.createElement('div'));
      im.style.cssText = section + ';margin-top:8px'; im.textContent = 'Import Model';
      var info = el.appendChild(document.createElement('div'));
      info.style.cssText = infoCss;
      info.textContent = 'Paste URL or upload .zip/.moc3. Zip files are auto-extracted.';
      var inputRow = el.appendChild(document.createElement('div'));
      inputRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px';
      var nameInput = inputRow.appendChild(document.createElement('input'));
      nameInput.type = 'text'; nameInput.placeholder = 'Model name';
      nameInput.style.cssText = urlInputCss + ';flex:0 0 80px';
      var urlInput = inputRow.appendChild(document.createElement('input'));
      urlInput.type = 'text'; urlInput.placeholder = 'URL to .model3.json';
      urlInput.style.cssText = urlInputCss + ';flex:1';
      var addBtn = inputRow.appendChild(document.createElement('button'));
      addBtn.textContent = 'Add'; addBtn.style.cssText = btnCss;
      addBtn.addEventListener('click',function(){
        var name = nameInput.value.trim() || 'Live2D Model';
        var url = urlInput.value.trim();
        if (!url) return;
        __ea.modelManager.addModel({name:name, url:url, type:'live2d'});
        closeSettings(); toggleSettings();
      });
    })();

    // === File upload ===
    (function(){
      var uploadRow = el.appendChild(document.createElement('div'));
      uploadRow.style.cssText = 'margin-bottom:6px';
      var fid = 'ea-file-upload-' + Date.now();
      var uploadLabel = uploadRow.appendChild(document.createElement('label'));
      uploadLabel.setAttribute('for', fid);
      uploadLabel.style.cssText = btnCss + ';display:inline-block;cursor:pointer';
      uploadLabel.textContent = '📁 Upload .moc3 / .zip';
      var fileInput = uploadRow.appendChild(document.createElement('input'));
      fileInput.id = fid; fileInput.type = 'file';
      fileInput.accept = '.moc3,.zip,.model3.json,.skel,.json,.atlas,.vrm';
      fileInput.style.cssText = 'display:none';
      fileInput.addEventListener('change',function(ev){
        var files = ev.target.files;
        if (!files || !files.length) return;
        var file = files[0];
        var name = file.name.replace(/\.(zip|moc3|skel|vrm)$/i,'');
        var ext = file.name.split('.').pop().toLowerCase();
        var type = (ext==='skel') ? 'spine' : 'live2d';
        var url = URL.createObjectURL(file);
        __ea.modelManager.addModel({name:name, url:url, type:type, fileSize:file.size});
        closeSettings(); toggleSettings();
      });
    })();

    // === Manage user models ===
    (function(){
      var userModels = __ea.modelManager.getAll().filter(function(m){return !m.id.startsWith('__preset__');});
      if (!userModels.length) return;
      var mg = el.appendChild(document.createElement('div'));
      mg.style.cssText = section + ';margin-top:8px';
      mg.textContent = 'Your Models';
      userModels.forEach(function(m){
        var row = mg.appendChild(document.createElement('div'));
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 0';
        var label = row.appendChild(document.createElement('span'));
        label.textContent = m.name;
        label.style.cssText = 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
        var del = row.appendChild(document.createElement('button'));
        del.textContent = '✕';
        del.style.cssText = btnCss + ';width:22px;height:22px;padding:0;font-size:11px;margin-left:4px';
        del.title = 'Remove model';
        del.addEventListener('click',function(){
          __ea.modelManager.removeModel(m.id);
          closeSettings(); toggleSettings();
        });
      });
    })();

    // === Preset-specific settings ===
    var activeModel = __ea.modelManager.getActiveModel();
    if (activeModel && activeModel.type === 'preset') {
      appendPresetSettings(el);
    }
  }

  function appendPresetSettings(el) {
    var PRESET_NAMES = __ea.PRESETS.list;
    var PRESETS = __ea.PRESETS.definitions;
    var currentPreset = localStorage.getItem('ea-canvas-2d-preset') || 'pixel';
    var sec = el.appendChild(document.createElement('div'));
    sec.style.cssText = section + ';margin-top:8px';
    sec.textContent = 'Preset Character';
    var sel = sec.appendChild(document.createElement('select'));
    sel.style.cssText = selectCss;
    PRESET_NAMES.forEach(function(n){
      var o = sel.appendChild(document.createElement('option'));
      o.value = n; o.textContent = PRESETS[n].name;
      if (n===currentPreset) o.selected = true;
    });
    sel.addEventListener('change',function(){
      localStorage.setItem('ea-canvas-2d-preset',this.value);
      if (__ea.renderer.canvas2d && __ea.renderer.canvas2d.switchPreset)
        __ea.renderer.canvas2d.switchPreset(this.value);
    });
    var p = PRESETS[currentPreset];
    if (p && p.colorLabels) {
      var cl = p.colorLabels;
      var cfg = {};
      try { cfg = JSON.parse(localStorage.getItem('ea-canvas-2d-config')||'{}'); } catch(_){}
      Object.keys(cl).forEach(function(k){
        var w = sec.appendChild(document.createElement('label'));
        w.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:4px';
        w.textContent = cl[k] + ' ';
        var i = w.appendChild(document.createElement('input'));
        i.type = 'color'; i.value = cfg[k] || p.colors[k] || '#888';
        i.style.cssText = 'width:36px;height:24px;border:1px solid var(--border2,#555);border-radius:4px;padding:0;cursor:pointer;background:none';
        i.addEventListener('input',function(){
          try {
            var c = JSON.parse(localStorage.getItem('ea-canvas-2d-config')||'{}');
            c[this.dataset.key || k] = this.value;
            localStorage.setItem('ea-canvas-2d-config',JSON.stringify(c));
          } catch(_){}
        });
      });
    }
  }

  var section = 'font-weight:600;margin-bottom:4px;font-size:13px';
  var infoCss = 'font-size:11px;color:var(--text2,#999);margin-bottom:6px';
  var selectCss = 'width:100%;padding:4px;margin-bottom:6px;background:var(--code-bg,#333);color:var(--text,#ddd);border:1px solid var(--border2,#555);border-radius:4px;font-size:12px';
  var urlInputCss = 'padding:4px;background:var(--code-bg,#333);color:var(--text,#ddd);border:1px solid var(--border2,#555);border-radius:4px;font-size:12px';
  var btnCss = 'padding:4px 8px;background:var(--accent-bg,#333);border:1px solid var(--border2,#555);border-radius:4px;color:var(--text,#ddd);cursor:pointer;font-size:11px';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ install(); }, {once:true});
  } else {
    setTimeout(install, 1000);
  }

  window.HermesEmotionAvatar = {
    version: '0.8.1',
    setExpression: function(e){__ea.pipe.set(e,'external');},
    getExpression: function(){return __ea.pipe.get();},
    setSize: function(v){applySize(v);},
    getSize: getSize,
    switchModel: function(id){
      var all = __ea.modelManager.getAll();
      for (var i=0;i<all.length;i++){if(all[i].id===id){__ea.modelManager.setActive(id);switchRenderer(all[i]);return true;}}
      return false;
    },
    importModel: function(name,url,type){return __ea.modelManager.addModel({name:name,url:url,type:type||'live2d'});},
    destroy: function(){
      if (activeRenderer&&activeRenderer.stop) activeRenderer.stop();
      if (__ea.inputAgent) __ea.inputAgent.stop();
      if (__ea.inputLLM) __ea.inputLLM.stop();
      if (__ea.inputFAC) __ea.inputFAC.stop();
      if (overlay&&overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (titlebarBtn&&titlebarBtn.parentNode) titlebarBtn.parentNode.removeChild(titlebarBtn);
      window.__hwxEmotionAvatarLoaded = false;
      delete window.HermesEmotionAvatar; delete window.__avatarExpression;
    },
    getModels: function(){return __ea.modelManager.getAll();},
    getActiveModel: function(){return __ea.modelManager.getActiveModel();},
  };
})();
