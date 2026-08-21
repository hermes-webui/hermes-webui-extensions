// Renderer: Live2D — loads user-supplied .model3.json or .zip models
// Runtime: PIXI.js + @pixi/unsafe-eval + Cubism core + pixi-live2d-display (self-hosted)
// Zip extraction: JSZip (auto-loaded, extracts .zip in browser, patches .model3.json paths)
(function() {
  'use strict';
  if (__ea._rendererLive2DLoaded) return; __ea._rendererLive2DLoaded = true;
  __ea.renderer = __ea.renderer || {};

  var _canvas = null;
  var _app = null;
  var _model = null;
  var _initialized = false;
  var _currentExpr = 'idle';
  var _loadingEl = null;
  var _errorEl = null;

  var BASE = '/extensions/emotion-avatar/assets/runtime/';
  var PIXI_CDN = BASE + 'pixi.min.js';
  var PIXI_UNSAFE_CDN = BASE + 'pixi-unsafe-eval.min.js';
  var CUBISM_CDN = BASE + 'live2dcubismcore.min.js';
  var L2D_CDN = BASE + 'pixi-live2d-display.min.js';
  var JSZIP_CDN = BASE + 'jszip.min.js';

  // -- UI helpers --
  function showLoading(msg) {
    if (!_canvas) return; hideError();
    if (!_loadingEl) {
      _loadingEl = document.createElement('div');
      _loadingEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text2,#999);pointer-events:none;z-index:1';
    }
    _loadingEl.textContent = msg || 'Loading...';
    if (!_loadingEl.parentNode) _canvas.appendChild(_loadingEl);
  }
  function hideLoading() {
    if (_loadingEl && _loadingEl.parentNode) _loadingEl.parentNode.removeChild(_loadingEl);
  }
  function showError(msg) {
    if (!_canvas) return; hideLoading();
    if (!_errorEl) {
      _errorEl = document.createElement('div');
      _errorEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#e55;text-align:center;padding:4px;pointer-events:none;z-index:1';
    }
    _errorEl.textContent = msg;
    if (!_errorEl.parentNode) _canvas.appendChild(_errorEl);
  }
  function hideError() {
    if (_errorEl && _errorEl.parentNode) _errorEl.parentNode.removeChild(_errorEl);
  }

  // -- Script injection --
  function injectScript(src) {
    return new Promise(function(resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous';
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error('Failed: ' + src.split('/').pop())); };
      document.head.appendChild(s);
    });
  }

  // -- Runtime init --
  function initRuntime() {
    if (_initialized) return Promise.resolve();
    showLoading('Loading PIXI...');
    return injectScript(PIXI_CDN).then(function() {
      showLoading('Patching CSP...');
      return injectScript(PIXI_UNSAFE_CDN);
    }).then(function() {
      showLoading('Loading Cubism...');
      return injectScript(CUBISM_CDN);
    }).then(function() {
      showLoading('Loading display...');
      return injectScript(L2D_CDN);
    }).then(function() {
      showLoading('Loading JSZip...');
      return injectScript(JSZIP_CDN);
    }).then(function() {
      hideLoading();
      if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel) {
        window.Live2DModel = window.PIXI.live2d.Live2DModel;
      }
      _initialized = true;
    }).catch(function(err) {
      showError(err.message || 'Runtime load failed');
      throw err;
    });
  }

  // -- PIXI app --
  function createApp() {
    if (_app) return; if (!_canvas) return;
    _canvas.style.position = 'relative'; _canvas.style.overflow = 'hidden';
    if (!window.PIXI) { showError('PIXI not loaded'); return; }
    try {
      _app = new PIXI.Application({width:192,height:192,backgroundAlpha:0,antialias:true,resolution:2,autoDensity:true});
    } catch(e) {
      try {
        _app = new PIXI.Application({view:document.createElement('canvas'),width:192,height:192,transparent:true,antialias:true,resolution:2});
      } catch(e2) { showError('PIXI init: '+(e2.message||e.message)); return; }
    }
    if (_app && _app.view) {
      _app.view.style.width = '100%'; _app.view.style.height = '100%';
      _canvas.appendChild(_app.view);
    }
  }

  // -- Zip extraction --
  function extractZipModel(blobUrl) {
    showLoading('Extracting...');
    return fetch(blobUrl).then(function(r){return r.blob();}).then(function(blob) {
      if (!window.JSZip) throw new Error('JSZip not loaded');
      return JSZip.loadAsync(blob);
    }).then(function(zip) {
      // Find .model3.json
      var model3File = null;
      zip.forEach(function(relativePath, file) {
        if (!model3File && /\.model3\.json$/i.test(relativePath) && !file.dir) {
          model3File = file;
        }
      });
      if (!model3File) throw new Error('No .model3.json found in zip');

      showLoading('Preparing model...');

      // Read the model JSON
      return model3File.async('text').then(function(jsonText) {
        var modelDef = JSON.parse(jsonText);
        var baseDir = model3File.name.replace(/[^/]+$/, '');

        // Create blob URLs for all files in the zip
        var fileUrls = {};
        var promises = [];
        zip.forEach(function(path, file) {
          if (file.dir) return;
          promises.push(file.async('blob').then(function(b) {
            fileUrls[path] = URL.createObjectURL(b);
          }));
        });

        return Promise.all(promises).then(function() {
          // Patch .model3.json to use blob URLs
          var fr = modelDef.FileReferences || {};
          var rel = function(p) {
            if (!p) return p;
            // Resolve relative to model3.json directory
            var resolved = baseDir + p;
            return fileUrls[resolved] || fileUrls[p] || p;
          };
          if (fr.Moc) fr.Moc = rel(fr.Moc);
          if (fr.Physics) fr.Physics = rel(fr.Physics);
          if (fr.DisplayInfo) fr.DisplayInfo = rel(fr.DisplayInfo);
          if (fr.Textures) {
            fr.Textures = fr.Textures.map(function(t){return rel(t);});
          }
          // Don't patch motions (they reference sounds which are relative too)
          modelDef.FileReferences = fr;

          var patchedJson = JSON.stringify(modelDef);
          var patchedBlob = new Blob([patchedJson], {type:'application/json'});
          return URL.createObjectURL(patchedBlob);
        });
      });
    });
  }

  // -- Model loading --
  function loadLive2DModel(url) {
    if (!_app) { showError('App not ready'); return Promise.reject(new Error('No app')); }
    if (!window.Live2DModel) { showError('Runtime not loaded'); return Promise.reject(new Error('No runtime')); }

    showLoading('Loading model...');

    // If it's a blob URL from a .zip, extract first
    var loadPromise;
    if (/\.zip$/i.test(url) || (url && url.startsWith('blob:') && !/\.model3\.json/i.test(url))) {
      loadPromise = extractZipModel(url);
    } else {
      loadPromise = Promise.resolve(url);
    }

    return loadPromise.then(function(resolvedUrl) {
      if (!resolvedUrl) throw new Error('Empty URL');
      return Live2DModel.from(resolvedUrl);
    }).then(function(model) {
      hideLoading();
      if (_model) { try { _app.stage.removeChild(_model); _model.destroy(); } catch(_){} }
      _model = model;
      var scale = Math.min(192/model.width, 192/model.height) * 0.85;
      model.anchor.set(0.5, 0.5);
      model.scale.set(scale);
      model.x = 96; model.y = 96;
      _app.stage.addChild(model);
      return model;
    }).catch(function(err) {
      showError('Model failed\n' + (err.message||'').slice(0,50));
      throw err;
    });
  }

  // -- Expression --
  function setExpression(expr) {
    if (!_model) return; _currentExpr = expr;
    try {
      var mm = _model.internalModel ? _model.internalModel.motionManager : null;
      if (!mm) return;
      var exprMap = {happy:'Vowels_CRI',surprised:'Vowels_CRI',speaking:'Vowels_CRI',sad:'Vowels_CRI',angry:'Vowels_CRI',thinking:'Vowels_CRI',confused:'Vowels_CRI',excited:'Vowels_CRI',worried:'Vowels_CRI',idle:null};
      var group = exprMap[expr];
      if (!group) { if (mm.stopAllMotions) mm.stopAllMotions(); return; }
      if (mm.startRandomMotion) mm.startRandomMotion(group, 3);
    } catch(e){}
  }
  function onExpressionChange(e) {
    if (e.detail && e.detail.expression) setExpression(e.detail.expression);
  }

  // -- Public renderer API --
  var Live2DRenderer = {
    name: 'Live2D',
    start: function(container) {
      _canvas = container;
      window.addEventListener('hermes:avatar:expression', onExpressionChange);
      return {ready:true, message:'Live2D active'};
    },
    loadModel: function(url) {
      hideError(); hideLoading();
      showLoading('Loading runtime...');
      return initRuntime().then(function() {
        createApp();
        if (!_app) throw new Error('App creation failed');
        return loadLive2DModel(url);
      });
    },
    setExpression: setExpression,
    stop: function() {
      window.removeEventListener('hermes:avatar:expression', onExpressionChange);
      if (_model) { try { _app.stage.removeChild(_model); _model.destroy(); } catch(_){} _model = null; }
      if (_app) { try { _app.destroy(true,{children:true}); } catch(_){} _app = null; }
      if (_canvas) { _canvas.innerHTML = ''; _canvas.style.position = ''; _canvas.style.overflow = ''; }
      _initialized = false;
    },
  };

  __ea.renderer.live2d = Live2DRenderer;
})();
