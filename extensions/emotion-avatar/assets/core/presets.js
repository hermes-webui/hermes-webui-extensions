// Shared globals (set by emotion-avatar.js bootstrap)
window.__ea = window.__ea || {};
window.__ea.PRESETS = window.__ea.PRESETS || (function() {
  'use strict';

  const PRESETS = {};
  const PRESET_NAMES = ['pixel', 'neko', 'yuki', 'robot', 'monster'];

  PRESETS.pixel = {
    name: 'Pixel',
    colors: { skin:'#FFDDC4', hair:'#5C3D2E', iris:'#6B4F3A', mouth:'#E07070', cheek:'rgba(255,150,120,0.3)' },
    colorLabels: { skin:'Skin', hair:'Hair', iris:'Iris', mouth:'Mouth' },
    paths: {
      head: 'M96,36 C136,36 160,66 160,100 C160,134 136,160 96,160 C56,160 32,134 32,100 C32,66 56,36 96,36 Z',
      hair: 'M96,36 C130,36 152,54 156,78 C150,66 130,52 96,48 C62,52 42,66 36,78 C40,54 62,36 96,36 Z M40,78 C38,90 38,100 40,106 C38,86 42,72 48,64 Q44,70 40,78 Z M152,78 C154,90 154,100 152,106 C154,86 150,72 144,64 Q148,70 152,78 Z M52,58 Q64,44 96,42 Q128,44 140,58 Q120,48 96,46 Q72,48 52,58 Z',
      bangs: 'M56,60 Q76,46 96,44 Q116,46 136,60 Q140,68 136,74 Q116,62 96,60 Q76,62 56,74 Q52,68 56,60 Z',
      eyeWhiteL: 'M66,84 A14,16 0 1,0 94,84 A14,16 0 1,0 66,84 Z',
      eyeWhiteR: 'M98,84 A14,16 0 1,0 126,84 A14,16 0 1,0 98,84 Z',
      irisL: 'M72,86 A8,9 0 1,0 88,86 A8,9 0 1,0 72,86 Z',
      irisR: 'M104,86 A8,9 0 1,0 120,86 A8,9 0 1,0 104,86 Z',
      pupilL: 'M78,86 A4,4 0 1,0 86,86 A4,4 0 1,0 78,86 Z',
      pupilR: 'M110,86 A4,4 0 1,0 118,86 A4,4 0 1,0 110,86 Z',
      highlightL: 'M74,80 A2.5,2.5 0 1,0 79,80 A2.5,2.5 0 1,0 74,80 Z',
      highlightR: 'M106,80 A2.5,2.5 0 1,0 111,80 A2.5,2.5 0 1,0 106,80 Z',
    },
    mouthPaths: makeMouthPaths()
  };

  PRESETS.neko = {
    name: 'Neko',
    colors: { fur:'#F5DEB3', ears:'#E8C8A0', earInner:'#F0A0A0', iris:'#6B8E23', nose:'#F08A8A', mouth:'#D06060', whisker:'#AAAAAA' },
    colorLabels: { fur:'Fur', ears:'Ears', iris:'Iris', nose:'Nose', mouth:'Mouth' },
    paths: {
      head: 'M96,34 C138,34 162,66 162,102 C162,138 138,162 96,162 C54,162 30,138 30,102 C30,66 54,34 96,34 Z',
      earL: 'M40,70 L22,24 L68,52 Z', earR: 'M152,70 L170,24 L124,52 Z',
      earInnerL: 'M44,64 L32,32 L64,54 Z', earInnerR: 'M148,64 L160,32 L128,54 Z',
      eyeWhiteL: 'M64,84 A13,15 0 1,0 90,84 A13,15 0 1,0 64,84 Z',
      eyeWhiteR: 'M102,84 A13,15 0 1,0 128,84 A13,15 0 1,0 102,84 Z',
      irisL: 'M70,86 A7,8 0 1,0 84,86 A7,8 0 1,0 70,86 Z',
      irisR: 'M108,86 A7,8 0 1,0 122,86 A7,8 0 1,0 108,86 Z',
      pupilL: 'M75,86 A3,3 0 1,0 81,86 A3,3 0 1,0 75,86 Z',
      pupilR: 'M113,86 A3,3 0 1,0 119,86 A3,3 0 1,0 113,86 Z',
      highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
      highlightR: 'M110,80 A2,2 0 1,0 114,80 A2,2 0 1,0 110,80 Z',
      nose: 'M93,100 L96,104 L99,100 Z',
      whiskerL1: 'M58,98 L34,94', whiskerL2: 'M58,102 L34,102', whiskerL3: 'M58,106 L34,110',
      whiskerR1: 'M134,98 L158,94', whiskerR2: 'M134,102 L158,102', whiskerR3: 'M134,106 L158,110',
    },
    mouthPaths: makeMouthPaths()
  };

  PRESETS.yuki = {
    name: 'Yuki',
    colors: { body:'#F0F4FF', iris:'#4A6FA5', mouth:'#7799CC', accent:'#B0C4E8', blush:'rgba(176,196,232,0.35)' },
    colorLabels: { body:'Body', iris:'Iris', mouth:'Mouth', accent:'Accent' },
    paths: {
      body: 'M96,30 C140,30 160,66 160,104 C160,140 140,170 96,170 C52,170 32,140 32,104 C32,66 52,30 96,30 Z',
      tail: 'M60,148 Q30,172 50,190 Q70,200 90,180 Q110,200 130,190 Q150,172 120,148',
      eyeWhiteL: 'M68,84 A11,13 0 1,0 90,84 A11,13 0 1,0 68,84 Z',
      eyeWhiteR: 'M102,84 A11,13 0 1,0 124,84 A11,13 0 1,0 102,84 Z',
      irisL: 'M74,86 A6,7 0 1,0 86,86 A6,7 0 1,0 74,86 Z',
      irisR: 'M108,86 A6,7 0 1,0 120,86 A6,7 0 1,0 108,86 Z',
      pupilL: 'M78,86 A2.5,2.5 0 1,0 83,86 A2.5,2.5 0 1,0 78,86 Z',
      pupilR: 'M112,86 A2.5,2.5 0 1,0 117,86 A2.5,2.5 0 1,0 112,86 Z',
      highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
      highlightR: 'M106,80 A2,2 0 1,0 110,80 A2,2 0 1,0 106,80 Z',
      blushL: 'M56,100 A8,5 0 1,0 72,100 A8,5 0 1,0 56,100 Z',
      blushR: 'M120,100 A8,5 0 1,0 136,100 A8,5 0 1,0 120,100 Z',
    },
    mouthPaths: makeMouthPaths()
  };

  PRESETS.robot = {
    name: 'Robot',
    colors: { body:'#A0A8B8', face:'#C8D0D8', iris:'#00DDFF', accent:'#FF8800', mouth:'#666', antenna:'#CCC' },
    colorLabels: { body:'Body', face:'Face', iris:'Eyes', accent:'Accent', mouth:'Mouth' },
    paths: {
      head: 'M36,46 L156,46 L156,144 L36,144 Z', face: 'M50,60 L142,60 L142,130 L50,130 Z',
      antenna: 'M96,46 L96,26', antennaBall: 'M96,22 A5,5 0 1,0 96,23',
      earBoltL: 'M34,100 A5,5 0 1,0 34,101', earBoltR: 'M158,100 A5,5 0 1,0 158,101',
      eyeWhiteL: 'M64,84 A12,10 0 1,0 88,84 A12,10 0 1,0 64,84 Z',
      eyeWhiteR: 'M104,84 A12,10 0 1,0 128,84 A12,10 0 1,0 104,84 Z',
      irisL: 'M70,86 A8,7 0 1,0 86,86 A8,7 0 1,0 70,86 Z',
      irisR: 'M110,86 A8,7 0 1,0 126,86 A8,7 0 1,0 110,86 Z',
      pupilL: 'M76,86 A3,3 0 1,0 82,86 A3,3 0 1,0 76,86 Z',
      pupilR: 'M116,86 A3,3 0 1,0 122,86 A3,3 0 1,0 116,86 Z',
      highlightL: 'M72,80 A2,2 0 1,0 76,80 A2,2 0 1,0 72,80 Z',
      highlightR: 'M112,80 A2,2 0 1,0 116,80 A2,2 0 1,0 112,80 Z',
    },
    mouthPaths: makeMouthPaths()
  };

  PRESETS.monster = {
    name: 'Monster',
    colors: { skin:'#6B8E4E', horn:'#4A3520', iris:'#FF4400', mouth:'#330000', tooth:'#FFFFF0', accent:'#8B4513' },
    colorLabels: { skin:'Skin', horn:'Horns', iris:'Eyes', mouth:'Mouth', accent:'Accent' },
    paths: {
      head: 'M96,32 C144,32 164,66 164,104 C164,142 144,166 96,166 C48,166 28,142 28,104 C28,66 48,32 96,32 Z',
      hornL: 'M50,60 Q38,18 70,28 Q64,42 58,56 Z', hornR: 'M142,60 Q154,18 122,28 Q128,42 134,56 Z',
      brow: 'M40,90 Q96,72 152,90 Q152,78 96,64 Q40,78 40,90 Z', jaw: 'M44,108 Q96,152 148,108',
      eyeWhiteL: 'M68,86 A10,8 0 1,0 88,86 A10,8 0 1,0 68,86 Z',
      eyeWhiteR: 'M104,86 A10,8 0 1,0 124,86 A10,8 0 1,0 104,86 Z',
      irisL: 'M74,86 A5,5 0 1,0 84,86 A5,5 0 1,0 74,86 Z',
      irisR: 'M110,86 A5,5 0 1,0 120,86 A5,5 0 1,0 110,86 Z',
      pupilL: 'M78,86 A2.5,2.5 0 1,0 83,86 A2.5,2.5 0 1,0 78,86 Z',
      pupilR: 'M114,86 A2.5,2.5 0 1,0 119,86 A2.5,2.5 0 1,0 114,86 Z',
      highlightL: 'M72,82 A1.5,1.5 0 1,0 75,82 A1.5,1.5 0 1,0 72,82 Z',
      highlightR: 'M108,82 A1.5,1.5 0 1,0 111,82 A1.5,1.5 0 1,0 108,82 Z',
    },
    mouthPaths: makeMouthPaths()
  };

  function makeMouthPaths() {
    return {
      idle: 'M86,120 Q96,124 106,120',
      happy: 'M82,118 Q96,130 110,118',
      speaking: 'M86,118 Q96,126 106,118',
      thinking: 'M90,118 Q96,114 102,118',
      surprised: 'M92,116 A6,6 0 1,0 100,116 Z',
    };
  }

  return { list: PRESET_NAMES, definitions: PRESETS };
})();
