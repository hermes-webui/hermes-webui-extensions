(() => {
  'use strict';

  // ── Session Export to PDF extension for Hermes WebUI ─────────────────────
  // Adds an "Export conversation" button to the app titlebar (next to Reload).
  // Clicking it opens a small menu: Export to PDF (print) or Copy as Markdown.
  // The PDF path clones the rendered transcript into a print-styled, off-screen
  // container and calls window.print() with a scoped @media print stylesheet, so
  // you control the output formatting instead of relying on raw Ctrl+P of the
  // whole app chrome. No backend, no bundled PDF library, no network.
  //
  // Credit: design reference is closed core PR #3425 (@vanshaj-pahwa) — the
  // print-markup / formatting approach; this is the extension form of that idea.

  const EXT = 'session-export-pdf';
  if (window.__hermesSessionExportLoaded) return;
  window.__hermesSessionExportLoaded = true;

  const BTN_ID = 'hwxExportBtn';
  const MENU_ID = 'hwxExportMenu';
  const PRINT_ROOT_ID = 'hwxPrintRoot';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function currentTitle() {
    const el = $('appTitlebarTitle');
    const t = el ? el.textContent.trim() : '';
    return (t && t !== 'Hermes') ? t : 'Conversation';
  }

  function hasOpenConversation() {
    const c = $('messages');
    return !!(c && c.querySelector('[data-msg-idx]'));
  }

  // ── extract the transcript as ordered {role, html/text} rows ─────────────
  // We read the REAL rendered rows so formatting (code blocks, lists, etc.) is
  // preserved for the PDF, and plain text for the Markdown copy. Hidden
  // anchor/worklog segments are skipped (same lesson as message-pins).
  function collectRows() {
    const container = $('messages');
    if (!container) return [];
    const rows = [];
    const seen = new Set();
    container.querySelectorAll('[data-msg-idx]').forEach((node) => {
      if (node.classList &&
          (node.classList.contains('assistant-segment-anchor') ||
           node.classList.contains('assistant-segment-worklog-source'))) return;
      const idx = node.getAttribute('data-msg-idx');
      if (idx == null || seen.has(idx)) return;
      const body = node.querySelector('.msg-body');
      if (!body) return;
      if (node.getBoundingClientRect().height <= 1) return;
      seen.add(idx);
      const isUser = !!node.closest('.msg-row') &&
        !node.classList.contains('assistant-turn') &&
        !node.querySelector('.role-icon.assistant');
      // role detection: assistant turns carry .role-icon.assistant / .assistant-turn
      const assistant = node.classList.contains('assistant-turn') ||
        node.querySelector('.role-icon.assistant') ||
        node.closest('.assistant-turn');
      rows.push({
        role: assistant ? 'assistant' : 'user',
        html: body.innerHTML,
        text: (body.innerText || body.textContent || '').trim(),
      });
    });
    return rows;
  }

  // ── PDF via print ─────────────────────────────────────────────────────────
  // Detect whether the transcript DOM is windowed/virtualized — in that case the
  // rendered #messages only holds part of the conversation, so an export from the
  // DOM is the "loaded/visible transcript", not necessarily the full session
  // (Frank, PR #27). Signals: a virtual spacer node, or the virtualize flag on
  // with a partial window.
  function transcriptMaybeWindowed() {
    try {
      const c = $('messages');
      if (!c) return false;
      if (c.querySelector('[data-virtual-spacer]')) return true;
      if (window._virtualizeTranscript === true) return true;
      return false;
    } catch (_) { return false; }
  }

  function exportPdf() {
    const rows = collectRows();
    if (!rows.length) { toast('No conversation to export.'); return; }
    const title = currentTitle();
    const windowed = transcriptMaybeWindowed();
    // Build an off-screen print root that ONLY shows during print.
    let root = $(PRINT_ROOT_ID);
    if (root) root.remove();
    root = document.createElement('div');
    root.id = PRINT_ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    let html = '<div class="hwx-print-head"><h1>' + escapeHtml(title) + '</h1>' +
      '<div class="hwx-print-meta">' + escapeHtml(new Date().toLocaleString()) +
      ' · ' + rows.length + ' messages rendered</div>' +
      (windowed
        ? '<div class="hwx-print-note">Note: this conversation is long enough to be ' +
          'windowed/virtualized, so this export covers the currently-loaded ' +
          'transcript, which may not include the entire conversation. Scroll to ' +
          'the top to load earlier messages before exporting for a complete copy.</div>'
        : '') +
      '</div>';
    for (const r of rows) {
      html += '<div class="hwx-print-msg hwx-print-' + r.role + '">' +
        '<div class="hwx-print-role">' + (r.role === 'user' ? 'You' : 'Assistant') + '</div>' +
        '<div class="hwx-print-body">' + r.html + '</div></div>';
    }
    root.innerHTML = html;
    document.body.appendChild(root);
    document.body.classList.add('hwx-printing');
    const cleanup = () => {
      document.body.classList.remove('hwx-printing');
      const r = $(PRINT_ROOT_ID);
      if (r) r.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    if (windowed) toast('Exporting the loaded transcript — scroll up to include earlier messages.');
    // Give layout a tick, then print.
    setTimeout(() => { try { window.print(); } catch (_) { cleanup(); } }, 60);
    closeMenu();
  }

  // ── Markdown copy ─────────────────────────────────────────────────────────
  function exportMarkdown() {
    const rows = collectRows();
    if (!rows.length) { toast('No conversation to export.'); return; }
    const windowed = transcriptMaybeWindowed();
    let md = '# ' + currentTitle() + '\n\n';
    if (windowed) {
      md += '> _Note: this export covers the currently-loaded transcript and may ' +
        'not include the entire conversation (long transcripts are windowed). ' +
        'Scroll to the top to load earlier messages before exporting._\n\n';
    }
    for (const r of rows) {
      md += '## ' + (r.role === 'user' ? 'You' : 'Assistant') + '\n\n' + r.text + '\n\n';
    }
    const done = () => toast(windowed
      ? 'Loaded transcript copied as Markdown (scroll up for earlier messages)'
      : 'Conversation copied as Markdown');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(done).catch(() => fallbackCopy(md, done));
    } else {
      fallbackCopy(md, done);
    }
    closeMenu();
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    ta.remove();
  }

  // ── menu ──────────────────────────────────────────────────────────────────
  function toggleMenu(anchor) {
    if ($(MENU_ID)) { closeMenu(); return; }
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'hwx-export-menu';
    menu.setAttribute('role', 'menu');
    const mkItem = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hwx-export-item'; b.textContent = label;
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    menu.appendChild(mkItem('Export to PDF', exportPdf));
    menu.appendChild(mkItem('Copy as Markdown', exportMarkdown));
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth || 180;
    let left = r.right - w;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }
  function outside(e) { const m = $(MENU_ID); if (m && !m.contains(e.target) && e.target.id !== BTN_ID && !(e.target.closest && e.target.closest('#' + BTN_ID))) closeMenu(); }
  function esc(e) { if (e.key === 'Escape') closeMenu(); }
  function closeMenu() {
    const m = $(MENU_ID); if (m) m.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  }

  // ── toast ─────────────────────────────────────────────────────────────────
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'hwx-export-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('hwx-export-toast--in'); }, 10);
    setTimeout(() => { t.classList.remove('hwx-export-toast--in'); setTimeout(() => t.remove(), 250); }, 2200);
  }

  // ── titlebar button ───────────────────────────────────────────────────────
  function icon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>';
  }
  function ensureButton() {
    if ($(BTN_ID)) return $(BTN_ID);
    const reload = $('btnReload');
    const titlebar = document.querySelector('.app-titlebar');
    if (!titlebar) return null;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'hwx-export-btn has-tooltip has-tooltip--bottom';
    btn.dataset.tooltip = 'Export conversation';
    btn.setAttribute('aria-label', 'Export conversation');
    btn.innerHTML = icon();
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(btn); });
    // Place just before Reload so it sits in the titlebar's right cluster.
    if (reload && reload.parentNode) reload.parentNode.insertBefore(btn, reload);
    else titlebar.appendChild(btn);
    return btn;
  }

  function refresh() {
    const btn = ensureButton();
    if (!btn) return;
    btn.style.display = hasOpenConversation() ? '' : 'none';
  }

  // ── observe so the button shows/hides with the open conversation ──────────
  let raf = false;
  function schedule() {
    if (raf) return; raf = true;
    requestAnimationFrame(() => { raf = false; try { refresh(); } catch (_) {} });
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.querySelector('.app-titlebar')) {
      ensureButton();
      refresh();
      const c = $('messages');
      if (c) {
        const obs = new MutationObserver(schedule);
        obs.observe(c, { childList: true, subtree: true });
      }
      window.HermesSessionExportExtension = {
        version: '0.1.0',
        exportPdf, exportMarkdown, refresh,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] app titlebar not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
