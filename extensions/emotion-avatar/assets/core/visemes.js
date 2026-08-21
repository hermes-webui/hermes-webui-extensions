// Lightweight viseme engine — phoneme → mouth shape mapping
// For audio-driven lip sync: plug in wlipsync or any phoneme detector.
// Without audio input, defaults to simple open/close on "speaking" state.
(function() {
  'use strict';
  __ea.visemes = {
    // Based on standard 12-viseme set, reduced to 7 for 2D mouth shapes
    map: {
      'AA': 'A', 'AE': 'A', 'AH': 'A', 'AO': 'O',
      'AW': 'O', 'AY': 'A', 'EH': 'E', 'ER': 'E',
      'EY': 'A', 'IH': 'I', 'IY': 'I', 'OW': 'O',
      'OY': 'O', 'UH': 'U', 'UW': 'U', 'W':  'U',
      'B': 'M', 'M': 'M', 'P': 'M',
      'S': 'S', 'Z': 'S', 'SH':'S', 'ZH':'S', 'CH':'S', 'JH':'S',
      'F': 'S', 'V': 'S', 'TH':'S', 'DH':'S',
      'D': 'rest','T': 'rest','G': 'rest','K': 'rest','N': 'rest',
      'NG':'rest','L': 'rest','R': 'rest','Y': 'rest','HH':'rest',
    },

    // Mouth shape parameters (used by canvas renderer)
    // open: vertical openness (0-1), width: horizontal stretch (0-1), round: lip rounding (0-1)
    shapes: {
      'A':    { open: 0.8, width: 0.4, round: 0.0 },  // "ah" — wide open
      'E':    { open: 0.5, width: 0.7, round: 0.0 },  // "eh" — medium wide
      'I':    { open: 0.4, width: 0.9, round: 0.0 },  // "ee" — stretched smile
      'O':    { open: 0.6, width: 0.2, round: 0.8 },  // "oh" — rounded open
      'U':    { open: 0.3, width: 0.15,round: 1.0 },  // "oo" — tight round
      'S':    { open: 0.15,width: 0.5, round: 0.0 },  // "ss" — teeth together
      'M':    { open: 0.0, width: 0.1, round: 0.0 },  // lips closed
      'rest': { open: 0.1, width: 0.3, round: 0.0 },  // neutral rest position
    },

    // Resolve phoneme to shape, with fallback
    resolve: function(phoneme) {
      return this.map[phoneme] || 'rest';
    },

    // Get shape parameters
    getShape: function(viseme) {
      return this.shapes[viseme] || this.shapes.rest;
    },

    // For use without audio: simple pulse on "speaking" state
    // Returns { open, width, round } for the current frame
    simplePulse: function(phase) {
      var t = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
      var base = this.shapes.rest;
      return {
        open: base.open + t * 0.6,
        width: base.width + t * 0.2,
        round: base.round,
      };
    }
  };
})();
