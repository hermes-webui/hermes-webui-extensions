(() => {
  'use strict';

  // ── Theme Toggle extension for Hermes WebUI (v2.2.0: clobber-safe persistence) ─
  // Injects a sun/moon theme toggle button directly under the Settings cog —
  // in the desktop icon rail and in the mobile sidebar nav. Clicking it flips
  // between light and dark: it applies the core's own theme helpers and
  // persists the choice with a theme-only POST to /api/settings.
  //
  // Persistence design (important — read before changing this):
  //   v2.1.0 called window._pickTheme(). That applies the theme, but it ends
  //   with the core's appearance autosave, which POSTs the FULL appearance
  //   payload built from the settings-pane DOM. Those checkbox controls are
  //   only hydrated from the server when the Settings tab is opened — in any
  //   tab where it has never been opened they hold template defaults, so the
  //   autosave silently overwrote the user's real saved appearance settings
  //   on every theme toggle (the "settings keep reverting" bug).
  //   This version never calls _pickTheme(). It replicates the safe parts of
  //   it (the core's _normalizeAppearance / _applyTheme / _syncThemePicker
  //   helpers) and persists with the same partial-merge pattern the WebUI's
  //   own boot path uses: a POST to /api/settings carrying only {theme}. The
  //   server merges only the keys present in the payload, so a theme click
  //   can never touch any other setting. The Settings pane's own autosave
  //   remains the writer for every non-theme appearance key.
  //   This code itself does no storage reads/writes, no fetch/XHR, and
  //   contains no URL literals.

  if (window.__hermesThemeToggleLoaded) return;
  window.__hermesThemeToggleLoaded = true;

  // ── SVG icons (20×20 to match rail button icons) ─────────────────────────
  const SUN_SVG = `<svg class="icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/>
    <line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>`;

  const MOON_SVG = `<svg class="icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;

  // ── Current effective theme ──────────────────────────────────────────────
  // The WebUI toggles the .dark class on <html>; this reflects the resolved
  // theme, including when the user picked "system".
  function isDarkMode() {
    return document.documentElement.classList.contains('dark');
  }

  // ── Theme-only persistence (partial merge — the core boot-path pattern) ─
  async function persistTheme(theme) {
    if (typeof window.api !== 'function') {
      // A core without the api() helper is older than this entry expects;
      // the visual flip still works for this page's lifetime and the
      // core's own boot write persists the choice on the next load.
      console.warn('theme-toggle: core api() unavailable; theme applied but not persisted this session');
      return;
    }
    try {
      // Same partial-merge POST the WebUI's boot path makes: only the keys
      // present in the body are merged into the saved settings, so this
      // call can never modify any other appearance key.
      await window.api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ theme: theme }),
      });
    } catch (e) {
      // Non-fatal: the theme is applied visually for this page's lifetime.
    }
  }

  // ── Toggle theme ─────────────────────────────────────────────────────────
  function toggleTheme() {
    // Brief global transition for a smooth color swap.
    document.documentElement.classList.add('theme-toggle-transitioning');
    setTimeout(() => {
      document.documentElement.classList.remove('theme-toggle-transitioning');
    }, 350);

    const next = isDarkMode() ? 'light' : 'dark';

    // Deliberately NOT _pickTheme(): its trailing full-pane autosave can
    // clobber other saved appearance settings (see the header note).
    if (typeof window._applyTheme !== 'function') {
      // No theme system in this core: stay inert rather than duplicating
      // core theme behavior — this entry requires the API.
      console.warn('theme-toggle: core theme helpers unavailable; button is inert');
      return;
    }

    let theme = next;
    try {
      // Normalize through the core validator (valid theme set, legacy-name
      // mapping). The skin reference is read-only, used for validation only;
      // this extension never writes a skin.
      if (typeof window._normalizeAppearance === 'function') {
        const sSel = document.getElementById('settingsSkin');
        const skinRef = (sSel && sSel.value) || 'default';
        theme = window._normalizeAppearance(next, skinRef).theme;
      }
    } catch (e) { /* fall through with `next` */ }

    try {
      window._applyTheme(theme);
      if (typeof window._syncThemePicker === 'function') {
        window._syncThemePicker(theme);
      }
      // Keep the pane's hidden input in sync when it exists in the DOM, so
      // any later pane-originated save (Settings tab opened in this tab)
      // reads the current value instead of a stale one.
      const tSel = document.getElementById('settingsTheme');
      if (tSel) tSel.value = theme;
    } catch (e) {
      console.warn('theme-toggle: core theme application failed', e);
    }

    persistTheme(theme);
  }

  // ── Button factory ───────────────────────────────────────────────────────
  function buildButton(id) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.innerHTML = SUN_SVG + MOON_SVG;
    btn.addEventListener('click', toggleTheme);
    return btn;
  }

  function syncMeta(btn) {
    const to = isDarkMode() ? 'light' : 'dark';
    btn.title = 'Switch to ' + to + ' mode';
    btn.setAttribute('aria-label', 'Switch to ' + to + ' theme');
  }

  // ── Injection ────────────────────────────────────────────────────────────
  // Desktop: the icon rail (.rail) is a vertical flex column; the Settings
  // button sits last (below the spacer). Insert the toggle right after it —
  // the bottom of the rail, under the settings cog.
  // Mobile: .sidebar > .sidebar-nav mirrors the same set of buttons; insert
  // after the mobile settings button.
  // The buttons carry no data-panel, so the WebUI's tab order / tab
  // visibility logic (which only touches .nav-tab[data-panel]) leaves them
  // alone.
  function inject() {
    const rail = document.querySelector('.rail');
    const railSettings = rail && rail.querySelector('.rail-btn[data-panel="settings"]');
    if (railSettings && !document.getElementById('hermes-rtt-rail')) {
      const btn = buildButton('hermes-rtt-rail');
      btn.className = 'rail-btn has-tooltip hermes-rtt';
      btn.setAttribute('data-tooltip', 'Theme');
      syncMeta(btn);
      railSettings.insertAdjacentElement('afterend', btn);
    }

    const nav = document.querySelector('.sidebar > .sidebar-nav');
    const navSettings = nav && nav.querySelector('.nav-tab[data-panel="settings"]');
    if (navSettings && !document.getElementById('hermes-rtt-mobile')) {
      const btn = buildButton('hermes-rtt-mobile');
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom hermes-rtt';
      btn.setAttribute('data-tooltip', 'Theme');
      btn.setAttribute('data-label', 'Theme');
      syncMeta(btn);
      navSettings.insertAdjacentElement('afterend', btn);
    }
  }

  // ── Keep tooltips/aria in sync when the theme changes from any source ────
  function observeThemeChanges() {
    let lastDark = isDarkMode();
    const observer = new MutationObserver(() => {
      const nowDark = isDarkMode();
      if (nowDark !== lastDark) {
        lastDark = nowDark;
        document.querySelectorAll('.hermes-rtt').forEach(syncMeta);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  // ── Init (retry briefly if the rail/sidebar aren't in the DOM yet) ──────
  function init(attempt) {
    attempt = attempt || 0;
    inject();
    if (!document.getElementById('hermes-rtt-rail') && attempt < 20) {
      setTimeout(() => init(attempt + 1), 150);
      return;
    }
    observeThemeChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
  } else {
    init();
  }
})();
