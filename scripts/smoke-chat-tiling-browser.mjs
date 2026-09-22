#!/usr/bin/env node
// Real-browser smoke test for Chat Tiling.
//
// Loads the CURRENT Core page (hermes-webui static/index.html) in a real
// Chromium via Playwright, injects the extension the way the host does, and
// asserts the user-visible entry point actually works: the toolbar renders and
// is VISIBLE, clicking it opens the grid, tiles occupy distinct cells, the
// overlay is anchored to the non-scrolling shell, and a click inside the
// focused tile reaches the live #msgInner.
//
// This is deliberately NOT a synthetic fixture: the page is the real Core
// markup from the hermes-webui repo (local checkout via HERMES_WEBUI_DIR, else
// fetched from GitHub master). The synthetic JSDOM suite
// (scripts/test-chat-tiling.mjs) must not be the only evidence for the
// user-visible entry point.
//
// Usage:
//   node scripts/smoke-chat-tiling-browser.mjs
// Env:
//   HERMES_WEBUI_DIR  path to a hermes-webui checkout (default: ../hermes-webui)
//   HERMES_SMOKE_URL  optional full URL of a running Core instance
//   CHAT_TILING_KEEP   keep the server/browser open (for debugging)

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const extPath = path.join(repoRoot, 'extensions/chat-tiling/assets/tiling.js');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ FAIL: ' + msg); } }

async function fetchCoreHtml() {
  const localDir = process.env.HERMES_WEBUI_DIR || path.resolve(repoRoot, '..', 'hermes-webui');
  const localIndex = path.join(localDir, 'static/index.html');
  if (existsSync(localIndex)) {
    console.log(`Using local Core checkout: ${localIndex}`);
    return readFileSync(localIndex, 'utf8');
  }
  console.log('No local hermes-webui checkout; fetching current Core from GitHub master');
  const res = await fetch('https://raw.githubusercontent.com/nesquena/hermes-webui/master/static/index.html');
  if (!res.ok) throw new Error(`Failed to fetch Core index.html: HTTP ${res.status}`);
  return res.text();
}

// Core's extension hooks (registerHermesSessionOpenHandler, renderTranscript)
// live in boot.js, which needs a live backend. Stand in for just those hooks
// so the extension can init against the REAL Core DOM structure.
//
// The stubs mirror Core's real contracts: `S` is a top-level lexical global
// (ui.js `const S`), and cancelSessionStream(session) refuses unless both
// snake_case stream/session fields are present.
const STUBS = `
  window.S = { session: null, messages: [], busy: false, activeStreamId: null };
  window.HermesExtensionSettings = { settingsForExtension: () => ({ get: (k) => k === 'auto_tile' ? true : undefined }) };
  window.registerHermesSessionOpenHandler = (fn) => { window.handlerRegistration = fn; };
  window.renderTranscript = (container, msgs) => { if (container) container.innerHTML = ''; };
  window.renderMessages = () => {};
  window.loadSession = (sid) => {
    window.S.session = { session_id: sid, title: sid, messages: [] };
    const composer = document.getElementById('msg');
    if (composer) composer.value = '';
    return Promise.resolve();
  };
  // Mirrors Core's boot.js::cancelSessionStream(session).
  window.__cancelCalls = [];
  window.cancelSessionStream = (session) => {
    window.__cancelCalls.push(session);
    if (!session || !session.active_stream_id || !session.session_id) return Promise.resolve(false);
    return Promise.resolve(true);
  };
  window.autoResize = () => {};
  window.syncTopbar = () => {};
  window.syncModelChip = () => {};
  window.showToast = () => {};
  window.clearInflightState = () => {};
  window.INFLIGHT = {};
  window.CSS = { escape: (s) => s };
`;

