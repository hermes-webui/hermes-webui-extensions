// Renderer: Live2D — loads user-supplied .model3.json models
// Requires: PIXI.js + Cubism WebGL runtime + pixi-live2d-display (all auto-loaded from CDN)
// Load order: PIXI → Cubism core → pixi-live2d-display
// Model: user-provided via URL (relative texture paths must resolve on same origin)
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

  // CDN URLs — corrected versions
  // Same-origin paths (self-hosted to bypass CSP — CDN scripts blocked by Content-Security-Policy)
  var BASE = '/extensions/emotion-avatar/assets/runtime/';
  var PIXI_CDN = BASE + 'pixi.min.js';
  var PIXI_UNSAFE_CDN = BASE + 'pixi-unsafe-eval.min.js';
  var CUBISM_CDN = BASE + 'live2dcubismcore.min.js';
  var L2D_CDN = BASE + 'pixi-live2d-display.min.js';

  function showLoading(msg) {
    if (!_canvas) return;
    hideError();
    if (!_loadingEl) {
      _loadingEl = document.createElement('div');
      _loadingEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text2,#999)';
    }
    _loadingEl.textContent = msg || 'Loading...';
    if (!_loadingEl.parentNode) _canvas.appendChild(_loadingEl);
  }

  function hideLoading() {
    if (_loadingEl && _loadingEl.parentNode) _loadingEl.parentNode.removeChild(_loadingEl);
  }

  function showError(msg) {
    if (!_canvas) return;
    hideLoading();
    if (!_errorEl) {
      _errorEl = document.createElement('div');
      _errorEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#e55;text-align:center;padding:4px';
    }
    _errorEl.textContent = msg;
    if (!_errorEl.parentNode) _canvas.appendChild(_errorEl);
  }

  function hideError() {
    if (_errorEl && _errorEl.parentNode) _errorEl.parentNode.removeChild(_errorEl);
  }

  function injectScript(src) {
    return new Promise(function(resolve, reject) {
      // Skip if already loaded
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = function() { resolve(); };
      s.onerror = function() { reject(new Error('Failed to load: ' + src.split('/').pop())); };
      document.head.appendChild(s);
    });
  }

  function initRuntime() {
    if (_initialized) return Promise.resolve();
    showLoading('Loading PIXI...');

    // Step 1: PIXI first (pixi-live2d-display depends on it)
    return injectScript(PIXI_CDN).then(function() {
      showLoading('Patching CSP...');
      // Step 2: @pixi/unsafe-eval shim (PIXI 7 requires unsafe-eval, blocked by CSP)
      return injectScript(PIXI_UNSAFE_CDN);
    }).then(function() {
      showLoading('Loading Cubism...');
      // Step 3: Cubism core runtime
      return injectScript(CUBISM_CDN);
    }).then(function() {
      showLoading('Loading display...');
      // Step 4: pixi-live2d-display
      return injectScript(L2D_CDN);
    }).then(function() {
      hideLoading();
      // Expose Live2DModel globally (it's namespaced under PIXI.live2d in UMD build)
      if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel) {
        window.Live2DModel = window.PIXI.live2d.Live2DModel;
      }
      _initialized = true;
    }).catch(function(err) {
      showError(err.message || 'Runtime load failed');
      throw err;
    });
  }

  function createApp() {
    if (_app) return;
    if (!_canvas) return;
    _canvas.style.position = 'relative';
    _canvas.style.overflow = 'hidden';

    if (!window.PIXI) {
      showError('PIXI not loaded');
      return;
    }

    try {
      _app = new PIXI.Application({
        width: 192,
        height: 192,
        backgroundAlpha: 0,
        antialias: true,
        resolution: 2,
        autoDensity: true,
      });
    } catch(e) {
      // PIXI 7 might still use the legacy constructor
      try {
        _app = new PIXI.Application({
          view: document.createElement('canvas'),
          width: 192, height: 192,
          transparent: true,
          antialias: true,
          resolution: 2,
        });
      } catch(e2) {
        showError('PIXI init failed: ' + (e2.message || e.message));
        return;
      }
    }

    if (_app && _app.view) {
      _app.view.style.width = '100%';
      _app.view.style.height = '100%';
      _canvas.appendChild(_app.view);
    }
  }

  function loadLive2DModel(url) {
    if (!_app) { showError('App not ready'); return Promise.reject(new Error('No PIXI app')); }
    if (!window.Live2DModel) { showError('Live2DModel not loaded'); return Promise.reject(new Error('Live2D runtime missing')); }

    showLoading('Loading model...');

    return Live2DModel.from(url).then(function(model) {
      hideLoading();
      if (_model) {
        try { _app.stage.removeChild(_model); } catch(_) {}
        try { _model.destroy(); } catch(_) {}
      }
      _model = model;

      // Center and scale to fit
      var scale = Math.min(192 / model.width, 192 / model.height) * 0.85;
      model.scale.set(scale);
      model.x = 96;
      model.y = 96;

      _app.stage.addChild(model);

      return model;
    }).catch(function(err) {
      showError('Model load failed\n' + (err.message || '').slice(0, 40));
      throw err;
    });
  }

  function setExpression(expr) {
    if (!_model) return;
    _currentExpr = expr;
    try {
      // pixi-live2d-display v0.4 API
      var mm = _model.internalModel ? _model.internalModel.motionManager : null;
      if (!mm) return;

      // Map expressions to motion groups
      var exprMap = {
        happy: '01_kei_en',
        surprised: '01_kei_en',
        sad: '01_kei_en',
        angry: '01_kei_en',
        thinking: '01_kei_en',
        speaking: '01_kei_en',
        idle: 'idle',
      };
      var group = exprMap[expr] || null;

      if (group === 'idle') {
        if (mm.stopAllMotions) mm.stopAllMotions();
      } else if (group) {
        // Start random motion from the group
        if (mm.startRandomMotion) {
          mm.startRandomMotion(group, 3);
        } else if (mm.startMotion) {
          mm.startMotion(group, 0, 3);
        }
      }
    } catch(e) {
      // Best-effort expression
    }
  }

  function onExpressionChange(e) {
    if (e.detail && e.detail.expression) {
      setExpression(e.detail.expression);
    }
  }

  var Live2DRenderer = {
    name: 'Live2D',
    start: function(container) {
      _canvas = container;
      window.addEventListener('hermes:avatar:expression', onExpressionChange);
      return { ready: true, message: 'Live2D renderer active — awaiting model URL' };
    },
    loadModel: function(url) {
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
      if (_model) { try { _app.stage.removeChild(_model); _model.destroy(); } catch(_) {} _model = null; }
      if (_app) { try { _app.destroy(true, { children: true }); } catch(_) {} _app = null; }
      if (_canvas) { _canvas.innerHTML = ''; _canvas.style.position = ''; _canvas.style.overflow = ''; }
      _initialized = false;
    },
  };

  __ea.renderer.live2d = Live2DRenderer;
})();
