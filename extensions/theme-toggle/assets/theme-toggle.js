(() => {
  'use strict';

  // ── Theme Toggle extension for Hermes WebUI (v2.3.0) ──────────────────────
  // Injects a sun/moon theme toggle button in the desktop icon rail, directly
  // ABOVE the Settings cog (the cog is the rail's fixed bottom anchor), with
  // the mobile sidebar copy created by core's own _syncNavActionMirrors()
  // instead of a hand-built twin.
  //
  // Persistence design (mirrors the WebUI's own /theme command):
  //   v2.1.0 called window._pickTheme(). That applies the theme, but it ends
  //   with the core's appearance autosave, which POSTs the FULL appearance
  //   payload built from the settings-pane DOM. Those checkbox controls are
  //   only hydrated from the server when the Settings tab is opened — in any
  //   tab where it has never been opened they hold template defaults, so the
  //   autosave silently overwrote the user's real saved appearance settings
  //   on every theme toggle (the "settings keep reverting" bug).
  //   v2.2.0 dropped _pickTheme() but persisted only via a {theme} POST.
  //   Core's boot code prefers an explicit localStorage theme over the
  //   server's, and boot writes that key on every load — so the stale key
  //   won after a reload and the choice visibly reverted.
  //   This version mirrors the /theme command exactly: write BOTH shared
  //   storage keys (hermes-theme, hermes-skin), apply theme + skin, then a
  //   partial-merge POST of {theme, skin} — the server merges only the keys
  //   present, so a click can never touch any other setting, and the
  //   full-pane autosave is never involved.
  //
  // Skin lock: while a scheme-forcing skin is active (registerHermesSkin
  // with {scheme:'light'|'dark'}), the base theme is ignored, so the button
  // is disabled with a tooltip naming the skin instead of appearing to do
  // nothing. The observer watches data-skin as well as the class attribute.
  //
  // This code performs no fetch/XHR of its own and contains no URL literals;
  // the one POST goes through the core's api() helper with redirect401:false
  // so a 401 can never bounce the user to the login page.

  if (window.__hermesThemeToggleLoaded) return;
  window.__hermesThemeToggleLoaded = true;

  // ── SVG icons (stroke-width 1.5, matching every core rail icon) ─────────
  const SUN_SVG = `<svg class="icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

  const MOON_SVG = `<svg class="icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;

  // ── Current effective theme ──────────────────────────────────────────────
  // The WebUI toggles the .dark class on <html>; this reflects the resolved
  // theme, including when the user picked "system".
  function isDarkMode() {
    return document.documentElement.classList.contains('dark');
  }

  // ── Scheme-forcing skin lock ─────────────────────────────────────────────
  // registerHermesSkin({scheme}) skins force their scheme and make the base
  // theme invisible; the toggle is inert while one is active.
  function forcedSkin() {
    if (typeof window._activeSkinScheme !== 'function') return null;
    let scheme = '';
    try { scheme = window._activeSkinScheme(); } catch (e) { return null; }
    if (scheme !== 'light' && scheme !== 'dark') return null;
    let name = 'active';
    try { name = localStorage.getItem('hermes-skin') || 'active'; } catch (e) {}
    return { scheme: scheme, name: name };
  }

  // ── Toggle: the /theme command idiom (clobber-safe, reload-safe) ────────
  function toggleTheme() {
    if (forcedSkin()) return; // locked: the base theme is not in effect
    const next = isDarkMode() ? 'light' : 'dark';

    if (typeof window._applyTheme !== 'function' ||
        typeof window._normalizeAppearance !== 'function') {
      // No theme system in this core: stay inert rather than duplicating
      // core theme behavior — this entry requires the API.
      console.warn('theme-toggle: core theme helpers unavailable; button is inert');
      return;
    }

    let appearance;
    try {
      appearance = window._normalizeAppearance(next, localStorage.getItem('hermes-skin'));
    } catch (e) {
      appearance = { theme: next, skin: 'default' };
    }

    try {
      // Same order as the /theme command: persist first, then apply.
      localStorage.setItem('hermes-theme', appearance.theme);
      localStorage.setItem('hermes-skin', appearance.skin);
      window._applyTheme(appearance.theme);
      if (typeof window._applySkin === 'function') window._applySkin(appearance.skin);
    } catch (e) {
      console.warn('theme-toggle: core theme application failed', e);
      return;
    }

    // Partial-merge POST — the same body the /theme command sends. The
    // server merges only the keys present, so no other setting is touched.
    // redirect401:false keeps a 401 from bouncing the user to the login page.
    if (typeof window.api === 'function') {
      try {
        window.api('/api/settings', {
          method: 'POST',
          redirect401: false,
          body: JSON.stringify({ theme: appearance.theme, skin: appearance.skin })
        }).catch(() => {});
      } catch (e) {
        // Non-fatal: the theme is applied and persisted locally already.
      }
    } else {
      console.warn('theme-toggle: core api() unavailable; theme applied but not synced to the server this session');
    }

    // Keep the Settings pane controls consistent with what we just did.
    try {
      const tSel = document.getElementById('settingsTheme');
      if (tSel) tSel.value = appearance.theme;
      const sSel = document.getElementById('settingsSkin');
      if (sSel) sSel.value = appearance.skin;
      if (typeof window._syncThemePicker === 'function') window._syncThemePicker(appearance.theme);
      if (typeof window._syncSkinPicker === 'function') window._syncSkinPicker(appearance.skin);
    } catch (e) {}
  }

  // ── Labels (core idiom: one wording, data-tooltip + aria-label, no title) ─
  function syncButton(btn) {
    const forced = forcedSkin();
    if (forced) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      const locked = 'Theme locked by the "' + forced.name + '" skin';
      btn.setAttribute('data-tooltip', locked);
      btn.setAttribute('aria-label', locked);
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-disabled');
      const label = 'Switch to ' + (isDarkMode() ? 'light' : 'dark') + ' theme';
      btn.setAttribute('data-tooltip', label);
      btn.setAttribute('aria-label', label);
    }
    // Core always pairs data-tooltip with removal of the native title:
    // a native title next to the custom tooltip would show two tooltips.
    btn.removeAttribute('title');
  }

  function syncAll() {
    document.querySelectorAll('.hermes-rtt').forEach(syncButton);
    // Refresh core's mobile mirrors so the sidebar copy matches the rail
    // source (labels change with the theme; the lock can engage at any time).
    if (typeof window._syncNavActionMirrors === 'function') {
      try { window._syncNavActionMirrors(); } catch (e) {}
    }
  }

  // ── Injection (core rail idiom: before the Settings cog) ────────────────
  // Settings is the rail's fixed bottom anchor and the last item in core's
  // tab order, so the toggle belongs immediately above it. The button is a
  // mirror-eligible rail action: .nav-tab with an id and no data-panel means
  // core's _syncNavActionMirrors() clones it into the mobile sidebar nav and
  // keeps click-forwarding and visibility in sync — no hand-built twin.
  function inject() {
    const rail = document.querySelector('.rail');
    const railSettings = rail && rail.querySelector('.rail-btn[data-panel="settings"]');
    if (!railSettings || document.getElementById('hermes-rtt-rail')) return;
    const btn = document.createElement('button');
    btn.id = 'hermes-rtt-rail';
    btn.type = 'button';
    btn.className = 'rail-btn nav-tab has-tooltip hermes-rtt';
    btn.innerHTML = SUN_SVG + MOON_SVG;
    btn.addEventListener('click', toggleTheme);
    railSettings.parentNode.insertBefore(btn, railSettings);
  }

  // ── Keep labels and the skin lock in sync with any theme/skin source ─────
  function observeThemeChanges() {
    let lastDark = isDarkMode();
    let lastForced = !!forcedSkin();
    const observer = new MutationObserver(() => {
      const nowDark = isDarkMode();
      const nowForced = !!forcedSkin();
      if (nowDark !== lastDark || nowForced !== lastForced) {
        lastDark = nowDark;
        lastForced = nowForced;
        syncAll();
      }
    });
    // data-skin lives on <html> alongside the class: engaging or releasing a
    // scheme-forcing skin must re-evaluate the lock, even if the resolved
    // theme does not change in the same tick.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-skin']
    });
  }

  // ── Init (retry briefly while the shell renders) ─────────────────────────
  function ready() {
    const railBtn = document.getElementById('hermes-rtt-rail');
    if (!railBtn) return false;
    if (typeof window._syncNavActionMirrors !== 'function') return true; // pre-mirror core
    if (!document.querySelector('.sidebar-nav')) return true;           // no mobile nav yet
    return !!document.querySelector('[data-nav-action-mirror="hermes-rtt-rail"]');
  }

  function init(attempt) {
    attempt = attempt || 0;
    inject();
    if (ready()) {
      syncAll();
      observeThemeChanges();
      return;
    }
    if (attempt < 20) setTimeout(() => init(attempt + 1), 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
  } else {
    init();
  }
})();