// Renderer: VRM — loads .vrm models via Three.js + @pixiv/three-vrm (v3 ESM)
// Uses jsdelivr +esm endpoint for bare-import resolution
(function() {
  'use strict';
  if (__ea._rendererVRMLoaded) return; __ea._rendererVRMLoaded = true;
  __ea.renderer = __ea.renderer || {};

  var _container = null;
  var _canvas = null;
  var _renderer = null;
  var _scene = null;
  var _camera = null;
  var _vrm = null;
  var _vrmScene = null;
  var _clock = null;
  var _rafId = null;
  var _initialized = false;
  var _currentExpr = 'idle';
  var _loadingEl = null;
  var _errorEl = null;
  var _size = 192;
  var _THREE = null;
  var _controls = null;
  var _extUrl = null;
  var _mixer = null;

  // CDN ESM URLs (/+esm resolves bare imports)
  // NOTE: All imports MUST use URLs that resolve to the same THREE module instance
  // three-vrm's +esm bundle resolves its 'three' import to /npm/three@0.184.0/+esm,
  // so we must import from https://cdn.jsdelivr.net/npm/three@0.184.0/+esm to share instance.
  var THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.184.0/+esm';
  var GLTF_CDN = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/loaders/GLTFLoader.js/+esm';
  var VRM_CDN = 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/lib/three-vrm.module.js/+esm';
  var ORBIT_CDN = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/controls/OrbitControls.js/+esm';
  var FBX_CDN = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/loaders/FBXLoader.js/+esm';

  // Compute extension base URL from the script's own src
  // vrm.js is at:  /extensions/<id>/assets/renderers/vrm.js
  // ext base is:   /extensions/<id>/
  try {
    var _s = document.currentScript;
    if (_s) {
      var _p = _s.src.split('/');
      _p.pop(); _p.pop(); _p.pop(); // remove vrm.js, renderers/, assets/
      _extUrl = _p.join('/') + '/';
    }
  } catch(e) {}

  // UI helpers
  function showLoading(msg) {
    if (!_container) return; hideError();
    if (!_loadingEl) {
      _loadingEl = document.createElement('div');
      _loadingEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text2,#999);pointer-events:none;z-index:1';
    }
    _loadingEl.textContent = msg || 'Loading...';
    if (!_loadingEl.parentNode) _container.appendChild(_loadingEl);
  }
  function hideLoading() {
    if (_loadingEl && _loadingEl.parentNode) _loadingEl.parentNode.removeChild(_loadingEl);
  }
  function showError(msg) {
    if (!_container) return; hideLoading();
    if (!_errorEl) {
      _errorEl = document.createElement('div');
      _errorEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#e55;text-align:center;padding:4px;pointer-events:none;z-index:1';
    }
    _errorEl.textContent = msg;
    if (!_errorEl.parentNode) _container.appendChild(_errorEl);
  }
  function hideError() {
    if (_errorEl && _errorEl.parentNode) _errorEl.parentNode.removeChild(_errorEl);
  }

  function initRuntime() {
    if (_initialized) return Promise.resolve();

    showLoading('Loading Three.js...');
    return import(THREE_CDN)
      .then(function(THREE) {
        _THREE = THREE;
        showLoading('Loading VRM...');
        return Promise.all([
          import(GLTF_CDN),
          import(VRM_CDN),
          import(ORBIT_CDN),
          import(FBX_CDN)
        ]);
      })
      .then(function(modules) {
        var GLTFLoader = modules[0].GLTFLoader;
        var VRMlib = modules[1];
        var OrbitControls = modules[2].OrbitControls;
        var FBXLoader = modules[3].FBXLoader;
        window.__VRMLib = VRMlib;
        window.__GLTFLoader = GLTFLoader;
        window.__OrbitControls = OrbitControls;
        window.__FBXLoader = FBXLoader;
        hideLoading();
        _initialized = true;
      })
      .catch(function(err) {
        showError('Runtime load: ' + (err.message || '').slice(0, 60));
        console.error('[VRM] Runtime init error:', err);
        throw err;
      });
  }

  function createScene() {
    if (_renderer) return;
    if (!_container) return;
    if (!_THREE) { showError('THREE not loaded'); return; }

    var THREE = _THREE;
    _container.style.position = 'relative';
    _container.style.overflow = 'hidden';

    _size = parseInt(localStorage.getItem('ea-avatar-size')) || 192;
    if (_size < 48) _size = 48; if (_size > 192) _size = 192;

    _canvas = document.createElement('canvas');
    _canvas.style.width = '100%';
    _canvas.style.height = '100%';
    _canvas.style.display = 'block';
    _container.appendChild(_canvas);

    _renderer = new THREE.WebGLRenderer({ canvas: _canvas, alpha: true, antialias: true });
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(_size, _size, false);

    _scene = new THREE.Scene();
    _scene.background = null;

    var ambient = new THREE.AmbientLight(0xffffff, 0.8);
    _scene.add(ambient);

    var dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(0, 1.5, 2);
    _scene.add(dir);

    var dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(0, -0.5, -1);
    _scene.add(dir2);

    _camera = new THREE.PerspectiveCamera(25, 1, 0.1, 100);
    _camera.position.set(0, 1.0, 3.5);
    _camera.lookAt(0, 0.9, 0);

    // Orbit controls for drag-to-rotate
    var OrbitControls = window.__OrbitControls;
    if (OrbitControls && _canvas) {
      _controls = new OrbitControls(_camera, _canvas);
      _controls.target.set(0, 0.9, 0);
      _controls.enableDamping = true;
      _controls.dampingFactor = 0.1;
      _controls.minDistance = 1.0;
      _controls.maxDistance = 10.0;
      _controls.update();
    }

    _clock = new THREE.Clock();
    _rafId = requestAnimationFrame(animate);
  }

  function animate() {
    _rafId = requestAnimationFrame(animate);
    if (!_renderer || !_scene || !_camera) return;

    var delta = _clock ? _clock.getDelta() : 0.016;

    if (_vrmScene && !_vrm) {
      _vrmScene.rotation.y += 0.002;
    }

    if (_vrm) {
      // Blend shape animation
      VRMHelpers.updateBlends(_vrm, _currentExpr);

      // Auto-blink
      VRMHelpers.autoBlink(_vrm);

      // Idle animation: subtle breathing + sway + arm relax
      if (_clock) {
        var t = performance.now() / 1000;
        // Gentle up/down bob (~1px at screen scale, ~0.5Hz)
        _vrmScene.position.y = -0.3 + Math.sin(t * 2.0) * 0.008;
        // Subtle body sway (~0.3deg at ~0.3Hz)
        _vrmScene.rotation.z = Math.sin(t * 1.2) * 0.005;
        _vrmScene.rotation.x = Math.sin(t * 0.8) * 0.003;
      }

      // three-vrm v3 requires update() each frame to apply expressions, lookAt, physics
      _vrm.update(delta);

      // Update FBX animation mixer (bored idle)
      if (_mixer) {
        _mixer.update(delta);
      }

      // Relax T-pose to a natural A-pose (arms slightly down)
      // Done after vrm.update() AND mixer.update() so neither overwrites it
      try {
        var a = _vrm.humanoid.getRawBoneNode('leftUpperArm');
        var b = _vrm.humanoid.getRawBoneNode('rightUpperArm');
        // Rotate around Z to bring arms down from T-pose (~11°)
        if (a) a.rotation.z = -0.2 + Math.sin(performance.now() / 1000 * 1.5) * 0.04;
        if (b) b.rotation.z = 0.2 + Math.sin(performance.now() / 1000 * 1.5) * 0.04;
      } catch(e) {}
    }

    if (_controls) {
      _controls.update();
    }

    _renderer.render(_scene, _camera);
  }

  var VRMHelpers = function() {
    var _blinkTimer = 2;
    var _blinkPhase = 0;
    var _blendWeights = {};
    // Expression -> blend shape target map
    var EXPR_MAP = {
      idle:       { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0 },
      happy:      { aa: 0.3, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0 },
      sad:        { aa: 0, ee: 0.3, ih: 0, oh: 0.2, ou: 0, blink: 0 },
      surprised:  { aa: 0.2, ee: 0, ih: 0, oh: 0.8, ou: 0, blink: 0 },
      angry:      { aa: 0.5, ee: 0, ih: 0.4, oh: 0, ou: 0, blink: 0 },
      thinking:   { aa: 0, ee: 0.2, ih: 0.1, oh: 0.1, ou: 0, blink: 0 },
      confused:   { aa: 0.1, ee: 0.3, ih: 0.1, oh: 0.2, ou: 0.1, blink: 0 },
      excited:    { aa: 0.7, ee: 0, ih: 0, oh: 0.5, ou: 0, blink: 0 },
      worried:    { aa: 0, ee: 0.2, ih: 0.2, oh: 0, ou: 0.3, blink: 0 },
      speaking:   function() {
        var t = (Date.now() % 1000) / 1000;
        return {
          aa: 0.5 * Math.sin(t * Math.PI * 4),
          ee: 0.2 * Math.sin(t * Math.PI * 2 + 4),
          ih: 0.3 * Math.sin(t * Math.PI * 3 + 1),
          oh: 0.4 * Math.sin(t * Math.PI * 2 + 2),
          ou: 0.3 * Math.sin(t * Math.PI * 2 + 3),
          blink: 0
        };
      }
    };

    return {
      updateBlends: function(vrm, expr) {
        var manager = vrm.expressionManager;
        if (!manager) return;

        var targets = EXPR_MAP[expr];
        if (typeof targets === 'function') targets = targets();

        var speed = 0.05;
        var keys = ['aa', 'ee', 'ih', 'oh', 'ou', 'blink'];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var target = (targets && targets[k] != null) ? targets[k] : 0;
          var current = (_blendWeights[k] != null) ? _blendWeights[k] : 0;
          var next = current + (target - current) * speed;
          if (Math.abs(next - target) < 0.01) next = target;
          _blendWeights[k] = next;

          // Try both naming conventions
          try { manager.setValue(k, next); } catch(e) {}
          try { manager.setValue(k.charAt(0).toUpperCase() + k.slice(1), next); } catch(e) {}
        }
      },
      autoBlink: function(vrm) {
        var manager = vrm.expressionManager;
        if (!manager) return;

        _blinkTimer -= 0.016;
        if (_blinkTimer <= 0) {
          _blinkTimer = 2 + Math.random() * 3;
          _blinkPhase = 0;
        }
        if (_blinkPhase < 0.5) {
          _blinkPhase += 0.016;
          var blinkW = _blinkPhase < 0.15
            ? _blinkPhase / 0.15
            : 1 - ((_blinkPhase - 0.15) / 0.35);
          blinkW = Math.max(0, Math.min(1, blinkW));
          try { manager.setValue('Blink', blinkW); } catch(e) {}
          try { manager.setValue('blink', blinkW); } catch(e) {}
        }
      },
      resetBlendWeights: function() {
        _blendWeights = {};
      }
    };
  }();

  function loadVRMModel(url) {
    if (!_renderer) { showError('Scene not ready'); return Promise.reject(new Error('No scene')); }
    if (!_THREE) { showError('Runtime not loaded'); return Promise.reject(new Error('No runtime')); }

    var modelUrl = url;
    if (!/^https?:\/\//.test(url) && !url.startsWith('blob:')) {
      modelUrl = new URL(url, _extUrl || window.location.href).href;
    }

    // Reset blend weights when loading a new model
    VRMHelpers.resetBlendWeights();

    showLoading('Loading model...');

    var THREE = _THREE;
    var VRMlib = window.__VRMLib;
    var GLTFLoaderClass = window.__GLTFLoader;
    var VRMLoaderPlugin = VRMlib.VRMLoaderPlugin;

    return new Promise(function(resolve, reject) {
      var loader = new GLTFLoaderClass();
      loader.register(function(parser) {
        // Force TextureLoader (<img>) instead of ImageBitmapLoader (fetch).
        // ImageBitmapLoader uses fetch() for blob: URLs, but connect-src CSP
        // doesn't include blob:. TextureLoader uses <img> which respects img-src (has blob:).
        parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
        return new VRMLoaderPlugin(parser);
      });

      loader.load(
        modelUrl,
        function(gltf) {
          var vrm = gltf.userData.vrm;
          if (!vrm) {
            reject(new Error('No VRM in GLTF'));
            return;
          }
          resolve(vrm);
        },
        undefined,
        function(error) {
          reject(error || new Error('Failed to load VRM'));
        }
      );
    })
    .then(function(vrm) {
      // Remove old model
      if (_vrmScene) {
        try { _scene.remove(_vrmScene); } catch(e) {}
      }
      _vrm = vrm;
      _vrmScene = vrm.scene;
      _scene.add(_vrmScene);

      // Position and scale
      _vrmScene.position.set(0, -0.3, 0);
      var box = new THREE.Box3().setFromObject(_vrmScene);
      var size = new THREE.Vector3();
      box.getSize(size);
      var maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        var scale = 1.5 / maxDim;
        _vrmScene.scale.set(scale, scale, scale);
      }

      hideLoading();
      // Load FBX idle animation (Bored) onto the VRM skeleton
      loadIdleAnimation();
      return vrm;
    })
    .catch(function(err) {
      showError('Model: ' + (err.message || '').slice(0, 50));
      throw err;
    });
  }

  // Load FBX idle animation onto the VRM rig
  var BORED_FBX_URL = 'assets/animations/Bored.fbx';

  function loadIdleAnimation() {
    var FBXLoader = window.__FBXLoader;
    var THREE = _THREE;
    if (!FBXLoader || !THREE || !_vrmScene) return;

    // Resolve relative URL using extension base
    var fbxUrl = BORED_FBX_URL;
    if (!/^https?:/.test(fbxUrl) && !fbxUrl.startsWith('blob:')) {
      fbxUrl = new URL(fbxUrl, _extUrl || window.location.href).href;
    }

    showLoading('Loading idle anim...');
    var loader = new FBXLoader();
    loader.load(fbxUrl,
      function(fbx) {
        hideLoading();
        var clip = fbx.animations && fbx.animations[0];
        if (!clip) { return; }
        // Filter to only rotation tracks, excluding root bones that
        // would rotate the entire model (Hips, Spine). Keep .quaternion/.rotation only.
        var rootBones = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Chest', 'Neck', 'Head'];
        var rotTracks = clip.tracks.filter(function(t) {
          if (t.name.indexOf('.quaternion') < 0 && t.name.indexOf('.rotation') < 0) return false;
          // Exclude root bone tracks (they rotate the whole model)
          var boneName = t.name.split('.')[0];
          for (var i = 0; i < rootBones.length; i++) {
            if (boneName.indexOf(rootBones[i]) >= 0) return false;
          }
          return true;
        });
        if (rotTracks.length === 0) { return; }
        var filteredClip = new THREE.AnimationClip(clip.name, clip.duration, rotTracks);
        // Create mixer for the VRM scene (bones must share names with FBX tracks)
        _mixer = new THREE.AnimationMixer(_vrmScene);
        var action = _mixer.clipAction(filteredClip);
        action.play();
      },
      undefined,
      function(err) {
        hideLoading();
        console.warn('[ea:vrm] Bored anim load failed:', err);
      }
    );
  }

  function setExpression(expr) {
    _currentExpr = expr;
  }

  function onExpressionChange(e) {
    if (e.detail && e.detail.expression) setExpression(e.detail.expression);
  }

  function onResize() {
    _size = parseInt(localStorage.getItem('ea-avatar-size')) || 192;
    if (_size < 48) _size = 48; if (_size > 192) _size = 192;
    if (_renderer) {
      _renderer.setSize(_size, _size, false);
      if (_camera) _camera.updateProjectionMatrix();
    }
  }

  // Public renderer API
  var VRMRenderer = {
    name: 'VRM',
    start: function(container) {
      _container = container;
      window.addEventListener('hermes:avatar:expression', onExpressionChange);
      window.addEventListener('ea-size-change', onResize);
      return { ready: true, message: 'VRM active' };
    },
    loadModel: function(url) {
      hideError(); hideLoading();
      return initRuntime().then(function() {
        createScene();
        if (!_renderer) throw new Error('Scene creation failed');
        return loadVRMModel(url);
      });
    },
    setExpression: setExpression,
    stop: function() {
      window.removeEventListener('hermes:avatar:expression', onExpressionChange);
      window.removeEventListener('ea-size-change', onResize);
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      if (_controls) {
        _controls.dispose();
        _controls = null;
      }
      if (_mixer) {
        _mixer.stopAllActions();
        _mixer = null;
      }
      if (_vrm) {
        _vrm = null;
      }
      if (_vrmScene && _scene) {
        try { _scene.remove(_vrmScene); } catch(e) {}
        _vrmScene = null;
      }
      if (_renderer) {
        try { _renderer.dispose(); } catch(e) {}
        _renderer = null;
      }
      if (_canvas && _canvas.parentNode) _canvas.parentNode.removeChild(_canvas);
      if (_container) { _container.innerHTML = ''; _container.style.position = ''; _container.style.overflow = ''; }
      _initialized = false;
      _THREE = null;
    }
  };

  __ea.renderer.vrm = VRMRenderer;
})();