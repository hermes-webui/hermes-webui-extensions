/* btop for Hermes WebUI — pure helpers (no DOM). Loaded before btop.js and
   importable from node for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HermesBtopCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];

  function fmtBytes(n, opts) {
    opts = opts || {};
    if (n == null || !isFinite(n)) return '–';
    let v = Math.abs(n);
    let i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
    const unit = UNITS[i] + (opts.rate ? (i === 0 ? '/s' : 'iB/s') : (i === 0 ? '' : 'iB'));
    return (n < 0 ? '-' : '') + v.toFixed(digits) + (opts.compact ? UNITS[i] : ' ' + unit);
  }

  function fmtBits(bytesPerSec) {
    if (bytesPerSec == null || !isFinite(bytesPerSec)) return '–';
    let v = bytesPerSec * 8;
    const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
    let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m) return m + 'm ' + String(s).padStart(2, '0') + 's';
    return s + 's';
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(sec / 86400);
    const hh = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    return (d ? d + 'd ' : '') + hh + ':' + mm;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* Merge a history delta from the sidecar into the client ring.
     Returns a new array (max `max` entries) sorted by seq, de-duplicated. */
  function mergeHistory(hist, delta, max) {
    max = max || 600;
    if (!Array.isArray(delta) || !delta.length) return hist.slice(-max);
    const last = hist.length ? hist[hist.length - 1].s : 0;
    const out = hist.slice();
    for (const h of delta) {
      if (h && typeof h.s === 'number' && h.s > last) out.push(h);
    }
    return out.length > max ? out.slice(out.length - max) : out;
  }

  /* Resample a series to exactly `n` points (newest last), padding the front
     with nulls so a short history renders flush right like btop. */
  function fitSeries(values, n) {
    if (n <= 0) return [];
    if (values.length >= n) return values.slice(values.length - n);
    return new Array(n - values.length).fill(null).concat(values);
  }

  const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  function sparkline(values, max, width) {
    const vals = fitSeries(values || [], width || values.length);
    const top = max || Math.max(1, ...vals.filter((v) => v != null));
    return vals.map((v) => {
      if (v == null || v <= 0) return ' ';
      return SPARK[clamp(Math.ceil((v / top) * SPARK.length) - 1, 0, SPARK.length - 1)];
    }).join('');
  }

  /* Choose a "nice" ceiling for auto-scaled graphs (net/disk). */
  function niceCeil(v) {
    if (!v || v <= 0) return 1024;
    const p = Math.pow(2, Math.ceil(Math.log2(v)));
    return Math.max(1024, p);
  }

  /* ── processes ─────────────────────────────────────────────────────────── */
  const SORT_KEYS = {
    pid: (p) => p.pid,
    name: (p) => (p.name || '').toLowerCase(),
    cmd: (p) => (p.cmd || '').toLowerCase(),
    threads: (p) => p.threads || 0,
    user: (p) => (p.user || '').toLowerCase(),
    mem: (p) => p.mem || 0,
    cpu: (p) => p.cpu || 0,
    age: (p) => p.age || 0,
  };

  function sortProcs(list, key, desc) {
    const get = SORT_KEYS[key] || SORT_KEYS.cpu;
    const dir = desc ? -1 : 1;
    return list.slice().sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      // stable tiebreak: busier then lower pid
      return (b.cpu - a.cpu) || (b.mem - a.mem) || (a.pid - b.pid);
    });
  }

  /* Filter terms are space-separated and ANDed. A term matches name, cmd,
     user, pid or hermes group. `!term` negates. `g:name` / `group:name` match
     the hermes group exactly; `g:*` or `hermes` (alone) = any hermes group. */
  function parseFilter(q) {
    return String(q || '').trim().split(/\s+/).filter(Boolean).map((t) => {
      let neg = false;
      if (t[0] === '!' && t.length > 1) { neg = true; t = t.slice(1); }
      const m = /^(?:g|group):(.*)$/i.exec(t);
      if (m) return { neg, group: m[1].toLowerCase() || '*' };
      return { neg, text: t.toLowerCase() };
    });
  }

  function matchProc(p, terms) {
    for (const t of terms) {
      let hit;
      if (t.group !== undefined) {
        hit = t.group === '*' ? !!p.group : (p.group || '') === t.group;
      } else if (t.text === 'hermes') {
        hit = !!p.group || (p.cmd || '').toLowerCase().includes('hermes');
      } else {
        hit = String(p.pid) === t.text
          || (p.name || '').toLowerCase().includes(t.text)
          || (p.cmd || '').toLowerCase().includes(t.text)
          || (p.user || '').toLowerCase() === t.text
          || (p.group || '') === t.text;
      }
      if (hit === t.neg) return false;
    }
    return true;
  }

  function filterProcs(list, q) {
    const terms = parseFilter(q);
    if (!terms.length) return list.slice();
    return list.filter((p) => matchProc(p, terms));
  }

  /* Build a process tree. Returns rows in display order with `depth` and a
     `prefix` drawn from box characters. Children are sorted by (key, desc).
     When a filter is active, ancestors of matches are kept (dimmed=true). */
  function buildTree(all, key, desc, q, collapsed) {
    collapsed = collapsed || new Set();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const terms = parseFilter(q);
    let keep = null;
    if (terms.length) {
      keep = new Map();
      for (const p of all) {
        if (!matchProc(p, terms)) continue;
        keep.set(p.pid, false);
        let cur = byPid.get(p.ppid);
        let guard = 0;
        while (cur && guard++ < 256) {
          if (!keep.has(cur.pid)) keep.set(cur.pid, true);
          cur = byPid.get(cur.ppid);
        }
      }
    }
    const kids = new Map();
    const roots = [];
    for (const p of all) {
      if (keep && !keep.has(p.pid)) continue;
      const parent = byPid.get(p.ppid);
      if (parent && parent.pid !== p.pid && (!keep || keep.has(parent.pid))) {
        if (!kids.has(parent.pid)) kids.set(parent.pid, []);
        kids.get(parent.pid).push(p);
      } else roots.push(p);
    }
    const out = [];
    const seen = new Set();
    function walk(nodes, depth, lead) {
      const sorted = sortProcs(nodes, key, desc);
      sorted.forEach((p, i) => {
        if (seen.has(p.pid)) return;
        seen.add(p.pid);
        const last = i === sorted.length - 1;
        const children = kids.get(p.pid) || [];
        const isCollapsed = collapsed.has(p.pid);
        const prefix = depth === 0 ? '' : lead + (last ? '└─' : '├─');
        out.push(Object.assign({}, p, {
          depth, prefix, hasKids: children.length > 0, collapsed: isCollapsed,
          dimmed: keep ? keep.get(p.pid) === true : false,
          kidCount: children.length,
        }));
        if (children.length && !isCollapsed) {
          walk(children, depth + 1, depth === 0 ? '' : lead + (last ? '  ' : '│ '));
        }
      });
    }
    walk(roots, 0, '');
    return out;
  }

  /* Pick the default network interface: busiest non-loopback by total bytes. */
  function pickIface(net) {
    const names = Object.keys(net || {}).filter((n) => n !== 'lo');
    if (!names.length) return Object.keys(net || {})[0] || null;
    names.sort((a, b) => ((net[b].rx_total + net[b].tx_total) - (net[a].rx_total + net[a].tx_total)));
    return names[0];
  }

  /* Map a 0..1 position to one of three colour stops (low/mid/high). */
  function stopIndex(frac) {
    return frac < 0.5 ? 0 : frac < 0.8 ? 1 : 2;
  }

  /* ── colour contrast ───────────────────────────────────────────────────── */
  /* Parse "#rgb", "#rrggbb", "rgb(a)(r, g, b[, a])", "rgb(r g b / a)" or
     "color(srgb r g b)" into [r, g, b] (0..255), or null. */
  function parseColor(s) {
    s = String(s || '').trim().toLowerCase();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    if (m) return [m[1], m[2], m[3]].map((x) => clamp(Math.round(Number(x)), 0, 255));
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
    if (m) return [m[1], m[2], m[3]].map((x) => clamp(Math.round(Number(x) * 255), 0, 255));
    return null;
  }

  function luminance(rgb) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function contrast(a, b) {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function toHex(rgb) {
    return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  /* Smallest step toward black (light background) or white (dark background)
     that gives `fg` at least `min` contrast on `bg`. Keeps the hue family so
     each box keeps its colour, but the text stays readable on every skin. */
  function textSafe(fg, bg, min) {
    min = min || 4.5;
    if (!fg || !bg) return null;
    if (contrast(fg, bg) >= min) return toHex(fg);
    const target = luminance(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    for (let p = 0.95; p > 0; p -= 0.05) {
      const c = fg.map((v, i) => v * p + target[i] * (1 - p));
      if (contrast(c, bg) >= min) return toHex(c);
    }
    return toHex(target);
  }

  /* Global keyboard shortcuts must not hijack focused controls. `ctx` says
     where focus is: editable (input/textarea/select/contenteditable),
     control (button/link/other focusable widget), foreign (focus is in core UI
     outside the btop page, its sidebar view and the nav buttons). */
  function shortcutAllowed(key, ctx) {
    ctx = ctx || {};
    if (ctx.editable || ctx.foreign) return false;
    if (ctx.control && (key === ' ' || key === 'Enter' || key === 'Spacebar' || /^Arrow/.test(key))) return false;
    return true;
  }

  return {
    fmtBytes, fmtBits, fmtDuration, fmtUptime, clamp, mergeHistory, fitSeries,
    sparkline, niceCeil, sortProcs, parseFilter, matchProc, filterProcs, buildTree,
    pickIface, stopIndex, SORT_KEYS, parseColor, luminance, contrast, toHex, textSafe,
    shortcutAllowed,
  };
});
