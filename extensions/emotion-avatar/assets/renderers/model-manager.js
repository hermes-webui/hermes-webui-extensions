// Model manager — manages model switching between builtin presets and user-imported
(function() {
  'use strict';
  if (__ea._modelManagerLoaded) return; __ea._modelManagerLoaded = true;

  __ea.modelManager = {};

  var ACTIVE_KEY = 'ea-active-model';
  var ACTIVE_TYPE_KEY = 'ea-active-model-type';
  var MODELS_KEY = 'ea-user-models';

  // In-memory model registry (persisted to localStorage for simple cases)
  function getModels() {
    try {
      return JSON.parse(localStorage.getItem(MODELS_KEY)) || [];
    } catch(_) { return []; }
  }

  function saveModels(arr) {
    try { localStorage.setItem(MODELS_KEY, JSON.stringify(arr)); } catch(_) {}
  }

  // Built-in presets
  var BUILTIN_PRESETS = [
    { id: '__preset__pixel',   name: 'Pixel',   type: 'preset' },
    { id: '__preset__neko',    name: 'Neko',    type: 'preset' },
    { id: '__preset__yuki',    name: 'Yuki',    type: 'preset' },
    { id: '__preset__robot',   name: 'Robot',   type: 'preset' },
    { id: '__preset__monster', name: 'Monster', type: 'preset' },
    { id: '__preset__coolbanana', name: 'Cool Banana', type: 'vrm', url: 'assets/models/CoolBanana.vrm' },
  ];

  function getAll() {
    return BUILTIN_PRESETS.concat(getModels());
  }

  function addModel(def) {
    var models = getModels();
    var id = 'model_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    models.push({
      id: id,
      name: def.name || 'Custom Model',
      type: def.type || 'live2d',
      url: def.url || null,
      fileSize: def.fileSize || null,
      added: Date.now(),
    });
    saveModels(models);
    return id;
  }

  function removeModel(id) {
    var models = getModels();
    saveModels(models.filter(function(m) { return m.id !== id; }));
    if (getActive() === id) { setActive('__preset__pixel'); }
  }

  function getActive() {
    return localStorage.getItem(ACTIVE_KEY) || '__preset__pixel';
  }

  function setActive(id) {
    localStorage.setItem(ACTIVE_KEY, id);
  }

  // Get the active model definition
  function getActiveModel() {
    var id = getActive();
    var all = getAll();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return BUILTIN_PRESETS[0];
  }

  __ea.modelManager = {
    getAll: getAll,
    builtins: BUILTIN_PRESETS,
    addModel: addModel,
    removeModel: removeModel,
    getActive: getActive,
    setActive: setActive,
    getActiveModel: getActiveModel,
  };
})();
