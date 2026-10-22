/* btop for Hermes WebUI — a btop-style system monitor as its own page.
   Adds a rail/nav entry (data-panel="x-btop"), a sidebar view
   (.panel-view[data-panel-token="btop"]) and a main view inside <main>, then
   polls the bundled loopback sidecar through the WebUI sidecar proxy. */
(() => {
  'use strict';
  const EXT = 'btop';
  const PANEL = 'x-btop';
  const BASE = '/api/extensions/btop/sidecar';
  if (window.__hermesBtop) return;
  const C = window.HermesBtopCore;
  if (!C) { console.warn('[btop] core helpers missing'); return; }

  // ── settings + storage ────────────────────────────────────────────────────
  let ext = null;
  try { ext = window.hermesExt && window.hermesExt.register ? window.hermesExt.register(EXT) : null; } catch (_) {}
  const settings = ext && ext.settings && ext.settings.supported ? ext.settings : null;
  const storage = ext && ext.storage ? ext.storage : null;   // extension-owned key "prefs" only
  const DEFAULT_PREFS = {
    boxes: { cpu: true, mem: true, net: true, disk: true, hermes: true, proc: true },
    sort: 'cpu', desc: true, tree: false, iface: null, filter: '',
  };
  function loadPrefs() {
    let p = null;
    try { p = storage ? storage.get('prefs', null) : null; } catch (_) {}
    p = Object.assign({}, DEFAULT_PREFS, p || {});
    p.boxes = Object.assign({}, DEFAULT_PREFS.boxes, (p && p.boxes) || {});
    return p;
  }
  function savePrefs() {
    // Without a registered extension handle there is nowhere sanctioned to
    // persist, so prefs just live for the page.
    try { if (storage) storage.set('prefs', prefs); } catch (_) {}
  }
  function opt(name, fallback) {
    try { if (settings) { const v = settings.get(name); if (v !== undefined) return v; } } catch (_) {}
    return fallback;
  }
  function setOpt(name, value) { try { if (settings) settings.set(name, value); } catch (_) {} }
  const prefs = loadPrefs();

  // ── state ─────────────────────────────────────────────────────────────────
  const st = {
    active: false, paused: false, timer: null, inflight: false,
    boot: '', seq: 0, history: [], snap: null, error: null, lastOk: 0,
    procHist: new Map(), selected: null, detail: null, detailAt: 0,
    collapsed: new Set(), confirm: null, ticks: 0, rows: [], warming: false,
  };

  // ── tiny DOM helpers ──────────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  /* Live regions re-render every tick. Writing innerHTML would destroy a
     focused control (keyboard users could never reach "confirm KILL?", and a
     Space meant for it would land on the page and pause instead). So: skip the
     write when nothing changed, and otherwise restore focus to the control
     with the same identity in the new markup. */
  const FOCUS_KEYS = ['sig', 'act', 'group', 'toggle', 'pick', 'boxToggle', 'sort'];
  function focusKey(el) {
    for (const k of FOCUS_KEYS) if (el.dataset && el.dataset[k] != null) return [k, el.dataset[k]];
    return null;
  }
  function setHTML(el, html) {
    if (!el || el.__hbtHTML === html) return;
    const active = document.activeElement;
    const key = active && el.contains(active) ? focusKey(active) : null;
    el.innerHTML = html;
    el.__hbtHTML = html;
    if (key) {
      const attr = 'data-' + key[0].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      const next = Array.from(el.querySelectorAll('[' + attr + ']')).find((n) => n.getAttribute(attr) === key[1]);
      if (next) { try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); } }
    }
  }
  function meter(pct, kind) {
    const p = C.clamp(Number(pct) || 0, 0, 100);
    return '<span class="hbt-meter' + (kind ? ' hbt-m-' + kind : '') + '" style="--p:' + p.toFixed(1) + '%"><i></i></span>';
  }
  const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M5 12h3l2-4 3 7 2-3h4"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';
  const GROUP_COLORS = ['accent', 'info', 'success', 'warning', 'error', 'link', 'accent2', 'accent3'];
  const groupColor = new Map();
  function colorOf(group) {
    if (!group) return '';
    if (!groupColor.has(group)) groupColor.set(group, GROUP_COLORS[groupColor.size % GROUP_COLORS.length]);
    return groupColor.get(group);
  }

  // ── layout ────────────────────────────────────────────────────────────────
  const BOXES = [['cpu', 'cpu'], ['mem', 'mem'], ['net', 'net'], ['disk', 'disks'], ['hermes', 'hermes'], ['proc', 'proc']];
  function pageHtml() {
    const chips = BOXES.map(([k, label], i) =>
      '<button type="button" class="hbt-chip" data-box-toggle="' + k + '" aria-pressed="true"><sup>' + (i + 1) + '</sup>' + label + '</button>').join('');
    return '' +
      '<div class="hbt-top">' +
        '<div class="hbt-brand"><span class="hbt-logo">btop</span><span class="hbt-host" data-f="host"></span></div>' +
        '<div class="hbt-chips">' + chips + '</div>' +
        '<div class="hbt-ctl">' +
          '<span class="hbt-live" data-f="live"><i></i><span>connecting</span></span>' +
          '<button type="button" class="hbt-btn" data-act="interval" title="Refresh interval">1s</button>' +
          '<button type="button" class="hbt-btn" data-act="graph" title="Graph style">⣿</button>' +
          '<button type="button" class="hbt-btn" data-act="pause" title="Pause (space)">❚❚</button>' +
        '</div>' +
      '</div>' +
      '<div class="hbt-notice" data-f="notice" hidden></div>' +
      '<div class="hbt-grid">' +
        '<section class="hbt-box hbt-cpu" data-box="cpu">' +
          '<h3 class="hbt-title"><sup>1</sup>cpu</h3><span class="hbt-title-r" data-f="cpuInfo"></span>' +
          '<div class="hbt-cpu-body">' +
            '<div class="hbt-graph-wrap"><canvas class="hbt-graph" data-g="cpu"></canvas><span class="hbt-graph-label" data-f="cpuPct"></span></div>' +
            '<div class="hbt-cores"><div class="hbt-core-total" data-f="cpuTotal"></div><div class="hbt-core-list" data-f="cores"></div>' +
              '<div class="hbt-cpu-foot" data-f="cpuFoot"></div></div>' +
          '</div>' +
          '<span class="hbt-title-b" data-f="uptime"></span>' +
        '</section>' +
        '<div class="hbt-left">' +
          '<section class="hbt-box hbt-mem" data-box="mem"><h3 class="hbt-title"><sup>2</sup>mem</h3><span class="hbt-title-r" data-f="memTotal"></span>' +
            '<div class="hbt-rows" data-f="memRows"></div><div class="hbt-graph-wrap hbt-small"><canvas class="hbt-graph" data-g="mem"></canvas></div></section>' +
          '<section class="hbt-box hbt-net" data-box="net"><h3 class="hbt-title"><sup>3</sup>net</h3>' +
            '<span class="hbt-title-r hbt-iface"><button type="button" data-act="iface-prev" aria-label="Previous interface">‹</button><b data-f="iface"></b><button type="button" data-act="iface-next" aria-label="Next interface">›</button></span>' +
            '<div class="hbt-net-body"><div class="hbt-graph-wrap"><canvas class="hbt-graph" data-g="rx"></canvas><span class="hbt-graph-label" data-f="rxLabel"></span></div>' +
            '<div class="hbt-graph-wrap"><canvas class="hbt-graph" data-g="tx"></canvas><span class="hbt-graph-label hbt-bottom" data-f="txLabel"></span></div></div>' +
            '<div class="hbt-net-stats" data-f="netStats"></div></section>' +
          '<section class="hbt-box hbt-disk" data-box="disk"><h3 class="hbt-title"><sup>4</sup>disks</h3><span class="hbt-title-r" data-f="diskIo"></span><div data-f="disks"></div></section>' +
          '<section class="hbt-box hbt-hermes" data-box="hermes"><h3 class="hbt-title"><sup>5</sup>hermes</h3><span class="hbt-title-r" data-f="hermesSum"></span><div data-f="hermes"></div></section>' +
        '</div>' +
        '<section class="hbt-box hbt-proc" data-box="proc"><h3 class="hbt-title"><sup>6</sup>proc</h3><span class="hbt-title-r" data-f="procCount"></span>' +
          '<div class="hbt-proc-bar">' +
            '<label class="hbt-filter"><span>filter</span><input type="search" data-f="filter" placeholder="name, pid, user, g:webui, !root" autocomplete="off" spellcheck="false"></label>' +
            '<button type="button" class="hbt-btn" data-act="tree" aria-pressed="false" title="Tree view (t)">tree</button>' +
            '<button type="button" class="hbt-btn" data-act="percore" aria-pressed="false" title="CPU% per core instead of share of all cores">per-core</button>' +
            '<button type="button" class="hbt-btn" data-act="reverse" title="Reverse sort (r)">↓</button>' +
          '</div>' +
          '<div class="hbt-detail" data-f="detail" hidden></div>' +
          '<div class="hbt-proc-scroll" data-f="procScroll"><table class="hbt-table"><thead><tr>' +
            '<th data-sort="pid" class="hbt-c-pid">pid</th><th data-sort="name" class="hbt-c-name">program</th>' +
            '<th data-sort="cmd" class="hbt-c-cmd">command</th><th data-sort="threads" class="hbt-c-thr">thr</th>' +
            '<th data-sort="user" class="hbt-c-user">user</th><th data-sort="mem" class="hbt-c-mem">mem</th>' +
            '<th data-sort="cpu" class="hbt-c-cpu">cpu%</th>' +
          '</tr></thead><tbody data-f="procBody"></tbody></table></div>' +
        '</section>' +
      '</div>';
  }

  function sideHtml() {
    return '<div class="hbt-side-inner">' +
      '<div class="hbt-side-head">System monitor</div>' +
      '<div class="hbt-side-sec" data-f="sideHost"></div>' +
      '<div class="hbt-side-sec" data-f="sideMeters"></div>' +
      '<div class="hbt-side-label">Hermes</div><div class="hbt-side-sec" data-f="sideHermes"></div>' +
      '<div class="hbt-side-label">Keys</div><div class="hbt-side-sec hbt-side-keys">' +
        '<div><kbd>1</kbd>–<kbd>6</kbd> toggle boxes</div><div><kbd>f</kbd> or <kbd>/</kbd> filter · <kbd>t</kbd> tree</div>' +
        '<div><kbd>c</kbd> <kbd>m</kbd> <kbd>p</kbd> <kbd>n</kbd> sort cpu/mem/pid/name · <kbd>r</kbd> reverse</div>' +
        '<div><kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>Esc</kbd> close · <kbd>space</kbd> pause</div></div>' +
      '</div>';
  }

  let page = null;
  let side = null;
  const F = {};   // data-f lookups

  function mount() {
    const main = document.querySelector('main.main');
    const rail = document.querySelector('.rail');
    if (!main) return false;
    if (!document.getElementById('mainBtop')) {
      page = document.createElement('div');
      page.id = 'mainBtop';
      page.className = 'main-view hbt-page';
      page.setAttribute('role', 'region');
      page.setAttribute('aria-label', 'System monitor');
      page.innerHTML = pageHtml();
      main.appendChild(page);
    } else page = document.getElementById('mainBtop');
    $$('[data-f]', page).forEach((el) => { F[el.dataset.f] = el; });

    const sideHost = (document.getElementById('panelInsights') || document.querySelector('.sidebar .panel-view'));
    if (sideHost && !document.querySelector('.panel-view[data-panel-token="btop"]')) {
      side = document.createElement('div');
      side.className = 'panel-view hbt-side';
      side.id = 'panelXBtop';
      side.dataset.panelToken = 'btop';
      side.innerHTML = sideHtml();
      sideHost.parentNode.appendChild(side);
    } else side = document.querySelector('.panel-view[data-panel-token="btop"]');
    if (side) $$('[data-f]', side).forEach((el) => { F[el.dataset.f] = el; });

    if (rail && !rail.querySelector('[data-panel="' + PANEL + '"]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-btn nav-tab has-tooltip hbt-rail';
      btn.dataset.panel = PANEL;
      btn.dataset.tooltip = 'System monitor';
      btn.setAttribute('aria-label', 'System monitor');
      btn.innerHTML = ICON;
      btn.addEventListener('click', (e) => { e.preventDefault(); onNavClick(); });
      const anchor = rail.querySelector('.rail-spacer');
      rail.insertBefore(btn, anchor || null);
    }
    const nav = document.querySelector('.sidebar-nav');
    if (nav && !nav.querySelector('[data-panel="' + PANEL + '"]')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nav-tab has-tooltip has-tooltip--bottom hbt-nav';
      b.dataset.panel = PANEL;
      b.dataset.label = 'Monitor';
      b.dataset.tooltip = 'System monitor';
      b.setAttribute('aria-label', 'System monitor');
      b.innerHTML = ICON.replace(/width="20" height="20"/, 'width="18" height="18"');
      b.addEventListener('click', (e) => { e.preventDefault(); onNavClick(true); });
      const settingsBtn = nav.querySelector('[data-panel="settings"]');
      nav.insertBefore(b, settingsBtn || null);
    }
    bindPage();
    applyBoxes();
    syncButtons();
    return true;
  }

  // ── navigation ────────────────────────────────────────────────────────────
  const isDesktop = () => (typeof _isDesktopWidth === 'function' ? _isDesktopWidth() : window.innerWidth >= 641);
  const sidebarCollapsed = () => (typeof _isSidebarCollapsed === 'function' ? _isSidebarCollapsed() : false);

  async function onNavClick(fromMobileNav) {
    if (st.active && isDesktop() && !fromMobileNav) {
      // same behaviour as core rail icons: clicking the active one toggles the sidebar
      if (sidebarCollapsed()) { if (typeof expandSidebar === 'function') expandSidebar(); }
      else if (typeof toggleSidebar === 'function') toggleSidebar(true);
      return;
    }
    if (isDesktop() && sidebarCollapsed() && !fromMobileNav && typeof expandSidebar === 'function') expandSidebar();
    await show();
    if (!isDesktop() && typeof closeMobileSidebar === 'function') closeMobileSidebar();
  }

  let coreSwitchPanel = null;   // Core's switchPanel, captured before wrapping

  async function show() {
    const main = document.querySelector('main.main');
    if (!main || !page) return;
    if (!st.active) {
      // Run Core's own panel transition first (to the chat base view). That is
      // what stops Logs auto-refresh, closes the Kanban SSE, honours the
      // unsaved-Settings guard and leaves _currentPanel truthful. Only then
      // overlay the btop view on top of it.
      const sw = coreSwitchPanel || window.switchPanel;
      if (typeof sw === 'function') {
        let ok = true;
        try { ok = await sw.call(window, 'chat'); } catch (_) { ok = true; }
        if (ok === false) return;      // e.g. Settings has unsaved changes
      }
    }
    Array.from(main.classList).filter((c) => c.startsWith('showing-')).forEach((c) => main.classList.remove(c));
    main.classList.add('showing-' + PANEL);
    $$('[data-panel]').forEach((t) => t.classList.toggle('active', t.dataset.panel === PANEL));
    $$('.panel-view').forEach((p) => p.classList.remove('active'));
    if (side) side.classList.add('active');
    st.active = true;
    syncTitle();
    // force a full redraw (graphs size to the now-visible box)
    if (st.snap) render();
    schedule(0);
  }

  function hide() {
    if (!st.active) return;
    st.active = false;
    const main = document.querySelector('main.main');
    if (main) main.classList.remove('showing-' + PANEL);
    if (side) side.classList.remove('active');
    $$('[data-panel="' + PANEL + '"]').forEach((t) => t.classList.remove('active'));
    clearTimeout(st.timer);
    st.timer = null;
  }

  function syncTitle() {
    if (!st.active) return;
    const title = document.getElementById('appTitlebarTitle');
    const sub = document.getElementById('appTitlebarSub');
    if (title && !title.querySelector('input')) {
      setText(title, 'System monitor');
      title.ondblclick = null;            // no chat-title rename on this page
    }
    if (sub) {
      const h = st.snap && st.snap.host ? st.snap.host.hostname : '';
      setText(sub, h);
      sub.hidden = !h;                    // Core toggles the sub with `hidden`
    }
    if (document.title !== 'System monitor') document.title = 'System monitor';
  }

  function wrapCore() {
    const orig = window.switchPanel;
    if (typeof orig === 'function' && !orig.__hbtWrapped) {
      coreSwitchPanel = orig;
      const wrapped = function (name, opts) {
        opts = opts || {};
        if (st.active && name !== PANEL) {
          hide();
          const cur = typeof _currentPanel === 'string' ? _currentPanel : null;
          // core would treat "click the already-current panel" as collapse
          if (opts.fromRailClick && name === cur && isDesktop()) {
            opts = Object.assign({}, opts, { fromRailClick: false });
            if (sidebarCollapsed() && typeof expandSidebar === 'function') expandSidebar();
          }
        }
        return orig.call(this, name, opts);
      };
      wrapped.__hbtWrapped = true;
      window.switchPanel = wrapped;
    }
    const origNew = window.newSession;
    if (typeof origNew === 'function' && !origNew.__hbtWrapped) {
      const w = function () {
        if (st.active) window.switchPanel('chat');
        return origNew.apply(this, arguments);
      };
      w.__hbtWrapped = true;
      window.newSession = w;
    }
    // Core re-syncs the titlebar for the chat base view on session events;
    // re-apply ours afterwards while the page is open.
    const origTitle = window.syncAppTitlebar;
    if (typeof origTitle === 'function' && !origTitle.__hbtWrapped) {
      const t = function () {
        const r = origTitle.apply(this, arguments);
        if (st.active) syncTitle();
        return r;
      };
      t.__hbtWrapped = true;
      window.syncAppTitlebar = t;
    }
  }

  // ── polling ───────────────────────────────────────────────────────────────
  function interval() { return C.clamp(Number(opt('interval', 1000)) || 1000, 250, 10000); }
  function schedule(ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(tick, ms == null ? interval() : ms);
  }

  async function tick() {
    st.timer = null;
    if (!st.active || st.paused || document.hidden) return;
    if (st.inflight) { schedule(); return; }
    st.inflight = true;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const to = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (_) {} }, 9000);
    try {
      const needProcs = prefs.boxes.proc || prefs.boxes.hermes || isSideVisible();
      const url = BASE + '/api/snapshot?since=' + st.seq + '&boot=' + encodeURIComponent(st.boot) + (needProcs ? '' : '&procs=0');
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      let body = null;
      try { body = await r.json(); } catch (_) {}
      if (!r.ok || !body) throw Object.assign(new Error((body && (body.error || body.message)) || ('HTTP ' + r.status)), { status: r.status, hint: body && body.hint });
      if (body.warming) {               // sidecar just started; first sample pending
        st.warming = true; st.error = null; renderStatus();
        return;
      }
      st.warming = false;
      if (!body.now) throw Object.assign(new Error('empty snapshot'), { status: r.status });
      if (body.boot !== st.boot) { st.history = []; st.boot = body.boot; }
      st.history = C.mergeHistory(st.history, body.history, 600);
      st.seq = body.seq;
      st.snap = body;
      st.error = null;
      st.lastOk = Date.now();
      st.ticks++;
      trackProcHist(body.procs || []);
      if (st.selected != null && (Date.now() - st.detailAt > 1900)) loadDetail(st.selected);
      render();
    } catch (err) {
      st.error = err;
      renderStatus();
    } finally {
      clearTimeout(to);
      st.inflight = false;
      if (st.active && !st.paused) schedule(st.error ? Math.min(10000, interval() * 3) : st.warming ? 500 : interval());
    }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.active && !st.timer) schedule(0); });

  function isSideVisible() {
    return !!(side && side.classList.contains('active') && side.offsetParent !== null);
  }

  function trackProcHist(procs) {
    const seen = new Set();
    for (const p of procs) {
      seen.add(p.pid);
      let h = st.procHist.get(p.pid);
      if (!h) { h = []; st.procHist.set(p.pid, h); }
      h.push(p.cpu);
      if (h.length > 10) h.shift();
    }
    for (const pid of st.procHist.keys()) if (!seen.has(pid)) st.procHist.delete(pid);
  }

  async function loadDetail(pid) {
    st.detailAt = Date.now();
    try {
      const r = await fetch(BASE + '/api/proc/' + pid, { credentials: 'same-origin', cache: 'no-store' });
      const body = await r.json().catch(() => null);
      if (st.selected !== pid) return;
      st.detail = r.ok ? body : { pid, gone: true, error: (body && body.error) || ('HTTP ' + r.status) };
    } catch (e) {
      if (st.selected === pid) st.detail = { pid, gone: true, error: String(e.message || e) };
    }
    renderDetail();
  }

  async function sendSignal(pid, sig, start) {
    try {
      const r = await fetch(BASE + '/api/proc/' + pid + '/signal', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        // `start` pins the exact process the user confirmed: the sidecar
        // refuses (409) if the PID now belongs to a different process.
        body: JSON.stringify({ signal: sig, start }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) toast('Sent SIG' + sig + ' to ' + pid, 'success');
      else toast('Signal failed: ' + (body.error || ('HTTP ' + r.status)), 'error');
    } catch (e) { toast('Signal failed: ' + (e.message || e), 'error'); }
    loadDetail(pid);
  }

  function toast(msg, type) {
    // No duration: Core's defaults apply (errors stay up longer, with Copy/Dismiss).
    if (typeof showToast === 'function') { try { showToast(msg, undefined, type); return; } catch (_) {} }
    console.log('[btop] ' + msg);
  }

  // ── colours ───────────────────────────────────────────────────────────────
  let palette = null;
  let paletteAt = 0;
  function colors() {
    if (palette && Date.now() - paletteAt < 3000) return palette;
    const cs = getComputedStyle(page || document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    palette = {
      lo: v('--success', '#3fb950'), mid: v('--warning', '#d29922'), hi: v('--error', '#f85149'),
      accent: v('--accent', '#58a6ff'), info: v('--info', '#58a6ff'), muted: v('--muted', '#8b949e'),
      border: v('--border', '#30363d'), text: v('--text', '#e6edf3'),
    };
    paletteAt = Date.now();
    applyTextColors();
    return palette;
  }

  /* Text drawn in a role colour (box titles, sorted header, hot CPU, tags…)
     gets a per-skin "text-safe" variant: the smallest darken (light themes) or
     lighten (dark themes) that reaches 5:1 on the actual background. Computed
     from the live tokens, so it holds for every built-in and extension skin. */
  const TEXT_ROLES = [['accent', '#58a6ff'], ['info', '#4dd0e1'], ['success', '#3fb950'], ['warning', '#d29922'],
    ['error', '#f85149'], ['link', '#79c0ff'], ['accent2', '#bc8cff'], ['accent3', '#ff9bce']];
  let probe = null;
  function resolved(el, value) {
    if (!probe) { probe = document.createElement('span'); probe.className = 'hbt-probe'; probe.setAttribute('aria-hidden', 'true'); }
    if (probe.parentNode !== el) el.appendChild(probe);
    probe.style.color = value;
    return C.parseColor(getComputedStyle(probe).color);
  }
  function backgroundOf(el) {
    // Resolve the background *token*, not the computed background-color: Core
    // transitions background-color (0.15 s) on theme/skin change, so the
    // computed value lags and a sample taken mid-transition is the old theme.
    // Custom properties are not animated, so the token is always current.
    const token = 'var(--bg)';   // .main-view and .panel-view both paint var(--bg)
    return resolved(el, token) || C.parseColor(getComputedStyle(document.documentElement).getPropertyValue('--bg')) || [255, 255, 255];
  }
  function applyTextColors() {
    [page, side].forEach((el) => {
      if (!el) return;
      const bg = backgroundOf(el);
      TEXT_ROLES.forEach(([role, fallback]) => {
        const fg = resolved(el, 'var(--' + role + ', ' + fallback + ')');
        const safe = C.textSafe(fg, bg, 5);
        if (safe && el.style.getPropertyValue('--hbt-t-' + role) !== safe) el.style.setProperty('--hbt-t-' + role, safe);
      });
    });
    if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
  }
  function refreshColors() { palette = null; colors(); }

  // ── graphs ────────────────────────────────────────────────────────────────
  function drawGraph(cv, series, o) {
    if (!cv) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pal = colors();
    const max = o.max || 100;
    const mirror = !!o.mirror;
    const stops = o.color ? [o.color, o.color, o.color] : [pal.lo, pal.mid, pal.hi];
    // faint guides
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = pal.border;
    for (const f of [0.25, 0.5, 0.75]) ctx.fillRect(0, Math.round(h * f), w, 1);
    ctx.globalAlpha = 1;
    const style = opt('graph', 'dots');
    if (style === 'dots') {
      const cell = w < 420 ? 3 : 4;
      const cols = Math.floor(w / cell);
      const rows = Math.max(1, Math.floor(h / cell));
      const vals = C.fitSeries(series, cols);
      const off = w - cols * cell;
      for (let band = 0; band < 3; band++) {
        ctx.fillStyle = stops[band];
        for (let i = 0; i < cols; i++) {
          const v = vals[i];
          if (v == null || v <= 0) continue;
          let n = Math.round(C.clamp(v / max, 0, 1) * rows);
          if (n === 0) n = 1;
          for (let r = 0; r < n; r++) {
            if (C.stopIndex(r / rows) !== band) continue;
            const x = off + i * cell;
            const y = mirror ? r * cell : h - (r + 1) * cell;
            ctx.fillRect(x, y + (cell - (cell - 1)) / 2, cell - 1, cell - 1);
          }
        }
      }
    } else {
      const n = Math.max(2, Math.floor(w / 2));
      const vals = C.fitSeries(series, n);
      const step = w / (n - 1);
      const grad = ctx.createLinearGradient(0, mirror ? 0 : h, 0, mirror ? h : 0);
      grad.addColorStop(0, stops[0]); grad.addColorStop(0.6, stops[1]); grad.addColorStop(1, stops[2]);
      ctx.beginPath();
      let started = false;
      let firstX = 0;
      let lastX = 0;
      vals.forEach((v, i) => {
        if (v == null) return;
        const x = i * step;
        const yv = C.clamp(v / max, 0, 1) * h;
        const y = mirror ? yv : h - yv;
        if (!started) { ctx.moveTo(x, mirror ? 0 : h); ctx.lineTo(x, y); firstX = x; started = true; } else ctx.lineTo(x, y);
        lastX = x;
      });
      if (started) {
        ctx.lineTo(lastX, mirror ? 0 : h);
        ctx.lineTo(firstX, mirror ? 0 : h);
        ctx.closePath();
        ctx.globalAlpha = 0.35; ctx.fillStyle = grad; ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = grad; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function renderStatus() {
    const live = F.live;
    if (!live) return;
    const err = st.error;
    live.classList.toggle('hbt-bad', !!err);
    live.classList.toggle('hbt-paused', st.paused);
    setText(live.querySelector('span'), st.paused ? 'paused' : err ? 'offline' : st.warming ? 'starting' : 'live');
    const n = F.notice;
    if (!n) return;
    if (!err) { n.hidden = true; return; }
    const ago = st.lastOk ? ' <span class="hbt-dim">· last update ' + C.fmtDuration((Date.now() - st.lastOk) / 1000) + ' ago</span>' : '';
    setHTML(n, noticeHtml(err) + ago);
    n.hidden = false;
  }

  /* Always show what the proxy / sidecar actually said; add a next step only
     when the status + message identify the cause. */
  function noticeHtml(err) {
    const s = err.status;
    const msg = String(err.message || err);
    const low = msg.toLowerCase();
    const ext = '<a href="#" data-act="open-ext">Settings → Extensions</a>';
    const unit = 'hermes-btop-sidecar';
    let hint = '';
    if (s === 403 && /authentication|password/.test(low)) {
      hint = 'token-v1 sidecars need WebUI authentication on: set a password in Settings, then approve the proxy.';
    } else if (s === 403 && /consent/.test(low)) {
      hint = 'Approve it in ' + ext + ' → Diagnostics → Loopback sidecars → btop → <i>Approve proxy consent</i>. ' +
        'Core only allows that while WebUI authentication (a password) is on.';
    } else if (s === 409) {
      hint = 'Check btop in ' + ext + ' (it may be disabled, or its sidecar declaration changed), then reload.';
    } else if ((s === 401 || s === 503) && /token/.test(low)) {
      hint = 'Re-approve the proxy in ' + ext + ', then restart the sidecar: <code>systemctl --user restart ' + unit + '</code>';
    } else if (s === 502 && /too large/.test(low)) {
      hint = 'The sidecar answered with more than the proxy allows. Update btop; this build caps responses at 448 KiB.';
    } else if ((s === 502 || s === 504) && /reach|refused|timed? ?out|connect/.test(low)) {
      hint = 'Is the sidecar running on 127.0.0.1:17797? <code>systemctl --user status ' + unit + '</code> · start: <code>systemctl --user start ' + unit + '</code>';
    } else if (s === 404 && /not configured|not found/.test(low)) {
      hint = 'btop isn\'t installed or enabled in ' + ext + '.';
    }
    return '<b>' + esc(msg) + '</b>' + (s ? ' <span class="hbt-dim">(HTTP ' + s + ')</span>' : '') + (hint ? '<br>' + hint : '');
  }

  function hostLine(snap) {
    const h = snap.host || {};
    return [h.hostname, h.distro, h.container ? h.container : null].filter(Boolean).join(' · ');
  }

  function render() {
    if (!st.active || !st.snap || !page) return;
    const snap = st.snap;
    const now = snap.now;
    renderStatus();
    syncTitle();
    setText(F.host, hostLine(snap));
    if (prefs.boxes.cpu) renderCpu(now);
    if (prefs.boxes.mem) renderMem(now);
    if (prefs.boxes.net) renderNet(now);
    if (prefs.boxes.disk) renderDisks(now);
    if (prefs.boxes.hermes) renderHermes(snap);
    if (prefs.boxes.proc) renderProcs(snap);
    renderSide(snap);
  }

  function series(key) { return st.history.map((h) => h[key]); }

  function renderCpu(now) {
    const cpu = now.cpu || {};
    const info = now.cpuinfo || {};
    const t = now.temps || {};
    const ghz = info.mhz ? (info.mhz / 1000).toFixed(2) + ' GHz' : '';
    setText(F.cpuInfo, [info.model, ghz, t.cpu != null ? Math.round(t.cpu) + '°C' : ''].filter(Boolean).join(' · '));
    setText(F.cpuPct, (cpu.total || 0).toFixed(1) + '%');
    drawGraph($('[data-g="cpu"]', page), series('cpu'), { max: 100 });
    F.cpuTotal.innerHTML = '<span class="hbt-lbl">CPU</span>' + meter(cpu.total) + '<span class="hbt-num">' + (cpu.total || 0).toFixed(0) + '%</span>' +
      (t.cpu != null ? '<span class="hbt-temp">' + Math.round(t.cpu) + '°</span>' : '');
    const cores = now.cores || [];
    const hist = st.history;
    F.cores.innerHTML = cores.map((v, i) => {
      const spark = C.sparkline(hist.slice(-8).map((h) => (h.cores || [])[i] || 0), 100, 8);
      const temp = t.cores && t.cores[i] != null ? '<span class="hbt-temp">' + Math.round(t.cores[i]) + '°</span>' : '';
      return '<div class="hbt-core"><span class="hbt-lbl">C' + i + '</span><span class="hbt-spark">' + esc(spark) + '</span>' + meter(v) +
        '<span class="hbt-num">' + Math.round(v) + '%</span>' + temp + '</div>';
    }).join('');
    const coreCols = cores.length > 16 ? 3 : cores.length > 6 ? 2 : 1;
    F.cores.style.setProperty('--hbt-core-cols', coreCols);
    F.cores.dataset.cols = String(coreCols);
    const l = (now.load || {}).load || [];
    F.cpuFoot.innerHTML = '<span>load <b>' + l.map((x) => x.toFixed(2)).join(' ') + '</b></span>' +
      '<span>usr <b>' + (cpu.user || 0).toFixed(1) + '</b> sys <b>' + (cpu.system || 0).toFixed(1) + '</b> io <b>' + (cpu.iowait || 0).toFixed(1) + '</b>' +
      (cpu.steal ? ' st <b>' + cpu.steal.toFixed(1) + '</b>' : '') + '</span>' +
      '<span>tasks <b>' + ((st.snap && st.snap.proc_total) || '–') + '</b> run <b>' + (now.procs_running || 0) + '</b></span>';
    setText(F.uptime, 'up ' + C.fmtUptime(now.uptime));
  }

  function renderMem(now) {
    const m = now.mem || {};
    setText(F.memTotal, C.fmtBytes(m.total));
    const pct = (x) => (m.total ? (x * 100) / m.total : 0);
    const row = (label, val, p, kind) => '<div class="hbt-row"><span class="hbt-lbl">' + label + '</span>' + meter(p, kind) +
      '<span class="hbt-val">' + C.fmtBytes(val) + '</span><span class="hbt-num">' + Math.round(p) + '%</span></div>';
    let html = row('used', m.used, pct(m.used), 'grad') + row('avail', m.available, pct(m.available), 'info') +
      row('cached', m.cached, pct(m.cached), 'accent') + row('free', m.free, pct(m.free), 'ok');
    if (m.swap_total) html += row('swap', m.swap_used, (m.swap_used * 100) / m.swap_total, 'grad');
    F.memRows.innerHTML = html;
    drawGraph($('[data-g="mem"]', page), series('mem'), { max: 100 });
  }

  function ifaceNames(now) { return Object.keys(now.net || {}).sort((a, b) => (a === 'lo') - (b === 'lo') || a.localeCompare(b)); }

  function renderNet(now) {
    const names = ifaceNames(now);
    if (!prefs.iface || !names.includes(prefs.iface)) prefs.iface = C.pickIface(now.net);
    const name = prefs.iface;
    setText(F.iface, name || '–');
    const cur = (now.net || {})[name] || { rx: 0, tx: 0, rx_total: 0, tx_total: 0 };
    const rx = st.history.map((h) => (h.net && h.net[name] ? h.net[name][0] : null));
    const tx = st.history.map((h) => (h.net && h.net[name] ? h.net[name][1] : null));
    const top = C.niceCeil(Math.max(1, ...rx.filter((v) => v != null), ...tx.filter((v) => v != null)));
    drawGraph($('[data-g="rx"]', page), rx, { max: top, color: colors().info });
    drawGraph($('[data-g="tx"]', page), tx, { max: top, mirror: true, color: colors().accent });
    setText(F.rxLabel, '▼ ' + C.fmtBytes(cur.rx, { rate: true }));
    setText(F.txLabel, '▲ ' + C.fmtBytes(cur.tx, { rate: true }));
    const peak = (arr) => Math.max(0, ...arr.filter((v) => v != null));
    F.netStats.innerHTML =
      '<div><span class="hbt-rx">▼ down</span> <b>' + C.fmtBits(cur.rx) + '</b> <span class="hbt-dim">peak ' + C.fmtBytes(peak(rx), { rate: true }) + ' · total ' + C.fmtBytes(cur.rx_total) + '</span></div>' +
      '<div><span class="hbt-tx">▲ up</span> <b>' + C.fmtBits(cur.tx) + '</b> <span class="hbt-dim">peak ' + C.fmtBytes(peak(tx), { rate: true }) + ' · total ' + C.fmtBytes(cur.tx_total) + '</span></div>' +
      '<div class="hbt-dim">scale ' + C.fmtBytes(top, { rate: true }) + '</div>';
  }

  function renderDisks(now) {
    const disks = now.disks || [];
    const last = st.history.length ? st.history[st.history.length - 1] : {};
    setText(F.diskIo, 'r ' + C.fmtBytes(last.dr || 0, { rate: true }) + ' · w ' + C.fmtBytes(last.dw || 0, { rate: true }));
    const rs = C.sparkline(series('dr').slice(-24), 0, 24);
    const ws = C.sparkline(series('dw').slice(-24), 0, 24);
    F.disks.innerHTML = disks.map((d) => {
      const p = d.total ? (d.used * 100) / d.total : 0;
      const stalled = d.stalled ? '<span class="hbt-stalled" title="statvfs is not returning; showing the last known numbers">not responding</span>' : '';
      return '<div class="hbt-disk-item' + (d.stalled ? ' hbt-is-stalled' : '') + '"><div class="hbt-disk-head"><b>' + esc(d.mount) + '</b><span class="hbt-dim">' + esc(d.dev) + ' · ' + esc(d.fs) + '</span>' + stalled +
        '<span class="hbt-val">' + (d.total ? C.fmtBytes(d.used) + ' / ' + C.fmtBytes(d.total) : '–') + '</span></div>' +
        '<div class="hbt-row">' + meter(p, 'grad') + '<span class="hbt-num">' + Math.round(p) + '%</span></div>' +
        (d.read != null ? '<div class="hbt-io hbt-dim">r ' + C.fmtBytes(d.read, { rate: true }) + ' · w ' + C.fmtBytes(d.write, { rate: true }) + (d.busy ? ' · busy ' + d.busy + '%' : '') + '</div>' : '') +
        '</div>';
    }).join('') + (disks.length ? '<div class="hbt-io-spark"><span class="hbt-dim">r</span><span class="hbt-spark">' + esc(rs) + '</span><span class="hbt-dim">w</span><span class="hbt-spark">' + esc(ws) + '</span></div>' : '<div class="hbt-dim">no block filesystems</div>');
  }

  function renderHermes(snap) {
    const groups = snap.groups || [];
    const ncpu = (snap.now && snap.now.ncpu) || 1;
    const perCore = !!opt('perCore', false);
    const div = perCore ? 1 : ncpu;
    let cpuSum = 0;
    let memSum = 0;
    groups.forEach((g) => { cpuSum += g.cpu; memSum += g.mem; });
    setText(F.hermesSum, (cpuSum / div).toFixed(1) + '% · ' + C.fmtBytes(memSum));
    if (!groups.length) { setHTML(F.hermes, '<div class="hbt-dim">no Hermes processes found</div>'); return; }
    const active = (prefs.filter || '').trim().toLowerCase();
    setHTML(F.hermes, '<div class="hbt-hg-head"><span></span><span>group</span><span>procs</span><span>cpu</span><span>mem</span><span class="hbt-hg-spark-h"></span></div>' +
      groups.map((g) => {
        const sp = C.sparkline(st.history.slice(-12).map((h) => (h.hg && h.hg[g.name]) || 0), 0, 12);
        const on = active === 'g:' + g.name;
        return '<button type="button" class="hbt-hg' + (on ? ' hbt-on' : '') + '" data-group="' + esc(g.name) + '" title="Filter processes to ' + esc(g.name) + '">' +
          '<i class="hbt-dot hbt-c-' + colorOf(g.name) + '"></i><span class="hbt-hg-name">' + esc(g.name) + '</span>' +
          '<span>' + g.procs + '</span><span>' + (g.cpu / div).toFixed(1) + '%</span><span>' + C.fmtBytes(g.mem, { compact: true }) + '</span>' +
          '<span class="hbt-spark">' + esc(sp) + '</span></button>';
      }).join(''));
  }

  function procRows(snap) {
    const procs = snap.procs || [];
    if (prefs.tree) return C.buildTree(procs, prefs.sort, prefs.desc, prefs.filter, st.collapsed);
    return C.sortProcs(C.filterProcs(procs, prefs.filter), prefs.sort, prefs.desc);
  }

  function renderProcs(snap) {
    const ncpu = (snap.now && snap.now.ncpu) || 1;
    const perCore = !!opt('perCore', false);
    const div = perCore ? 1 : ncpu;
    const rows = procRows(snap);
    st.rows = rows;
    const table = F.procBody && F.procBody.closest('table');
    if (table) table.classList.toggle('hbt-tree-mode', !!prefs.tree);
    const shown = rows.length;
    const tr = snap.truncated;
    const cut = tr && tr.procs ? ' · top ' + (snap.procs || []).length + ' sent' : '';
    setText(F.procCount, (prefs.filter ? shown + '/' : '') + (snap.proc_total || 0) + ' procs' + cut);
    if (F.procCount) F.procCount.title = cut ? 'The sidecar trimmed the quietest processes to stay under the WebUI proxy size limit.' : '';
    $$('th[data-sort]', page).forEach((th) => {
      th.classList.toggle('hbt-sorted', th.dataset.sort === prefs.sort);
      th.dataset.dir = th.dataset.sort === prefs.sort ? (prefs.desc ? '▼' : '▲') : '';
    });
    const sel = st.selected;
    let html = '';
    for (const p of rows) {
      const cpu = p.cpu / div;
      const spark = C.sparkline((st.procHist.get(p.pid) || []).map((v) => v / div), Math.max(1, 100 / (perCore ? 1 : ncpu) * (perCore ? 1 : 1)), 6);
      const cls = ['hbt-pr'];
      if (p.pid === sel) cls.push('hbt-sel');
      if (p.dimmed) cls.push('hbt-dimrow');
      if (cpu >= 50) cls.push('hbt-hot'); else if (cpu >= 10) cls.push('hbt-warm');
      const tw = prefs.tree
        ? '<span class="hbt-tree">' + esc(p.prefix || '') + (p.hasKids ? '<button type="button" class="hbt-tw" data-toggle="' + p.pid + '">' + (p.collapsed ? '[+]' : '[-]') + '</button>' : '') + '</span>'
        : '';
      const dot = p.group ? '<i class="hbt-dot hbt-c-' + colorOf(p.group) + '" title="' + esc(p.group) + '"></i>' : '';
      html += '<tr class="' + cls.join(' ') + '" data-pid="' + p.pid + '">' +
        '<td class="hbt-c-pid">' + p.pid + '</td>' +
        '<td class="hbt-c-name">' + tw + dot + esc(p.name) + '</td>' +
        '<td class="hbt-c-cmd" title="' + esc(p.cmd) + '">' + esc(p.cmd || '[' + p.name + ']') + '</td>' +
        '<td class="hbt-c-thr">' + p.threads + '</td>' +
        '<td class="hbt-c-user">' + esc(p.user) + '</td>' +
        '<td class="hbt-c-mem">' + C.fmtBytes(p.mem, { compact: true }) + '</td>' +
        '<td class="hbt-c-cpu"><span class="hbt-spark">' + esc(spark) + '</span>' + cpu.toFixed(1) + '</td></tr>';
    }
    if (!rows.length) html = '<tr><td colspan="7" class="hbt-dim hbt-empty">' + (prefs.filter ? 'no process matches “' + esc(prefs.filter) + '”' : 'waiting for process data…') + '</td></tr>';
    setHTML(F.procBody, html);
    renderDetail();
  }

  function renderDetail() {
    const el = F.detail;
    if (!el) return;
    const d = st.detail;
    if (st.selected == null || !d) { el.hidden = true; setHTML(el, ''); return; }
    el.hidden = false;
    const live = (st.snap && (st.snap.procs || []).find((p) => p.pid === st.selected)) || null;
    const ncpu = (st.snap && st.snap.now && st.snap.now.ncpu) || 1;
    const div = opt('perCore', false) ? 1 : ncpu;
    if (d.gone) {
      setHTML(el, '<div class="hbt-d-head"><b>' + st.selected + '</b> <span class="hbt-dim">' + esc(d.error || 'process ended') + '</span>' +
        '<button type="button" class="hbt-btn" data-act="close-detail">close</button></div>');
      return;
    }
    const kv = (k, v) => (v == null || v === '' ? '' : '<div><span class="hbt-dim">' + k + '</span> ' + v + '</div>');
    const sigs = st.snap && st.snap.signals ? ['TERM', 'INT', 'HUP', 'KILL', (String(d.state || '').startsWith('T') ? 'CONT' : 'STOP')] : [];
    const sigHtml = sigs.map((s) => {
      const armed = st.confirm && st.confirm.pid === d.pid && st.confirm.sig === s;
      return '<button type="button" class="hbt-btn hbt-sig' + (s === 'KILL' ? ' hbt-danger' : '') + (armed ? ' hbt-armed' : '') + '" data-sig="' + s + '">' +
        (armed ? 'confirm ' + s + '?' : s.toLowerCase()) + '</button>';
    }).join('');
    const spark = C.sparkline((st.procHist.get(d.pid) || []).map((v) => v / div), 100 / (div === 1 ? 1 : 1), 10);
    setHTML(el,
      '<div class="hbt-d-head"><b>' + d.pid + '</b> <b class="hbt-d-name">' + esc(d.name) + '</b>' +
        (d.group ? ' <span class="hbt-tag hbt-c-' + colorOf(d.group) + '">' + esc(d.group) + '</span>' : '') +
        '<span class="hbt-d-cpu">' + (live ? (live.cpu / div).toFixed(1) + '% <span class="hbt-spark">' + esc(spark) + '</span>' : '') + '</span>' +
        '<span class="hbt-grow"></span>' + sigHtml +
        '<button type="button" class="hbt-btn" data-act="close-detail" aria-label="Close details">✕</button></div>' +
      '<div class="hbt-d-cmd">' + esc(d.cmd || '[' + d.name + ']') + '</div>' +
      '<div class="hbt-d-grid">' +
        kv('state', esc(d.state)) + kv('user', esc(d.user)) + kv('ppid', d.ppid) + kv('threads', d.threads) +
        kv('nice', d.nice) + kv('up', C.fmtDuration(d.age)) + kv('cpu time', C.fmtDuration(d.cpu_time)) +
        kv('rss', C.fmtBytes(d.rss)) + kv('virt', C.fmtBytes(d.vsize)) + kv('peak', d.peak != null ? C.fmtBytes(d.peak) : null) +
        kv('swap', d.swap ? C.fmtBytes(d.swap) : null) + kv('fds', d.fds) +
        kv('io r/w', d.io_read != null ? C.fmtBytes(d.io_read) + ' / ' + C.fmtBytes(d.io_write) : null) +
        kv('ctx', d.ctx_vol != null ? d.ctx_vol + ' / ' + d.ctx_invol : null) +
        kv('cwd', d.cwd ? '<code>' + esc(d.cwd) + '</code>' : null) + kv('exe', d.exe ? '<code>' + esc(d.exe) + '</code>' : null) +
        (d.children && d.children.length ? kv('children', d.children.slice(0, 12).map((c) => '<a href="#" data-pick="' + c.pid + '">' + c.pid + ' ' + esc(c.name) + '</a>').join(', ') + (d.children.length > 12 ? ' …' : '')) : '') +
      '</div>');
  }

  function renderSide(snap) {
    if (!F.sideHost) return;
    const h = snap.host || {};
    const now = snap.now || {};
    F.sideHost.innerHTML =
      '<div><b>' + esc(h.hostname || '') + '</b></div>' +
      '<div class="hbt-dim">' + esc([h.distro, h.kernel, h.arch].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="hbt-dim">' + esc(((now.cpuinfo || {}).model || '') + (now.ncpu ? ' · ' + now.ncpu + ' threads' : '')) + '</div>' +
      '<div class="hbt-dim">up ' + C.fmtUptime(now.uptime) + (h.container ? ' · ' + esc(h.container) : '') + '</div>';
    const m = now.mem || {};
    const disk = (now.disks || [])[0];
    const mrow = (label, p, txt) => '<div class="hbt-row"><span class="hbt-lbl">' + label + '</span>' + meter(p, 'grad') + '<span class="hbt-num">' + txt + '</span></div>';
    F.sideMeters.innerHTML =
      mrow('cpu', (now.cpu || {}).total || 0, Math.round((now.cpu || {}).total || 0) + '%') +
      mrow('mem', m.total ? (m.used * 100) / m.total : 0, m.total ? Math.round((m.used * 100) / m.total) + '%' : '–') +
      (m.swap_total ? mrow('swap', (m.swap_used * 100) / m.swap_total, Math.round((m.swap_used * 100) / m.swap_total) + '%') : '') +
      (disk ? mrow('disk', (disk.used * 100) / disk.total, Math.round((disk.used * 100) / disk.total) + '%') : '');
    const groups = snap.groups || [];
    const div = opt('perCore', false) ? 1 : (now.ncpu || 1);
    setHTML(F.sideHermes, groups.length ? groups.map((g) =>
      '<button type="button" class="hbt-side-g" data-group="' + esc(g.name) + '"><i class="hbt-dot hbt-c-' + colorOf(g.name) + '"></i>' + esc(g.name) +
      '<span class="hbt-dim">' + g.procs + ' · ' + (g.cpu / div).toFixed(1) + '% · ' + C.fmtBytes(g.mem, { compact: true }) + '</span></button>').join('')
      : '<div class="hbt-dim">none running</div>');
  }

  // ── interactions ──────────────────────────────────────────────────────────
  function applyBoxes() {
    if (!page) return;
    BOXES.forEach(([k]) => {
      const box = $('[data-box="' + k + '"]', page);
      if (box) box.hidden = !prefs.boxes[k];
      const chip = $('[data-box-toggle="' + k + '"]', page);
      if (chip) chip.setAttribute('aria-pressed', String(!!prefs.boxes[k]));
    });
    const left = $('.hbt-left', page);
    const anyLeft = ['mem', 'net', 'disk', 'hermes'].some((k) => prefs.boxes[k]);
    if (left) left.hidden = !anyLeft;
    page.classList.toggle('hbt-no-left', !anyLeft);
    page.classList.toggle('hbt-no-proc', !prefs.boxes.proc);
  }

  function syncButtons() {
    if (!page) return;
    const iv = interval();
    setText($('[data-act="interval"]', page), iv >= 1000 ? (iv / 1000) + 's' : iv + 'ms');
    const g = opt('graph', 'dots');
    setText($('[data-act="graph"]', page), g === 'dots' ? '⣿' : '◢');
    $('[data-act="graph"]', page).title = 'Graph style: ' + g;
    const pause = $('[data-act="pause"]', page);
    setText(pause, st.paused ? '▶' : '❚❚');
    pause.setAttribute('aria-pressed', String(st.paused));
    $('[data-act="tree"]', page).setAttribute('aria-pressed', String(!!prefs.tree));
    $('[data-act="percore"]', page).setAttribute('aria-pressed', String(!!opt('perCore', false)));
    setText($('[data-act="reverse"]', page), prefs.desc ? '↓' : '↑');
    if (F.filter && document.activeElement !== F.filter && F.filter.value !== prefs.filter) F.filter.value = prefs.filter || '';
  }

  function toggleBox(k) {
    prefs.boxes[k] = !prefs.boxes[k];
    savePrefs();
    applyBoxes();
    render();
  }

  function setSort(key) {
    if (prefs.sort === key) prefs.desc = !prefs.desc;
    else { prefs.sort = key; prefs.desc = !['pid', 'name', 'cmd', 'user'].includes(key); }
    savePrefs(); syncButtons(); render();
  }

  function setFilter(v) {
    prefs.filter = v;
    savePrefs();
    if (F.filter && F.filter.value !== v) F.filter.value = v;
    render();
  }

  function select(pid) {
    if (pid == null || st.selected === pid) {
      st.selected = null; st.detail = null; st.confirm = null;
      renderDetail(); render();
      return;
    }
    st.selected = pid;
    st.detail = null;
    st.confirm = null;
    loadDetail(pid);
    render();
  }

  function moveSel(delta) {
    const rows = st.rows || [];
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.pid === st.selected);
    i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : C.clamp(i + delta, 0, rows.length - 1);
    select(rows[i].pid);
    const tr = $('tr[data-pid="' + rows[i].pid + '"]', page);
    if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
  }

  function bindPage() {
    if (!page || page.__hbtBound) return;
    page.__hbtBound = true;
    page.addEventListener('click', (e) => {
      const t = e.target;
      const chip = t.closest('[data-box-toggle]');
      if (chip) { toggleBox(chip.dataset.boxToggle); return; }
      const th = t.closest('th[data-sort]');
      if (th) { setSort(th.dataset.sort); return; }
      const tw = t.closest('[data-toggle]');
      if (tw) {
        const pid = Number(tw.dataset.toggle);
        if (st.collapsed.has(pid)) st.collapsed.delete(pid); else st.collapsed.add(pid);
        render();
        return;
      }
      const grp = t.closest('[data-group]');
      if (grp) {
        const f = 'g:' + grp.dataset.group;
        setFilter(prefs.filter === f ? '' : f);
        return;
      }
      const sig = t.closest('[data-sig]');
      if (sig && st.detail) {
        const s = sig.dataset.sig;
        const pid = st.detail.pid;
        if (st.confirm && st.confirm.pid === pid && st.confirm.sig === s && Date.now() - st.confirm.at < 5000) {
          const start = st.confirm.start;
          st.confirm = null;
          sendSignal(pid, s, start);
        } else {
          st.confirm = { pid, sig: s, at: Date.now(), start: st.detail.start };
          setTimeout(() => { if (st.confirm && Date.now() - st.confirm.at >= 5000) { st.confirm = null; renderDetail(); } }, 5100);
        }
        renderDetail();
        return;
      }
      const pick = t.closest('[data-pick]');
      if (pick) { e.preventDefault(); select(Number(pick.dataset.pick)); return; }
      const act = t.closest('[data-act]');
      if (act) {
        e.preventDefault();
        const a = act.dataset.act;
        if (a === 'pause') { st.paused = !st.paused; syncButtons(); renderStatus(); if (!st.paused) schedule(0); }
        else if (a === 'interval') {
          const steps = [500, 1000, 2000, 5000];
          const i = steps.indexOf(interval());
          setOpt('interval', steps[(i + 1) % steps.length]);
          syncButtons(); schedule();
        } else if (a === 'graph') { setOpt('graph', opt('graph', 'dots') === 'dots' ? 'area' : 'dots'); syncButtons(); render(); }
        else if (a === 'tree') { prefs.tree = !prefs.tree; savePrefs(); syncButtons(); render(); }
        else if (a === 'percore') { setOpt('perCore', !opt('perCore', false)); syncButtons(); render(); }
        else if (a === 'reverse') { prefs.desc = !prefs.desc; savePrefs(); syncButtons(); render(); }
        else if (a === 'close-detail') select(null);
        else if (a === 'iface-prev' || a === 'iface-next') {
          const names = st.snap ? ifaceNames(st.snap.now) : [];
          if (names.length) {
            const i = names.indexOf(prefs.iface);
            prefs.iface = names[(i + (a === 'iface-next' ? 1 : names.length - 1)) % names.length];
            savePrefs(); render();
          }
        } else if (a === 'open-ext') openExtensionsSettings();
        return;
      }
      const tr = t.closest('tr[data-pid]');
      if (tr) select(Number(tr.dataset.pid));
    });
    if (F.filter) {
      F.filter.addEventListener('input', () => setFilter(F.filter.value));
      F.filter.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { setFilter(''); F.filter.blur(); }
        if (e.key === 'Enter') F.filter.blur();
      });
    }
    if (side) {
      side.addEventListener('click', (e) => {
        const g = e.target.closest('[data-group]');
        if (g) {
          setFilter('g:' + g.dataset.group);
          if (!prefs.boxes.proc) toggleBox('proc');
          if (!isDesktop() && typeof closeMobileSidebar === 'function') closeMobileSidebar();
        }
      });
    }
    if (typeof ResizeObserver === 'function') {
      let raf = 0;
      new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => render()); }).observe(page);
    }
  }

  function openExtensionsSettings() {
    try {
      window.switchPanel('settings');
      if (typeof switchSettingsSection === 'function') switchSettingsSection('extensions');
    } catch (_) {}
  }

  const CONTROL_SEL = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  function focusContext(target) {
    const t = target && target.nodeType === 1 ? target : null;
    if (!t || t === document.body || t === document.documentElement) return {};
    const editable = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    const ours = (page && page.contains(t)) || (side && side.contains(t)) || !!t.closest('[data-panel="' + PANEL + '"]');
    return { editable, control: !!t.closest(CONTROL_SEL), foreign: !ours && !t.closest('.rail, .sidebar-nav') };
  }

  document.addEventListener('keydown', (e) => {
    if (!st.active || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!C.shortcutAllowed(e.key, focusContext(e.target))) return;
    const k = e.key;
    if (k >= '1' && k <= '6') { toggleBox(BOXES[Number(k) - 1][0]); e.preventDefault(); return; }
    const map = { c: 'cpu', m: 'mem', p: 'pid', n: 'name' };
    if (map[k]) { setSort(map[k]); e.preventDefault(); return; }
    if (k === 'f' || k === '/') { if (F.filter) { F.filter.focus(); F.filter.select(); } e.preventDefault(); return; }
    if (k === 't') { prefs.tree = !prefs.tree; savePrefs(); syncButtons(); render(); e.preventDefault(); return; }
    if (k === 'r') { prefs.desc = !prefs.desc; savePrefs(); syncButtons(); render(); e.preventDefault(); return; }
    if (k === ' ') { st.paused = !st.paused; syncButtons(); renderStatus(); if (!st.paused) schedule(0); e.preventDefault(); return; }
    if (k === 'ArrowDown') { moveSel(1); e.preventDefault(); return; }
    if (k === 'ArrowUp') { moveSel(-1); e.preventDefault(); return; }
    if (k === 'Escape') { if (st.selected != null) select(null); else if (prefs.filter) setFilter(''); }
  });

  // ── boot ──────────────────────────────────────────────────────────────────
  function install(attempt) {
    attempt = attempt || 0;
    if (document.querySelector('main.main') && document.querySelector('.rail, .sidebar-nav') && typeof window.switchPanel === 'function') {
      mount();
      wrapCore();
      // Skin / light-dark switches change the tokens: recompute text-safe colours.
      if (typeof MutationObserver === 'function') {
        let themeTimer = 0;
        new MutationObserver(() => {
          clearTimeout(themeTimer);
          themeTimer = setTimeout(() => { refreshColors(); if (st.active) render(); }, 150);
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin', 'data-theme', 'style'] });
      }
      refreshColors();
      window.__hermesBtop = {
        version: '0.2.0',
        open: () => onNavClick(true),
        close: () => window.switchPanel('chat'),
        state: () => ({ active: st.active, paused: st.paused, seq: st.seq, history: st.history.length,
          error: st.error ? { status: st.error.status, message: st.error.message } : null,
          procs: st.snap ? (st.snap.procs || []).length : 0, rows: st.rows.length, selected: st.selected,
          prefs: JSON.parse(JSON.stringify(prefs)), interval: interval(), graph: opt('graph', 'dots'),
          warming: st.warming, truncated: st.snap ? st.snap.truncated || null : null,
          currentPanel: typeof _currentPanel === 'string' ? _currentPanel : null }),
      };
      return;
    }
    if (attempt < 100) setTimeout(() => install(attempt + 1), 150);
    else console.warn('[btop] WebUI shell not found; not installed');
  }
  window.__hermesBtop = window.__hermesBtop || null;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  else install();
})();
