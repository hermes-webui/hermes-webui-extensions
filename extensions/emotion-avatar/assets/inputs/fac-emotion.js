// Input: FAC emotion event listener
// Listens for hermes:fac:emotion events from the Fun-Audio-Chat voice pipeline
(function() {
  'use strict';
  if (__ea._inputFACLoaded) return; __ea._inputFACLoaded = true;

  function handle(e) {
    if (e.detail && e.detail.emotion) {
      __ea.pipe.pulse(e.detail.emotion, 'fac');
    }
  }

  __ea.inputFAC = {
    start: function() {
      window.addEventListener('hermes:fac:emotion', handle);
    },
    stop: function() {
      window.removeEventListener('hermes:fac:emotion', handle);
    }
  };
})();
