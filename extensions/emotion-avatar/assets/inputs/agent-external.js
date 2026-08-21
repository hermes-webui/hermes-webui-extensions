// Input: external agent/orchestrator expression events
// Listens for hermes:agent:state (dispatched by session-orchestrator PR #49)
// and feeds the embedded expression as a cross-extension ('external') source.
// 'external' has priority 1 in pipeline.PRIORITY — above llm/agent polling but
// below FAC voice emotion — so an explicit orchestrator command wins over
// idle/busy polling yet never overrides live voice emotion.
(function() {
  'use strict';
  if (__ea._inputAgentExternalLoaded) return; __ea._inputAgentExternalLoaded = true;

  function handle(e) {
    var expr = e && e.detail && e.detail.expression;
    if (expr) __ea.pipe.pulse(expr, 'external');
  }

  __ea.inputAgentExternal = {
    start: function() {
      window.addEventListener('hermes:agent:state', handle);
    },
    stop: function() {
      window.removeEventListener('hermes:agent:state', handle);
    }
  };
})();
