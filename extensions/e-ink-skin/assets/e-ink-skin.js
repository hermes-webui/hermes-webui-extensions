(() => {
  'use strict';

  // ── E-Ink Skin extension for Hermes WebUI ────────────────────────────────
  // Registers a maximum-contrast, near-monochrome light skin tuned for e-ink
  // displays (Kindle / Boox / reMarkable): pure-white background, near-black
  // text, hard borders, no gray-on-gray, flattened shadows. It uses the core
  // theme-registration capability (window.registerHermesSkin) so the skin shows
  // up in the NATIVE Settings -> Appearance picker, selectable + persisted like
  // any built-in skin.
  //
  // DEPENDENCY: requires the core `registerHermesSkin` capability
  // (nesquena/hermes-webui PR #5100). On an older WebUI without it, this
  // extension simply no-ops (the skin is unavailable) rather than erroring.

  if (window.__hermesEInkSkinLoaded) return;
  window.__hermesEInkSkinLoaded = true;

  // High-contrast, near-monochrome token set. Only design tokens on the core
  // allowlist are used; values are plain hex so they pass core sanitization.
  const E_INK_SKIN = {
    name: 'E-Ink',
    value: 'e-ink',
    label: 'E-Ink',
    colors: ['#000000', '#ffffff', '#000000'],
    tokens: {
      '--bg': '#ffffff',
      '--surface': '#ffffff',
      '--surface2': '#f4f4f4',
      '--surface-subtle': '#f4f4f4',
      '--text': '#000000',
      '--text2': '#1a1a1a',
      '--muted': '#3a3a3a',
      '--accent': '#000000',
      '--accent2': '#000000',
      '--accent-hover': '#000000',
      '--accent-text': '#000000',
      '--accent-contrast': '#ffffff',
      '--accent-bg': '#eaeaea',
      '--accent-bg-strong': '#cccccc',
      '--accent-rgb': '0, 0, 0',
      '--border': '#000000',
      '--border2': '#555555',
      '--hover-bg': '#eaeaea',
      '--code-bg': '#f4f4f4',
      '--code-text': '#000000',
      '--sidebar': '#ffffff',
      '--sidebar-text': '#000000',
      '--user-bubble': '#eaeaea',
      '--assistant-bubble': '#ffffff',
      '--link': '#000000'
    }
  };

  function register(attempt) {
    attempt = attempt || 0;
    if (typeof window.registerHermesSkin === 'function') {
      const ok = window.registerHermesSkin(E_INK_SKIN);
      if (!ok) {
        console.warn('[e-ink-skin] registerHermesSkin rejected the descriptor');
      }
      return true;
    }
    // Core capability not present yet (older WebUI, or boot.js not parsed).
    // Retry briefly, then give up quietly.
    if (attempt < 40) {
      setTimeout(() => register(attempt + 1), 150);
      return false;
    }
    console.warn('[e-ink-skin] window.registerHermesSkin unavailable; skin not registered (needs core theme-registration capability)');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => register(), { once: true });
  } else {
    register();
  }
})();
