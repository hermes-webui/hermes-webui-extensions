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
  var _animManager = null;

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

      // Update animation state machine (FBX animations, cross-fade, boredom)
      // Runs after vrm.update() so mixer overwrites humanoid bones with animation
      if (_animManager) {
        _animManager.update(delta, _currentExpr);
      }
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

    return {
      updateBlends: function(vrm, expr) {
        var manager = vrm.expressionManager;
        if (!manager) return;

        var targets = __ea.getBlends(expr) || {};

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
      // Rotate 180° around Y: glTF +Z forward → faces camera at +Z
      _vrmScene.rotation.y = Math.PI;
      var box = new THREE.Box3().setFromObject(_vrmScene);
      var size = new THREE.Vector3();
      box.getSize(size);
      var maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        var scale = 1.5 / maxDim;
        _vrmScene.scale.set(scale, scale, scale);
      }

      hideLoading();
      // Initialise animation state machine (loads idle FBX animations)
      if (_THREE && _vrmScene) {
        _animManager = new AnimManager(_THREE, _vrmScene, _vrm, _extUrl);
      }
      return vrm;
    })
    .catch(function(err) {
      showError('Model: ' + (err.message || '').slice(0, 50));
      throw err;
    });
  }

  // ── Animation State Machine ──────────────────────────────────────────
  // Pre-loads FBX idle animations from osa-gallery, retargets Mixamo→VRM bones,
  // and cross-fades between states based on expression + boredom timer.

  // Mixamo → VRM bone name mapping (from osa-gallery)
  var mixamoVRMRigMap = {
    mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest',
    mixamorigSpine2: 'upperChest', mixamorigNeck: 'neck', mixamorigHead: 'head',
    mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm',
    mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
    mixamorigLeftHandThumb1: 'leftThumbMetacarpal', mixamorigLeftHandThumb2: 'leftThumbProximal',
    mixamorigLeftHandThumb3: 'leftThumbDistal', mixamorigLeftHandIndex1: 'leftIndexProximal',
    mixamorigLeftHandIndex2: 'leftIndexIntermediate', mixamorigLeftHandIndex3: 'leftIndexDistal',
    mixamorigLeftHandMiddle1: 'leftMiddleProximal', mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
    mixamorigLeftHandMiddle3: 'leftMiddleDistal', mixamorigLeftHandRing1: 'leftRingProximal',
    mixamorigLeftHandRing2: 'leftRingIntermediate', mixamorigLeftHandRing3: 'leftRingDistal',
    mixamorigLeftHandPinky1: 'leftLittleProximal', mixamorigLeftHandPinky2: 'leftLittleIntermediate',
    mixamorigLeftHandPinky3: 'leftLittleDistal', mixamorigRightShoulder: 'rightShoulder',
    mixamorigRightArm: 'rightUpperArm', mixamorigRightForeArm: 'rightLowerArm',
    mixamorigRightHand: 'rightHand', mixamorigRightHandPinky1: 'rightLittleProximal',
    mixamorigRightHandPinky2: 'rightLittleIntermediate', mixamorigRightHandPinky3: 'rightLittleDistal',
    mixamorigRightHandRing1: 'rightRingProximal', mixamorigRightHandRing2: 'rightRingIntermediate',
    mixamorigRightHandRing3: 'rightRingDistal', mixamorigRightHandMiddle1: 'rightMiddleProximal',
    mixamorigRightHandMiddle2: 'rightMiddleIntermediate', mixamorigRightHandMiddle3: 'rightMiddleDistal',
    mixamorigRightHandIndex1: 'rightIndexProximal', mixamorigRightHandIndex2: 'rightIndexIntermediate',
    mixamorigRightHandIndex3: 'rightIndexDistal', mixamorigRightHandThumb1: 'rightThumbMetacarpal',
    mixamorigRightHandThumb2: 'rightThumbProximal', mixamorigRightHandThumb3: 'rightThumbDistal',
    mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg',
    mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
    mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg',
    mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes',
  };

  // Animation definitions — name → FBX filename + mood tag
  var ANIM_DEFS = {
    bored:   { file: 'Bored.fbx',             weight: 1 },
    looking: { file: 'LookingAround.fbx',     weight: 1 },
    active:  { file: 'OffensiveIdle.fbx',     weight: 1 },
  };

  // Expression → animation state mapping
  var EXPR_TO_STATE = {
    idle:      'idle',
    happy:     'active',
    angry:     'active',
    excited:   'active',
    thinking:  'looking',
    surprised: 'looking',
    sad:       'idle',
    confused:  'idle',
    worried:   'idle',
    speaking:  'idle',
  };

  var ANIM_BASE_URL = 'https://cdn.jsdelivr.net/gh/ToxSam/osa-gallery@main/public/animations/';

  // ── AnimManager constructor ────────────────────────────────────────
  function AnimManager(THREE, root, vrm, extUrl) {
    this.THREE = THREE;
    this.root = root;        // _vrmScene
    this.vrm = vrm;
    this.extUrl = extUrl;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = {};         // name → retargeted AnimationClip
    this.actions = {};       // name → AnimationAction
    this.currentState = 'idle';
    this.prevState = null;
    this._loading = {};      // name → true  (dedup)
    this._boredomTimer = 0;
    this._crossFading = null; // {from, to, duration, elapsed}
    this._exprTime = 0;      // seconds since last expression change
    this._activeExpr = 'idle';
    this.FBXLoader = window.__FBXLoader;

    // Load first idle anim immediately, queue others
    this._loadAnim('bored').then(function(mgr) {
      // After bored loads, try idle → bored transition after timer
    }.bind(this));
    this._loadAnim('looking');
    this._loadAnim('active');
  }

  // ── Load + retarget a single FBX animation ─────────────────────────
  AnimManager.prototype._loadAnim = function(name) {
    var def = ANIM_DEFS[name];
    if (!def || this._loading[name]) return;
    this._loading[name] = true;

    var self = this;
    var THREE = this.THREE;
    var FBXLoader = this.FBXLoader;
    var loader = new FBXLoader();
    var url = ANIM_BASE_URL + def.file;

    return new Promise(function(resolve) {
      loader.load(url,
        function(fbx) {
          var clip = THREE.AnimationClip.findByName(fbx.animations, 'mixamo.com');
          if (!clip) { clip = fbx.animations[0]; }
          if (!clip) { resolve(); return; }

          // Bone names from the FBX use 'mixamorigHips' (no colon).
          // The VRM scene uses 'mixamorig:Hips' (with colon).
          // Rename tracks to match the scene's node names via the VRM humanoid.
          var tracks = [];
          clip.tracks.forEach(function(track) {
            var splitted = track.name.split('.');
            var mixamoName = splitted[0];
            var prop = splitted[1];
            var vrmBoneName = mixamoVRMRigMap[mixamoName];
            if (!vrmBoneName) return;
            var vrmNode = self.vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
            var vrmNodeName = vrmNode ? vrmNode.name : null;
            if (!vrmNodeName) return;

            if (track instanceof THREE.QuaternionKeyframeTrack) {
              tracks.push(new THREE.QuaternionKeyframeTrack(
                vrmNodeName + '.' + prop, track.times, track.values.slice()
              ));
            } else if (track instanceof THREE.VectorKeyframeTrack) {
              tracks.push(new THREE.VectorKeyframeTrack(
                vrmNodeName + '.' + prop, track.times, track.values.slice()
              ));
            }
          });

          if (tracks.length === 0) { resolve(); return; }
          var retargetedClip = new THREE.AnimationClip('anim_' + name, clip.duration, tracks);
          self.clips[name] = retargetedClip;
          // Create action (stopped — will play on transition)
          var action = self.mixer.clipAction(retargetedClip);
          action.stop();
          self.actions[name] = action;
          console.log('[ea:vrm] Loaded & retargeted "' + name + '" (' + tracks.length + ' tracks)');
          resolve(self);
        },
        undefined,
        function(err) {
          console.warn('[ea:vrm] Failed to load anim "' + name + '":', err);
          resolve();
        }
      );
    });
  };

  // ── Transition to a named state with cross-fade ────────────────────
  AnimManager.prototype.transitionTo = function(state, blendTime) {
    if (state === this.currentState) return;
    blendTime = blendTime || 0.35;

    var prev = this.currentState;
    this.currentState = state;
    this.prevState = prev;

    // Stop old action, start new one with cross-fade
    var oldAction = this.actions[prev];
    var newAction = this.actions[state];

    if (newAction) {
      newAction.reset();
      newAction.setEffectiveWeight(1); // action.stop() set weight=0; restore it
      newAction.play();
      if (oldAction) {
        oldAction.crossFadeTo(newAction, blendTime, false);
        setTimeout(function() { oldAction.stop(); }, blendTime * 1000 + 100);
      }
    } else if (oldAction) {
      // No clip for the new state — stop playing (procedural idle)
      oldAction.crossFadeTo(null, blendTime);
      setTimeout(function() { oldAction.stop(); }, blendTime * 1000 + 100);
    }

    // Stop all non-target actions that might be lingering
    this._stopOtherActions(state);
  };

  AnimManager.prototype._stopOtherActions = function(keep) {
    for (var name in this.actions) {
      if (name !== keep && this.actions[name].isRunning()) {
        this.actions[name].stop();
      }
    }
  };

  // ── Main per-frame update — called from animate() ──────────────────
  AnimManager.prototype.update = function(delta, expr) {
    // Track expression state
    if (expr !== this._activeExpr) {
      this._activeExpr = expr;
      this._exprTime = 0;
      this._boredomTimer = 0;
    } else {
      this._exprTime += delta;
    }

    // Determine target state from expression
    var targetState = EXPR_TO_STATE[expr] || 'idle';

    // Active emotion → override to active anim
    if (targetState !== 'idle') {
      if (this.clips[targetState] && this.currentState !== targetState) {
        this.transitionTo(targetState, 0.3);
      }
      this._boredomTimer = 0;
    } else {
      // Idle expression — check boredom timer for random idle anims
      if (this.currentState !== 'idle' && this.currentState !== 'bored' && this.currentState !== 'looking') {
        // Came back to idle from active — reset to procedural
        this._idleProcedural();
      }

      if (this._exprTime > 6 && this.currentState === 'idle') {
        // After 6s of idle expression, try bored
        if (this.clips['bored'] && this.currentState !== 'bored') {
          this.transitionTo('bored', 0.5);
        }
      }
      if (this._exprTime > 12 && this.currentState === 'bored') {
        // After 12s total idle, alternate
        if (this.clips['looking'] && Math.random() < 0.01) {
          this.transitionTo('looking', 0.4);
        }
      }
      if (this._exprTime > 18 && this.currentState === 'looking') {
        // Back to bored
        if (this.clips['bored']) {
          this.transitionTo('bored', 0.4);
        }
      }
    }

    // Update mixer
    this.mixer.update(delta);
  };

  // Return to procedural idle (no FBX)
  AnimManager.prototype._idleProcedural = function() {
    this.currentState = 'idle';
    this._stopOtherActions(null);
  };

  // ── Cleanup ────────────────────────────────────────────────────────
  AnimManager.prototype.destroy = function() {
    this.mixer.stopAllActions();
    this.clips = {};
    this.actions = {};
    this.mixer = null;
  };

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
      if (_animManager) {
        _animManager.destroy();
        _animManager = null;
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