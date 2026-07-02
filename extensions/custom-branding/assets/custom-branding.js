(() => {
  'use strict';

  // ── Custom Branding extension for Hermes WebUI ───────────────────────────
  // White-label the Hermes chrome with your own logo + favicon. Click the
  // titlebar logo to open a small picker (upload / clear a logo, upload / clear
  // a favicon). Uploaded images are processed entirely in the browser
  // (FileReader -> <canvas> downscale -> data-URL) and stored in localStorage;
  // nothing is uploaded anywhere.
  //
  // On boot and on every DOM re-render it swaps:
  //   - the app titlebar logo (the inline <svg> inside .app-titlebar-icon)
  //   - the empty-state hero logo (the inline <svg> inside .empty-logo)
  //   - the favicon <link> nodes in <head> (rel="icon" / "shortcut icon" /
  //     "apple-touch-icon")
  // with your stored images, and restores the originals when you clear them.
  //
  // Rebuilt as a client-side extension from closed core PR
  // nesquena/hermes-webui#3307 (author: @gavinssr, "Add custom logo and favicon
  // uploads"). #3307 shipped a server-side upload endpoint + config.yaml
  // persistence; extensions cannot add core endpoints, so this is a pure
  // client-side rebuild using localStorage data-URLs.
  //
  // Pure DOM-injection, client-side only — no core changes, no backend.

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

    if (dataUrl && isDataImage(dataUrl)) {
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
    const dataUrl = getLogo();
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
    const dataUrl = getFavicon();
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
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    // restore focus to the trigger the picker was opened from (a11y)
    if (lastAnchor && typeof lastAnchor.focus === 'function') { try { lastAnchor.focus(); } catch (_) {} }
    lastAnchor = null;
  }
  function outside(ev) { if (picker && !picker.contains(ev.target)) closePicker(); }
  function esc(ev) { if (ev.key === 'Escape') closePicker(); }

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

  function buildPickerBody() {
    const frag = document.createDocumentFragment();

    const title = document.createElement('div');
    title.className = 'hwx-branding-title';
    title.textContent = 'Custom Branding';
    frag.appendChild(title);

    frag.appendChild(makeSection('Logo', getLogo(), 'logo', LOGO_MAX_DIM, LOGO_MAX_BYTES));
    frag.appendChild(makeSection('Favicon', getFavicon(), 'favicon', FAVICON_MAX_DIM, FAVICON_MAX_BYTES));

    const status = document.createElement('div');
    status.className = 'hwx-branding-status';
    status.id = 'hwxBrandingStatus';
    // role="status" (implicit aria-live="polite") so the "Couldn't save — storage
    // full." message is announced to screen-reader users, not just shown visually.
    status.setAttribute('role', 'status');
    frag.appendChild(status);

    return frag;
  }

  function rebuildPicker() {
    if (!picker) return;
    picker.textContent = '';
    picker.appendChild(buildPickerBody());
    // Any rebuild destroys the control the user just activated (Upload/Remove),
    // dropping keyboard focus to <body>. Restore it to the first control so a
    // keyboard user stays inside the dialog. Centralized here so every call-site
    // (upload + remove) is covered.
    const firstBtn = picker.querySelector('button');
    if (firstBtn) { try { firstBtn.focus(); } catch (_) {} }
  }

  function openPicker(anchor) {
    closePicker();
    lastAnchor = anchor || null;
    picker = document.createElement('div');
    picker.className = 'hwx-branding-picker';
    picker.setAttribute('role', 'dialog');
    // Light-dismiss popover (outside-click / Esc closes it); we don't trap Tab,
    // so don't claim aria-modal — that would tell a screen reader focus is
    // trapped when it isn't.
    picker.setAttribute('aria-label', 'Custom Branding');
    picker.setAttribute('tabindex', '-1');
    picker.appendChild(buildPickerBody());
    document.body.appendChild(picker);
    position(anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    // move focus into the dialog on open (first focusable, else the dialog)
    const focusTarget = picker.querySelector('button, input, [tabindex]') || picker;
    try { focusTarget.focus(); } catch (_) {}
  }

  function setStatus(msg) {
    const s = document.getElementById('hwxBrandingStatus');
    if (s) s.textContent = msg || '';
  }

  function position(anchor) {
    if (!picker || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = picker.offsetWidth || 240;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    picker.style.left = left + 'px';
    let top = r.bottom + 6;
    const h = picker.offsetHeight || 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    picker.style.top = top + 'px';
  }

  function wireClick(container) {
    if (!container || container.dataset.hwxBrandingWired) return;
    container.dataset.hwxBrandingWired = '1';
    container.style.cursor = 'pointer';
    // The titlebar is a PWA drag region (core .app-titlebar sets
    // -webkit-app-region:drag). Opt this control out — otherwise, in an installed
    // desktop PWA, clicking the titlebar logo starts a window drag and the picker
    // never opens (core does the same for its own titlebar buttons).
    container.style.setProperty('-webkit-app-region', 'no-drag');
    container.style.setProperty('app-region', 'no-drag');
    container.title = 'Click to set a custom logo / favicon';
    // a11y: the core mark is aria-hidden with no keyboard role. Make our edit
    // affordance reachable by keyboard + screen readers once we own the click.
    container.removeAttribute('aria-hidden');
    if (!container.hasAttribute('role')) container.setAttribute('role', 'button');
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
    container.setAttribute('aria-label', 'Set a custom logo or favicon');
    const open = (ev) => { ev.preventDefault(); ev.stopPropagation(); openPicker(container); };
    container.addEventListener('click', open);
    container.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') open(ev);
    });
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
      applyAll();
      window.HermesCustomBrandingExtension = {
        version: '0.1.0',
        getLogo: getLogo,
        getFavicon: getFavicon,
        // setLogo/setFavicon gate the value internally (isDataImage) and return
        // true on success / false if rejected or storage failed.
        setLogo: (dataUrl) => setLogo(dataUrl),
        setFavicon: (dataUrl) => setFavicon(dataUrl),
        clearLogo: () => setLogo(''),
        clearFavicon: () => setFavicon(''),
        refresh: applyAll
      };
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
