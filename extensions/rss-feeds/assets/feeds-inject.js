/* RSS Feeds — frontend injector (self-contained WebUI extension).
   Builds a two-pane overlay with the exact DOM ids feeds.js needs, adds a
   titlebar launcher, and grants sidecar-proxy consent so feeds.js's repointed
   /api/extensions/rss-feeds/sidecar/* calls reach the loopback feeds backend.
   No index.html edits, no fork coupling — survives upstream updates. */
(function () {
  'use strict';
  if (window.__rssFeeds) return; window.__rssFeeds = true;
  var EXT = 'rss-feeds';

  var SIDEBAR_INNER = `      <div class="panel-head">
        <span>Feeds</span>
        <div class="panel-head-actions">
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSearchBtnD" onclick="mcToggleSearchBar()" data-tooltip="Search" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsToolsBtnD" onclick="mcToggleMobileTools()" data-tooltip="Filters" aria-label="Show filters"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsGearBtnD" onclick="mcOpenFeedSettings(event)" data-tooltip="Settings" aria-label="RSS settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsAddBtn" onclick="mcOpenAddFeed()" data-tooltip="Add feed" aria-label="Add feed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsRefreshBtn" onclick="mcRefreshAllFeeds()" data-tooltip="Refresh all" aria-label="Refresh all feeds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:8px" id="feedsListSidebar"><div style="color:var(--muted);font-size:12px">Loading…</div></div>`;
  var MAIN_INNER = `      <div class="main-view-header">
        <div class="main-view-title" id="feedsViewTitle">Feeds</div>
        <div class="main-view-actions">
          <span class="mc-feeds-timer mc-feeds-timer-top" id="feedsTimerTop" data-feed-timer hidden title="Auto-refresh countdown"></span>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSettingsBtn" onclick="mcOpenFeedSettings(event)" data-tooltip="Settings" aria-label="RSS settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsRefreshHeadBtn" onclick="mcRefreshAllFeeds()" data-tooltip="Refresh now" aria-label="Refresh feeds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
                  </div>
      </div>
      <div class="main-view-body" id="feedsViewBody" style="overflow-y:auto;padding:14px"></div>
      <!-- jump arrows for the feeds pane — ↑ anchored top, ↓ anchored bottom (responsive, touch-friendly) -->
      <button type="button" class="feeds-scroll-btn feeds-scroll-btn--top" id="feedsScrollTopBtn" onclick="mcFeedsScrollTop()" aria-label="Scroll to top" title="Top" style="display:none"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
      <button type="button" class="feeds-scroll-btn feeds-scroll-btn--bottom" id="feedsScrollBottomBtn" onclick="mcFeedsScrollBottom()" aria-label="Scroll to bottom" title="Bottom" style="display:none"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></button>
      <div class="main-view-empty" id="feedsViewEmpty">
        <svg class="main-view-empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
        <div class="main-view-empty-title">Select a feed</div>
        <div class="main-view-empty-sub">Pick a feed from the sidebar to read its entries. Tap <strong>+</strong> to add one.</div>
      </div>`;

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

  function buildOverlay() {
    if (document.getElementById('hxFeedsOverlay')) return;
    if (!document.body) return;
    var ov = document.createElement('div');
    ov.id = 'hxFeedsOverlay';
    ov.className = 'hx-feeds-overlay';
    ov.style.display = 'none';
    ov.innerHTML =
      '<div class="hx-feeds-card" role="dialog" aria-label="Feeds">' +
        '<div class="hx-feeds-topbar">' +
          '<span class="hx-feeds-brand">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>' +
            '<span id="hxFeedsBrandLabel"> Feeds</span>' +
            '<span class="hx-feeds-brand-title" id="hxFeedsBrandTitle"></span></span>' +
          // Topbar actions. The "movable" group (search, filter, all-feeds,
          // clicked, summaries, gear) sits inline on desktop but relocates to a
          // bottom-right thumb cluster on mobile (via CSS). Add + Refresh + Close
          // always stay in the top bar.
          '<span class="hx-feeds-topbar-actions">' +
            '<span class="hx-feeds-actions-move" id="hxFeedsActionsMove">' +
              '<button type="button" class="panel-head-btn" id="feedsSearchBtn" onclick="mcToggleSearchBar()" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>' +
              '<button type="button" class="panel-head-btn" id="feedsToolsBtn" onclick="mcToggleMobileTools()" aria-label="Filters"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg></button>' +
              '<button type="button" class="panel-head-btn" id="feedsAllBtn" onclick="mcSelectFeed(null)" aria-label="All feeds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></button>' +
              '<button type="button" class="panel-head-btn" id="feedsClickedBtnM" onclick="mcSelectRead()" aria-label="Clicked articles"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></button>' +
              '<button type="button" class="panel-head-btn" id="feedsSummariesBtnM" onclick="mcSelectSummaries()" aria-label="Summaries"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21l-.9-1.8-2.1-.9 2.1-.9z"/></svg></button>' +
              '<button type="button" class="panel-head-btn" id="feedsGearBtnM" onclick="mcOpenFeedSettings(event)" aria-label="RSS settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>' +
            '</span>' +
            '<span class="hx-feeds-nav-slot" id="hxFeedsNavSlot"></span>' +
            '<button type="button" class="panel-head-btn" id="feedsAddBtnM" onclick="mcOpenAddFeed()" aria-label="Add feed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>' +
            '<button type="button" class="panel-head-btn" id="feedsRefreshBtnM" onclick="mcRefreshAllFeeds()" aria-label="Refresh all feeds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' +
          '</span>' +
          '<button type="button" class="hx-feeds-close" id="hxFeedsClose" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="hx-feeds-body">' +
          '<div class="panel-view hx-feeds-sidebar" id="panelFeeds">' + SIDEBAR_INNER + '</div>' +
          '<div id="mainFeeds" class="main-view hx-feeds-main">' + MAIN_INNER + '</div>' +
        '</div>' +
        // Floating burger (mobile) — toggles the action menu on pages that have
        // no bottom controls bar (Summaries / Clicked). On grouped pages a burger
        // lives in the Expand/Collapse/Filter bar instead (this one hides).
        '<button type="button" class="hx-feeds-burger hx-feeds-burger-fab" id="hxFeedsBurgerFab" onclick="mcToggleActionMenu()" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
    var c = document.getElementById('hxFeedsClose');
    if (c) c.addEventListener('click', closeOverlay);
    // Auto-close the burger menu once any action icon inside it is tapped.
    var moveGroup = document.getElementById('hxFeedsActionsMove');
    if (moveGroup) moveGroup.addEventListener('click', function (e) {
      if (e.target.closest('button') && typeof window.mcCloseActionMenu === 'function') {
        setTimeout(window.mcCloseActionMenu, 0);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || ov.style.display === 'none') return;
      // Peel the frontmost body-mounted popup first; only close the overlay
      // itself once nothing is stacked above it.
      if (window.mcFeedsDismissTopPopup && window.mcFeedsDismissTopPopup()) return;
      closeOverlay();
    });
  }

  function openOverlay() {
    buildOverlay();
    var ov = document.getElementById('hxFeedsOverlay');
    if (ov) ov.style.display = 'flex';
    sidecarConsented().then(function (ok) {
      var body = document.getElementById('feedsViewBody');
      if (!ok) {
        if (body) body.innerHTML = '<div class="main-view-empty"><div class="main-view-empty-title">Approval needed</div><div class="main-view-empty-sub">Enable the RSS&nbsp;Feeds sidecar in <strong>Settings&nbsp;\u2192&nbsp;Extensions</strong>, then reopen.</div></div>';
        return;
      }
      if (typeof window.mcLoadFeedsPanel === 'function') { try { window.mcLoadFeedsPanel(); } catch (_) {} }
    });
  }
  function closeOverlay() {
    if (window.mcFeedsTeardownPopups) window.mcFeedsTeardownPopups();
    var ov = document.getElementById('hxFeedsOverlay');
    if (ov) ov.style.display = 'none';
  }
  window.hxOpenFeeds = openOverlay;
  window.hxCloseFeeds = closeOverlay;

  function addLauncher() {
    if (document.getElementById('hxFeedsLauncher')) return;
    var host = document.querySelector('.app-titlebar-right')
      || document.querySelector('.app-titlebar')
      || document.querySelector('header')
      || document.body;
    var btn = document.createElement('button');
    btn.id = 'hxFeedsLauncher';
    btn.type = 'button';
    // Host replaced native tooltips (#1775) — use its has-tooltip convention,
    // not a native title=.
    btn.className = 'hx-feeds-launcher has-tooltip has-tooltip--bottom';
    btn.setAttribute('data-tooltip', 'Feeds');
    btn.setAttribute('aria-label', 'Open Feeds');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>';
    btn.addEventListener('click', openOverlay);
    host.appendChild(btn);
  }

  function init() { buildOverlay(); addLauncher(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
