(() => {
  'use strict';

  // ── Skin Pack extension for Hermes WebUI ─────────────────────────────────
  // Bundles a set of popular editor-inspired color themes (Dracula, Gruvbox,
  // One Dark, Tokyo Night, Rosé Pine, Solarized Dark) and registers each into
  // the NATIVE Settings -> Appearance skin picker via the core
  // theme-registration capability (window.registerHermesSkin). Core stays
  // curated; this is the "long tail of editor themes" the extension system is
  // for.
  //
  // DEPENDENCY: requires the core registerHermesSkin capability
  // (nesquena/hermes-webui PR #5083). On an older WebUI it no-ops gracefully.

  if (window.__hermesSkinPackLoaded) return;
  window.__hermesSkinPackLoaded = true;

  // Each theme is a dark editor palette. Tokens are plain hex / rgb-triple so
  // they pass core's value sanitizer; only allowlisted token names are used.
  const SKINS = [
    {
      name: 'Dracula', value: 'dracula',
      colors: ['#bd93f9', '#ff79c6', '#50fa7b'],
      tokens: {
        '--bg': '#282a36', '--surface': '#2b2e3b', '--surface2': '#343746',
        '--surface-subtle': '#343746', '--text': '#f8f8f2', '--text2': '#e6e6e0',
        '--muted': '#9aa0b5', '--accent': '#bd93f9', '--accent2': '#ff79c6',
        '--accent-hover': '#caa9fa', '--accent-text': '#bd93f9',
        '--accent-contrast': '#282a36', '--accent-bg': 'rgba(189,147,249,0.14)',
        '--accent-bg-strong': 'rgba(189,147,249,0.26)', '--accent-rgb': '189, 147, 249',
        '--border': '#44475a', '--border2': '#565a72', '--hover-bg': '#343746',
        '--code-bg': '#21222c', '--code-text': '#f8f8f2', '--sidebar': '#21222c',
        '--sidebar-text': '#f8f8f2', '--user-bubble': '#44475a',
        '--assistant-bubble': '#2b2e3b', '--link': '#8be9fd'
      }
    },
    {
      name: 'Gruvbox', value: 'gruvbox',
      colors: ['#fabd2f', '#fe8019', '#b8bb26'],
      tokens: {
        '--bg': '#282828', '--surface': '#32302f', '--surface2': '#3c3836',
        '--surface-subtle': '#3c3836', '--text': '#ebdbb2', '--text2': '#fbf1c7',
        '--muted': '#a89984', '--accent': '#fabd2f', '--accent2': '#fe8019',
        '--accent-hover': '#fdd55f', '--accent-text': '#fabd2f',
        '--accent-contrast': '#282828', '--accent-bg': 'rgba(250,189,47,0.14)',
        '--accent-bg-strong': 'rgba(250,189,47,0.26)', '--accent-rgb': '250, 189, 47',
        '--border': '#504945', '--border2': '#665c54', '--hover-bg': '#3c3836',
        '--code-bg': '#1d2021', '--code-text': '#ebdbb2', '--sidebar': '#1d2021',
        '--sidebar-text': '#ebdbb2', '--user-bubble': '#504945',
        '--assistant-bubble': '#32302f', '--link': '#83a598'
      }
    },
    {
      name: 'One Dark', value: 'one-dark',
      colors: ['#61afef', '#c678dd', '#98c379'],
      tokens: {
        '--bg': '#282c34', '--surface': '#2c313a', '--surface2': '#353b45',
        '--surface-subtle': '#353b45', '--text': '#abb2bf', '--text2': '#d7dae0',
        '--muted': '#7f848e', '--accent': '#61afef', '--accent2': '#c678dd',
        '--accent-hover': '#7cbef1', '--accent-text': '#61afef',
        '--accent-contrast': '#282c34', '--accent-bg': 'rgba(97,175,239,0.14)',
        '--accent-bg-strong': 'rgba(97,175,239,0.26)', '--accent-rgb': '97, 175, 239',
        '--border': '#3e4451', '--border2': '#4b5263', '--hover-bg': '#353b45',
        '--code-bg': '#21252b', '--code-text': '#abb2bf', '--sidebar': '#21252b',
        '--sidebar-text': '#abb2bf', '--user-bubble': '#3e4451',
        '--assistant-bubble': '#2c313a', '--link': '#56b6c2'
      }
    },
    {
      name: 'Tokyo Night', value: 'tokyo-night',
      colors: ['#7aa2f7', '#bb9af7', '#9ece6a'],
      tokens: {
        '--bg': '#1a1b26', '--surface': '#1f2335', '--surface2': '#24283b',
        '--surface-subtle': '#24283b', '--text': '#c0caf5', '--text2': '#d5d9f0',
        '--muted': '#9099bb', '--accent': '#7aa2f7', '--accent2': '#bb9af7',
        '--accent-hover': '#94b4f9', '--accent-text': '#7aa2f7',
        '--accent-contrast': '#1a1b26', '--accent-bg': 'rgba(122,162,247,0.14)',
        '--accent-bg-strong': 'rgba(122,162,247,0.26)', '--accent-rgb': '122, 162, 247',
        '--border': '#2f334d', '--border2': '#3b3f5c', '--hover-bg': '#24283b',
        '--code-bg': '#16161e', '--code-text': '#c0caf5', '--sidebar': '#16161e',
        '--sidebar-text': '#c0caf5', '--user-bubble': '#2f334d',
        '--assistant-bubble': '#1f2335', '--link': '#7dcfff'
      }
    },
    {
      name: 'Rosé Pine', value: 'rose-pine',
      colors: ['#ebbcba', '#c4a7e7', '#9ccfd8'],
      tokens: {
        '--bg': '#191724', '--surface': '#1f1d2e', '--surface2': '#26233a',
        '--surface-subtle': '#26233a', '--text': '#e0def4', '--text2': '#eae8ff',
        '--muted': '#a6a0c6', '--accent': '#ebbcba', '--accent2': '#c4a7e7',
        '--accent-hover': '#f0cccb', '--accent-text': '#ebbcba',
        '--accent-contrast': '#191724', '--accent-bg': 'rgba(235,188,186,0.14)',
        '--accent-bg-strong': 'rgba(235,188,186,0.26)', '--accent-rgb': '235, 188, 186',
        '--border': '#403d52', '--border2': '#524f6b', '--hover-bg': '#26233a',
        '--code-bg': '#15131f', '--code-text': '#e0def4', '--sidebar': '#15131f',
        '--sidebar-text': '#e0def4', '--user-bubble': '#403d52',
        '--assistant-bubble': '#1f1d2e', '--link': '#9ccfd8'
      }
    },
    {
      name: 'Solarized Dark', value: 'solarized-dark',
      colors: ['#268bd2', '#2aa198', '#859900'],
      tokens: {
        '--bg': '#002b36', '--surface': '#073642', '--surface2': '#0a4250',
        '--surface-subtle': '#0a4250', '--text': '#93a1a1', '--text2': '#eee8d5',
        '--muted': '#657b83', '--accent': '#268bd2', '--accent2': '#2aa198',
        '--accent-hover': '#3fa0e4', '--accent-text': '#2aa198',
        '--accent-contrast': '#002b36', '--accent-bg': 'rgba(38,139,210,0.14)',
        '--accent-bg-strong': 'rgba(38,139,210,0.26)', '--accent-rgb': '38, 139, 210',
        '--border': '#0a4250', '--border2': '#0f5566', '--hover-bg': '#073642',
        '--code-bg': '#001f27', '--code-text': '#93a1a1', '--sidebar': '#001f27',
        '--sidebar-text': '#93a1a1', '--user-bubble': '#0a4250',
        '--assistant-bubble': '#073642', '--link': '#b58900'
      }
    }
  ];

  function register(attempt) {
    attempt = attempt || 0;
    if (typeof window.registerHermesSkin === 'function') {
      let ok = 0;
      for (const skin of SKINS) {
        if (window.registerHermesSkin(skin)) ok++;
        else console.warn('[skin-pack] rejected: ' + skin.value);
      }
      console.log('[skin-pack] registered ' + ok + '/' + SKINS.length + ' themes');
      return true;
    }
    if (attempt < 40) {
      setTimeout(() => register(attempt + 1), 150);
      return false;
    }
    console.warn('[skin-pack] window.registerHermesSkin unavailable; themes not registered (needs core theme-registration capability)');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => register(), { once: true });
  } else {
    register();
  }
})();
