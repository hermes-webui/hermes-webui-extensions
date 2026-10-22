// btop core helpers: formatting, history merge, sort, filter grammar, tree.
// Runs in this repo (extension/) and in the gallery (extensions/btop/):  node --test <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CORE = ['../extension/assets/btop-core.js', '../extensions/btop/assets/btop-core.js']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((p) => existsSync(p));
// Same-realm load (deepStrictEqual compares prototypes), independent of the
// surrounding package.json "type", via the UMD module.exports branch.
const mod = { exports: {} };
new vm.Script('(function (module) {' + readFileSync(CORE, 'utf8') + '\n})', { filename: CORE })
  .runInThisContext()(mod);
const C = mod.exports;

const procs = [
  { pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init', user: 'root', cpu: 0, mem: 8e6, threads: 1, group: null },
  { pid: 100, ppid: 1, name: 'python3', cmd: '/opt/hermes-webui/server.py', user: 'root', cpu: 3.5, mem: 4.8e8, threads: 20, group: 'webui' },
  { pid: 101, ppid: 100, name: 'node', cmd: 'node pyright-langserver --stdio', user: 'root', cpu: 0.5, mem: 2.6e8, threads: 9, group: 'webui' },
  { pid: 200, ppid: 1, name: 'hermes', cmd: 'python3 -I -c hermes', user: 'root', cpu: 12, mem: 3.7e8, threads: 30, group: 'agent' },
  { pid: 201, ppid: 200, name: 'bash', cmd: 'bash -c ls', user: 'root', cpu: 0, mem: 3e6, threads: 1, group: 'agent' },
  { pid: 300, ppid: 1, name: 'sshd', cmd: 'sshd: /usr/sbin/sshd -D', user: 'root', cpu: 0, mem: 5e5, threads: 1, group: null },
  { pid: 400, ppid: 1, name: 'node', cmd: 'node server.js', user: 'blabbleu', cpu: 1, mem: 3.4e7, threads: 11, group: null },
];

test('fmtBytes', () => {
  assert.equal(C.fmtBytes(0), '0 B');
  assert.equal(C.fmtBytes(1536), '1.50 KiB');
  assert.equal(C.fmtBytes(4294967296), '4.00 GiB');
  assert.equal(C.fmtBytes(2048, { rate: true }), '2.00 KiB/s');
  assert.equal(C.fmtBytes(512 * 1024 * 1024, { compact: true }), '512M');
  assert.equal(C.fmtBytes(null), '–');
});

test('fmtBits / durations', () => {
  assert.equal(C.fmtBits(125000), '1.0 Mbps');
  assert.equal(C.fmtDuration(59), '59s');
  assert.equal(C.fmtDuration(3725), '1h 02m');
  assert.equal(C.fmtDuration(90061), '1d 1h');
  assert.equal(C.fmtUptime(1381904), '15d 23:51');
});

test('mergeHistory appends only newer samples and caps length', () => {
  const h = [{ s: 1 }, { s: 2 }];
  const out = C.mergeHistory(h, [{ s: 2 }, { s: 3 }, { s: 4 }], 3);
  assert.deepEqual(out.map((x) => x.s), [2, 3, 4]);
  assert.deepEqual(C.mergeHistory(h, [], 10).map((x) => x.s), [1, 2]);
});

test('fitSeries pads the front so short history is flush right', () => {
  assert.deepEqual(C.fitSeries([1, 2], 4), [null, null, 1, 2]);
  assert.deepEqual(C.fitSeries([1, 2, 3, 4, 5], 3), [3, 4, 5]);
});

test('sparkline scales to max', () => {
  assert.equal(C.sparkline([0, 50, 100], 100, 3), ' ▄█');
  assert.equal(C.sparkline([], 100, 2), '  ');
});

test('sort by cpu desc and by name asc', () => {
  assert.deepEqual(C.sortProcs(procs, 'cpu', true).slice(0, 3).map((p) => p.pid), [200, 100, 400]);
  assert.equal(C.sortProcs(procs, 'name', false)[0].name, 'bash');
});

test('filter terms: text, pid, user, group, negation, hermes', () => {
  assert.deepEqual(C.filterProcs(procs, 'node').map((p) => p.pid), [101, 400]);
  assert.deepEqual(C.filterProcs(procs, '200').map((p) => p.pid), [200]);
  assert.deepEqual(C.filterProcs(procs, 'blabbleu').map((p) => p.pid), [400]);
  assert.deepEqual(C.filterProcs(procs, 'g:webui').map((p) => p.pid), [100, 101]);
  assert.deepEqual(C.filterProcs(procs, 'node !g:webui').map((p) => p.pid), [400]);
  assert.deepEqual(C.filterProcs(procs, 'g:*').map((p) => p.pid).sort(), [100, 101, 200, 201]);
  assert.deepEqual(C.filterProcs(procs, 'hermes').map((p) => p.pid).sort(), [100, 101, 200, 201]);
  assert.equal(C.filterProcs(procs, '').length, procs.length);
});

test('tree: structure, prefixes, collapse, filtered ancestors dimmed', () => {
  const rows = C.buildTree(procs, 'cpu', true, '', new Set());
  assert.equal(rows[0].pid, 1);
  assert.equal(rows[0].depth, 0);
  const kids = rows.filter((r) => r.depth === 1).map((r) => r.pid);
  assert.deepEqual(kids, [200, 100, 400, 300]);
  const last = rows.find((r) => r.pid === 300);
  assert.equal(last.prefix, '└─');
  const nested = rows.find((r) => r.pid === 201);
  assert.equal(nested.depth, 2);
  assert.equal(nested.prefix, '│ └─');

  const collapsed = C.buildTree(procs, 'cpu', true, '', new Set([200]));
  assert.ok(!collapsed.some((r) => r.pid === 201));
  assert.ok(collapsed.find((r) => r.pid === 200).collapsed);

  const filtered = C.buildTree(procs, 'cpu', true, 'pyright', new Set());
  assert.deepEqual(filtered.map((r) => r.pid), [1, 100, 101]);
  assert.ok(filtered[0].dimmed && filtered[1].dimmed && !filtered[2].dimmed);
});

test('tree tolerates cycles and missing parents', () => {
  const weird = [{ pid: 5, ppid: 6, name: 'a', cpu: 0, mem: 0 }, { pid: 6, ppid: 5, name: 'b', cpu: 0, mem: 0 }, { pid: 7, ppid: 999, name: 'c', cpu: 0, mem: 0 }];
  const rows = C.buildTree(weird, 'pid', false, '', new Set());
  assert.ok(rows.some((r) => r.pid === 7));
  assert.ok(rows.length <= 3);
});

test('pickIface prefers busiest non-loopback', () => {
  const net = { lo: { rx_total: 9e12, tx_total: 9e12 }, eth0: { rx_total: 1e9, tx_total: 1e9 }, docker0: { rx_total: 1e6, tx_total: 1e6 } };
  assert.equal(C.pickIface(net), 'eth0');
  assert.equal(C.pickIface({ lo: { rx_total: 1, tx_total: 1 } }), 'lo');
});


// ── colour contrast ───────────────────────────────────────────────────────
// Every Core skin's colour tokens, light and dark, generated from
// hermes-webui static/style.css (master ca8f81e); a skin that does not set a
// token inherits the default palette, as in Core. Roles a skin never defines
// (accent2/accent3/link) use the extension's fallbacks, as btop.js does.
const SKINS = {
  "default/light": {"bg": "#FEFCF7", "text": "#1A1610", "accent": "#B8860B", "info": "#0288A8", "success": "#3D8B40", "warning": "#E68A00", "error": "#C62828"},
  "default/dark": {"bg": "#0D0D1A", "text": "#FFF8DC", "accent": "#FFD700", "info": "#4DD0E1", "success": "#4CAF50", "warning": "#FFA726", "error": "#EF5350"},
  "graphite/light": {"bg": "#FFFFFF", "text": "#242424", "accent": "#303030", "info": "#55564F", "success": "#0F8F70", "warning": "#B87916", "error": "#D44D4D"},
  "graphite/dark": {"bg": "#151614", "text": "#ECEBE4", "accent": "#D7D6CE", "info": "#C9C8C0", "success": "#10A37F", "warning": "#E6B15C", "error": "#FF6B6B"},
  "codex/light": {"bg": "#FFFFFF", "text": "#252523", "accent": "#2E7A60", "info": "#4D8DFF", "success": "#2E7A60", "warning": "#B87916", "error": "#D92D20"},
  "codex/dark": {"bg": "#151614", "text": "#ECEBE4", "accent": "#72B39A", "info": "#C9C8C0", "success": "#72B39A", "warning": "#E6B15C", "error": "#FF6B6B"},
  "terracotta/light": {"bg": "#FAF9F5", "text": "#30302E", "accent": "#D97757", "info": "#6396D6", "success": "#6EA100", "warning": "#B87916", "error": "#C15F3C"},
  "terracotta/dark": {"bg": "#141413", "text": "#EDEAE0", "accent": "#D97757", "info": "#7BA7DE", "success": "#9BCB5A", "warning": "#E6B15C", "error": "#F08A6F"},
  "github/light": {"bg": "#FFFFFF", "text": "#242424", "accent": "#0969DA", "info": "#0969DA", "success": "#1A7F37", "warning": "#9A6700", "error": "#D1242F"},
  "github/dark": {"bg": "#151614", "text": "#ECEBE4", "accent": "#4493F8", "info": "#58A6FF", "success": "#3FB950", "warning": "#D29922", "error": "#FF7B72"},
  "sienna/light": {"bg": "#FAF9F5", "text": "#1F1E1C", "accent": "#D97757", "info": "#0288A8", "success": "#3D8B40", "warning": "#E68A00", "error": "#C62828"},
  "sienna/dark": {"bg": "#1F1E1C", "text": "#EDEBE3", "accent": "#E0896D", "info": "#4DD0E1", "success": "#4CAF50", "warning": "#FFA726", "error": "#EF5350"},
  "catppuccin/light": {"bg": "#EFF1F5", "text": "#4C4F69", "accent": "#8839EF", "info": "#0288A8", "success": "#3D8B40", "warning": "#E68A00", "error": "#C62828"},
  "catppuccin/dark": {"bg": "#1E1E2E", "text": "#CDD6F4", "accent": "#CBA6F7", "info": "#4DD0E1", "success": "#4CAF50", "warning": "#FFA726", "error": "#EF5350"},
  "hepburn/light": {"bg": "#fff3f7", "text": "#3d1a28", "accent": "#d44a7a", "info": "#8671e5", "success": "#3d8b40", "warning": "#e67e22", "error": "#c0392b"},
  "hepburn/dark": {"bg": "#110a0f", "text": "#f2e4ee", "accent": "#f278ad", "info": "#8671e5", "success": "#6cd4a5", "warning": "#f2b370", "error": "#ff5c5c"},
  "nous/light": {"bg": "#FFFFFF", "text": "#1A2A3A", "accent": "#4682B4", "info": "#4682B4", "success": "#3D8B40", "warning": "#E68A00", "error": "#C62828"},
  "nous/dark": {"bg": "#0A0E14", "text": "#C8D6E5", "accent": "#4682B4", "info": "#4682B4", "success": "#4CAF50", "warning": "#FFA726", "error": "#EF5350"},
  "geist-contrast/light": {"bg": "#ffffff", "text": "#111111", "accent": "#0070f3", "info": "#0070f3", "success": "#007a45", "warning": "#b45309", "error": "#e5484d"},
  "geist-contrast/dark": {"bg": "#000000", "text": "#ededed", "accent": "#FFF175", "info": "#FFF175", "success": "#3dd68c", "warning": "#f5a524", "error": "#ff6369"},
  "zeus/dark": {"bg": "#0F0F0F", "text": "#FFF8DC", "accent": "#FFD700", "info": "#4DD0E1", "success": "#4CAF50", "warning": "#FFA726", "error": "#EF5350"},
  "neon/light": {"bg": "#F8F7FC", "text": "#1E1B2E", "accent": "#9333EA", "info": "#7C3AED", "success": "#059669", "warning": "#D97706", "error": "#DC2626"},
  "neon/dark": {"bg": "#08060d", "text": "#d8d6f0", "accent": "#b347ff", "info": "#00ddff", "success": "#00dd88", "warning": "#ffaa33", "error": "#ff4466"},
  "neon-soft/light": {"bg": "#F8F7FC", "text": "#1E1B2E", "accent": "#9333EA", "info": "#7C3AED", "success": "#059669", "warning": "#D97706", "error": "#DC2626"},
  "neon-soft/dark": {"bg": "#181428", "text": "#e8e6f8", "accent": "#b347ff", "info": "#00ddff", "success": "#00dd88", "warning": "#ffaa33", "error": "#ff4466"},
  "neon-paint/light": {"bg": "#F5F0FF", "text": "#1A1028", "accent": "#FF2D95", "info": "#00E5FF", "success": "#00E676", "warning": "#FFB300", "error": "#FF1744"},
  "neon-paint/dark": {"bg": "#0D0A16", "text": "#f0e8ff", "accent": "#FF2D95", "info": "#00E5FF", "success": "#00E676", "warning": "#FFB300", "error": "#FF1744"},
  "verdigris/dark": {"bg": "#0F1714", "text": "#F3ECDD", "accent": "#C89A5A", "info": "#C89A5A", "success": "#719A68", "warning": "#D1A45C", "error": "#D26A6A"}
};
const ROLE_FALLBACKS = { accent: '#58a6ff', info: '#4dd0e1', success: '#3fb950', warning: '#d29922',
  error: '#f85149', link: '#79c0ff', accent2: '#bc8cff', accent3: '#ff9bce' };

test('parseColor handles hex, rgb() and color(srgb)', () => {
  assert.deepEqual(C.parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(C.parseColor('#3D8B40'), [61, 139, 64]);
  assert.deepEqual(C.parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(C.parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30]);
  assert.deepEqual(C.parseColor('rgb(10 20 30 / 50%)'), [10, 20, 30]);
  assert.deepEqual(C.parseColor('color(srgb 1 0.5 0)'), [255, 128, 0]);
  assert.equal(C.parseColor('var(--x)'), null);
});

test('contrast matches WCAG reference values', () => {
  assert.equal(Math.round(C.contrast([0, 0, 0], [255, 255, 255]) * 100) / 100, 21);
  assert.equal(Math.round(C.contrast([255, 255, 255], [255, 255, 255]) * 100) / 100, 1);
  assert.ok(Math.abs(C.contrast(C.parseColor('#767676'), [255, 255, 255]) - 4.54) < 0.01);
});

test('textSafe keeps passing colours and fixes failing ones', () => {
  const white = [255, 255, 255];
  assert.equal(C.textSafe([0, 0, 0], white, 4.5), '#000000');
  const fixed = C.textSafe(C.parseColor('#00E5FF'), C.parseColor('#F5F0FF'), 5);   // neon-paint light info: 1.4:1 raw
  assert.ok(C.contrast(C.parseColor(fixed), C.parseColor('#F5F0FF')) >= 5);
  const dark = C.textSafe(C.parseColor('#5A6A7A'), C.parseColor('#0A0E14'), 5);    // lightened on dark
  assert.ok(C.luminance(C.parseColor(dark)) > C.luminance(C.parseColor('#5A6A7A')));
});

test('every box-title role reaches 5:1 in every Core skin (light and dark)', () => {
  let worstRaw = Infinity;
  let checked = 0;
  for (const [skin, tok] of Object.entries(SKINS)) {
    const bg = C.parseColor(tok.bg);
    for (const role of Object.keys(ROLE_FALLBACKS)) {
      const fg = C.parseColor(tok[role] || ROLE_FALLBACKS[role]);
      worstRaw = Math.min(worstRaw, C.contrast(fg, bg));
      const safe = C.parseColor(C.textSafe(fg, bg, 5));
      assert.ok(C.contrast(safe, bg) >= 5, skin + ' ' + role + ' -> ' + C.toHex(safe));
      checked++;
    }
  }
  assert.ok(checked >= 200, 'checked ' + checked);
  assert.ok(worstRaw < 2, 'fixture should include failing raw colours (worst ' + worstRaw.toFixed(2) + ')');
});

test('shortcut guard: fields, foreign UI and activation keys on controls', () => {
  assert.equal(C.shortcutAllowed('t', {}), true);
  assert.equal(C.shortcutAllowed('t', { editable: true }), false);
  assert.equal(C.shortcutAllowed('1', { foreign: true }), false);
  assert.equal(C.shortcutAllowed(' ', { control: true }), false);       // e.g. focused "confirm KILL?"
  assert.equal(C.shortcutAllowed('Enter', { control: true }), false);
  assert.equal(C.shortcutAllowed('ArrowDown', { control: true }), false);
  assert.equal(C.shortcutAllowed('t', { control: true }), true);         // letters have no native action
  assert.equal(C.shortcutAllowed(' ', {}), true);                         // body focus: space pauses
});
