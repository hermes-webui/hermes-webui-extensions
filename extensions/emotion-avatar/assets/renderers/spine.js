// Renderer: Spine — loads user-supplied .skel/.json + atlas files
// Requires: Spine Canvas runtime (proprietary, user must provide their own copy)
// Reference: https://esotericsoftware.com/spine-runtimes
(function() {
  'use strict';
  if (__ea._rendererSpineLoaded) return; __ea._rendererSpineLoaded = true;
  __ea.renderer = __ea.renderer || {};

  var SpineRenderer = {
    name: 'Spine',
    start: function(container) {
      _canvas = container;
      return { ready: false, message: 'Spine renderer requires Spine Runtime (esotericsoftware.com). Check README for setup.' };
    },
    stop: function() {},
    setExpression: function() {},
    loadModel: function() {
      return Promise.reject(new Error('Spine rendering not yet implemented. See README for custom renderer guide.'));
    },
  };

  __ea.renderer.spine = SpineRenderer;
})();
