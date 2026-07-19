/* Profile Avatars — per-profile avatar images across the whole WebUI.
   Server-stored (sidecar SQLite), so avatars sync across every device and are
   delivered as normal HTTP images with ETag + immutable caching — nothing is
   kept in localStorage. Renders in four places:
     1. the native profile chips (titlebar + composer);
     2. assistant role badges in the chat transcript (active profile's image);
     3. the session sidebar — every chat row carries its owning profile's
        avatar (incl. rows revealed by "Show N from other profiles");
     4. a manager modal (upload / replace / remove per profile).
   Falls back to a colored-initial bubble when a profile has no image, and to
   the native glyph on transcript badges. Upstream switches profiles in place
   with no event, so the chip label is observed and everything re-renders. */
(function () {
  'use strict';
  if (window.__profileAvatars) return; window.__profileAvatars = true;
  var EXT = 'profile-avatars';
  var BASE = '/api/extensions/' + EXT + '/sidecar';

  var _byProfile = Object.create(null);
  var _activeName = null;
  var _loaded = false;

  // Consent is granted by the user in Settings -> Extensions; we NEVER auto-grant it.
  // Resolves true only when the proxy reports this extension's sidecar as consented.
  function sidecarConsented() {
    return fetch('/api/extensions/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var recs = (d && (d.extensions || d.records)) || (Array.isArray(d) ? d : []);
        var me = null;
        for (var i = 0; i < recs.length; i++) { if (recs[i] && recs[i].id === EXT) { me = recs[i]; break; } }
        if (!me || !me.sidecars || !me.sidecars.length) return true;
        for (var k = 0; k < me.sidecars.length; k++) {
          var p = me.sidecars[k] && me.sidecars[k].proxy;
          if (p && p.consent_required) return false;
        }
        return true;
      }).catch(function () { return false; });
  }

  function _hashColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return 'hsl(' + (Math.abs(h) % 360) + ', 55%, 45%)';
  }
  function _initial(name) {
    if (!name) return '?';
    var t = name.trim();
    return t ? t[0].toUpperCase() : '?';
  }
  function _record(name, avatarUrl, opts) {
    if (!name) return;
    opts = opts || {};
    var disp = opts.label || name;
    _byProfile[name] = {
      url: avatarUrl || null,
      blob: null,           // in-memory object URL, filled by _prefetchImages
      initial: _initial(disp),
      color: _hashColor(disp),
      is_default: !!opts.is_default,
      label: disp,
    };
  }

  /* Each avatar is downloaded ONCE per page load into an in-memory blob URL
     that every render target shares (chips, badges, hundreds of session rows).
     The WebUI sidecar proxy stamps no-store on responses, which would defeat
     normal HTTP caching — this sidesteps it with zero persistent storage. */
  var _blobByUrl = Object.create(null);   // source url → object URL
  function _prefetchImages() {
    var jobs = [];
    Object.keys(_byProfile).forEach(function (name) {
      var e = _byProfile[name];
      if (!e.url) return;
      if (_blobByUrl[e.url]) { e.blob = _blobByUrl[e.url]; return; }
      jobs.push(
        fetch(e.url, { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (b) {
            if (!b) return;
            var obj = URL.createObjectURL(b);
            _blobByUrl[e.url] = obj;
            if (_byProfile[name]) _byProfile[name].blob = obj;
          })
          .catch(function () {})
      );
    });
    return jobs.length ? Promise.all(jobs) : Promise.resolve();
  }

  // Roster from /api/profiles (vanilla has no avatar_url) merged with the
  // sidecar's avatar map; image urls are repointed through the proxy.
  function refresh() {
    return Promise.all([
      fetch('/api/profiles', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch(BASE + '/api/avatars', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (res) {
      var data = res[0], amap = (res[1] && res[1].avatars) || {};
      if (!data) return;
      _activeName = data.active || _activeName;
      var profiles = Array.isArray(data.profiles) ? data.profiles : [];
      for (var k in _byProfile) delete _byProfile[k];
      for (var i = 0; i < profiles.length; i++) {
        var p = profiles[i];
        var raw = amap[p.name] && amap[p.name].url;
        var url = raw ? (BASE + raw) : null;
        if (p.is_default) _record(p.name, url, { is_default: true, label: window._botName || 'Hermes' });
        else _record(p.name, url);
      }
      _loaded = true;
      _broadcast();                            // initial bubbles render immediately
      return _prefetchImages().then(_broadcast);  // images swap in once fetched (once each)
    });
  }

  function _broadcast() {
    document.querySelectorAll('[data-avatar-profile]').forEach(function (el) {
      renderInto(el, el.getAttribute('data-avatar-profile'));
    });
    document.querySelectorAll('[data-avatar-active]').forEach(function (el) {
      renderInto(el, _activeName);
    });
    _renderBadges();
    _decorateSessionRows();
    if (document.getElementById('paAvatarManager')) _renderManagerList();
  }

  function active() { return _activeName; }
  function entry(name) { return _byProfile[name] || null; }
  function list() {
    return Object.keys(_byProfile).map(function (n) { return Object.assign({ name: n }, _byProfile[n] || {}); });
  }

  function renderInto(el, name, opts) {
    if (!el) return;
    var o = opts || {};
    var shape = o.shape === 'square' ? 'pa-avatar--square' : 'pa-avatar--circle';
    el.classList.add('pa-avatar', shape);
    if (o.size) el.classList.add('pa-avatar--' + o.size);
    el.innerHTML = '';
    var e = name ? _byProfile[name] : null;
    if (e && e.blob) {
      var img = document.createElement('img');
      img.src = e.blob; img.alt = name; img.decoding = 'async';
      img.onerror = function () { _renderInitial(el, name); };
      el.appendChild(img);
    } else {
      // No image yet (none set, or blob still prefetching — a later
      // _broadcast swaps the real image in).
      _renderInitial(el, name);
    }
  }
  function _renderInitial(el, name) {
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = 'pa-avatar__initial';
    span.textContent = _initial(name);
    span.style.background = name ? _hashColor(name) : '#888';
    span.title = name || '';
    el.appendChild(span);
  }

  /* ---- Transcript: assistant role badges show the active profile's image.
     Only swaps when an image exists; the native letter glyph is preserved
     and restored otherwise. ---- */
  function _renderBadges() {
    var e = _activeName ? _byProfile[_activeName] : null;
    document.querySelectorAll('.role-icon.assistant').forEach(function (el) {
      if (e && e.blob) {
        var img = el.querySelector('img.pa-badge-img');
        if (img && img.getAttribute('src') === e.blob) return;   // already right
        if (el.dataset.paOrig === undefined) el.dataset.paOrig = el.innerHTML;
        el.classList.add('pa-badge');
        el.innerHTML = '';
        img = document.createElement('img');
        img.className = 'pa-badge-img';
        img.src = e.blob; img.alt = _activeName; img.decoding = 'async';
        img.onerror = function () { _restoreBadge(el); };
        el.appendChild(img);
      } else {
        _restoreBadge(el);
      }
    });
  }
  function _restoreBadge(el) {
    if (el.dataset.paOrig !== undefined) {
      el.innerHTML = el.dataset.paOrig;
      delete el.dataset.paOrig;
    }
    el.classList.remove('pa-badge');
  }

  /* ---- Session sidebar: every row gets its owning profile's avatar next
     to the title (with "Show N from other profiles" you see exactly who
     initiated each chat). The sid → profile map comes from
     /api/sessions?all_profiles=1, throttled, in memory only. ---- */
  var _sessProf = Object.create(null);
  var _sessProfAt = 0;
  var _sessProfInflight = null;
  var _SESS_TTL = 20000;  // ms between map refetches

  function _fetchSessionProfiles(force) {
    var now = Date.now();
    if (!force && now - _sessProfAt < _SESS_TTL) return Promise.resolve();
    if (_sessProfInflight) return _sessProfInflight;
    // core /api/sessions honours only ?all_profiles=1 (limit/offset/archived
    // params are ignored — verified in source), so we don't send them.
    _sessProfInflight = fetch('/api/sessions?all_profiles=1', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var arr = (d && Array.isArray(d.sessions)) ? d.sessions : [];
        _sessProf = Object.create(null);
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          if (s && s.session_id) _sessProf[s.session_id] = s.profile || 'default';
        }
        _sessProfAt = Date.now();
      })
      .catch(function () {})
      .then(function () { _sessProfInflight = null; });
    return _sessProfInflight;
  }

  function _decorateSessionRows() {
    // "Which agent owns this chat" is only meaningful with ≥2 profiles; with a
    // single profile every row would get an identical, information-free bubble
    // on the session list — so skip decoration entirely in that case.
    var multiProfile = Object.keys(_byProfile).length >= 2;
    document.querySelectorAll('.session-item[data-sid]').forEach(function (row) {
      var sid = row.dataset.sid;
      // Only decorate rows whose owning profile the map actually knows. Never
      // fall back to the active profile for an unknown sid: core's /api/sessions
      // exposes no archived/pagination params (verified in source), so archived
      // and other rows can be absent from the map, and guessing "active" would
      // mis-stamp them with the wrong avatar.
      var p = multiProfile ? _sessProf[sid] : null;
      var titleRow = row.querySelector('.session-title-row');
      var slot = row.querySelector('.pa-session-avatar');
      if (p && _byProfile[p] && titleRow) {
        if (!slot) {
          slot = document.createElement('span');
          slot.className = 'pa-session-avatar';
          titleRow.insertBefore(slot, titleRow.firstChild);
        }
        var e = _byProfile[p];
        // Re-render when the profile changes OR when its image finished
        // downloading after we'd only drawn the letter fallback. Without the
        // second condition the row was stamped once (as a letter) and never
        // upgraded to the image — the "avatars missing until I refresh" bug.
        var wantImg = e.blob ? '1' : '0';
        if (slot.dataset.paFor !== p || slot.dataset.paImg !== wantImg) {
          slot.dataset.paFor = p;
          slot.dataset.paImg = wantImg;
          slot.title = (e && e.label) || p;
          renderInto(slot, p, { size: 'xs' });
        }
      } else if (slot) {
        slot.remove();
      }
    });
  }

  // Background map upkeep only. Rows are decorated SYNCHRONOUSLY from the
  // cached map when the list re-renders (pre-paint, so no visible pop-in /
  // jitter); this just refreshes the sid → profile map when stale and
  // re-decorates in case it changed (idempotent — unchanged rows are skipped).
  var _decorateTimer = null;
  function _decorateSoon() {
    clearTimeout(_decorateTimer);
    _decorateTimer = setTimeout(function () {
      _fetchSessionProfiles(false).then(_decorateSessionRows);
    }, 500);
  }

  function upload(name, blob) {
    var fd = new FormData();
    fd.append('avatar', blob, blob.name || 'avatar');
    return fetch(BASE + '/api/avatars/' + encodeURIComponent(name), {
      method: 'POST', body: fd, credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (jj) {
        throw new Error(jj.error || ('Upload failed (HTTP ' + r.status + ')'));
      });
      return r.json();
    }).then(function (jj) {
      var raw = jj.url || ('/api/avatars/' + name + '?v=' + Math.floor(Date.now() / 1000));
      _record(name, BASE + raw, _byProfile[name] || {});
      return _prefetchImages().then(function () { _broadcast(); return jj; });
    });
  }
  function remove(name) {
    return fetch(BASE + '/api/avatars/' + encodeURIComponent(name), {
      method: 'DELETE', credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (jj) {
        throw new Error(jj.error || ('Delete failed (HTTP ' + r.status + ')'));
      });
      if (_byProfile[name]) { _byProfile[name].url = null; _byProfile[name].blob = null; }
      _broadcast();
      return r.json();
    });
  }

  window.addEventListener('profileSwitched', function () {
    refresh().then(function () { _fetchSessionProfiles(true).then(_decorateSessionRows); });
  });

  function _watch() {
    if (!('MutationObserver' in window)) return;
    new MutationObserver(function (muts) {
      var sawSessions = false, sawBadges = false;
      for (var a = 0; a < muts.length; a++) {
        var nodes = muts[a].addedNodes || [];
        for (var b = 0; b < nodes.length; b++) {
          var node = nodes[b];
          if (!(node instanceof Element)) continue;
          if (node.matches && node.matches('[data-avatar-active]')) renderInto(node, _activeName);
          else if (node.matches && node.matches('[data-avatar-profile]')) renderInto(node, node.getAttribute('data-avatar-profile'));
          if (node.querySelectorAll) {
            node.querySelectorAll('[data-avatar-active]').forEach(function (el) {
              if (!el.querySelector('img,.pa-avatar__initial')) renderInto(el, _activeName);
            });
            node.querySelectorAll('[data-avatar-profile]').forEach(function (el) {
              if (!el.querySelector('img,.pa-avatar__initial')) renderInto(el, el.getAttribute('data-avatar-profile'));
            });
          }
          if (!sawSessions && node.matches &&
              (node.matches('.session-item') || (node.querySelector && node.querySelector('.session-item')))) {
            sawSessions = true;
          }
          if (!sawBadges && node.matches &&
              (node.matches('.role-icon.assistant') || (node.querySelector && node.querySelector('.role-icon.assistant')))) {
            sawBadges = true;
          }
        }
      }
      if (sawSessions) {
        _decorateSessionRows();   // sync from cached map — runs before paint
        _decorateSoon();          // then refresh the map in the background
      }
      if (sawBadges) _renderBadges();
    }).observe(document.body, { childList: true, subtree: true });
  }

  function _setActive(name) {
    if (!name) return;
    _activeName = name;
    document.querySelectorAll('[data-avatar-active]').forEach(function (el) { renderInto(el, name); });
    _renderBadges();
    _decorateSessionRows();
  }

  /* Enhance upstream's NATIVE profile chips (titlebar + composer) — they ship a
     generic person icon and no avatar. Their icon slots are marked
     data-avatar-active so the real image renders there. Upstream switches
     profiles in place with no event, so the chip LABEL is watched and a switch
     re-fetches + re-renders everything (chips, badges, session rows). */
  function _hookNativeChips() {
    ['.app-titlebar-profile-icon', '.composer-profile-icon'].forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        el.setAttribute('data-avatar-active', '');
        if (_loaded) renderInto(el, _activeName);
      });
    });
    if (!('MutationObserver' in window)) return;
    ['profileChipLabel', 'titlebarProfileLabel'].forEach(function (id) {
      var lblEl = document.getElementById(id);
      if (!lblEl || lblEl.__paAvatarWatched) return;
      lblEl.__paAvatarWatched = true;
      new MutationObserver(function () {
        clearTimeout(_switchDebounce);
        _switchDebounce = setTimeout(function () {
          refresh().then(function () { _fetchSessionProfiles(true).then(_decorateSessionRows); });
        }, 350);  // let the in-place switch settle, then re-fetch
      }).observe(lblEl, { childList: true, characterData: true, subtree: true });
    });
  }
  var _switchDebounce = null;

  /* ---- Manager modal: upload / remove an avatar per profile ---- */
  function _renderManagerList() {
    var wrap = document.getElementById('paAvatarManagerList');
    if (!wrap) return;
    wrap.innerHTML = '';
    var items = list().sort(function (x, y) { return (x.label || x.name).localeCompare(y.label || y.name); });
    items.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'pa-m-row';
      var slot = document.createElement('div');
      slot.className = 'pa-m-slot';
      renderInto(slot, p.name, { size: 'lg' });
      var meta = document.createElement('div');
      meta.className = 'pa-m-meta';
      // Build with textContent — p.label can be the user-set bot name (arbitrary
      // text), so it must never flow through innerHTML.
      var nm = document.createElement('div');
      nm.className = 'pa-m-name';
      nm.textContent = p.label || p.name;
      var sub = document.createElement('div');
      sub.className = 'pa-m-sub';
      sub.textContent = p.url ? 'custom image' : 'initial only';
      meta.appendChild(nm); meta.appendChild(sub);
      var actions = document.createElement('div');
      actions.className = 'pa-m-actions';
      var up = document.createElement('button');
      up.type = 'button'; up.className = 'pa-m-btn'; up.textContent = p.url ? 'Replace' : 'Upload';
      up.onclick = function () { _pickAndUpload(p.name); };
      actions.appendChild(up);
      if (p.url) {
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'pa-m-btn pa-m-btn--danger'; rm.textContent = 'Remove';
        rm.onclick = function () {
          rm.disabled = true;
          remove(p.name).catch(function (e) { alert(e.message); }).then(function () { rm.disabled = false; });
        };
        actions.appendChild(rm);
      }
      row.appendChild(slot); row.appendChild(meta); row.appendChild(actions);
      wrap.appendChild(row);
    });
  }
  function _pickAndUpload(name) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      // 512 KiB matches the core sidecar-proxy's hard response cap — anything
      // larger uploads "ok" then 502s on read, so reject it up front.
      if (f.size > 512 * 1024) { alert('Image too large (max 512 KiB). Resize to 256–512px first.'); return; }
      upload(name, f).catch(function (e) { alert(e.message); });
    };
    inp.click();
  }
  function _buildManager() {
    if (document.getElementById('paAvatarManager')) return;
    var ov = document.createElement('div');
    ov.id = 'paAvatarManager';
    ov.className = 'pa-m-overlay';
    ov.style.display = 'none';
    ov.innerHTML =
      '<div class="pa-m-card" role="dialog" aria-label="Profile avatars">' +
        '<div class="pa-m-topbar"><span class="pa-m-brand">Profile avatars</span>' +
          '<button type="button" class="pa-m-close" id="paAvatarClose" aria-label="Close">&times;</button></div>' +
        '<div class="pa-m-hint">PNG / JPEG / WebP, ≤ 512 KiB. 256–512px square looks best.</div>' +
        '<div class="pa-m-list" id="paAvatarManagerList"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) _closeManager(); });
    document.getElementById('paAvatarClose').addEventListener('click', _closeManager);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.style.display !== 'none') _closeManager();
    });
  }
  function openManager() {
    _buildManager();
    document.getElementById('paAvatarManager').style.display = 'flex';
    (_loaded ? Promise.resolve() : refresh()).then(_renderManagerList);
  }
  function _closeManager() {
    var ov = document.getElementById('paAvatarManager');
    if (ov) ov.style.display = 'none';
  }
  window.paOpenAvatars = openManager;

  // The manager launcher lives in the Profiles tab (#profilesPanel), which the
  // WebUI wipes + rebuilds on every render — so we (re)inject a banner button at
  // its top and watch for rebuilds. Extension-scoped and fully reversible: when
  // the extension is disabled the button simply isn't injected.
  function _injectProfilesLauncher() {
    var panel = document.getElementById('profilesPanel');
    if (!panel || panel.querySelector('#paAvatarLauncher')) return;
    // Don't inject over the "Loading…" placeholder — wait for real content.
    if (!panel.querySelector('.profile-card, .profile-card-header')) return;
    var btn = document.createElement('button');
    btn.id = 'paAvatarLauncher'; btn.type = 'button'; btn.className = 'pa-profiles-launcher';
    btn.setAttribute('aria-label', 'Manage profile avatars');
    btn.innerHTML =
      '<span class="pa-pl-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg></span>' +
      '<span class="pa-pl-text"><span class="pa-pl-title">Profile avatars</span><span class="pa-pl-sub">Upload or remove a photo for each profile</span></span>' +
      '<span class="pa-pl-chevron" aria-hidden="true">&rsaquo;</span>';
    btn.addEventListener('click', openManager);
    panel.insertBefore(btn, panel.firstChild);
  }
  function _addLauncher() {
    _injectProfilesLauncher();
    if (!('MutationObserver' in window)) return;
    var panel = document.getElementById('profilesPanel');
    var target = panel || document.body;   // panel may not exist until first visit
    new MutationObserver(function () { _injectProfilesLauncher(); })
      .observe(target, { childList: true, subtree: !panel });
  }

  window.ProfileAvatars = {
    refresh: refresh, active: active, entry: entry, list: list,
    renderInto: renderInto, upload: upload, remove: remove,
    _setActive: _setActive, openManager: openManager,
  };

  function init() {
    sidecarConsented().then(function (ok) { return ok ? refresh() : null; }).then(function () {
      _fetchSessionProfiles(true).then(_decorateSessionRows);
    });
    _watch(); _hookNativeChips(); _addLauncher();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
