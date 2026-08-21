// Emotion Manifest — standard mapping from emotion name to blends + animation clips
// All renderers (VRM, Live2D, Spine) consume this as their single source of truth.
// Voice/state extensions (FAC, Hermes agent, orchestrator) emit emotion labels;
// the renderer looks up the response here.
(function() {
  'use strict';
  if (__ea._emotionManifestLoaded) return;
  __ea._emotionManifestLoaded = true;

  // Base path for animation files (relative to extension root, resolved by renderer)
  var OSAGAL_BASE = 'https://cdn.jsdelivr.net/gh/ToxSam/osa-gallery@main/public/animations/';

  // Each emotion defines:
  //   blends:  {presetName: weight}  — VRM expression preset weights (string names)
  //            null = dynamic (renderer computes at runtime, e.g. speaking lip-sync)
  //   bodyIdle: "clipId"             — animation clip when state is idle/thinking
  //   bodySpeaking: "clipId"         — animation clip when state is speaking
  //            null = no body animation, use procedural idle
  //   fade:     seconds              — crossfade duration to this emotion
  __ea.emotions = {
    idle: {
      blends: { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0 },
      bodyIdle: 'bored',
      bodySpeaking: null,
      fade: 1.0
    },
    happy: {
      blends: { aa: 0.3, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.3
    },
    sad: {
      blends: { aa: 0, ee: 0.3, ih: 0, oh: 0.2, ou: 0, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.5
    },
    surprised: {
      blends: { aa: 0.2, ee: 0, ih: 0, oh: 0.8, ou: 0, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.3
    },
    angry: {
      blends: { aa: 0.5, ee: 0, ih: 0.4, oh: 0, ou: 0, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.2
    },
    thinking: {
      blends: { aa: 0, ee: 0.2, ih: 0.1, oh: 0.1, ou: 0, blink: 0 },
      bodyIdle: 'bored',
      bodySpeaking: null,
      fade: 0.4
    },
    confused: {
      blends: { aa: 0.1, ee: 0.3, ih: 0.1, oh: 0.2, ou: 0.1, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.4
    },
    excited: {
      blends: { aa: 0.7, ee: 0, ih: 0, oh: 0.5, ou: 0, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.3
    },
    worried: {
      blends: { aa: 0, ee: 0.2, ih: 0.2, oh: 0, ou: 0.3, blink: 0 },
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.4
    },
    speaking: {
      blends: null,   // dynamic — lip-sync computed by renderer
      bodyIdle: null,
      bodySpeaking: null,
      fade: 0.1
    },
    bored: {
      blends: { aa: 0, ee: 0, ih: 0.1, oh: 0.1, ou: 0, blink: 0 },
      bodyIdle: 'bored',
      bodySpeaking: null,
      fade: 0.4
    }
  };

  // Animation clip registry — maps clipId → URL + metadata
  // Renderers load these on demand via FBXLoader.
  __ea.animClips = {
    bored: {
      url: OSAGAL_BASE + 'Bored.fbx',
      size: 2563088,
      loop: true,
      duration: 8.3   // seconds, approximate from Mixamo
    },
    fightIdle: {
      url: OSAGAL_BASE + 'FightIdle.fbx',
      size: 413616,
      loop: true,
      duration: 3.3
    },
    crossJumps: {
      url: OSAGAL_BASE + 'CrossJumps.fbx',
      size: 1961968,
      loop: true,
      duration: 5.0
    },
    looking: {
      url: OSAGAL_BASE + 'Looking.fbx',
      size: 2401872,
      loop: true,
      duration: 5.0
    },
    lookingAround: {
      url: OSAGAL_BASE + 'LookingAround.fbx',
      size: 1229504,
      loop: true,
      duration: 4.0
    },
    magicSpell: {
      url: OSAGAL_BASE + 'MagicSpellCasting.fbx',
      size: 2071024,
      loop: false,
      duration: 3.0
    },
    searchingFiles: {
      url: OSAGAL_BASE + 'SearchingFilesHigh.fbx',
      size: 1098496,
      loop: true,
      duration: 3.0
    },
    texting: {
      url: OSAGAL_BASE + 'TextingWhileStanding.fbx',
      size: 1255520,
      loop: true,
      duration: 4.0
    }
  };

  // Helper: look up an emotion definition (fallback to idle)
  __ea.getEmotion = function(name) {
    return __ea.emotions[name] || __ea.emotions['idle'];
  };

  // Helper: get blends for an emotion, resolving 'speaking' lip-sync if needed
  __ea.getBlends = function(name) {
    var def = __ea.emotions[name] || __ea.emotions['idle'];
    if (def.blends === null && name === 'speaking') {
      // dynamic speaking — compute lip-sync in renderer
      return __ea.getSpeakingBlends();
    }
    return def.blends || {};
  };

  // Dynamic speaking lip-sync using sine oscillation
  // (kept here so it's the same logic regardless of renderer)
  __ea.getSpeakingBlends = function() {
    var t = (Date.now() % 1000) / 1000;
    return {
      aa: 0.5 * Math.sin(t * Math.PI * 4),
      ee: 0.2 * Math.sin(t * Math.PI * 2 + 4),
      ih: 0.3 * Math.sin(t * Math.PI * 3 + 1),
      oh: 0.4 * Math.sin(t * Math.PI * 2 + 2),
      ou: 0.3 * Math.sin(t * Math.PI * 2 + 3),
      blink: 0
    };
  };
})();
