(() => {
  'use strict';

  // Based on the client-side rebuild of gavinssr's core PR #3307.
  // Core owns shared metadata/icons; this extension owns the editor and DOM logos.

  const EXT = 'custom-branding';
  if (window.__hermesCustomBrandingLoaded) return;
  window.__hermesCustomBrandingLoaded = true;

  const LOGO_KEY = 'hermes-ext-custom-branding-logo';        // stores a data-URL (or empty)
  const FAVICON_KEY = 'hermes-ext-custom-branding-favicon';  // stores a data-URL (or empty)

  const LOGO_MAX_DIM = 256;            // downscale target for the logo (px)
  const FAVICON_MAX_DIM = 64;          // downscale target for the favicon (px)
  const LOGO_MAX_BYTES = 512 * 1024;   // refuse logos that won't downscale small enough
  const FAVICON_MAX_BYTES = 128 * 1024;// refuse favicons that won't downscale small enough

  // Titlebar logo container + empty-state hero logo container.
  const LOGO_CONTAINERS = [
    { sel: '.app-titlebar-icon', size: 'titlebar' },
    { sel: '.empty-logo', size: 'hero' }
  ];
  // Core favicon links we neutralize while a custom favicon is active.
  const FAVICON_SELECTOR = 'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]';

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nullableString = value => value === null || typeof value === 'string';
  // v1 guarantees an app-root base. Accept only the exact public derivative paths.
  function assetURL(value) {
    if (typeof value !== 'string' || !/^branding\/[a-f0-9]{64}\/icon-512\.png$/.test(value)) return '';
    try {
      const base = new URL(document.baseURI);
      const url = new URL(value, base);
      return base.origin === location.origin && url.origin === location.origin &&
        base.pathname.endsWith('/') && url.pathname.startsWith(base.pathname) ? url.href : '';
    } catch (_) { return ''; }
  }
  function validPublic(value) {
    if (!object(value) || value.api_version !== 1 || !object(value.effective)) return false;
    const e = value.effective;
    return typeof e.active === 'boolean' && nullableString(e.name) && typeof e.revision === 'string' &&
      (e.icon_512 === null || !!assetURL(e.icon_512));
  }
  function validManagement(value) {
    return validPublic(value) && object(value.config) &&
      ['can_manage', 'can_upload', 'provider_available', 'name_supported'].every(k => typeof value[k] === 'boolean') &&
      typeof value.config.enabled === 'boolean' && typeof value.config.manages_instance_name === 'boolean' &&
      nullableString(value.config.instance_name);
  }
  const hasBootstrap = window.__HERMES_INSTANCE_BRANDING__ !== undefined;
  let shared = validPublic(window.__HERMES_INSTANCE_BRANDING__) ? window.__HERMES_INSTANCE_BRANDING__ : null;
  let management = null;
  let etag = null;
  let busy = false;
  let configureResolve = null;
  let configureRegistered = false;
  let readEpoch = 0;
  let readError = false;
  let saveMessage = '';
  let draft = null;
  let draftDirty = false;
  let previewURL = '';
  const sharedActive = () => shared?.effective.active === true;
  const endpoint = (suffix = '') => new URL('api/instance-branding' + suffix, document.baseURI);
  const sharedLogo = () => sharedActive() ? assetURL(shared.effective.icon_512) : '';
  function ensureDraft() {
    if ((!draft || !draftDirty) && management) draft = {name: management.config.instance_name || '',
      adopt: management.config.manages_instance_name, enabled: management.config.enabled, file: null};
  }
  async function readShared() {
    if (busy) return;
    const epoch = ++readEpoch;
    etag = null;
    try {
      const response = await fetch(endpoint(), {cache: 'no-store', credentials: 'same-origin'});
      if (epoch !== readEpoch) return;
      if (response.status === 404 && !hasBootstrap && !management) { readError = false; return; }
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json();
      if (epoch !== readEpoch) return;
      if (!validManagement(value)) throw new Error('invalid');
      management = value;
      shared = {api_version: 1, effective: value.effective};
      etag = response.headers.get('ETag');
      readError = false;
      ensureDraft();
      if (saveMessage) saveMessage = 'Current shared settings refreshed. Your draft is kept; review it before saving.';
    } catch (_) {
      if (epoch !== readEpoch) return;
      readError = true;
    } finally {
      if (epoch === readEpoch) { applyAll(); rebuildPicker(); }
    }
  }
  async function postShared(patch, image = false) {
    const match = etag;
    etag = null; // Unknown outcomes must be read explicitly, never replayed.
    const headers = {'Content-Type': image ? 'image/png' : 'application/json', 'If-Match': match};
    const token = window.__HERMES_CONFIG__?.csrfToken;
    if (token) headers['X-Hermes-CSRF-Token'] = token;
    const response = await fetch(endpoint(image ? '/image' : ''), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
      body: image ? patch : JSON.stringify(patch)
    });
    if (!response.ok) throw new Error(response.status === 412 ?
      'Changed elsewhere. Refresh shared settings, review your draft, then save again.' :
      'Save could not be confirmed. Refresh shared settings before trying again.');
    const value = await response.json();
    if (!validManagement(value)) throw new Error('invalid');
    management = value;
    shared = {api_version: 1, effective: value.effective};
    window.__HERMES_INSTANCE_BRANDING__ = shared;
    etag = response.headers.get('ETag');
    applyAll();
  }
  async function writeShared(reset = false) {
    if (busy || !management?.can_manage || !etag) return;
    ensureDraft();
    const pending = {...draft};
    if (!reset && pending.file && (!management.can_upload || !management.provider_available)) return;
    if (!reset && pending.enabled && !management.config.enabled &&
        !window.confirm('Enable shared branding? The name and image will be public for all devices.')) return;
    if (reset && !window.confirm('Reset shared images and the branding-owned name? Personal browser images are retained.')) return;
    ++readEpoch;
    busy = true;
    saveMessage = 'Saving…';
    rebuildPicker();
    let imageSaved = false;
    try {
      if (!reset && pending.file) {
        await postShared(pending.file, true);
        imageSaved = true;
        draft.file = null;
        clearPreview();
        if (!etag || !management.can_manage) throw new Error('read required');
      }
      await postShared(reset ? {action: 'reset'} : {
        instance_name: pending.name, manages_instance_name: pending.adopt, enabled: pending.enabled
      });
      draft = null;
      clearPreview();
      // Core owns the complete initial shell (title owners, manifest/Apple links,
      // notification metadata). Refresh once after the whole Save, not per HTTP step.
      location.reload();
    } catch (error) {
      etag = null;
      saveMessage = (imageSaved ? 'Image saved; the remaining changes could not be confirmed. ' : '') +
        (error.message.startsWith('Changed elsewhere') ? error.message :
          'Save could not be confirmed. Refresh shared settings before trying again.');
    } finally { busy = false; rebuildPicker(); }
  }
  function clearPreview() {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = '';
  }

  let observer = null;
  let picker = null;
  let lastAnchor = null;

  // ── storage helpers ──────────────────────────────────────────────────────
  function getLogo() {
    try { return localStorage.getItem(LOGO_KEY) || ''; } catch (_) { return ''; }
  }
  function getFavicon() {
    try { return localStorage.getItem(FAVICON_KEY) || ''; } catch (_) { return ''; }
  }
  // Returns true on success, false if the value was rejected or storage failed
  // (e.g. quota exceeded) so the caller can show honest status instead of a
  // false "Applied." Storage is gated by isDataImage() as defense-in-depth — the
  // apply-time sinks already guard, but gating here keeps a bad value from ever
  // being persisted (protects future refactors + the picker's Change/Remove state).
  function setLogo(dataUrl) {
    let ok = true;
    try {
      if (dataUrl) {
        if (!isDataImage(dataUrl)) return false;
        localStorage.setItem(LOGO_KEY, dataUrl);
      } else {
        localStorage.removeItem(LOGO_KEY);
      }
    } catch (_) { ok = false; }
    applyLogos();
    return ok;
  }
  function setFavicon(dataUrl) {
    let ok = true;
    try {
      if (dataUrl) {
        if (!isDataImage(dataUrl)) return false;
        localStorage.setItem(FAVICON_KEY, dataUrl);
      } else {
        localStorage.removeItem(FAVICON_KEY);
      }
    } catch (_) { ok = false; }
    applyFavicon();
    return ok;
  }

  // ── validation ───────────────────────────────────────────────────────────
  // MVP restricts to raster png/jpeg/webp. Uploaded images are rasterized via
  // <canvas> before storage (canvas.toDataURL emits png/jpeg only), so a stored
  // value can never carry raw SVG markup — this avoids the SVG-XSS surface that
  // an <svg> favicon/logo would otherwise open up.
  function isDataImage(s) {
    return typeof s === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
  }
  function mimeFromDataUrl(s) {
    const m = /^data:(image\/[a-z+]+);base64,/.exec(s || '');
    return m ? m[1] : 'image/png';
  }

  // ── logo swap ──────────────────────────────────────────────────────────────
  function applyLogoToContainer(container, sizeKind, dataUrl) {
    if (!container) return;
    const nativeSvg = container.querySelector(':scope > svg');
    let img = container.querySelector(':scope > img.hwx-branding-logo-img');

    if (dataUrl && (isDataImage(dataUrl) || dataUrl === sharedLogo())) {
      // Compare against the live <img> src rather than stashing the full ≤512KB
      // data-URL in a DOM dataset attribute (cheaper, and no giant attribute write
      // on every rAF-coalesced re-render pass).
      if (!img || img.getAttribute('src') !== dataUrl) {
        if (nativeSvg && nativeSvg.style.display !== 'none') nativeSvg.style.display = 'none';
        if (!img) {
          img = document.createElement('img');
          img.className = 'hwx-branding-logo-img hwx-branding-logo-' + sizeKind;
          img.alt = 'Custom logo';
          container.appendChild(img);
        }
        img.src = dataUrl;
        container.classList.add('hwx-branding-logo-set');
      }
    } else {
      if (img) img.remove();
      if (nativeSvg && nativeSvg.style.display === 'none') nativeSvg.style.display = '';
      container.classList.remove('hwx-branding-logo-set');
    }
    wireClick(container);
  }

  function applyLogos() {
    const dataUrl = sharedActive() ? sharedLogo() : getLogo();
    LOGO_CONTAINERS.forEach(({ sel, size }) => {
      document.querySelectorAll(sel).forEach((container) => applyLogoToContainer(container, size, dataUrl));
    });
  }

  // ── favicon swap ─────────────────────────────────────────────────────────
  // Neutralize the core favicon links (remember their rel so we can restore),
  // then inject a single managed <link rel="icon"> with the stored data-URL.
  // A custom SVG favicon can otherwise win the browser's icon-priority race, so
  // disabling the originals is required, not cosmetic.
  function coreFaviconLinks() {
    return Array.from(document.querySelectorAll(FAVICON_SELECTOR))
      .filter((l) => l.dataset.hwxBrandingFavicon !== '1');
  }

  function applyFavicon() {
    const head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    const dataUrl = sharedActive() ? '' : getFavicon();
    let injected = head.querySelector('link[data-hwx-branding-favicon="1"]');

    if (dataUrl && isDataImage(dataUrl)) {
      coreFaviconLinks().forEach((l) => {
        if (l.dataset.hwxBrandingOrigRel === undefined) {
          l.dataset.hwxBrandingOrigRel = l.getAttribute('rel') || '';
        }
        l.setAttribute('rel', 'hwx-branding-disabled-icon');
      });
      if (!injected) {
        injected = document.createElement('link');
        injected.setAttribute('rel', 'icon');
        injected.dataset.hwxBrandingFavicon = '1';
        head.appendChild(injected);
      }
      if (injected.getAttribute('href') !== dataUrl) {
        // Remove + re-add a fresh node to force the browser to refresh the icon.
        const fresh = injected.cloneNode(false);
        fresh.setAttribute('type', mimeFromDataUrl(dataUrl));
        fresh.setAttribute('href', dataUrl);
        injected.replaceWith(fresh);
        injected = fresh;
      }
    } else {
      if (injected) injected.remove();
      document.querySelectorAll('link[data-hwx-branding-orig-rel]').forEach((l) => {
        l.setAttribute('rel', l.dataset.hwxBrandingOrigRel || 'icon');
        delete l.dataset.hwxBrandingOrigRel;
      });
    }
  }

  function applyAll() {
    applyLogos();
    applyFavicon();
  }

  // ── image handling: downscale to a small data-URL (aspect preserved) ───────
  function downscaleToDataUrl(file, maxDim, maxBytes, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null, 'Not an image file.'); return; }
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      cb(null, 'Only PNG, JPEG, or WebP images are supported.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) { cb(null, 'Image too large (max 8 MB before downscale).'); return; }
    const reader = new FileReader();
    reader.onerror = () => cb(null, 'Could not read the file.');
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => cb(null, 'Could not decode the image.');
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          let out = canvas.toDataURL('image/png');
          if (out.length > maxBytes) out = canvas.toDataURL('image/jpeg', 0.85);
          if (out.length > maxBytes) { cb(null, 'Image could not be reduced small enough.'); return; }
          cb(out, null);
        } catch (e) { cb(null, 'Image processing failed.'); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ── picker popover ─────────────────────────────────────────────────────────
  function closePicker() {
    if (picker) { picker.remove(); picker = null; }
    if (configureResolve) { const finish = configureResolve; configureResolve = null; finish(); }
    window.removeEventListener('resize', reposition);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    // restore focus to the trigger the picker was opened from (a11y)
    if (lastAnchor && typeof lastAnchor.focus === 'function') { try { lastAnchor.focus(); } catch (_) {} }
    lastAnchor = null;
  }
  function outside(ev) { if (picker && !picker.contains(ev.target)) closePicker(); }
  function esc(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePicker(); } }

  function makeSection(labelText, currentValue, kind, maxDim, maxBytes) {
    const section = document.createElement('div');
    section.className = 'hwx-branding-section';

    const label = document.createElement('div');
    label.className = 'hwx-branding-label';
    label.textContent = labelText;
    section.appendChild(label);

    // Preview box + a "Default" label. The label is a SIBLING of the box (not a
    // child) so the box's fixed size + overflow:hidden can't clip it — a 32px
    // favicon box was clipping "Default" to "efaul".
    const previewRow = document.createElement('div');
    previewRow.className = 'hwx-branding-preview-row';
    const preview = document.createElement('div');
    preview.className = 'hwx-branding-preview hwx-branding-preview-' + kind;
    if (currentValue && isDataImage(currentValue)) {
      const pimg = document.createElement('img');
      pimg.src = currentValue;
      pimg.alt = labelText + ' preview';
      preview.appendChild(pimg);
      previewRow.appendChild(preview);
    } else {
      previewRow.appendChild(preview);
      const none = document.createElement('span');
      none.className = 'hwx-branding-preview-none';
      none.textContent = 'Default';
      previewRow.appendChild(none);
    }
    section.appendChild(previewRow);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'hwx-branding-btn';
    uploadBtn.textContent = currentValue ? 'Change…' : 'Upload…';
    uploadBtn.addEventListener('click', () => input.click());

    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      setStatus('Processing…');
      downscaleToDataUrl(f, maxDim, maxBytes, (dataUrl, err) => {
        if (err) { setStatus(err); return; }
        const ok = (kind === 'favicon') ? setFavicon(dataUrl) : setLogo(dataUrl);
        // rebuildPicker() wipes the popover body (incl. the status node) and
        // restores focus to the first control, so set the message AFTER it —
        // otherwise the honest quota-fail status is erased before paint.
        rebuildPicker();
        setStatus(ok ? 'Applied.' : 'Couldn’t save — storage full.');
      });
    });

    section.appendChild(uploadBtn);
    section.appendChild(input);

    if (currentValue) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'hwx-branding-btn hwx-branding-btn--clear';
      clearBtn.textContent = 'Remove';
      clearBtn.addEventListener('click', () => {
        if (kind === 'favicon') setFavicon(''); else setLogo('');
        rebuildPicker();
      });
      section.appendChild(clearBtn);
    }

    return section;
  }

  function sharedSection() {
    const section = document.createElement('section');
    section.className = 'hwx-branding-section';
    const heading = document.createElement('strong');
    heading.textContent = 'Shared instance'; section.appendChild(heading);
    const info = document.createElement('p'); section.appendChild(info);
    if (!management.can_manage) {
      info.textContent = 'Turn on WebUI password protection and sign in as owner to change shared branding.';
      return section;
    }
    ensureDraft();
    info.textContent = management.provider_available ? 'The shared name and image are public. Upload happens only when you save.' :
      "Shared branding isn't active on this server.";
    const disabled = busy || !etag;
    const providerMissing = !management.provider_available;
    function button(text, action, unavailable = false) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'hwx-branding-btn'; btn.textContent = text;
      btn.disabled = busy || unavailable;
      btn.addEventListener('click', action); section.appendChild(btn); return btn;
    }
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Instance name';
    const name = document.createElement('input');
    name.id = 'hwxSharedName'; name.type = 'text'; name.maxLength = 80; name.value = draft.name;
    name.disabled = disabled || providerMissing || !management.name_supported;
    name.addEventListener('input', () => { draft.name = name.value; draftDirty = true; });
    nameLabel.appendChild(name); section.appendChild(nameLabel);
    const adoptLabel = document.createElement('label');
    const adopt = document.createElement('input'); adopt.type = 'checkbox'; adopt.checked = draft.adopt;
    adopt.disabled = name.disabled;
    adopt.addEventListener('change', () => { draft.adopt = adopt.checked; draftDirty = true; });
    adoptLabel.append(adopt, document.createTextNode(' Remove this name when sharing is turned off or reset'));
    section.appendChild(adoptLabel);
    const preview = document.createElement('div'); preview.className = 'hwx-branding-preview-row';
    const current = previewURL || sharedLogo();
    if (current) {
      const img = document.createElement('img'); img.className = 'hwx-branding-preview-logo';
      img.src = current; img.alt = draft.file ? 'Prepared shared image' : 'Current shared image'; preview.appendChild(img);
    }
    const imageState = document.createElement('span');
    imageState.textContent = draft.file ? 'Image ready to save' : management.config.image_revision ? 'Image set' : 'None';
    preview.appendChild(imageState); section.appendChild(preview);
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png'; input.hidden = true;
    input.dataset.sharedImage = '1';
    input.disabled = disabled || providerMissing || !management.can_upload;
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file) return;
      if (file.type !== 'image/png' || file.size > 2 * 1024 * 1024) { setStatus('Choose a PNG up to 2 MB.'); input.value = ''; return; }
      clearPreview();
      draft.file = file; draftDirty = true;
      if (typeof URL.createObjectURL === 'function') previewURL = URL.createObjectURL(file);
      rebuildPicker();
    });
    button('Upload…', () => input.click(), input.disabled);
    section.appendChild(input);
    const limits = document.createElement('p'); limits.textContent = 'Square PNG, 512–2048 px, max 2 MB'; section.appendChild(limits);
    if (!management.can_upload && management.provider_available) {
      const note = document.createElement('p');
      note.textContent = 'Image import unavailable. Install the optional image dependency in the WebUI environment; existing images and names remain available.';
      section.appendChild(note);
    }
    const enableLabel = document.createElement('label');
    const enable = document.createElement('input'); enable.type = 'checkbox'; enable.checked = draft.enabled;
    enable.dataset.sharedEnabled = '1'; enable.disabled = disabled || (providerMissing && !management.config.enabled);
    enable.addEventListener('change', () => { draft.enabled = enable.checked; draftDirty = true; });
    enableLabel.append(enable, document.createTextNode(' Enable sharing')); section.appendChild(enableLabel);
    const reloadNote = document.createElement('p');
    reloadNote.textContent = 'Saving reloads this page. Save other unfinished work first.'; section.appendChild(reloadNote);
    button('Save', () => writeShared(), disabled || providerMissing || (!!draft.file && !management.can_upload));
    const status = document.createElement('div'); status.className = 'hwx-branding-save-status';
    status.setAttribute('role', 'status'); status.textContent = saveMessage;
    status.classList.toggle('hwx-branding-save-status--error', !busy && !etag); section.appendChild(status);
    if (!etag) button('Refresh shared settings', readShared);
    if (providerMissing && management.config.enabled) button('Disable sharing', () => {
      draft.enabled = false; draftDirty = true; writeSharedDisabled();
    }, disabled);
    button('Reset shared branding…', () => writeShared(true), disabled).classList.add('hwx-branding-btn--clear');
    return section;
  }
  async function writeSharedDisabled() {
    if (busy || !etag || !management?.can_manage) return;
    busy = true; ++readEpoch; rebuildPicker();
    try { await postShared({enabled: false}); location.reload(); }
    catch (_) { etag = null; saveMessage = 'Save could not be confirmed. Refresh shared settings before trying again.'; }
    finally { busy = false; rebuildPicker(); }
  }
  function buildPickerBody() {
    const frag = document.createDocumentFragment();
    const title = document.createElement('div'); title.className = 'hwx-branding-title';
    const label = document.createElement('span'); label.textContent = 'Custom Branding'; title.appendChild(label);
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'hwx-branding-btn hwx-branding-close'; close.textContent = '×';
    close.setAttribute('aria-label', 'Close'); close.addEventListener('click', closePicker);
    title.appendChild(close); frag.appendChild(title);
    if (management) frag.appendChild(sharedSection());
    if (readError) {
      const retry = document.createElement('div');
      const note = document.createElement('p'); note.setAttribute('role', 'status');
      note.textContent = "Shared branding isn't available right now."; retry.appendChild(note);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'hwx-branding-btn';
      btn.textContent = 'Retry'; btn.disabled = busy; btn.addEventListener('click', readShared); retry.appendChild(btn);
      frag.appendChild(retry);
    }
    if (sharedActive()) {
      const personal = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Personal images (paused while sharing is active)';
      personal.appendChild(summary);
      const note = document.createElement('p'); note.textContent = 'Your personal images are kept on this browser.'; personal.appendChild(note);
      personal.open = personalOpen;
      personal.addEventListener('toggle', () => { personalOpen = personal.open; position(lastAnchor); });
      frag.appendChild(personal);
    } else {
      frag.appendChild(makeSection('Logo', getLogo(), 'logo', LOGO_MAX_DIM, LOGO_MAX_BYTES));
      frag.appendChild(makeSection('Favicon', getFavicon(), 'favicon', FAVICON_MAX_DIM, FAVICON_MAX_BYTES));
    }
    const status = document.createElement('div'); status.className = 'hwx-branding-status';
    status.id = 'hwxBrandingStatus'; status.setAttribute('role', 'status'); frag.appendChild(status);
    return frag;
  }
  let personalOpen = false;
  function focusPicker() {
    const target = picker?.querySelector('input[type=text]:not(:disabled), .hwx-branding-section button:not(:disabled)') || picker?.querySelector('button');
    try { target?.focus(); } catch (_) {}
  }
  function rebuildPicker() {
    if (!picker) return;
    const focused = picker.contains(document.activeElement);
    picker.textContent = ''; picker.appendChild(buildPickerBody());
    position(lastAnchor);
    if (focused) focusPicker();
  }
  function openPicker(anchor) {
    closePicker();
    lastAnchor = anchor || null;
    picker = document.createElement('div'); picker.className = 'hwx-branding-picker';
    picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'Custom Branding');
    // Light dismiss; no aria-modal claim because Tab can leave the picker.
    picker.setAttribute('tabindex', '-1'); picker.appendChild(buildPickerBody());
    document.body.appendChild(picker); position(anchor); focusPicker();
    readShared();
    window.addEventListener('resize', reposition);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
  }

  function setStatus(msg) {
    const s = document.getElementById('hwxBrandingStatus');
    if (s) s.textContent = msg || '';
  }

  function reposition() { position(lastAnchor); }
  function position(anchor) {
    if (!picker) return;
    if (!anchor) { picker.style.left = Math.max(8, (window.innerWidth - (picker.offsetWidth || 360)) / 2) + 'px'; picker.style.top = '8px'; return; }
    const r = anchor.getBoundingClientRect();
    const w = picker.offsetWidth || 240;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    picker.style.left = left + 'px';
    let top = r.bottom + 6;
    const h = picker.offsetHeight || 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    picker.style.top = Math.min(top, Math.max(8, window.innerHeight - h - 8)) + 'px';
  }

  const wired = new WeakMap();
  function wireClick(container) {
    if (!container) return;
    const allowed = management?.can_manage !== false && (!sharedActive() || management?.can_manage === true) &&
      !(configureRegistered && container.matches('.empty-logo'));
    const old = wired.get(container);
    if (!allowed) {
      if (old) {
        container.removeEventListener('click', old.open); container.removeEventListener('keydown', old.key);
        for (const [key, value] of Object.entries(old.attrs)) {
          if (value === null) container.removeAttribute(key); else container.setAttribute(key, value);
        }
        delete container.dataset.hwxBrandingWired; wired.delete(container);
      }
      return;
    }
    if (old) return;
    const attrs = Object.fromEntries(['style', 'title', 'aria-hidden', 'role', 'tabindex', 'aria-label'].map(k => [k, container.getAttribute(k)]));
    container.dataset.hwxBrandingWired = '1';
    container.style.cursor = 'pointer';
    // The titlebar is a PWA drag region (core .app-titlebar sets
    // -webkit-app-region:drag). Opt this control out — otherwise, in an installed
    // desktop PWA, clicking the titlebar logo starts a window drag and the picker
    // never opens (core does the same for its own titlebar buttons).
    container.style.setProperty('-webkit-app-region', 'no-drag');
    container.style.setProperty('app-region', 'no-drag');
    container.title = 'Configure Custom Branding';
    // a11y: the core mark is aria-hidden with no keyboard role. Make our edit
    // affordance reachable by keyboard + screen readers once we own the click.
    container.removeAttribute('aria-hidden');
    if (!container.hasAttribute('role')) container.setAttribute('role', 'button');
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
    container.setAttribute('aria-label', 'Configure Custom Branding');
    const open = (ev) => { ev.preventDefault(); ev.stopPropagation(); openPicker(container); };
    container.addEventListener('click', open);
    const key = (ev) => { if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') open(ev); };
    container.addEventListener('keydown', key);
    wired.set(container, {open, key, attrs});
  }

  // ── observe re-renders ─────────────────────────────────────────────────────
  let raf = false;
  function schedule() {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => { raf = false; try { applyAll(); } catch (_) {} });
  }

  function startObserver() {
    if (observer) return true;
    const container = document.body;
    observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
    return true;
  }

  function install(attempt) {
    attempt = attempt || 0;
    const haveLogo = document.querySelector('.app-titlebar-icon') || document.querySelector('.empty-logo');
    if (haveLogo || document.getElementById('messages')) {
      startObserver();
      window.HermesCustomBrandingExtension = {
        version: '0.2.1',
        getLogo: getLogo,
        getFavicon: getFavicon,
        // setLogo/setFavicon gate the value internally (isDataImage) and return
        // true on success / false if rejected or storage failed.
        setLogo: (dataUrl) => setLogo(dataUrl),
        setFavicon: (dataUrl) => setFavicon(dataUrl),
        clearLogo: () => setLogo(''),
        clearFavicon: () => setFavicon(''),
        refresh: applyAll,
        open: () => openPicker(null)
      };
      try {
        const handle = window.hermesExt?.register?.(EXT);
        if (typeof handle?.settings?.registerConfigure === 'function') {
          const unregister = handle.settings.registerConfigure(() => new Promise((resolve) => {
            openPicker(document.activeElement);
            configureResolve = resolve;
          }));
          configureRegistered = typeof unregister === 'function';
        }
      } catch (_) { /* Legacy core keeps the titlebar picker. */ }
      applyAll();
      if (hasBootstrap) readShared();
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] titlebar/logo containers not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
