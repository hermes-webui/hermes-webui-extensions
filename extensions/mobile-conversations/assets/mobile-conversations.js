(() => {
  'use strict';

  const EXT = 'mobile-conversations';
  const BUTTON_ID = 'mobileConversationsBtn';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LONG_PRESS_DELAY_MS = 400;
  const CLICK_IGNORE_MS = 700;
  const INIT_RETRIES = 80;
  const INIT_DELAY_MS = 150;

  if (window.__hermesMobileConversationsExtensionLoaded) return;
  window.__hermesMobileConversationsExtensionLoaded = true;

  let menu = null;
  let pressTimer = null;
  let ignoreClickUntil = 0;
  let pressX = 0;
  let pressY = 0;
  let sidebarObserver = null;

  function $(id) {
    return document.getElementById(id);
  }

  function isDesktopWidth() {
    try {
      if (typeof window._isDesktopWidth === 'function') return window._isDesktopWidth();
    } catch (_) {}
    try { return window.matchMedia('(min-width:641px)').matches; }
    catch (_) { return true; }
  }

  function translate(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        const value = window.t(key);
        if (value && value !== key) return value;
      }
    } catch (_) {}
    return fallback;
  }

  function sidebarOpen() {
    const sidebar = document.querySelector('.sidebar');
    return !!(sidebar && sidebar.classList.contains('mobile-open'));
  }

  function buttonHomeShell() {
    return document.querySelector('.messages-shell');
  }

  function buttonHomeBefore(shell) {
    if (!shell) return null;
    return $('jumpToSessionStartBtn') || $('scrollToBottomBtn') || shell.firstElementChild;
  }

  function placeButtonForSidebarState(btn, open) {
    if (!btn) return;
    if (open) {
      if (btn.parentNode !== document.body) document.body.appendChild(btn);
      return;
    }
    const shell = buttonHomeShell();
    if (!shell || btn.parentNode === shell) return;
    const before = buttonHomeBefore(shell);
    shell.insertBefore(btn, before || null);
  }

  function appendSvgNode(svg, name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    svg.appendChild(node);
    return node;
  }

  function setButtonIcon(btn, open) {
    const svg = btn.querySelector('svg[data-hwx-mobile-conversations-icon="1"]');
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (open) {
      appendSvgNode(svg, 'line', { x1: '18', y1: '6', x2: '6', y2: '18' });
      appendSvgNode(svg, 'line', { x1: '6', y1: '6', x2: '18', y2: '18' });
      return;
    }
    appendSvgNode(svg, 'path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' });
  }

  function syncButton() {
    const btn = $(BUTTON_ID);
    if (!btn || btn.dataset.hwxMobileConversations !== '1') return;
    const open = sidebarOpen();
    placeButtonForSidebarState(btn, open);
    setButtonIcon(btn, open);
    btn.classList.toggle('mobile-conversations-fab--drawer-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close conversations' : 'Open conversations');
    btn.title = open ? 'Close conversations' : 'Conversations';
    if (open) btn.removeAttribute('aria-haspopup');
    else btn.setAttribute('aria-haspopup', 'menu');
  }

  function closeDrawer() {
    try {
      if (typeof window.closeMobileSidebar === 'function') {
        window.closeMobileSidebar();
        syncButton();
        return;
      }
    } catch (_) {}
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('mobileOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('visible');
    syncButton();
  }

  function openDrawerDirect() {
    if (isDesktopWidth()) return false;
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('mobileOverlay');
    if (!sidebar) return false;
    const layout = document.querySelector('.layout');
    if (layout) layout.classList.remove('sidebar-collapsed');
    sidebar.classList.remove('sidebar-collapsed');
    try { document.documentElement.removeAttribute('data-sidebar-collapsed'); } catch (_) {}
    sidebar.classList.add('mobile-open');
    if (overlay) overlay.classList.add('visible');
    syncButton();
    return true;
  }

  async function openChatDrawer() {
    if (isDesktopWidth()) return false;
    closeMenu();
    if (typeof window.switchPanel === 'function') {
      try {
        const result = await window.switchPanel('chat', { fromRailClick: true });
        if (result === false) {
          syncButton();
          return false;
        }
      } catch (_) {
        openDrawerDirect();
      }
    } else {
      openDrawerDirect();
    }
    if (!sidebarOpen()) openDrawerDirect();
    syncButton();
    return sidebarOpen();
  }

  async function toggleMobileConversationsSidebar() {
    if (isDesktopWidth()) return false;
    closeMenu();
    if (sidebarOpen()) {
      closeDrawer();
      return false;
    }
    return openChatDrawer();
  }

  function ignoreNextClick() {
    ignoreClickUntil = Date.now() + CLICK_IGNORE_MS;
  }

  function consumeIgnoredClick() {
    if (!ignoreClickUntil) return false;
    if (Date.now() > ignoreClickUntil) {
      ignoreClickUntil = 0;
      return false;
    }
    ignoreClickUntil = 0;
    return true;
  }

  function clearClickIgnore() {
    ignoreClickUntil = 0;
  }

  function clearPressTimer() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    const btn = $(BUTTON_ID);
    if (btn) btn.classList.remove('mobile-conversations-fab--pressing');
  }

  function icon(name) {
    const attrs = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (name === 'plus') return `<svg ${attrs}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
    if (name === 'message') return `<svg ${attrs}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    if (name === 'up') return `<svg ${attrs}><path d="m18 15-6-6-6 6"/></svg>`;
    return `<svg ${attrs}><path d="m6 9 6 6 6-6"/></svg>`;
  }

  function actionButton(label, title, iconName, onSelect) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'ws-opt session-action-opt mobile-conversations-menu-opt';
    opt.setAttribute('role', 'menuitem');
    opt.tabIndex = -1;
    if (title) opt.title = title;

    const action = document.createElement('span');
    action.className = 'ws-opt-action';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'ws-opt-icon';
    iconWrap.innerHTML = icon(iconName);

    const copy = document.createElement('span');
    copy.className = 'session-action-copy';
    const name = document.createElement('span');
    name.className = 'ws-opt-name';
    name.textContent = label;
    copy.appendChild(name);

    action.appendChild(iconWrap);
    action.appendChild(copy);
    opt.appendChild(action);

    opt.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      await onSelect();
    });
    return opt;
  }

  async function newConversation() {
    const btn = $('btnNewChat');
    if (btn) {
      btn.click();
      return;
    }
    if (typeof window.newSession === 'function') {
      await window.newSession();
      if (typeof window.renderSessionList === 'function') await window.renderSessionList();
      const msg = $('msg');
      if (msg && typeof msg.focus === 'function') msg.focus();
    }
  }

  async function goTop() {
    if (typeof window.jumpToSessionStart === 'function') {
      await window.jumpToSessionStart();
      return;
    }
    const messages = $('messages');
    if (messages) messages.scrollTop = 0;
  }

  function goLast() {
    if (typeof window.scrollToBottom === 'function') {
      window.scrollToBottom();
      return;
    }
    const messages = $('messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  function positionMenu() {
    const btn = $(BUTTON_ID);
    if (!menu || !btn) return;
    const rect = btn.getBoundingClientRect();
    const menuW = Math.min(280, Math.max(220, menu.scrollWidth || 220));
    let left = rect.right - menuW;
    if (left < 8) left = 8;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = '';
    const menuH = menu.offsetHeight || 0;
    const margin = 8;
    let top = rect.top - menuH - 8;
    if (top < margin) top = rect.bottom + 8;
    if (top + menuH > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - menuH);
    menu.style.top = `${top}px`;
  }

  function closeMenu() {
    if (menu) {
      menu.removeEventListener('keydown', menuKeydown);
      menu.remove();
      menu = null;
    }
    const btn = $(BUTTON_ID);
    if (btn) {
      btn.classList.remove('active', 'mobile-conversations-fab--pressing');
      btn.setAttribute('aria-haspopup', 'menu');
    }
    document.removeEventListener('pointerdown', outsidePointer, true);
    document.removeEventListener('scroll', scrollClose, true);
    window.removeEventListener('keydown', keyClose, true);
    window.removeEventListener('resize', resizeClose);
    syncButton();
  }

  function openMenu(anchor) {
    if (isDesktopWidth()) return false;
    const btn = anchor || $(BUTTON_ID);
    if (!btn) return false;
    try { if (typeof window.closeSessionActionMenu === 'function') window.closeSessionActionMenu(); } catch (_) {}
    closeMenu();

    menu = document.createElement('div');
    menu.className = 'session-action-menu mobile-conversations-menu hwx-mobile-conversations-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Conversation shortcuts');
    menu.appendChild(actionButton(translate('new_conversation', 'New conversation'), 'New conversation', 'plus', newConversation));
    menu.appendChild(actionButton('Open sidebar', 'Open conversations sidebar', 'message', openChatDrawer));
    menu.appendChild(actionButton('Go to top', 'Go to top of this conversation', 'up', goTop));
    menu.appendChild(actionButton('Go to last message', 'Go to latest message', 'down', goLast));
    document.body.appendChild(menu);

    btn.classList.add('active');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'true');
    positionMenu();
    requestAnimationFrame(positionMenu);
    const first = menu.querySelector('[role="menuitem"]');
    if (first && typeof first.focus === 'function') setTimeout(() => first.focus({ preventScroll: true }), 0);
    try { if (typeof window._playSessionActionMenuEntrance === 'function') window._playSessionActionMenuEntrance(menu); } catch (_) {}

    menu.addEventListener('keydown', menuKeydown);
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('scroll', scrollClose, true);
    window.addEventListener('keydown', keyClose, true);
    window.addEventListener('resize', resizeClose);
    return true;
  }

  function outsidePointer(event) {
    const btn = $(BUTTON_ID);
    if (menu && menu.contains(event.target)) return;
    if (btn && btn.contains(event.target)) return;
    closeMenu();
  }

  function scrollClose(event) {
    if (menu && menu.contains(event.target)) return;
    closeMenu();
  }

  function keyClose(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu();
    const btn = $(BUTTON_ID);
    if (btn && typeof btn.focus === 'function') btn.focus({ preventScroll: true });
  }

  function menuKeydown(event) {
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next >= 0) {
      event.preventDefault();
      items[next].focus({ preventScroll: true });
    }
  }

  function resizeClose() {
    closeMenu();
  }

  function buttonSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-hwx-mobile-conversations-icon', '1');
    appendSvgNode(svg, 'path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' });
    return svg;
  }

  function ensureButton() {
    let btn = $(BUTTON_ID);
    if (btn && btn.dataset.hwxMobileConversations !== '1') {
      // Core WebUI owns this affordance on newer builds; leave it alone.
      return null;
    }
    if (!btn) {
      const shell = document.querySelector('.messages-shell');
      if (!shell) return null;
      btn = document.createElement('button');
      btn.id = BUTTON_ID;
      btn.type = 'button';
      btn.className = 'mobile-conversations-fab hwx-mobile-conversations-fab';
      btn.dataset.hwxMobileConversations = '1';
      btn.setAttribute('aria-label', 'Open conversations');
      btn.setAttribute('aria-controls', 'panelChat');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'Conversations';
      btn.appendChild(buttonSvg());
      const before = buttonHomeBefore(shell);
      shell.insertBefore(btn, before || null);
    }
    return btn;
  }

  function wireButton(btn) {
    if (!btn || btn.__hwxMobileConversationsWired) return;
    btn.__hwxMobileConversationsWired = true;
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (consumeIgnoredClick()) return;
      await toggleMobileConversationsSidebar();
    });
    btn.addEventListener('pointerdown', (event) => {
      if (isDesktopWidth()) return;
      if (event.pointerType === 'mouse' || (event.button && event.button !== 0)) return;
      if (sidebarOpen()) {
        clearPressTimer();
        clearClickIgnore();
        return;
      }
      clearPressTimer();
      clearClickIgnore();
      pressX = event.clientX;
      pressY = event.clientY;
      btn.classList.add('mobile-conversations-fab--pressing');
      pressTimer = setTimeout(() => {
        pressTimer = null;
        ignoreNextClick();
        btn.classList.remove('mobile-conversations-fab--pressing');
        openMenu(btn);
      }, LONG_PRESS_DELAY_MS);
    });
    btn.addEventListener('pointermove', (event) => {
      if (!pressTimer) return;
      if (Math.abs(event.clientX - pressX) > 10 || Math.abs(event.clientY - pressY) > 10) clearPressTimer();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => btn.addEventListener(name, clearPressTimer));
    btn.addEventListener('contextmenu', (event) => {
      if (isDesktopWidth()) return;
      event.preventDefault();
      if (sidebarOpen()) return;
      clearPressTimer();
      ignoreNextClick();
      openMenu(btn);
    });
  }

  function observeSidebar() {
    if (sidebarObserver) return;
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebarObserver = new MutationObserver(syncButton);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  }

  function install(attempt = 0) {
    const btn = ensureButton();
    if (btn) {
      wireButton(btn);
      observeSidebar();
      syncButton();
      window.HermesMobileConversationsExtension = {
        version: '0.1.1',
        sync: syncButton,
        openMenu,
        toggle: toggleMobileConversationsSidebar,
      };
      return true;
    }
    if (attempt < INIT_RETRIES) setTimeout(() => install(attempt + 1), INIT_DELAY_MS);
    else console.warn(`[${EXT}] messages shell not found; mobile conversations button not installed`);
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
