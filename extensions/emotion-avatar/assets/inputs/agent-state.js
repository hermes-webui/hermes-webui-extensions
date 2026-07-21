// Input: Agent state polling (speaking, thinking via speechSynthesis + S.busy)
(function() {
  'use strict';
  if (__ea._inputAgentLoaded) return; __ea._inputAgentLoaded = true;

  var POLL_MS = 300;
  var timer = null;

  function detect() {
    try {
      // Speaking: TTS is playing
      if (window.speechSynthesis && window.speechSynthesis.speaking) return 'speaking';
      // Thinking: agent has active stream or is busy
      if (typeof S !== 'undefined' && S) {
        if (S.busy || (S.session && S.session.active_stream_id) || S.activeStreamId) return 'thinking';
      }
      if (typeof INFLIGHT === 'object' && INFLIGHT) {
        for (var sid in INFLIGHT) { if (Object.prototype.hasOwnProperty.call(INFLIGHT, sid)) return 'thinking'; }
      }
      if (typeof _allSessions !== 'undefined' && Array.isArray(_allSessions)) {
        for (var i = 0; i < _allSessions.length; i++) {
          var s = _allSessions[i];
          if (s && (s.is_streaming || s.active_stream_id)) return 'thinking';
        }
      }
    } catch(_) {}
    return 'idle';
  }

  __ea.inputAgent = {
    start: function() {
      var last = 'idle';
      timer = setInterval(function() {
        var state = detect();
        if (state !== last) {
          last = state;
          __ea.pipe.pulse(state, 'agent');
        } else if (state === 'idle') {
          // Keep pulse alive so idle clears stale agent state
          __ea.pipe.pulse(state, 'agent');
        }
      }, POLL_MS);
    },
    stop: function() {
      if (timer) { clearInterval(timer); timer = null; }
    }
  };
})();
