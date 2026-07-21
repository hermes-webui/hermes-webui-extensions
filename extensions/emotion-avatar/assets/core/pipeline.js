// Pipeline: expression priority engine + event dispatch
// Sources push expressions via EmotionPipe.set(). The pipe resolves priority and emits.
(function() {
  'use strict';

  __ea.pipe = {
    // Priority config — lower number = higher priority
    PRIORITY: {
      fac: 0,       // FAC voice emotion detection (highest)
      external: 1,  // External dispatch from another extension
      llm: 2,       // LLM response tags [happy] [surprised]
      agent: 3,     // Agent state (speaking via speechSynthesis, thinking via S.busy)
      idle: 4,      // Default idle (lowest)
    },

    _exprs: {},   // { source: { expression, timestamp, priority } }
    _current: 'idle',
    _tweenTime: 120, // ms to tween between two expressions

    // Set expression from a source
    set: function(expression, source) {
      var pri = this.PRIORITY.hasOwnProperty(source) ? this.PRIORITY[source] : this.PRIORITY.external;
      this._exprs[source] = { expression: expression, timestamp: Date.now(), priority: pri };
      this._resolve();
    },

    // Clear a source (it's no longer providing input)
    clear: function(source) {
      delete this._exprs[source];
      this._resolve();
    },

    // Resolve highest-priority expression
    _resolve: function() {
      var best = null, bestPri = 999, bestTs = 0;
      var now = Date.now();
      // Stale thresholds (ms): if source hasn't updated in this long, ignore
      var STALE = { fac: 4000, external: 5000, llm: 8000, agent: 2000, idle: 99999 };
      var keys = Object.keys(this._exprs);
      for (var i = 0; i < keys.length; i++) {
        var e = this._exprs[keys[i]];
        var stale = STALE[keys[i]] || 5000;
        if (now - e.timestamp > stale) { delete this._exprs[keys[i]]; continue; }
        if (e.priority < bestPri || (e.priority === bestPri && e.timestamp > bestTs)) {
          best = e.expression;
          bestPri = e.priority;
          bestTs = e.timestamp;
        }
        if (e.source) best = e.expression; // legacy support
      }
      if (best && best !== this._current) {
        var prev = this._current;
        this._current = best;
        this._emit(best, prev);
      }
      if (!best && this._current !== 'idle') {
        this._current = 'idle';
        this._emit('idle', this._current);
      }
    },

    _emit: function(expression, previous) {
      window.__avatarExpression = expression;
      window.dispatchEvent(new CustomEvent('hermes:avatar:expression', {
        detail: { expression: expression, previous: previous, timestamp: Date.now() }
      }));
    },

    // Get current resolved expression
    get: function() { return this._current; },

    // Set directly with auto-cleanup (for agent state polling)
    pulse: function(expression, source) {
      this.set(expression, source);
    }
  };
})();
