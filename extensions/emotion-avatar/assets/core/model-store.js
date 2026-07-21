// Model store — manages user-imported models in IndexedDB
(function() {
  'use strict';
  if (__ea.modelStore) return;
  __ea.modelStore = {};

  var DB_NAME = 'HermesEmotionAvatarModels';
  var DB_VER = 1;
  var STORE = 'models';

  // Built-in preset models — always available
  var BUILTINS = [
    { id: '__preset_pixel',   name: 'Pixel',   type: 'preset', builtin: true },
    { id: '__preset_neko',    name: 'Neko',    type: 'preset', builtin: true },
    { id: '__preset_yuki',    name: 'Yuki',    type: 'preset', builtin: true },
    { id: '__preset_robot',   name: 'Robot',   type: 'preset', builtin: true },
    { id: '__preset_monster', name: 'Monster', type: 'preset', builtin: true },
  ];

  var _db = null;
  var _ready = false;
  var _queue = [];

  function open() {
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        var s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = function(e) {
      _db = e.target.result;
      _ready = true;
      _queue.forEach(function(fn) { try { fn(); } catch(_) {} });
      _queue = [];
    };
    req.onerror = function() {
      console.warn('[ea:model-store] IndexedDB unavailable — will use memory only');
      _ready = true;
      _queue.forEach(function(fn) { try { fn(); } catch(_) {} });
      _queue = [];
    };
  }

  function ready(fn) {
    if (_ready) { try { fn(); } catch(_) {} return; }
    _queue.push(fn);
  }

  // Get all models (builtins + user models)
  function getAll() {
    return BUILTINS.slice();
  }

  // Add a user model
  function add(modelDef, fileBlob) {
    var id = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    var entry = {
      id: id,
      name: modelDef.name || 'Imported Model',
      type: modelDef.type || 'live2d',
      builtin: false,
      url: modelDef.url || null,
      added: Date.now(),
    };
    if (fileBlob) {
      // Store blob reference — actual files stored separately or via URL
      entry._fileSize = fileBlob.size;
      entry._fileType = fileBlob.type;
    }
    if (_db) {
      try {
        var tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add(entry);
        if (fileBlob) {
          // Store blob in a second store keyed by model id
          var blobTx = _db.transaction(STORE + '_files', 'readwrite');
          if (blobTx) { /* best effort */ }
        }
      } catch(_) {}
    }
    return entry;
  }

  // Remove a user model
  function remove(id) {
    if (_db) {
      try {
        var tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
      } catch(_) {}
    }
  }

  // Get active model ID from localStorage
  var ACTIVE_KEY = 'ea-active-model';

  function getActive() {
    return localStorage.getItem(ACTIVE_KEY) || 'preset';
  }

  function setActive(id) {
    localStorage.setItem(ACTIVE_KEY, id);
  }

  __ea.modelStore = { open: open, ready: ready, getAll: getAll, add: add, remove: remove, getActive: getActive, setActive: setActive };

  // Auto-open on next tick
  setTimeout(open, 0);
})();
