(() => {
  'use strict';

  // ── Model Favorites extension for Hermes WebUI ───────────────────────────
  // Lets you star/favorite the models you use most in the composer model
  // picker. Favorited models are promoted into a "★ Favorites" group at the top
  // of the dropdown for one-click switching. Favorites persist locally and are
  // provider-aware (the same model id under two providers is two distinct
  // favorites).
  //
  // Pure DOM-injection over the existing picker (no core changes, no backend).
  // The picker re-renders on open/search/select, so a MutationObserver re-applies
  // the stars + the Favorites group after every rebuild.

  const EXT = 'model-favorites';
  if (window.__hermesModelFavoritesLoaded) return;
  window.__hermesModelFavoritesLoaded = true;

  const STORAGE_KEY = 'hermes-ext-model-favorites';
  const DD_ID = 'composerModelDropdown';
  const FAV_GROUP_FLAG = 'hwxFavGroup';     // marks our injected group
  const STAR_FLAG = 'hwxFavStar';           // marks a wired star button
  const DECOR_FLAG = 'hwxFavDecorated';     // marks a row we've decorated

  let observer = null;
  let applying = false;                     // re-entrancy guard (we mutate the DD)

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── persistence ──────────────────────────────────────────────────────────
  function loadFavs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((f) => f && typeof f.id === 'string') : [];
    } catch (_) { return []; }
  }
  function saveFavs(favs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favs)); } catch (_) {}
  }
  // Provider-aware identity key.
  function favKey(id, provider) { return (provider || '') + '\u241F' + (id || ''); }
  function isFav(id, provider, favs) {
    const k = favKey(id, provider);
    return (favs || loadFavs()).some((f) => favKey(f.id, f.provider) === k);
  }

  // ── read a row's identity from the existing DOM ──────────────────────────
  // Provider identity: prefer the visible .model-opt-provider chip, but core omits
  // it for rows under their own provider heading — in that case derive it from the
  // enclosing core group wrapper .model-group-body[data-group] (data-group is the
  // providerId, set in core ui.js renderModelDropdown). (Codex gate, PR #23.)
  function rowProvider(row) {
    const provEl = row.querySelector(':scope .model-opt-provider');
    if (provEl && provEl.textContent.trim()) return provEl.textContent.trim();
    const grp = row.closest('.model-group-body[data-group]');
    if (grp && grp.dataset && grp.dataset.group && grp.dataset.group !== '__ungrouped__') {
      return grp.dataset.group;
    }
    return '';
  }
  function rowInfo(row) {
    const idEl = row.querySelector(':scope .model-opt-id');
    const nameEl = row.querySelector(':scope .model-opt-name');
    const id = idEl ? idEl.textContent.trim() : '';
    const name = nameEl ? nameEl.textContent.trim() : id;
    const provider = rowProvider(row);
    return { id, name, provider };
  }

  function toggleFav(id, name, provider) {
    let favs = loadFavs();
    const k = favKey(id, provider);
    if (favs.some((f) => favKey(f.id, f.provider) === k)) {
      favs = favs.filter((f) => favKey(f.id, f.provider) !== k);
    } else {
      favs.push({ id, name, provider });
    }
    saveFavs(favs);
    apply();   // re-decorate + rebuild the favorites group
  }

  function starSvg(filled) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  }

  function makeStar(info, favs) {
    const fav = isFav(info.id, info.provider, favs);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hwx-fav-star' + (fav ? ' hwx-fav-star--on' : '');
    btn.dataset[STAR_FLAG] = '1';
    btn.title = fav ? 'Remove from favorites' : 'Add to favorites';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    btn.innerHTML = starSvg(fav);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();           // never trigger the row's model-select onclick
      toggleFav(info.id, info.name, info.provider);
    });
    return btn;
  }

  // ── build the Favorites group at the top of the dropdown ─────────────────
  function buildFavGroup(dd, favs) {
    // Remove any prior injected group first (idempotent rebuild).
    const prior = dd.querySelector(':scope > [data-' + 'hwx-fav-group="1"]');
    if (prior) prior.remove();
    if (!favs.length) return;

    const wrap = document.createElement('div');
    wrap.setAttribute('data-hwx-fav-group', '1');
    wrap.className = 'hwx-fav-group';

    const heading = document.createElement('div');
    heading.className = 'model-group hwx-fav-heading';
    heading.textContent = '\u2605 Favorites';
    wrap.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'model-group-body';

    for (const f of favs) {
      const row = document.createElement('div');
      row.className = 'model-opt hwx-fav-row';
      const provChip = f.provider
        ? '<span class="model-opt-provider">' + escapeHtml(f.provider) + '</span>' : '';
      row.innerHTML = '<div class="model-opt-top"><span class="model-opt-name">' +
        escapeHtml(f.name || f.id) + '</span>' + provChip + '</div>' +
        '<span class="model-opt-id">' + escapeHtml(f.id) + '</span>';
      // Selecting a favorite: prefer re-clicking the REAL core row so the exact
      // providerId (carried only in core's row.onclick closure, not exposed as a
      // DOM attribute) is used. Match the live row by model id; only fall back to
      // selectModelFromDropdown(id) when no live row exists. This avoids selecting
      // the wrong provider for duplicate model ids. (Codex gate, PR #23.)
      row.addEventListener('click', (ev) => {
        const star = ev.target.closest('.hwx-fav-star');
        if (star) return;
        const dd = document.getElementById(DD_ID);
        let liveRow = null;
        if (dd) {
          dd.querySelectorAll('.model-opt:not(.hwx-fav-row)').forEach((r) => {
            if (liveRow) return;
            const info = rowInfo(r);
            // Match on id + provider so duplicate model ids across providers don't
            // re-click the wrong row. (Codex gate, PR #23.)
            if (info.id === f.id && (info.provider || '') === (f.provider || '')) liveRow = r;
          });
        }
        if (liveRow && typeof liveRow.click === 'function') {
          liveRow.click();   // exact core selection incl. real providerId
          return;
        }
        if (typeof window.selectModelFromDropdown === 'function') {
          window.selectModelFromDropdown(f.id, f.provider || null);
        }
      });
      // a star (filled) to allow un-favoriting directly from the group —
      // placed inside .model-opt-top so it sits inline with the name, matching
      // the main list rows.
      const top = row.querySelector('.model-opt-top') || row;
      top.appendChild(makeStar({ id: f.id, name: f.name, provider: f.provider }, favs));
      body.appendChild(row);
    }
    wrap.appendChild(body);
    dd.insertBefore(wrap, dd.firstChild);
  }

  // ── decorate every real model row with a star ────────────────────────────
  function decorateRows(dd, favs) {
    const rows = dd.querySelectorAll('.model-opt');
    rows.forEach((row) => {
      if (row.classList.contains('hwx-fav-row')) return;   // our own group's rows
      const info = rowInfo(row);
      if (!info.id) return;
      let star = row.querySelector(':scope > .hwx-fav-star, :scope .model-opt-top > .hwx-fav-star');
      const fav = isFav(info.id, info.provider, favs);
      if (!star) {
        star = makeStar(info, favs);
        const top = row.querySelector(':scope .model-opt-top') || row;
        top.appendChild(star);
        row.dataset[DECOR_FLAG] = '1';
      } else {
        const want = fav;
        const has = star.classList.contains('hwx-fav-star--on');
        if (want !== has) {
          // Only rewrite the star DOM when the filled state actually changed —
          // an unconditional innerHTML rewrite every pass creates childList
          // mutations that can feed an observer loop. (Codex gate, PR #23.)
          star.classList.toggle('hwx-fav-star--on', fav);
          star.setAttribute('aria-pressed', fav ? 'true' : 'false');
          star.title = fav ? 'Remove from favorites' : 'Add to favorites';
          star.innerHTML = starSvg(fav);
        }
      }
    });
  }

  function apply() {
    const dd = document.getElementById(DD_ID);
    if (!dd || applying) return;
    applying = true;
    // Disconnect the observer for the duration of our own mutations so the
    // queued MutationObserver callbacks (which fire on a microtask AFTER the
    // `applying` flag is reset) can't re-trigger apply() in a loop. (Codex gate, PR #23.)
    if (observer) { try { observer.disconnect(); } catch (_) {} }
    try {
      const favs = loadFavs();
      buildFavGroup(dd, favs);
      decorateRows(dd, favs);
    } finally {
      if (observer) { try { observer.observe(dd, { childList: true, subtree: true }); } catch (_) {} }
      applying = false;
    }
  }

  // ── observe re-renders of the dropdown ───────────────────────────────────
  let raf = false;
  function scheduleApply() {
    if (raf || applying) return;   // ignore mutations we caused
    raf = true;
    requestAnimationFrame(() => { raf = false; try { apply(); } catch (_) {} });
  }

  function startObserver() {
    const dd = document.getElementById(DD_ID);
    if (!dd || observer) return !!observer;
    observer = new MutationObserver((mutations) => {
      if (applying) return;
      // Only react to childList changes that aren't purely our own group.
      scheduleApply();
    });
    observer.observe(dd, { childList: true, subtree: true });
    return true;
  }

  function install(attempt) {
    attempt = attempt || 0;
    const dd = document.getElementById(DD_ID);
    if (dd) {
      startObserver();
      apply();
      window.HermesModelFavoritesExtension = {
        version: '0.1.0',
        favorites: loadFavs,
        refresh: apply,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] model dropdown (#' + DD_ID + ') not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
