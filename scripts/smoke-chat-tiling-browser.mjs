#!/usr/bin/env node
// Real-browser smoke test for Chat Tiling.
//
// Loads the CURRENT Core page (hermes-webui static/index.html) in a real
// Chromium via Playwright, injects the extension the way the host does, and
// asserts the user-visible toolbar controls render with the expected
// aria-labels. This is deliberately NOT a synthetic fixture: the page is the
// real Core markup from the hermes-webui repo (local checkout via
// HERMES_WEBUI_DIR, else fetched from GitHub master). The synthetic JSDOM
// suite (scripts/test-chat-tiling.mjs) must not be the only evidence for the
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
const STUBS = `
  window.S = { session: null, messages: [], busy: false, activeStreamId: null };
  window.HermesExtensionSettings = { settingsForExtension: () => ({ get: (k) => k === 'auto_tile' ? true : undefined }) };
  window.registerHermesSessionOpenHandler = () => {};
  window.renderTranscript = (container, msgs) => { if (container) container.innerHTML = ''; };
  window.renderMessages = () => {};
  window.loadSession = () => Promise.resolve();
  window.cancelSessionStream = () => Promise.resolve(true);
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

  const browser = await chromium.launch();
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
    return {
      hasToolbar: !!tb,
      inTitlebar: !!tb && !!titlebar && titlebar.contains(tb),
      labels,
      hasTopbar,
      grid: !!document.getElementById('ext-tile-grid'),
    };
  });

  console.log(`\nCurrent Core DOM: #topbar=${result.hasTopbar} .app-titlebar=${!!result.inTitlebar}`);
  assert(result.hasToolbar, '#ext-tiling-toolbar rendered on the current Core page');
  assert(result.inTitlebar, 'toolbar is anchored inside .app-titlebar (current Core host hook)');
  assert(!result.hasTopbar, 'current Core page has no #topbar (the stale selector that broke v0)');
  assert(result.labels.includes('Split in 2'), 'renders aria-label "Split in 2"');
  assert(result.labels.includes('Split in 4'), 'renders aria-label "Split in 4"');
  assert(result.labels.includes('Split in 6'), 'renders aria-label "Split in 6"');
  assert(result.labels.includes('Close tiling'), 'renders aria-label "Close tiling"');

  // Click "Split in 2" — the entry point must actually open the grid.
  await page.click('[aria-label="Split in 2"]');
  await page.waitForTimeout(200);
  const gridActive = await page.evaluate(() => {
    const grid = document.getElementById('ext-tile-grid');
    return !!grid && grid.classList.contains('ext-tile-grid--active') &&
           document.querySelectorAll('.ext-tile').length === 2;
  });
  assert(gridActive, 'clicking "Split in 2" opens a 2-tile grid on the current Core page');

  await browser.close();
  server.close();

  console.log(`\nSmoke test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Smoke test error:', e);
  process.exit(1);
});
