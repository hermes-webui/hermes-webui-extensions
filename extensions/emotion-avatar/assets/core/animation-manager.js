// Animation Manager — clip registry + crossfade controller
// Renderers register loaded FBX/glTF animation clips here.
// The manager handles crossfading between clips and distributing updates.
//
// API:
//   __ea.animator.registerClip(clipId, clip)     — store a loaded THREE.AnimationClip
//   __ea.animator.play(clipId, mixer, fade)       — play clip on mixer with crossfade
//   __ea.animator.stop(mixer, fade)               — stop all on mixer
//   __ea.animator.update(delta)                   — update all mixers (called each frame)
//   __ea.animator.getClip(clipId)                 — get a registered clip (or null)
(function() {
  'use strict';
  if (__ea._animatorLoaded) return;
  __ea._animatorLoaded = true;

  var _clips = {};   // clipId → THREE.AnimationClip
  var _mixers = [];  // all active mixers
  var _actions = {}; // mixer ID → current action

  var _mixerId = 0;

  function registerClip(clipId, clip) {
    if (!clip || !clip.name) {
      console.warn('[ea:animator] invalid clip for id:', clipId);
      return;
    }
    _clips[clipId] = clip;
  }

  function getClip(clipId) {
    return _clips[clipId] || null;
  }

  // Play a clip on a mixer with optional crossfade from current action
  // Returns the new action (or null if clip not found)
  function play(clipId, mixer, fadeSeconds) {
    if (!mixer || !clipId) return null;

    var clip = _clips[clipId];
    if (!clip) {
      console.warn('[ea:animator] clip not found:', clipId);
      return null;
    }

    // Track this mixer
    if (_mixers.indexOf(mixer) === -1) {
      mixer._eaId = ++_mixerId;
      _mixers.push(mixer);
    }

    // Stop currently playing action with crossfade
    var currentAction = _actions[mixer._eaId];
    if (currentAction && currentAction.getClip().name === clip.name) {
      // Already playing this clip — no change
      return currentAction;
    }

    if (currentAction) {
      currentAction.fadeOut(fadeSeconds || 0.4);
    }

    // Play new action
    var action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(clip.loop || true);
    action.fadeIn(fadeSeconds || 0.3);
    action.play();

    _actions[mixer._eaId] = action;
    return action;
  }

  // Stop all actions on a mixer
  function stop(mixer, fadeSeconds) {
    if (!mixer || !mixer._eaId) return;

    var action = _actions[mixer._eaId];
    if (action) {
      action.fadeOut(fadeSeconds || 0.3);
      delete _actions[mixer._eaId];
    }
  }

  // Update all active mixers (call each frame)
  function update(delta) {
    for (var i = 0; i < _mixers.length; i++) {
      _mixers[i].update(delta);
    }
  }

  // Remove a mixer from the manager (e.g. on renderer stop)
  function removeMixer(mixer) {
    if (!mixer || !mixer._eaId) return;

    var action = _actions[mixer._eaId];
    if (action) {
      action.stop();
      delete _actions[mixer._eaId];
    }

    var idx = _mixers.indexOf(mixer);
    if (idx >= 0) _mixers.splice(idx, 1);
  }

  // Check if a clipId is known (may or may not be loaded)
  function clipExists(clipId) {
    return clipId && (__ea.animClips && __ea.animClips[clipId]);
  }

  __ea.animator = {
    registerClip: registerClip,
    getClip: getClip,
    play: play,
    stop: stop,
    update: update,
    removeMixer: removeMixer,
    clipExists: clipExists
  };
})();