async function main() {
  const coreHtml = await fetchCoreHtml();

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(coreHtml);
      return;
    }
    if (req.url === '/extensions/chat-tiling/assets/tiling.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(readFileSync(extPath, 'utf8'));
      return;
    }
    // Everything else (static/... assets the real page references) can 404 —
    // the DOM structure we assert on is already in the served HTML.
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Serving current Core page on http://127.0.0.1:${port}`);

  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  // Allow pointing at a system Chromium when Playwright's own download is
  // unavailable (e.g. a firewall blocks cdn.playwright.dev).
  if (process.env.CHAT_TILING_CHROMIUM) launchOpts.executablePath = process.env.CHAT_TILING_CHROMIUM;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  await page.addInitScript(STUBS);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // Inject the extension the way the host does (script tag), then wait for init.
  await page.addScriptTag({ path: extPath });
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const tb = document.getElementById('ext-tiling-toolbar');
    const titlebar = document.querySelector('.app-titlebar');
    const hasTopbar = !!document.getElementById('topbar');
    const labels = tb ? Array.from(tb.querySelectorAll('.ext-toolbar-btn')).map(b => b.getAttribute('aria-label')) : [];
    const cs = tb ? getComputedStyle(tb) : null;
    const rect = tb ? tb.getBoundingClientRect() : null;
    return {
      hasToolbar: !!tb,
      inTitlebar: !!tb && !!titlebar && titlebar.contains(tb),
      labels,
      hasTopbar,
      toolbarVisible: !!tb && !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && !!rect && rect.height > 0,
      grid: !!document.getElementById('ext-tile-grid'),
    };
  });

  console.log(`\nCurrent Core DOM: #topbar=${result.hasTopbar} .app-titlebar=${!!result.inTitlebar}`);
  assert(result.hasToolbar, '#ext-tiling-toolbar rendered on the current Core page');
  assert(result.inTitlebar, 'toolbar is anchored inside .app-titlebar (current Core host hook)');
  assert(result.toolbarVisible, 'toolbar is actually VISIBLE on the chat view (not display:none)');
  assert(!result.hasTopbar, 'current Core page has no #topbar (the stale selector that broke v0)');
  assert(result.labels.includes('Split in 2'), 'renders aria-label "Split in 2"');
  assert(result.labels.includes('Split in 4'), 'renders aria-label "Split in 4"');
  assert(result.labels.includes('Split in 6'), 'renders aria-label "Split in 6"');
  assert(result.labels.includes('Close tiling'), 'renders aria-label "Close tiling"');

  // Click "Split in 2" — the entry point must actually open the grid.
  await page.click('[aria-label="Split in 2"]');
  await page.waitForTimeout(300);
  const gridState = await page.evaluate(() => {
    const grid = document.getElementById('ext-tile-grid');
    const shell = document.querySelector('.messages-shell');
    const messages = document.getElementById('messages');
    const tiles = Array.from(document.querySelectorAll('.ext-tile'));
    const boxes = tiles.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      hasGrid: !!grid,
      anchoredToShell: !!grid && !!shell && grid.parentElement === shell,
      insideScrollContainer: !!grid && grid.parentElement === messages,
      tileCount: tiles.length,
      boxes,
      hasFocusedBody: !!document.querySelector('.ext-tile--focused .ext-tile-body'),
      hasMsgInner: !!document.getElementById('msgInner'),
    };
  });

  assert(gridState.hasGrid, 'clicking "Split in 2" opens the tile grid on the current Core page');
  assert(gridState.tileCount === 2, `grid renders 2 tiles (got ${gridState.tileCount})`);
  assert(gridState.anchoredToShell, 'grid is anchored to .messages-shell (the non-scrolling overlay host)');
  assert(!gridState.insideScrollContainer, 'grid is NOT inside the scrolling #messages');
  const origins = new Set(gridState.boxes.map((b) => `${b.x},${b.y}`));
  assert(origins.size === gridState.boxes.length, `tiles occupy distinct cells, no overlap (${JSON.stringify(gridState.boxes)})`);
  assert(gridState.boxes.every((b) => b.w > 50 && b.h > 50), 'tiles are usable size (not collapsed/overlapping)');
  assert(gridState.hasMsgInner, '#msgInner present in the live Core DOM');

  // The stub page does not run Core's layout/scroll management, so make the
  // live transcript region deterministically occupy the transcript viewport.
  // The probe then measures what it is meant to: that the focused tile is a
  // transparent window onto #msgInner rather than a click-blocking surface.
  await page.evaluate(() => {
    const mi = document.getElementById('msgInner');
    const m = document.getElementById('messages');
    if (!mi) return;
    // Fixed + z-index 0 pins the live region to the viewport while keeping the
    // tile overlay (z-index 10) above it, so the probe measures pass-through
    // rather than Core's unstubbed scroll geometry.
    mi.style.position = 'fixed';
    mi.style.inset = '0';
    mi.style.zIndex = '0';
    mi.style.overflow = 'auto';
    mi.innerHTML = '';
    for (let i = 0; i < 40; i++) {
      const d = document.createElement('div');
      d.textContent = 'live transcript line ' + i;
      d.style.minHeight = '40px';
      mi.appendChild(d);
    }
  });
  await page.waitForTimeout(150);

  // A click inside the focused tile must reach the live #msgInner beneath it.
  await page.evaluate(() => {
    window.__innerClicks = 0;
    const mi = document.getElementById('msgInner');
    if (mi) mi.addEventListener('click', () => { window.__innerClicks++; }, { once: true });
  });

  // Click a point that lies inside BOTH the focused tile body and #msgInner.
  const target = await page.evaluate(() => {
    const body = document.querySelector('.ext-tile--focused .ext-tile-body');
    const mi = document.getElementById('msgInner');
    if (!body || !mi) return null;
    const a = body.getBoundingClientRect();
    const b = mi.getBoundingClientRect();
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.right, b.right), y2 = Math.min(a.bottom, b.bottom);
    if (x2 <= x1 || y2 <= y1) {
      return { overlap: false, body: { x: a.x, y: a.y, w: a.width, h: a.height }, inner: { x: b.x, y: b.y, w: b.width, h: b.height } };
    }
    return { overlap: true, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  });
  assert(!!target && target.overlap === true,
    `focused tile body overlaps the live transcript (${JSON.stringify(target)})`);
  if (target && target.overlap) {
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(300);
  }
  const innerClicks = await page.evaluate(() => window.__innerClicks || 0);
  assert(innerClicks >= 1, `click inside the focused tile reaches #msgInner (got ${innerClicks})`);

  await browser.close();
  server.close();

  console.log(`\nSmoke test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Smoke test error:', e);
  process.exit(1);
});
