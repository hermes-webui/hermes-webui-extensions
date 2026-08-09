;(() => {
  'use strict';

  if (window.__hermesTypographyLoaded) return;
  window.__hermesTypographyLoaded = true;

  const VERSION = '0.1.0';
  const RAIL_BUTTON_ID = 'hwx-type-rail-button';
  const PANEL_ID = 'hwx-type-panel';
  const GOOGLE_STYLE_ID = 'hwx-type-google-fonts';
  const DISCLOSURE = 'Google-hosted choices load selected families from Google and expose your browser IP to Google. WebUI default choices use core-provided system font stacks; this extension makes no external font request for them. Local fonts stay in this browser and are never sent to a server.';
  const STORAGE_KEY = 'selection';
  const FALLBACK_STORAGE_KEY = 'hermes-ext-typography-selection';
  const FONT_DB_NAME = 'hermes-ext-typography-fonts';
  const FONT_STORE_NAME = 'hermes-ext-typography-font-records';
  const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2';
  const MAX_FONT_BYTES = 10 * 1024 * 1024;
  const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf';
  const ROLES = ['interface', 'conversation', 'code'];
  const ROLE_LABELS = Object.freeze({ interface: 'Interface', conversation: 'Conversations', code: 'Code' });
  const DEFAULTS = Object.freeze({ interface: 'default', conversation: 'same-ui', code: 'default' });
  const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  const PRESETS = Object.freeze([
    Object.freeze({ id: 'webui-default', label: 'WebUI Default', interface: 'default', conversation: 'same-ui', code: 'default' }),
    Object.freeze({ id: 'nous', label: 'Nous', interface: 'courier-prime', conversation: 'same-ui', code: 'courier-prime' }),
    Object.freeze({ id: 'modern', label: 'Modern', interface: 'geist', conversation: 'same-ui', code: 'geist-mono' }),
    Object.freeze({ id: 'accessible', label: 'Accessible', interface: 'atkinson-hyperlegible-next', conversation: 'same-ui', code: 'atkinson-hyperlegible-mono' }),
    Object.freeze({ id: 'comfortable-reading', label: 'Comfortable Reading', interface: 'lexend-deca', conversation: 'literata', code: 'source-code-pro' }),
    Object.freeze({ id: 'noto', label: 'Noto', interface: 'noto-sans', conversation: 'noto-serif', code: 'noto-sans-mono' }),
    Object.freeze({ id: 'ibm-plex', label: 'IBM Plex', interface: 'ibm-plex-sans', conversation: 'ibm-plex-serif', code: 'ibm-plex-mono' }),
    Object.freeze({ id: 'developer', label: 'Developer', interface: 'inter', conversation: 'same-ui', code: 'jetbrains-mono' }),
    Object.freeze({ id: 'dense', label: 'Dense', interface: 'public-sans', conversation: 'same-ui', code: 'inconsolata' }),
    Object.freeze({ id: 'warm', label: 'Warm', interface: 'nunito-sans', conversation: 'lora', code: 'fira-code' }),
    Object.freeze({ id: 'cyberdeck', label: 'Cyberdeck', interface: 'oxanium', conversation: 'geist', code: 'space-mono' }),
  ]);

  const MIME_TYPES = Object.freeze({
    woff2: new Set(['font/woff2', 'application/font-woff2']),
    woff: new Set(['font/woff', 'application/font-woff']),
    ttf: new Set(['font/ttf', 'font/truetype', 'application/x-font-ttf', 'application/font-sfnt']),
    otf: new Set(['font/otf', 'font/opentype', 'application/x-font-opentype', 'application/vnd.ms-opentype', 'application/font-sfnt']),
  });
  const SIGNATURES = Object.freeze({
    woff2: Object.freeze(['wOF2']),
    woff: Object.freeze(['wOFF']),
    ttf: Object.freeze(['0x00010000', 'true']),
    otf: Object.freeze(['OTTO', '0x00010000']),
  });

  const freezeOptions = (options) => Object.freeze(options.map((option) => Object.freeze({ ...option })));

  const UI_OPTIONS = freezeOptions([
    { value: 'atkinson-hyperlegible-next', label: 'Atkinson Hyperlegible Next', family: 'Atkinson Hyperlegible Next', google: 'Atkinson+Hyperlegible+Next', stack: '"Atkinson Hyperlegible Next", ui-sans-serif, system-ui, sans-serif' },
    { value: 'courier-prime', label: 'Courier Prime', family: 'Courier Prime', google: 'Courier+Prime', stack: '"Courier Prime", ui-monospace, monospace' },
    { value: 'dm-sans', label: 'DM Sans', family: 'DM Sans', google: 'DM+Sans', stack: '"DM Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'figtree', label: 'Figtree', family: 'Figtree', google: 'Figtree', stack: 'Figtree, ui-sans-serif, system-ui, sans-serif' },
    { value: 'geist', label: 'Geist', family: 'Geist', google: 'Geist', stack: 'Geist, ui-sans-serif, system-ui, sans-serif' },
    { value: 'ibm-plex-sans', label: 'IBM Plex Sans', family: 'IBM Plex Sans', google: 'IBM+Plex+Sans', stack: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'inter', label: 'Inter', family: 'Inter', google: 'Inter', stack: 'Inter, ui-sans-serif, system-ui, sans-serif' },
    { value: 'lexend-deca', label: 'Lexend Deca', family: 'Lexend Deca', google: 'Lexend+Deca', stack: '"Lexend Deca", ui-sans-serif, system-ui, sans-serif' },
    { value: 'noto-sans', label: 'Noto Sans', family: 'Noto Sans', google: 'Noto+Sans', stack: '"Noto Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'nunito-sans', label: 'Nunito Sans', family: 'Nunito Sans', google: 'Nunito+Sans', stack: '"Nunito Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'oxanium', label: 'Oxanium', family: 'Oxanium', google: 'Oxanium', stack: '"Oxanium", ui-sans-serif, system-ui, sans-serif' },
    { value: 'open-sans', label: 'Open Sans', family: 'Open Sans', google: 'Open+Sans', stack: '"Open Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'public-sans', label: 'Public Sans', family: 'Public Sans', google: 'Public+Sans', stack: '"Public Sans", ui-sans-serif, system-ui, sans-serif' },
    { value: 'source-sans-3', label: 'Source Sans 3', family: 'Source Sans 3', google: 'Source+Sans+3', stack: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif' },
  ]);

  const READING_OPTIONS = freezeOptions([
    { value: 'literata', label: 'Literata', family: 'Literata', google: 'Literata', stack: 'Literata, ui-serif, Georgia, serif' },
    { value: 'merriweather', label: 'Merriweather', family: 'Merriweather', google: 'Merriweather', stack: 'Merriweather, ui-serif, Georgia, serif' },
    { value: 'source-serif-4', label: 'Source Serif 4', family: 'Source Serif 4', google: 'Source+Serif+4', stack: '"Source Serif 4", ui-serif, Georgia, serif' },
    { value: 'lora', label: 'Lora', family: 'Lora', google: 'Lora', stack: 'Lora, ui-serif, Georgia, serif' },
    { value: 'noto-serif', label: 'Noto Serif', family: 'Noto Serif', google: 'Noto+Serif', stack: '"Noto Serif", ui-serif, Georgia, serif' },
    { value: 'ibm-plex-serif', label: 'IBM Plex Serif', family: 'IBM Plex Serif', google: 'IBM+Plex+Serif', stack: '"IBM Plex Serif", ui-serif, Georgia, serif' },
    { value: 'newsreader', label: 'Newsreader', family: 'Newsreader', google: 'Newsreader', stack: 'Newsreader, ui-serif, Georgia, serif' },
    { value: 'bitter', label: 'Bitter', family: 'Bitter', google: 'Bitter', stack: 'Bitter, ui-serif, Georgia, serif' },
  ]);

  const CODE_OPTIONS = freezeOptions([
    { value: 'atkinson-hyperlegible-mono', label: 'Atkinson Hyperlegible Mono', family: 'Atkinson Hyperlegible Mono', google: 'Atkinson+Hyperlegible+Mono', stack: '"Atkinson Hyperlegible Mono", ui-monospace, monospace' },
    { value: 'courier-prime', label: 'Courier Prime', family: 'Courier Prime', google: 'Courier+Prime', stack: '"Courier Prime", ui-monospace, monospace' },
    { value: 'geist-mono', label: 'Geist Mono', family: 'Geist Mono', google: 'Geist+Mono', stack: '"Geist Mono", ui-monospace, monospace' },
    { value: 'jetbrains-mono', label: 'JetBrains Mono', family: 'JetBrains Mono', google: 'JetBrains+Mono', stack: '"JetBrains Mono", ui-monospace, monospace' },
    { value: 'fira-code', label: 'Fira Code', family: 'Fira Code', google: 'Fira+Code', stack: '"Fira Code", ui-monospace, monospace' },
    { value: 'source-code-pro', label: 'Source Code Pro', family: 'Source Code Pro', google: 'Source+Code+Pro', stack: '"Source Code Pro", ui-monospace, monospace' },
    { value: 'ibm-plex-mono', label: 'IBM Plex Mono', family: 'IBM Plex Mono', google: 'IBM+Plex+Mono', stack: '"IBM Plex Mono", ui-monospace, monospace' },
    { value: 'roboto-mono', label: 'Roboto Mono', family: 'Roboto Mono', google: 'Roboto+Mono', stack: '"Roboto Mono", ui-monospace, monospace' },
    { value: 'inconsolata', label: 'Inconsolata', family: 'Inconsolata', google: 'Inconsolata', stack: 'Inconsolata, ui-monospace, monospace' },
    { value: 'noto-sans-mono', label: 'Noto Sans Mono', family: 'Noto Sans Mono', google: 'Noto+Sans+Mono', stack: '"Noto Sans Mono", ui-monospace, monospace' },
    { value: 'space-mono', label: 'Space Mono', family: 'Space Mono', google: 'Space+Mono', stack: '"Space Mono", ui-monospace, monospace' },
    { value: 'martian-mono', label: 'Martian Mono', family: 'Martian Mono', google: 'Martian+Mono', stack: '"Martian Mono", ui-monospace, monospace' },
  ]);

  const CATALOG = Object.freeze({
    interface: freezeOptions([{ value: 'default', label: 'WebUI default' }, ...UI_OPTIONS]),
    conversation: freezeOptions([
      { value: 'default', label: 'WebUI default' },
      { value: 'same-ui', label: 'Same as interface' },
      ...UI_OPTIONS,
      ...READING_OPTIONS,
    ]),
    code: freezeOptions([{ value: 'default', label: 'WebUI default' }, ...CODE_OPTIONS]),
  });
  const PUBLIC_CATALOG = Object.freeze({
    interface: Object.freeze(CATALOG.interface.map(({ value, label }) => Object.freeze({ value, label }))),
    conversation: Object.freeze(CATALOG.conversation.map(({ value, label }) => Object.freeze({ value, label }))),
    code: Object.freeze(CATALOG.code.map(({ value, label }) => Object.freeze({ value, label }))),
  });

  let selection = { ...DEFAULTS };
  let initialSelection = { ...DEFAULTS };
  let opener = null;
  let localFonts = new Map();
  let localFontState = {
    available: false,
    ready: false,
    message: 'Local font imports are loading.',
    error: false,
  };
  let localFontBusy = false;
  const dirtyRoles = new Set();

  function localSelectionValue(id) {
    return 'local:' + id;
  }

  function removeLocalFontFromSelection(value, id) {
    const candidate = value && typeof value === 'object' ? { ...value } : {};
    const removed = localSelectionValue(id);
    for (const role of ROLES) {
      if (candidate[role] === removed) candidate[role] = DEFAULTS[role];
    }
    return candidate;
  }

  function localIdFromValue(value) {
    if (typeof value !== 'string' || !value.startsWith('local:')) return null;
    const id = value.slice('local:'.length);
    return LOCAL_ID_RE.test(id) ? id : null;
  }

  function activeLocalIds() {
    return new Set([...localFonts.values()].filter((record) => record.active).map((record) => record.id));
  }

  function staticOptionFor(role, value) {
    return CATALOG[role].find((option) => option.value === value) || null;
  }

  function localFamilyFor(id) {
    return 'HermesTypographyLocal_' + id;
  }

  function localFallbackForRole(role) {
    return role === 'code' ? 'ui-monospace, monospace' : 'ui-sans-serif, system-ui, sans-serif';
  }

  function localOptionFor(record, role) {
    const family = localFamilyFor(record.id);
    return {
      value: localSelectionValue(record.id),
      label: record.name,
      family,
      stack: '"' + family + '", ' + localFallbackForRole(role),
    };
  }

  function optionFor(role, value) {
    if (role === 'conversation' && value === 'same-ui') return optionFor('interface', selection.interface);
    const staticOption = staticOptionFor(role, value);
    if (staticOption) return staticOption;
    const id = localIdFromValue(value);
    const record = id ? localFonts.get(id) : null;
    return record && record.active ? localOptionFor(record, role) : null;
  }

  function normalizeSelection(value, availableLocalIds = activeLocalIds()) {
    const candidate = value && typeof value === 'object' ? value : {};
    const ids = availableLocalIds instanceof Set ? availableLocalIds : new Set(availableLocalIds || []);
    return Object.fromEntries(ROLES.map((role) => {
      const roleValue = candidate[role];
      const valid = staticOptionFor(role, roleValue) || (localIdFromValue(roleValue) && ids.has(localIdFromValue(roleValue)));
      return [role, valid ? roleValue : DEFAULTS[role]];
    }));
  }

  function parseStored(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function extensionStorage() {
    try {
      const api = window.HermesExtensionSettings;
      if (!api || typeof api.storageForExtension !== 'function') return null;
      const store = api.storageForExtension('typography');
      if (!store || store.supported === false) return null;
      if (typeof store.get === 'function' && typeof store.set === 'function') return store;
      if (typeof store.getItem === 'function' && typeof store.setItem === 'function') return store;
    } catch (_) {}
    return null;
  }

  function readStore(store) {
    return typeof store.get === 'function' ? store.get(STORAGE_KEY) : store.getItem(STORAGE_KEY);
  }

  function writeStore(store, value) {
    return (typeof store.set === 'function' ? store.set(STORAGE_KEY, value) : store.setItem(STORAGE_KEY, value)) !== false;
  }

  function loadSelection() {
    const store = extensionStorage();
    if (store) {
      try {
        const stored = readStore(store);
        if (stored !== undefined && stored !== null) return parseStored(stored);
      } catch (_) {}
    }
    try { return parseStored(localStorage.getItem(FALLBACK_STORAGE_KEY)); } catch (_) { return null; }
  }

  function selectionForPersistence(value, persisted, dirty, ready, records) {
    const candidate = value && typeof value === 'object' ? { ...value } : {};
    const dirtySet = dirty && typeof dirty.has === 'function' ? dirty : new Set();
    for (const role of ROLES) {
      const persistedValue = persisted && persisted[role];
      const id = localIdFromValue(persistedValue);
      if (!dirtySet.has(role) && id && (!ready || (records && typeof records.has === 'function' && records.has(id)))) {
        candidate[role] = persistedValue;
      }
    }
    return candidate;
  }

  function saveSelection() {
    const value = JSON.stringify(selectionForPersistence(selection, initialSelection, dirtyRoles, localFontState.ready, localFonts));
    const store = extensionStorage();
    if (store) {
      try { if (writeStore(store, value)) return; } catch (_) {}
    }
    try { localStorage.setItem(FALLBACK_STORAGE_KEY, value); } catch (_) {}
  }

  function stackFor(role, value) {
    const option = optionFor(role, value);
    return option && option.stack ? option.stack : '';
  }

  function googleStylesheetHrefForOptions(optionsByRole) {
    const families = new Map();
    for (const role of ROLES) {
      const option = optionsByRole && optionsByRole[role];
      if (!option || !option.google) continue;
      const existing = families.get(option.google);
      if (existing) {
        existing.prose = existing.prose || role !== 'code';
      } else {
        families.set(option.google, { option, prose: role !== 'code' });
      }
    }
    if (!families.size) return '';
    return GOOGLE_FONTS_URL + '?'
      + [...families.values()].map(({ option, prose }) => 'family=' + option.google + (prose
        ? ':ital,wght@0,400;0,500;0,600;0,700;1,400;1,700'
        : ':wght@400;500;600;700')).join('&')
      + '&display=swap';
  }

  function buildGoogleStylesheetHref(value = {}) {
    const candidate = value && typeof value === 'object' ? value : {};
    const interfaceValue = candidate.interface;
    const options = Object.fromEntries(ROLES.map((role) => {
      const selectedValue = role === 'conversation' && candidate[role] === 'same-ui'
        ? interfaceValue
        : candidate[role];
      return [role, staticOptionFor(role, selectedValue)];
    }));
    return googleStylesheetHrefForOptions(options);
  }

  function updateGoogleStylesheet() {
    const options = Object.fromEntries(ROLES.map((role) => [role, optionFor(role, selection[role])]));
    const href = googleStylesheetHrefForOptions(options);
    let link = document.getElementById(GOOGLE_STYLE_ID);
    if (!href) {
      if (link) link.remove();
      return;
    }
    if (link && link.tagName !== 'LINK') { link.remove(); link = null; }
    if (!link) {
      link = document.createElement('link');
      link.id = GOOGLE_STYLE_ID;
      link.rel = 'stylesheet';
      link.dataset.hwxTypeOwned = 'true';
      link.href = href;
      if (document.head) document.head.appendChild(link);
    } else {
      link.href = href;
    }
  }

  function updatePreviews() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const role of ROLES) {
      const stack = stackFor(role, selection[role]);
      const select = panel.querySelector('#hwx-type-' + role);
      const preview = panel.querySelector('[data-hwx-type-preview="' + role + '"]');
      if (select) select.style.fontFamily = stack;
      if (preview) preview.style.fontFamily = stack;
    }
  }

  function apply() {
    selection = normalizeSelection(selection);
    const root = document.documentElement;
    if (root) {
      const ui = stackFor('interface', selection.interface);
      const conversation = stackFor('conversation', selection.conversation);
      const code = stackFor('code', selection.code);
      if (ui) root.style.setProperty('--font-ui', ui); else root.style.removeProperty('--font-ui');
      if (conversation) root.style.setProperty('--font-conversation', conversation); else root.style.removeProperty('--font-conversation');
      if (code) root.style.setProperty('--font-mono', code); else root.style.removeProperty('--font-mono');
    }
    updateGoogleStylesheet();
    updatePreviews();
    return { ...selection };
  }

  function matchingPreset(value = selection) {
    return PRESETS.find((preset) => ROLES.every((role) => preset[role] === value[role])) || null;
  }

  function setRole(role, value) {
    if (!ROLES.includes(role)) return;
    dirtyRoles.add(role);
    selection = normalizeSelection({ ...selection, [role]: value });
    saveSelection();
    apply();
    syncControls();
  }

  function setPreset(id) {
    const preset = PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    ROLES.forEach((role) => dirtyRoles.add(role));
    selection = normalizeSelection(preset);
    saveSelection();
    apply();
    syncControls();
  }

  function appendSelectOption(select, option) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.appendChild(element);
  }

  function populateSelect(select, role) {
    if (!select) return;
    while (select.firstChild) select.removeChild(select.firstChild);
    CATALOG[role].forEach((option) => appendSelectOption(select, option));
    const locals = [...localFonts.values()].filter((record) => record.active);
    if (locals.length) {
      const group = document.createElement('optgroup');
      group.label = 'Local fonts';
      locals.forEach((record) => appendSelectOption(group, localOptionFor(record, role)));
      select.appendChild(group);
    }
    select.value = selection[role];
  }

  function buildPresetControl(host) {
    const field = document.createElement('label');
    field.className = 'hwx-type-preset-field';
    const label = document.createElement('span');
    label.className = 'hwx-type-field-label';
    label.textContent = 'Preset';
    const select = document.createElement('select');
    select.id = 'hwx-type-preset';
    select.className = 'hwx-type-select';
    select.setAttribute('aria-label', 'Typography preset');
    appendSelectOption(select, { value: 'custom', label: 'Custom' });
    PRESETS.forEach((preset) => appendSelectOption(select, { value: preset.id, label: preset.label }));
    select.addEventListener('change', () => setPreset(select.value));
    field.append(label, select);
    host.appendChild(field);
  }

  function buildSelect(role, host) {
    const field = document.createElement('label');
    field.className = 'hwx-type-field';
    const label = document.createElement('span');
    label.className = 'hwx-type-field-label';
    label.textContent = ROLE_LABELS[role];
    const select = document.createElement('select');
    select.id = 'hwx-type-' + role;
    select.className = 'hwx-type-select';
    select.setAttribute('aria-label', ROLE_LABELS[role]);
    populateSelect(select, role);
    select.addEventListener('change', () => setRole(role, select.value));
    field.append(label, select);
    host.appendChild(field);
  }

  function setLocalStatus(message, error = false) {
    localFontState.message = message;
    localFontState.error = error;
    const status = document.getElementById('hwx-type-local-status');
    if (status) {
      status.textContent = message;
      status.classList.toggle('hwx-type-status-error', error);
    }
  }

  function setLocalControlsDisabled(disabled) {
    const input = document.getElementById('hwx-type-local-file');
    const importButton = document.getElementById('hwx-type-import');
    if (input) input.disabled = disabled;
    if (importButton) importButton.disabled = disabled;
  }

  function clearChildren(element) {
    while (element && element.firstChild) element.removeChild(element.firstChild);
  }

  function renderLocalFonts() {
    const list = document.getElementById('hwx-type-local-list');
    if (!list) return;
    clearChildren(list);
    if (!localFonts.size) {
      const empty = document.createElement('li');
      empty.className = 'hwx-type-local-empty';
      empty.textContent = 'No local fonts imported yet.';
      list.appendChild(empty);
      return;
    }
    for (const record of localFonts.values()) {
      const item = document.createElement('li');
      item.className = 'hwx-type-local-item';

      const details = document.createElement('div');
      details.className = 'hwx-type-local-details';
      const heading = document.createElement('div');
      heading.className = 'hwx-type-local-heading';
      const name = document.createElement('strong');
      name.className = 'hwx-type-local-name';
      name.textContent = record.name;
      const format = document.createElement('span');
      format.className = 'hwx-type-local-format';
      format.textContent = '· ' + record.format.toUpperCase();
      heading.append(name, format);
      const preview = document.createElement('span');
      preview.className = 'hwx-type-local-preview';
      preview.style.fontFamily = localFamilyFor(record.id);
      preview.textContent = 'Il1 O0 {} [] != => ,.;:';
      details.append(heading, preview);
      if (!record.active) {
        const meta = document.createElement('span');
        meta.className = 'hwx-type-local-meta';
        meta.textContent = 'Stored but unavailable; replace or delete it.';
        details.appendChild(meta);
      }

      const actions = document.createElement('div');
      actions.className = 'hwx-type-local-actions';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'hwx-type-local-action';
      rename.textContent = 'Rename';
      rename.disabled = localFontBusy;
      rename.addEventListener('click', () => renameLocalFont(record.id));
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.className = 'hwx-type-local-action';
      replace.textContent = 'Replace';
      replace.disabled = localFontBusy;
      replace.addEventListener('click', () => chooseReplacement(record.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'hwx-type-local-action hwx-type-local-delete';
      remove.textContent = 'Delete';
      remove.disabled = localFontBusy;
      remove.addEventListener('click', () => deleteLocalFont(record.id));
      actions.append(rename, replace, remove);

      item.append(details, actions);
      list.appendChild(item);
    }
  }

  function syncControls() {
    const panel = document.getElementById(PANEL_ID);
    const active = document.activeElement;
    const restoreFocus = panel && typeof panel.contains === 'function' && panel.contains(active);
    if (panel) {
      const preset = panel.querySelector('#hwx-type-preset');
      if (preset) preset.value = matchingPreset() ? matchingPreset().id : 'custom';
      for (const role of ROLES) {
        const select = panel.querySelector('#hwx-type-' + role);
        populateSelect(select, role);
      }
    }
    setLocalControlsDisabled(!localFontState.available || !localFontState.ready || localFontBusy);
    const status = document.getElementById('hwx-type-local-status');
    if (status) {
      status.textContent = localFontState.message;
      status.classList.toggle('hwx-type-status-error', localFontState.error);
    }
    renderLocalFonts();
    updatePreviews();
    if (restoreFocus && !panel.contains(document.activeElement)) {
      const target = panel.querySelector('#hwx-type-import:not([disabled])')
        || panel.querySelector('button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      if (target) target.focus();
    }
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'hwx-type-overlay';
    panel.innerHTML = `
      <div class="hwx-type-card" role="dialog" aria-modal="true" aria-labelledby="hwx-type-title">
        <div class="hwx-type-header">
          <div>
            <div class="hwx-type-title-row">
              <h2 id="hwx-type-title">Typography</h2>
              <button type="button" class="hwx-type-info has-tooltip has-tooltip--bottom" data-tooltip="${DISCLOSURE}" aria-label="Privacy and network information: ${DISCLOSURE}">i</button>
            </div>
            <p class="hwx-type-subtitle">Choose a font for each part of Hermes.</p>
          </div>
          <button type="button" class="hwx-type-close" aria-label="Close typography">&times;</button>
        </div>
        <div class="hwx-type-body">
          <div class="hwx-type-preset"></div>
          <div class="hwx-type-controls"></div>
          <div class="hwx-type-previews" aria-label="Font previews">
            <div class="hwx-type-preview" data-hwx-type-preview="interface"><span class="hwx-type-preview-label">Interface</span><span>Ag Il1 O0 0123456789 · Clear controls and compact labels</span></div>
            <div class="hwx-type-preview" data-hwx-type-preview="conversation"><span class="hwx-type-preview-label">Conversations</span><span>Ag Il1 O0 0123456789 · Readable paragraphs <em>feel at home</em> with <strong>clear emphasis</strong>.</span></div>
            <div class="hwx-type-preview hwx-type-preview-code" data-hwx-type-preview="code"><span class="hwx-type-preview-label">Code</span><code>Il1 O0 {} [] != =&gt; ,.;:</code></div>
          </div>
          <section class="hwx-type-local" aria-labelledby="hwx-type-local-title">
            <h3 id="hwx-type-local-title">Local fonts</h3>
            <p class="hwx-type-local-disclosure">Import .woff2, .woff, .ttf, or .otf files up to 10 MiB each.</p>
            <input id="hwx-type-local-file" type="file" accept=".woff2,.woff,.ttf,.otf" hidden>
            <button type="button" id="hwx-type-import">Import font</button>
            <p class="hwx-type-local-help">Choose local fonts in any role selector.</p>
            <p id="hwx-type-local-status" class="hwx-type-local-status" role="status" aria-live="polite" aria-atomic="true"></p>
            <ul id="hwx-type-local-list" class="hwx-type-local-list"></ul>
          </section>
        </div>
        <div class="hwx-type-actions">
          <button type="button" class="hwx-type-close-action">Close</button>
        </div>
      </div>`;
    const preset = panel.querySelector('.hwx-type-preset');
    const controls = panel.querySelector('.hwx-type-controls');
    buildPresetControl(preset);
    ROLES.forEach((role) => buildSelect(role, controls));
    const fileInput = panel.querySelector('#hwx-type-local-file');
    const importButton = panel.querySelector('#hwx-type-import');
    const info = panel.querySelector('.hwx-type-info');
    fileInput.accept = FONT_ACCEPT;
    importButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) importLocalFont(file);
    });
    info.addEventListener('click', () => info.classList.toggle('hwx-type-tooltip-open'));
    info.addEventListener('blur', () => info.classList.remove('hwx-type-tooltip-open'));
    panel.querySelector('.hwx-type-close').addEventListener('click', close);
    panel.querySelector('.hwx-type-close-action').addEventListener('click', close);
    panel.addEventListener('click', (event) => { if (event.target === panel) close(); });
    return panel;
  }

  function onKeydown(event) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = panel.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!panel.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open(openerElement) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      const first = existing.querySelector('select');
      if (first) first.focus();
      return;
    }
    opener = openerElement && typeof openerElement.focus === 'function' ? openerElement : document.activeElement;
    if (!document.body) return;
    const panel = buildPanel();
    document.body.appendChild(panel);
    syncControls();
    document.addEventListener('keydown', onKeydown, true);
    const first = panel.querySelector('select');
    if (first) first.focus();
  }

  function close() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.remove();
    document.removeEventListener('keydown', onKeydown, true);
    const restore = opener;
    opener = null;
    if (restore && restore.isConnected && typeof restore.focus === 'function') restore.focus();
  }

  function ensureRailButton() {
    const existing = document.getElementById(RAIL_BUTTON_ID);
    if (existing) return existing;
    const rail = document.querySelector('.rail');
    if (!rail) return null;
    const button = document.createElement('button');
    button.id = RAIL_BUTTON_ID;
    button.type = 'button';
    button.className = 'rail-btn nav-tab has-tooltip hwx-type-rail-button';
    button.dataset.tooltip = 'Typography';
    button.setAttribute('aria-label', 'Typography');
    button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/></svg>';
    button.addEventListener('click', (event) => { event.preventDefault(); open(button); });
    const spacer = rail.querySelector('.rail-spacer');
    if (spacer) rail.insertBefore(button, spacer);
    else rail.appendChild(button);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        const currentSpacer = rail.querySelector('.rail-spacer');
        const children = Array.from(rail.children);
        const buttonIndex = children.indexOf(button);
        const spacerIndex = children.indexOf(currentSpacer);
        if (buttonIndex < 0 || spacerIndex < 0 || spacerIndex <= buttonIndex) return;
        if (children.slice(buttonIndex + 1, spacerIndex).some((child) =>
          child.classList.contains('nav-tab') && child.dataset.panel !== undefined
        )) rail.insertBefore(button, currentSpacer);
      }).observe(rail, { childList: true });
    }
    return button;
  }

  function installRailButton(attempt = 0) {
    if (ensureRailButton() || attempt >= 80) return;
    setTimeout(() => installRailButton(attempt + 1), 150);
  }

  function hasLocalFontSupport() {
    return typeof window.indexedDB !== 'undefined'
      && window.indexedDB && typeof window.indexedDB.open === 'function'
      && typeof window.FontFace === 'function'
      && typeof document !== 'undefined'
      && document.fonts
      && typeof document.fonts.add === 'function'
      && typeof document.fonts.delete === 'function';
  }

  function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return null;
  }

  function signatureForBytes(bytes) {
    const view = new Uint8Array(bytes);
    if (view.length < 4) return '';
    const ascii = String.fromCharCode(view[0], view[1], view[2], view[3]);
    if (ascii === 'wOF2' || ascii === 'wOFF' || ascii === 'OTTO' || ascii === 'true') return ascii;
    if (view[0] === 0x00 && view[1] === 0x01 && view[2] === 0x00 && view[3] === 0x00) return '0x00010000';
    return '';
  }

  function extensionForFilename(filename) {
    const base = String(filename || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }

  function displayNameForFilename(filename) {
    const base = String(filename || '').split(/[\\/]/).pop() || '';
    const extension = extensionForFilename(base);
    const withoutExtension = extension ? base.slice(0, -(extension.length + 1)) : base;
    return withoutExtension.trim().slice(0, 80) || 'Imported font';
  }

  function validateLocalFontMetadata({ name, type, size, signature } = {}) {
    const format = extensionForFilename(name);
    if (!Object.prototype.hasOwnProperty.call(SIGNATURES, format)) return { ok: false, error: 'Use a .woff2, .woff, .ttf, or .otf font file.' };
    if (!Number.isInteger(size) || size <= 0) return { ok: false, error: 'The font file is empty.' };
    if (size > MAX_FONT_BYTES) return { ok: false, error: 'Font files must be 10 MiB or smaller.' };
    const mime = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (mime && mime !== 'application/octet-stream' && !MIME_TYPES[format].has(mime)) return { ok: false, error: 'The file MIME type does not match its extension.' };
    if (!SIGNATURES[format].includes(signature)) return { ok: false, error: 'The file signature does not match a supported font format.' };
    return { ok: true, format };
  }

  function normalizeStoredRecord(record) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !LOCAL_ID_RE.test(record.id)) return null;
    const bytes = toArrayBuffer(record.bytes) || new ArrayBuffer(0);
    const formatValue = typeof record.format === 'string' ? record.format.trim().toLowerCase() : '';
    const format = Object.prototype.hasOwnProperty.call(SIGNATURES, formatValue) ? formatValue : 'unknown';
    const metadata = format === 'unknown' ? { ok: false } : validateLocalFontMetadata({
      name: record.id + '.' + format,
      type: '',
      size: bytes.byteLength,
      signature: signatureForBytes(bytes),
    });
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) || 'Imported font' : 'Imported font';
    const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
    const updatedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt;
    return {
      id: record.id,
      name,
      format,
      bytes,
      createdAt,
      updatedAt,
      active: false,
      face: null,
      invalid: !(metadata.ok && metadata.format === format),
    };
  }

  function storedRecord(record) {
    return {
      id: record.id,
      name: record.name,
      format: record.format,
      bytes: record.bytes.slice(0),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        transaction.oncomplete = null;
        transaction.onerror = null;
        transaction.onabort = null;
        callback(value);
      };
      transaction.oncomplete = () => finish(resolve);
      transaction.onerror = () => finish(reject, transaction.error || new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  async function transactionRequest(transaction, requestFactory) {
    const complete = transactionComplete(transaction);
    try {
      const result = await idbRequest(requestFactory(transaction.objectStore(FONT_STORE_NAME)));
      await complete;
      return result;
    } catch (error) {
      try { await complete; } catch (_) {}
      throw error;
    }
  }

  function openFontDatabase() {
    return new Promise((resolve, reject) => {
      let request;
      try { request = window.indexedDB.open(FONT_DB_NAME, 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FONT_STORE_NAME)) database.createObjectStore(FONT_STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local font storage.'));
    });
  }

  async function readFontRecords() {
    const database = await openFontDatabase();
    try {
      const transaction = database.transaction(FONT_STORE_NAME, 'readonly');
      return await transactionRequest(transaction, (store) => store.getAll());
    } finally {
      database.close();
    }
  }

  async function putFontRecord(record) {
    const database = await openFontDatabase();
    try {
      const transaction = database.transaction(FONT_STORE_NAME, 'readwrite');
      await transactionRequest(transaction, (store) => store.put(storedRecord(record)));
    } finally {
      database.close();
    }
  }

  async function removeFontRecord(id) {
    const database = await openFontDatabase();
    try {
      const transaction = database.transaction(FONT_STORE_NAME, 'readwrite');
      await transactionRequest(transaction, (store) => store.delete(id));
    } finally {
      database.close();
    }
  }

  function makeOpaqueId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (_) {}
    return 'font-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function loadFace(id, bytes) {
    const face = new window.FontFace(localFamilyFor(id), bytes);
    await face.load();
    return face;
  }

  function removeFace(face) {
    if (face && document.fonts && typeof document.fonts.delete === 'function') document.fonts.delete(face);
  }

  function localErrorMessage(error, fallback) {
    return error && typeof error.message === 'string' && error.message ? error.message : fallback;
  }

  async function readValidatedFile(file, nameOverride) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('This browser cannot read local font files.');
    if (Number.isFinite(file.size) && file.size > MAX_FONT_BYTES) throw new Error('Font files must be 10 MiB or smaller.');
    const bytes = toArrayBuffer(await file.arrayBuffer());
    if (!bytes) throw new Error('The selected file could not be read.');
    const metadata = validateLocalFontMetadata({
      name: file.name,
      type: file.type,
      size: bytes.byteLength,
      signature: signatureForBytes(bytes),
    });
    if (!metadata.ok) throw new Error(metadata.error);
    const name = nameOverride === undefined ? displayNameForFilename(file.name) : String(nameOverride).trim().slice(0, 80);
    return { bytes, format: metadata.format, name: name || 'Imported font' };
  }

  async function runLocalOperation(operation) {
    if (localFontBusy) return;
    localFontBusy = true;
    syncControls();
    try {
      await operation();
    } finally {
      localFontBusy = false;
      syncControls();
    }
  }

  function importLocalFont(file) {
    runLocalOperation(async () => {
      try {
        const imported = await readValidatedFile(file);
        let id = makeOpaqueId();
        while (localFonts.has(id)) id = makeOpaqueId();
        const face = await loadFace(id, imported.bytes);
        document.fonts.add(face);
        const now = Date.now();
        const record = {
          id,
          name: imported.name,
          format: imported.format,
          bytes: imported.bytes,
          createdAt: now,
          updatedAt: now,
          active: true,
          face,
          invalid: false,
        };
        try {
          await putFontRecord(record);
        } catch (error) {
          removeFace(face);
          throw error;
        }
        localFonts.set(id, record);
        setLocalStatus('');
        syncControls();
      } catch (error) {
        setLocalStatus(localErrorMessage(error, 'The font could not be imported.'), true);
      }
    });
  }

  function chooseReplacement(id) {
    if (localFontBusy) return;
    if (!document.body) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = FONT_ACCEPT;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.display = 'none';
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      input.remove();
    };
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      cleanup();
      if (file) replaceLocalFont(id, file);
    });
    input.addEventListener('cancel', cleanup, { once: true });
    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      cleanup();
      setLocalStatus(localErrorMessage(error, 'The replacement picker could not open.'), true);
    }
  }

  function replaceLocalFont(id, file) {
    runLocalOperation(async () => {
      const previous = localFonts.get(id);
      if (!previous) return;
      try {
        const replacement = await readValidatedFile(file, previous.name);
        const face = await loadFace(id, replacement.bytes);
        document.fonts.add(face);
        const next = {
          ...previous,
          format: replacement.format,
          bytes: replacement.bytes,
          updatedAt: Date.now(),
          active: true,
          face,
          invalid: false,
        };
        try {
          await putFontRecord(next);
        } catch (error) {
          removeFace(face);
          throw error;
        }
        removeFace(previous.face);
        localFonts.set(id, next);
        const persisted = loadSelection();
        if (persisted) {
          selection = normalizeSelection(persisted);
          apply();
        }
        setLocalStatus('Font replaced. Its name and selections were preserved.');
        syncControls();
      } catch (error) {
        setLocalStatus(localErrorMessage(error, 'The font could not be replaced; the previous font is unchanged.'), true);
      }
    });
  }

  function renameLocalFont(id) {
    const record = localFonts.get(id);
    if (!record || localFontBusy) return;
    if (typeof window.prompt !== 'function') {
      setLocalStatus('Renaming is unavailable in this browser.', true);
      return;
    }
    const entered = window.prompt('Font name (80 characters maximum)', record.name);
    if (entered === null) return;
    const name = String(entered).trim().slice(0, 80);
    if (!name) {
      setLocalStatus('Font names cannot be empty.', true);
      return;
    }
    runLocalOperation(async () => {
      const next = { ...record, name, updatedAt: Date.now() };
      try {
        await putFontRecord(next);
        localFonts.set(id, next);
        setLocalStatus('Font renamed.');
        syncControls();
      } catch (error) {
        setLocalStatus(localErrorMessage(error, 'The font could not be renamed.'), true);
      }
    });
  }

  function deleteLocalFont(id) {
    const record = localFonts.get(id);
    if (!record || localFontBusy) return;
    if (typeof window.confirm === 'function' && !window.confirm('Delete this imported font?')) return;
    runLocalOperation(async () => {
      try {
        await removeFontRecord(id);
        removeFace(record.face);
        localFonts.delete(id);
        const persisted = loadSelection();
        const before = persisted && typeof persisted === 'object' ? persisted : selection;
        const candidate = removeLocalFontFromSelection(before, id);
        const changedRoles = ROLES.filter((role) => candidate[role] !== before[role]);
        if (changedRoles.length) {
          changedRoles.forEach((role) => dirtyRoles.add(role));
          selection = normalizeSelection(candidate);
          saveSelection();
          apply();
        }
        setLocalStatus('Font deleted.');
        syncControls();
      } catch (error) {
        setLocalStatus(localErrorMessage(error, 'The font could not be deleted.'), true);
      }
    });
  }

  async function initializeLocalFonts() {
    if (!hasLocalFontSupport()) {
      localFontState = {
        available: false,
        ready: false,
        message: 'Local font imports are unavailable here because IndexedDB and FontFace support are required. Curated fonts and presets remain available.',
        error: true,
      };
      selection = normalizeSelection(selection);
      apply();
      syncControls();
      return;
    }
    localFontState = { available: true, ready: false, message: 'Loading stored local fonts.', error: false };
    syncControls();
    try {
      const records = await readFontRecords();
      localFonts = new Map();
      for (const raw of records || []) {
        const record = normalizeStoredRecord(raw);
        if (record) localFonts.set(record.id, record);
      }
      let activationFailures = 0;
      for (const record of localFonts.values()) {
        if (record.invalid) {
          activationFailures += 1;
          continue;
        }
        try {
          record.face = await loadFace(record.id, record.bytes);
          document.fonts.add(record.face);
          record.active = true;
        } catch (_) {
          record.face = null;
          record.active = false;
          activationFailures += 1;
        }
      }
      localFontState = {
        available: true,
        ready: true,
        message: activationFailures
          ? 'Some stored local fonts could not be activated; their records were kept. Replace or delete them if needed.'
          : '',
        error: Boolean(activationFailures),
      };
    } catch (_) {
      localFonts = new Map();
      localFontState = {
        available: false,
        ready: false,
        message: 'Local font imports are unavailable because this browser could not open IndexedDB. Curated fonts and presets remain available.',
        error: true,
      };
      selection = normalizeSelection(selection);
      apply();
      syncControls();
      return;
    }
    const candidate = { ...initialSelection };
    for (const role of dirtyRoles) candidate[role] = selection[role];
    selection = normalizeSelection(candidate);
    apply();
    syncControls();
  }

  const DEBUG = Object.freeze({
    normalizeSelection: (value, localIds = []) => normalizeSelection(value, new Set(localIds)),
    selectionForPersistence: (value, persisted, dirtyRoles = [], ready = false, localIds = []) => selectionForPersistence(
      value,
      persisted,
      new Set(Array.isArray(dirtyRoles) ? dirtyRoles : []),
      ready,
      new Set(Array.isArray(localIds) ? localIds : []),
    ),
    normalizeStoredRecord,
    removeLocalFontFromSelection,
    validateLocalFontMetadata,
    isStableLocalSelection: (value) => Boolean(localIdFromValue(value)),
    localFallbackForRole,
    buildGoogleStylesheetHref,
  });

  window.HermesTypographyExtension = Object.freeze({
    version: VERSION,
    open,
    close,
    getSelection: () => ({ ...selection }),
    apply,
    catalog: PUBLIC_CATALOG,
    presets: PRESETS,
    debug: DEBUG,
  });

  function init() {
    initialSelection = loadSelection();
    selection = normalizeSelection(initialSelection);
    apply();
    installRailButton();
    initializeLocalFonts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
