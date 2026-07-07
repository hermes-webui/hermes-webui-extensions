(() => {
  'use strict';
  if (window.__emotionBridgeLoaded) return;
  window.__emotionBridgeLoaded = true;

  var B = {
    enabled: true,
    status: 'idle',
    pollMs: 300,
    prevExpression: null,
  };

  function emit(expression, source) {
    if (!B.enabled) return;
    if (expression === B.prevExpression) return;
    B.prevExpression = expression;
    window.__avatarExpression = expression;
    window.dispatchEvent(new CustomEvent('hermes:avatar:expression', {
      detail: { expression: expression, source: source || 'bridge', timestamp: Date.now() }
    }));
  }

  function scanMessages() {
    var messages = document.querySelectorAll('.message-content, .assistant-message, [class*="message"]');
    if (!messages.length) return;
    var last = messages[messages.length - 1];
    var text = last.textContent || '';
    var match = text.match(/\[(\w+)\]/g);
    if (match) {
      var tag = match[match.length - 1].replace(/[\[\]]/g, '').toLowerCase();
      emit(tag, 'llm-tag');
    }
  }

  function pollAgentState() {
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
      emit('speaking', 'agent');
      return;
    }
    try {
      if (typeof S !== 'undefined' && S && (S.busy || (S.session && S.session.active_stream_id))) {
        emit('thinking', 'agent');
        return;
      }
      if (typeof INFLIGHT === 'object' && INFLIGHT) {
        for (var sid in INFLIGHT) {
          if (Object.prototype.hasOwnProperty.call(INFLIGHT, sid)) {
            emit('thinking', 'agent');
            return;
          }
        }
      }
    } catch(_) {}
    emit('idle', 'agent');
  }

  function watchFACTags() {
    window.addEventListener('hermes:fac:emotion', function(e) {
      if (e.detail && e.detail.emotion) {
        emit(e.detail.emotion, 'fac');
      }
    });
  }

  function handleExternal(e) {
    if (e.detail && e.detail.expression) {
      emit(e.detail.expression, e.detail.source || 'external');
    }
  }

  var pollTimer = null;
  var scanTimer = null;

  function start() {
    if (pollTimer) clearInterval(pollTimer);
    if (scanTimer) clearInterval(scanTimer);
    B.status = 'connected';
    pollTimer = setInterval(pollAgentState, B.pollMs);
    scanTimer = setInterval(scanMessages, 2000);
    watchFACTags();
    window.addEventListener('hermes:avatar:emotion', handleExternal);
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    window.removeEventListener('hermes:avatar:emotion', handleExternal);
    B.status = 'stopped';
  }

  window.__emotionBridge = {
    emit: emit,
    enable: function() { B.enabled = true; start(); },
    disable: function() { B.enabled = false; B.status = 'disabled'; },
    enabled: function() { return B.enabled; },
    status: function() { return B.status; },
    current: function() { return B.prevExpression; },
  };

  function init() {
    if (B.enabled) start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    setTimeout(init, 1000);
  }
})();
