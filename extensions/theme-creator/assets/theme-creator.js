(() => {
  'use strict';

  // ── Theme Creator extension for Hermes WebUI ─────────────────────────────
  // A build-your-own-theme editor. Pick colors for the key design tokens, see a
  // live preview, name it, and save — the theme is registered into the NATIVE
  // Settings -> Appearance skin picker (selectable + persisted like a built-in
  // skin) via the core theme-registration capability.
  //
  // Create, edit, and delete multiple custom themes. Everything is stored
  // locally; nothing is uploaded.
  //
  // DEPENDENCY: requires the core registerHermesSkin capability
  // (nesquena/hermes-webui PR #5100). Without it the extension shows a notice and
  // does nothing destructive.
  //
  // Design note: rather than expose ~30 raw tokens, the editor offers a curated
  // set of primary colors and DERIVES the accent family + surfaces from them, so
  // a usable theme is a few clicks. The derived values are still sent through the
  // core registerHermesSkin sanitizer, so an invalid color can never be applied.

  const EXT = 'theme-creator';
  if (window.__hermesThemeCreatorLoaded) return;
  window.__hermesThemeCreatorLoaded = true;

  const STORE_KEY = 'hermes-ext-custom-themes';   // [{key,name,base:{...}}]
  const KEY_PREFIX = 'custom-';                    // skin key namespace
  const RAIL_BTN_ID = 'hwxThemeCreatorRailBtn';
  const PANEL_ID = 'hwxThemeCreatorPanel';

  // Curated, human-friendly inputs. Everything else is derived from these.
  const FIELDS = [
    { id: 'bg', label: 'Background', def: '#0d0d1a' },
    { id: 'surface', label: 'Panels / surfaces', def: '#16161f' },
    { id: 'text', label: 'Text', def: '#f5f5f5' },
    { id: 'muted', label: 'Muted text', def: '#9aa0b5' },
    { id: 'accent', label: 'Accent', def: '#f5c542' },
    { id: 'border', label: 'Borders', def: '#2a2a3a' },
    { id: 'userBubble', label: 'Your message bubble', def: '#26314a' },
  ];

  // ── helpers ────────────────────────────────────────────────────────────
  function loadThemes() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((t) => t && t.key && t.base) : [];
    } catch (_) { return []; }
  }
  function saveThemes(themes) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(themes)); } catch (_) {}
  }
  function hasCapability() { return typeof window.registerHermesSkin === 'function'; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function slugify(name) {
    return KEY_PREFIX + String(name || 'theme').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || (KEY_PREFIX + 'theme');
  }

  // colour math (hex <-> rgb, mix, contrast)
  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbStr(hex) { const c = hexToRgb(hex); return c ? c.r + ', ' + c.g + ', ' + c.b : '0, 0, 0'; }
  function clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function toHex(c) { return '#' + [c.r, c.g, c.b].map((v) => clamp(v).toString(16).padStart(2, '0')).join(''); }
  function mix(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    if (!a || !b) return hexA;
    return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  }
  function luminance(hex) {
    const c = hexToRgb(hex); if (!c) return 0;
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }
  function readableOn(hex) { return luminance(hex) > 0.5 ? '#111111' : '#ffffff'; }

  function isHex(s) { return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s || '').trim()); }

  // Derive a full token set from the curated base inputs.
  function deriveTokens(base) {
    const dark = luminance(base.bg) < 0.5;
    const surface2 = mix(base.surface, dark ? '#ffffff' : '#000000', 0.06);
    const accentText = base.accent;
    const accentContrast = readableOn(base.accent);
    return {
      '--bg': base.bg,
      '--surface': base.surface,
      '--surface2': surface2,
      '--surface-subtle': surface2,
      '--text': base.text,
      '--text2': mix(base.text, base.bg, 0.15),
      '--muted': base.muted,
      '--accent': base.accent,
      '--accent2': base.accent,
      '--accent-hover': mix(base.accent, dark ? '#ffffff' : '#000000', 0.18),
      '--accent-text': accentText,
      '--accent-contrast': accentContrast,
      '--accent-bg': 'rgba(' + rgbStr(base.accent) + ', 0.14)',
      '--accent-bg-strong': 'rgba(' + rgbStr(base.accent) + ', 0.26)',
      '--accent-rgb': rgbStr(base.accent),
      '--border': base.border,
      '--border2': mix(base.border, base.text, 0.18),
      '--hover-bg': mix(base.surface, base.text, 0.08),
      '--code-bg': mix(base.bg, dark ? '#ffffff' : '#000000', 0.04),
      '--code-text': base.text,
      '--sidebar': base.surface,
      '--sidebar-text': base.text,
      '--user-bubble': base.userBubble,
      '--assistant-bubble': base.surface,
      '--link': base.accent,
    };
  }

  function descriptorFor(theme) {
    return {
      name: theme.name,
      value: theme.key,
      colors: [theme.base.accent, theme.base.bg, theme.base.surface],
      tokens: deriveTokens(theme.base),
    };
  }

  // ── code / chat surface token coverage ───────────────────────────────────
  // The core registerHermesSkin allowlist excludes several code/chat-surface
  // tokens (--strong, --code-inline-bg, --pre-text, --input-bg) and emits no
  // dark-mode variant, so on a mismatched base theme a custom theme's inline
  // code / code blocks inherit the base-theme values and can render unreadable
  // (the same composition gap @franksong2702 flagged on the fixed skin packs).
  // We can't push these through registerHermesSkin, so we emit our own managed
  // <style> for every saved theme + the live-preview key, derived from each
  // theme's own palette, under both :root[data-skin] and :root.dark[data-skin]
  // so it composes cleanly in Light, Dark, and System Default base modes.
  const _CODE_STYLE_ID = 'hwxThemeCreatorCodeStyles';

  function codeTokensFor(base) {
    const dark = luminance(base.bg) < 0.5;
    return {
      '--strong': mix(base.text, dark ? '#ffffff' : '#000000', 0.15),
      '--code-bg': mix(base.bg, dark ? '#ffffff' : '#000000', 0.04),
      '--code-text': base.text,
      '--code-inline-bg': 'rgba(' + rgbStr(dark ? '#ffffff' : '#000000') + ', ' + (dark ? '0.08' : '0.06') + ')',
      '--pre-text': base.text,
      '--input-bg': mix(base.surface, dark ? '#ffffff' : '#000000', 0.03),
    };
  }

  function renderCodeStyles(extra) {
    let el = document.getElementById(_CODE_STYLE_ID);
    if (!el) { el = document.createElement('style'); el.id = _CODE_STYLE_ID; document.head.appendChild(el); }
    const entries = loadThemes().map((t) => ({ key: t.key, base: t.base }));
    if (extra && extra.key && extra.base) entries.push(extra);
    const blocks = [];
    for (const e of entries) {
      const toks = codeTokensFor(e.base);
      const decls = Object.keys(toks).map((k) => k + ':' + toks[k] + ' !important').join(';');
      if (decls) blocks.push(':root[data-skin="' + e.key + '"],\n:root.dark[data-skin="' + e.key + '"]{' + decls + '}');
    }
    el.textContent = blocks.join('\n');
  }

  // Register all saved themes into the native picker.
  function registerAll() {
    if (!hasCapability()) return 0;
    let n = 0;
    for (const t of loadThemes()) {
      try { if (window.registerHermesSkin(descriptorFor(t))) n++; } catch (_) {}
    }
    renderCodeStyles();
    return n;
  }

  // ── rail button ────────────────────────────────────────────────────────
  function railIcon() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="11.5" r="2.5"/>' +
      '<circle cx="16.5" cy="14.5" r="2.5"/><path d="M3 21h18"/></svg>';
  }
  function ensureRailButton() {
    if (document.getElementById(RAIL_BTN_ID)) return;
    const rail = document.querySelector('.rail');
    if (!rail) return;
    const btn = document.createElement('button');
    btn.id = RAIL_BTN_ID;
    btn.type = 'button';
    btn.className = 'rail-btn nav-tab has-tooltip hwx-tc-rail';
    btn.dataset.tooltip = 'Theme Creator';
    btn.setAttribute('aria-label', 'Theme Creator');
    btn.innerHTML = railIcon();
    btn.addEventListener('click', (ev) => { ev.preventDefault(); openPanel(); });
    const spacer = rail.querySelector('.rail-spacer');
    if (spacer) rail.insertBefore(btn, spacer); else rail.appendChild(btn);
  }

  // ── editor panel ─────────────────────────────────────────────────────────
  let editing = null;        // {key,name,base} being edited (or null for new)
  let previewKey = null;     // skin key currently used for live preview
  let prevSkinBeforePreview = null;

  function defaultBase() {
    const b = {};
    FIELDS.forEach((f) => { b[f.id] = f.def; });
    return b;
  }

  function openPanel() {
    closePanel();
    editing = null;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'hwx-tc-panel';
    panel.innerHTML =
      '<div class="hwx-tc-card" role="dialog" aria-label="Theme Creator">' +
        '<div class="hwx-tc-head"><span class="hwx-tc-title">Theme Creator</span>' +
          '<button type="button" class="hwx-tc-x" aria-label="Close">✕</button></div>' +
        (hasCapability() ? '' :
          '<div class="hwx-tc-warn">The theme-registration capability isn\u2019t available in this WebUI build ' +
          '(needs core PR #5100). You can still design a theme, but it can\u2019t be applied yet.</div>') +
        '<div class="hwx-tc-body">' +
          '<div class="hwx-tc-editor"></div>' +
          '<div class="hwx-tc-saved"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('.hwx-tc-x').addEventListener('click', () => closePanel());
    panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
    document.addEventListener('keydown', escClose, true);
    renderEditor();
    renderSaved();
  }
  function escClose(ev) { if (ev.key === 'Escape') closePanel(); }
  function closePanel() {
    cancelPreview();
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    document.removeEventListener('keydown', escClose, true);
  }

  function currentBaseFromInputs() {
    const panel = document.getElementById(PANEL_ID);
    const base = {};
    FIELDS.forEach((f) => {
      const inp = panel.querySelector('.hwx-tc-color-' + f.id);
      base[f.id] = inp && isHex(inp.value) ? inp.value : f.def;
    });
    return base;
  }

  function renderEditor() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const host = panel.querySelector('.hwx-tc-editor');
    const base = editing ? editing.base : defaultBase();
    const nameVal = editing ? editing.name : '';
    let rows = '';
    FIELDS.forEach((f) => {
      const v = base[f.id] || f.def;
      rows +=
        '<label class="hwx-tc-row"><span>' + escapeHtml(f.label) + '</span>' +
          '<span class="hwx-tc-swatchwrap">' +
            '<input type="color" class="hwx-tc-color hwx-tc-color-' + f.id + '" value="' + escapeHtml(v) + '">' +
            '<input type="text" class="hwx-tc-hex hwx-tc-hex-' + f.id + '" value="' + escapeHtml(v) + '" maxlength="7">' +
          '</span></label>';
    });
    host.innerHTML =
      '<div class="hwx-tc-section-title">' + (editing ? 'Edit theme' : 'New theme') + '</div>' +
      '<label class="hwx-tc-namerow"><span>Name</span>' +
        '<input type="text" class="hwx-tc-name" maxlength="28" placeholder="My Theme" value="' + escapeHtml(nameVal) + '"></label>' +
      rows +
      '<div class="hwx-tc-actions">' +
        '<button type="button" class="hwx-tc-btn hwx-tc-preview">Live preview</button>' +
        '<button type="button" class="hwx-tc-btn hwx-tc-stoppreview" hidden>Stop preview</button>' +
        '<span class="hwx-tc-spacer"></span>' +
        (editing ? '<button type="button" class="hwx-tc-btn hwx-tc-newbtn">New</button>' : '') +
        '<button type="button" class="hwx-tc-btn hwx-tc-save">' + (editing ? 'Update' : 'Save') + '</button>' +
      '</div>' +
      '<div class="hwx-tc-err" hidden></div>';

    // wire colour <-> hex sync + live preview update
    FIELDS.forEach((f) => {
      const color = host.querySelector('.hwx-tc-color-' + f.id);
      const hex = host.querySelector('.hwx-tc-hex-' + f.id);
      color.addEventListener('input', () => { hex.value = color.value; if (previewKey) updatePreview(); });
      hex.addEventListener('input', () => { if (isHex(hex.value)) { color.value = hex.value.length === 4 ? expand(hex.value) : hex.value; if (previewKey) updatePreview(); } });
    });
    host.querySelector('.hwx-tc-preview').addEventListener('click', startPreview);
    host.querySelector('.hwx-tc-stoppreview').addEventListener('click', cancelPreview);
    host.querySelector('.hwx-tc-save').addEventListener('click', saveCurrent);
    const nb = host.querySelector('.hwx-tc-newbtn');
    if (nb) nb.addEventListener('click', () => { editing = null; cancelPreview(); renderEditor(); });
  }

  function expand(h) { h = h.replace('#', ''); return '#' + h.split('').map((c) => c + c).join(''); }

  // ── live preview (register under a temp key + apply) ─────────────────────
  function startPreview() {
    if (!hasCapability()) return;
    const base = currentBaseFromInputs();
    previewKey = KEY_PREFIX + 'preview';
    if (prevSkinBeforePreview === null) {
      try { prevSkinBeforePreview = localStorage.getItem('hermes-skin') || 'default'; } catch (_) { prevSkinBeforePreview = 'default'; }
    }
    try {
      window.registerHermesSkin({ name: 'Preview', value: previewKey, colors: [base.accent, base.bg, base.surface], tokens: deriveTokens(base) });
      renderCodeStyles({ key: previewKey, base });
      applySkin(previewKey);
    } catch (_) {}
    togglePreviewButtons(true);
  }
  function updatePreview() {
    if (!previewKey || !hasCapability()) return;
    const base = currentBaseFromInputs();
    try { window.registerHermesSkin({ name: 'Preview', value: previewKey, colors: [base.accent, base.bg, base.surface], tokens: deriveTokens(base) }); renderCodeStyles({ key: previewKey, base }); applySkin(previewKey); } catch (_) {}
  }
  function cancelPreview() {
    if (previewKey && prevSkinBeforePreview !== null) {
      try { applySkin(prevSkinBeforePreview); } catch (_) {}
    }
    previewKey = null;
    prevSkinBeforePreview = null;
    togglePreviewButtons(false);
  }
  function togglePreviewButtons(on) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const p = panel.querySelector('.hwx-tc-preview');
    const s = panel.querySelector('.hwx-tc-stoppreview');
    if (p) p.hidden = on;
    if (s) s.hidden = !on;
  }
  function applySkin(key) {
    // Use the core picker path if present; else set the attribute directly.
    if (typeof window._pickSkin === 'function') { try { window._pickSkin(key); return; } catch (_) {} }
    document.documentElement.dataset.skin = key === 'default' ? '' : key;
    try { localStorage.setItem('hermes-skin', key); } catch (_) {}
    if (!document.documentElement.dataset.skin) delete document.documentElement.dataset.skin;
  }

  // ── save / manage ────────────────────────────────────────────────────────
  function showErr(msg) {
    const panel = document.getElementById(PANEL_ID);
    const e = panel && panel.querySelector('.hwx-tc-err');
    if (e) { e.hidden = !msg; e.textContent = msg || ''; }
  }
  function saveCurrent() {
    const panel = document.getElementById(PANEL_ID);
    const name = (panel.querySelector('.hwx-tc-name').value || '').trim();
    if (!name) { showErr('Give your theme a name.'); return; }
    const base = currentBaseFromInputs();
    for (const f of FIELDS) { if (!isHex(base[f.id])) { showErr('“' + f.label + '” is not a valid colour.'); return; } }
    let themes = loadThemes();
    const key = editing ? editing.key : slugify(name);
    const existingIdx = themes.findIndex((t) => t.key === key);
    const rec = { key, name: name.slice(0, 28), base };
    if (existingIdx >= 0) themes[existingIdx] = rec; else themes.push(rec);
    saveThemes(themes);
    // register + apply it
    if (hasCapability()) {
      try { window.registerHermesSkin(descriptorFor(rec)); } catch (_) {}
      renderCodeStyles();
      cancelPreview();
      applySkin(key);
    }
    editing = rec;
    showErr('');
    renderEditor();
    renderSaved();
  }

  function renderSaved() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const host = panel.querySelector('.hwx-tc-saved');
    const themes = loadThemes();
    if (!themes.length) { host.innerHTML = '<div class="hwx-tc-section-title">Saved themes</div><div class="hwx-tc-muted">No custom themes yet.</div>'; return; }
    let items = '';
    themes.forEach((t) => {
      const sw = (c) => '<span class="hwx-tc-mini" style="background:' + escapeHtml(c) + '"></span>';
      items +=
        '<div class="hwx-tc-saved-row" data-key="' + escapeHtml(t.key) + '">' +
          '<span class="hwx-tc-swatches">' + sw(t.base.bg) + sw(t.base.surface) + sw(t.base.accent) + '</span>' +
          '<span class="hwx-tc-saved-name">' + escapeHtml(t.name) + '</span>' +
          '<span class="hwx-tc-spacer"></span>' +
          '<button type="button" class="hwx-tc-link hwx-tc-apply">Apply</button>' +
          '<button type="button" class="hwx-tc-link hwx-tc-edit">Edit</button>' +
          '<button type="button" class="hwx-tc-link hwx-tc-del">Delete</button>' +
        '</div>';
    });
    host.innerHTML = '<div class="hwx-tc-section-title">Saved themes</div>' + items;
    host.querySelectorAll('.hwx-tc-saved-row').forEach((row) => {
      const key = row.dataset.key;
      row.querySelector('.hwx-tc-apply').addEventListener('click', () => { if (hasCapability()) { applySkin(key); } });
      row.querySelector('.hwx-tc-edit').addEventListener('click', () => {
        const t = loadThemes().find((x) => x.key === key);
        if (t) { editing = JSON.parse(JSON.stringify(t)); cancelPreview(); renderEditor(); }
      });
      row.querySelector('.hwx-tc-del').addEventListener('click', () => {
        let themes = loadThemes().filter((x) => x.key !== key);
        saveThemes(themes);
        if (editing && editing.key === key) editing = null;
        // if the deleted theme was active, revert to default
        try { if ((localStorage.getItem('hermes-skin') || '') === key) applySkin('default'); } catch (_) {}
        renderCodeStyles();
        renderEditor();
        renderSaved();
      });
    });
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.querySelector('.rail')) {
      ensureRailButton();
      registerAll();   // make saved themes available in the picker on load
      window.HermesThemeCreatorExtension = {
        version: '0.1.1',
        themes: loadThemes,
        open: openPanel,
        registerAll,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] rail not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
