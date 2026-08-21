// Input: LLM response tag scanner
// Scans latest message for [happy] [surprised] [thinking] [sad] [confused] [excited] [angry] [worried]
(function() {
  'use strict';
  if (__ea._inputLLMLoaded) return; __ea._inputLLMLoaded = true;

  var SCAN_MS = 2000;
  var VALID = ['happy','sad','surprised','confused','thinking','excited','angry','worried'];
  var timer = null;
  var lastTag = null;

  function scan() {
    // Find the last message element
    var msgs = document.querySelectorAll('.message-content, [class*="message"][class*="content"]');
    if (!msgs.length) return null;
    var last = msgs[msgs.length - 1];
    var text = last.textContent || '';
    // Find expression tags like [happy] [surprised]
    var matches = text.match(/\[(\w+)\]/g);
    if (!matches) return null;
    // Take the last tag that matches a valid expression
    for (var i = matches.length - 1; i >= 0; i--) {
      var tag = matches[i].replace(/[\[\]]/g, '').toLowerCase();
      if (VALID.indexOf(tag) >= 0) return tag;
    }
    return null;
  }

  __ea.inputLLM = {
    start: function() {
      timer = setInterval(function() {
        var tag = scan();
        if (tag && tag !== lastTag) {
          lastTag = tag;
          __ea.pipe.pulse(tag, 'llm');
        }
      }, SCAN_MS);
    },
    stop: function() {
      if (timer) { clearInterval(timer); timer = null; }
    }
  };
})();
