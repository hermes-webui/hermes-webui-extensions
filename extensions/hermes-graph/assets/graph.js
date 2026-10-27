/* hermes-graph v2 — knowledge-graph view of workspace files + Hermes memory/skills/sessions.
 *
 * Vanilla JS, no dependency, no build step, no remote asset. Data comes from the loopback sidecar through the
 * WebUI's same-origin token-v1 proxy:  /api/extensions/hermes-graph/sidecar/graph
 *
 * Architecture (see study/DESIGN_V2.md for the measurements behind every choice):
 *   simCoreModule()  pure physics (SoA typed arrays): Barnes-Hut repulsion, springs, constant-magnitude gravity,
 *                    hard collision via spatial hash + position projection, drag inertia. Runs in a blob: Web Worker
 *                    (positions come back as a transferred Float32Array); falls back to the main thread if Worker/blob
 *                    is unavailable. The same source text is used for both, and for the node unit tests.
 *   renderers        WebGL2 instanced (1 draw call per layer; SDF circles) with a Canvas2D fallback, + a 2D overlay
 *                    canvas for labels/halos. The render loop stops completely when nothing moves.
 * All text from the index (file names, memory text...) is attacker-influenceable: it is ONLY ever written with
 * textContent / canvas fillText — never innerHTML.
 */
(() => {
  'use strict';
  const EXT = 'hermes-graph';
  const BASE = '/api/extensions/' + EXT + '/sidecar';

  // ── physics core (self-contained: its source text is also loaded into a Worker blob — no outer references!) ──
  function simCoreModule() {
    'use strict';

    function mulberry(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

    // cfg: { n, rad:Float64Array, comm:Int32Array (dense 0..ncomm-1), ncomm, src:Int32Array, dst:Int32Array,
    //        rest:Float64Array, w:Float64Array, pos?:Float32Array(2n), opts? }
    function create(cfg) {
      const n = cfg.n | 0;
      const o = Object.assign({
        repulsion: 220,     // Coulomb-like: F = repulsion * qi*qj / (d^2 + eps^2)   (alpha-scaled); simConfig() scales it with graph size (pressure grows with n)
        theta: 1.0,         // Barnes-Hut opening angle
        linkK: 0.08,        // spring strength (alpha-scaled, d3-style degree bias)
        gravity: 0.30,      // constant-magnitude pull to the centre (|F| ~ dist^0), alpha-scaled; eases to 0 inside gravityZone
        gravityZone: 60,
        cohesion: 0.02,     // pull to the community centroid (alpha-scaled)
        friction: 0.32,     // velocity decay per tick (d3 velocityDecay)
        pad: 3,             // minimum clear gap between two disks, world units
        collideIter: 2,
        collideStiff: 0.85,
        restitution: 0.5,   // share of a collision push that becomes momentum (the "poke the web" feel)
        push: 0.6,          // outward shove on neighbours of a held node, scaled by drag speed
        fling: 2.0,         // release-velocity gain
        vmax: 30,
        repelEveryAbove: 6000,   // above this many active nodes the tree walk runs every 2nd tick
        alphaDecay: 0.01, alphaMin: 0.01,   // slow cooling: the layout must be close to equilibrium when it sleeps, otherwise the first drag "relaxes" everything (measured: median drift 12 → 3.5 units)
        alphaTargetDrag: 0.03, grabAlpha: 0.03, releaseAlpha: 0.04,
        heldLinkBoost: 0.3,   // links touching the held node always pull at least this strongly (the "tug" on direct neighbours), independent of global alpha
        seed: 12345,
      }, cfg.opts || {});
      const rnd = mulberry(o.seed);
      const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
      const px = new Float64Array(n), py = new Float64Array(n), fcx = new Float64Array(n), fcy = new Float64Array(n);
      const rad = Float64Array.from(cfg.rad), comm = Int32Array.from(cfg.comm), q = new Float64Array(n), invM = new Float64Array(n);
      for (let i = 0; i < n; i++) { q[i] = 0.6 + rad[i] / 12; invM[i] = 1 / (rad[i] * rad[i] + 1); }
      const m = cfg.src.length, src = Int32Array.from(cfg.src), dst = Int32Array.from(cfg.dst), rest = Float64Array.from(cfg.rest), lw = Float64Array.from(cfg.w);
      const deg = new Int32Array(n);
      for (let k = 0; k < m; k++) { deg[src[k]]++; deg[dst[k]]++; }
      const lstr = new Float64Array(m), lbias = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        const a = deg[src[k]], b = deg[dst[k]];
        lstr[k] = (0.45 + 0.55 * Math.min(1, lw[k])) / Math.min(a, b);   // d3 default 1/min(deg), here also weighted
        lbias[k] = a / (a + b);
      }
      const act = new Uint8Array(n).fill(1), pin = new Uint8Array(n), lact = new Uint8Array(m).fill(1);
      let list = new Int32Array(n), na = 0, alink = new Int32Array(m), nl = 0, cellSize = 20;
      const ncomm = Math.max(1, cfg.ncomm | 0), csx = new Float64Array(ncomm), csy = new Float64Array(ncomm), csn = new Float64Array(ncomm);

      // ── seed: communities on a phyllotaxis spiral sized by area, members inside their disc ──
      if (cfg.pos && cfg.pos.length >= 2 * n) { for (let i = 0; i < n; i++) { x[i] = cfg.pos[2 * i]; y[i] = cfg.pos[2 * i + 1]; } }
      else {
        const cnt = new Int32Array(ncomm), area = new Float64Array(ncomm);
        for (let i = 0; i < n; i++) { cnt[comm[i]]++; const r = rad[i] + o.pad; area[comm[i]] += Math.PI * r * r * 2.6; }
        const order = Array.from({ length: ncomm }, (_, c) => c).filter(c => cnt[c] > 0).sort((a, b) => area[b] - area[a]);
        const cx = new Float64Array(ncomm), cy = new Float64Array(ncomm), cr = new Float64Array(ncomm);
        let cum = 0;
        order.forEach((c, k) => {
          cum += area[c] / 2;
          const rho = Math.sqrt(cum / Math.PI) * 1.1, ang = k * 2.399963229728653;
          cx[c] = Math.cos(ang) * rho; cy[c] = Math.sin(ang) * rho; cr[c] = Math.sqrt(area[c] / Math.PI);
          cum += area[c] / 2;
        });
        for (let i = 0; i < n; i++) {
          const c = comm[i], a = rnd() * 6.283185307, d = cr[c] * Math.sqrt(rnd());
          x[i] = cx[c] + Math.cos(a) * d; y[i] = cy[c] + Math.sin(a) * d;
        }
      }

      // ── Barnes-Hut quadtree in flat arrays ──
      const cap = 8 * n + 64;
      const tsx = new Float64Array(cap), tsy = new Float64Array(cap), tm = new Float64Array(cap);
      const tx0 = new Float64Array(cap), ty0 = new Float64Array(cap), ts = new Float64Array(cap);
      const tbody = new Int32Array(cap), tkid = new Int32Array(cap * 4), stack = new Int32Array(1024);
      let nc = 0;
      function newCell(px0, py0, size) {
        const c = nc++;
        tsx[c] = 0; tsy[c] = 0; tm[c] = 0; tx0[c] = px0; ty0[c] = py0; ts[c] = size; tbody[c] = -1;
        const b = c * 4; tkid[b] = tkid[b + 1] = tkid[b + 2] = tkid[b + 3] = -1;
        return c;
      }
      function kidOf(c, qd) {
        const b = c * 4 + qd;
        if (tkid[b] >= 0) return tkid[b];
        const h = ts[c] * 0.5;
        return (tkid[b] = newCell(tx0[c] + (qd & 1) * h, ty0[c] + (qd >> 1) * h, h));
      }
      const quad = (c, i) => { const h = tx0[c] + ts[c] * 0.5, g = ty0[c] + ts[c] * 0.5; return (x[i] >= h ? 1 : 0) + (y[i] >= g ? 2 : 0); };
      function insert(i) {
        let c = 0, depth = 0;
        const w = q[i];
        for (;;) {
          if (tm[c] === 0) { tsx[c] = w * x[i]; tsy[c] = w * y[i]; tm[c] = w; tbody[c] = i; return; }
          tsx[c] += w * x[i]; tsy[c] += w * y[i]; tm[c] += w;
          let b = tbody[c];
          if (b === -2 || nc + 8 >= cap) { tbody[c] = -2; return; }
          if (b >= 0) {   // occupied leaf → split: push the resident one level down
            if (depth >= 28) { tbody[c] = -2; return; }
            tbody[c] = -1;
            const kb = kidOf(c, quad(c, b));
            tsx[kb] = q[b] * x[b]; tsy[kb] = q[b] * y[b]; tm[kb] = q[b]; tbody[kb] = b;
          }
          c = kidOf(c, quad(c, i)); depth++;
        }
      }
      function repel(a) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < na; k++) { const i = list[k]; if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i]; if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i]; }
        nc = 0; newCell(x0 - 0.5, y0 - 0.5, Math.max(x1 - x0, y1 - y0) + 1);
        for (let k = 0; k < na; k++) insert(list[k]);
        const th2 = o.theta * o.theta, K = o.repulsion * a, eps2 = 36;
        for (let k = 0; k < na; k++) {
          const i = list[k];
          if (pin[i] || i === held) continue;
          const xi = x[i], yi = y[i], qi = q[i];
          let fx = 0, fy = 0, sp = 0;
          stack[sp++] = 0;
          while (sp > 0) {
            const c = stack[--sp], mc = tm[c];
            if (mc === 0) continue;
            const dx = tsx[c] / mc - xi, dy = tsy[c] / mc - yi, b = tbody[c];
            let d2 = dx * dx + dy * dy;
            if (b === -1) {   // internal cell: open it unless far enough (and never when we sit inside it)
              const s = ts[c];
              if ((xi >= tx0[c] && xi < tx0[c] + s && yi >= ty0[c] && yi < ty0[c] + s) || s * s >= th2 * d2) {
                const kb = c * 4;
                if (tkid[kb] >= 0) stack[sp++] = tkid[kb];
                if (tkid[kb + 1] >= 0) stack[sp++] = tkid[kb + 1];
                if (tkid[kb + 2] >= 0) stack[sp++] = tkid[kb + 2];
                if (tkid[kb + 3] >= 0) stack[sp++] = tkid[kb + 3];
                continue;
              }
            } else if (b === i || d2 < 1e-9) continue;
            d2 += eps2;
            const f = K * qi * mc / (d2 * Math.sqrt(d2));
            fx -= dx * f; fy -= dy * f;
          }
          fcx[i] = fx; fcy[i] = fy;
          vx[i] += fx; vy[i] += fy;
        }
      }
      // large graphs: the far field changes slowly, so recompute the tree walk every 2nd tick and replay the cached force in between
      function replayRepel() { for (let k = 0; k < na; k++) { const i = list[k]; if (pin[i] || i === held) continue; vx[i] += fcx[i]; vy[i] += fcy[i]; } }

      // ── collision: spatial hash (counting sort into buckets), each pair handled by its larger disk ──
      let T = 1, bstart = new Int32Array(2), bitems = new Int32Array(1), bidx = new Int32Array(n), cxs = new Int32Array(n), cys = new Int32Array(n);
      function buildGrid(X, Y) {
        let want = 2; while (want < na * 2) want <<= 1;
        if (want !== T) { T = want; bstart = new Int32Array(T + 1); bitems = new Int32Array(Math.max(1, n)); }
        bstart.fill(0);
        const mask = T - 1, inv = 1 / cellSize;
        for (let k = 0; k < na; k++) {
          const i = list[k], cx = Math.floor(X[i] * inv), cy = Math.floor(Y[i] * inv);
          cxs[i] = cx; cys[i] = cy;
          const b = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & mask;
          bidx[i] = b; bstart[b + 1]++;
        }
        for (let b = 0; b < T; b++) bstart[b + 1] += bstart[b];
        const fill = bstart.slice(0, T);   // running cursor per bucket
        for (let k = 0; k < na; k++) { const i = list[k]; bitems[fill[bidx[i]]++] = i; }
      }
      // mode 0: resolve (returns #pairs touched); mode 1: only count real overlaps deeper than tol
      function sweep(X, Y, stiff, mode, tol) {
        const mask = T - 1, pad = o.pad;
        let hits = 0;
        for (let k = 0; k < na; k++) {
          const i = list[k], ri = rad[i], reach = Math.ceil((2 * ri + pad) / cellSize), ci = cxs[i], cj = cys[i];
          for (let gx = ci - reach; gx <= ci + reach; gx++) for (let gy = cj - reach; gy <= cj + reach; gy++) {
            const b = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) & mask;
            for (let e = bstart[b], end = bstart[b + 1]; e < end; e++) {
              const j = bitems[e];
              if (j === i) continue;
              const rj = rad[j];
              if (rj > ri || (rj === ri && j > i)) continue;   // the larger disk owns the pair
              let dx = X[i] - X[j], dy = Y[i] - Y[j];
              const min = ri + rj + (mode ? -tol : pad), d2 = dx * dx + dy * dy;
              if (d2 >= min * min) continue;
              hits++;
              if (mode) continue;
              let d = Math.sqrt(d2);
              if (d < 1e-6) { const a = rnd() * 6.283185307; dx = Math.cos(a); dy = Math.sin(a); d = 1e-6 + 0.01; }
              else { dx /= d; dy /= d; }
              const corr = (min - d) * stiff;
              const wi = (pin[i] || i === held) ? 0 : invM[i], wj = (pin[j] || j === held) ? 0 : invM[j], ws = wi + wj;
              if (ws === 0) continue;
              const si = wi / ws;
              X[i] += dx * corr * si; Y[i] += dy * corr * si;
              X[j] -= dx * corr * (1 - si); Y[j] -= dy * corr * (1 - si);
            }
          }
        }
        return hits;
      }

      // ── state ──
      let alpha = cfg.asleep ? 0 : 1, alphaTarget = 0, awake = !cfg.asleep, fresh = !cfg.asleep, tickNo = 0, held = -1, htx = 0, hty = 0, hvx = 0, hvy = 0, maxV2 = 0;
      const prof = { links: 0, tree: 0, repel: 0, misc: 0, collide: 0 }, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      function setActive(mask, lmask) {   // mask: visible nodes; lmask (optional): links that should pull (hidden edge kinds don't)
        const ns = [];
        na = 0;
        for (let i = 0; i < n; i++) { act[i] = mask ? (mask[i] ? 1 : 0) : 1; if (act[i]) list[na++] = i; }
        if (lmask) for (let k = 0; k < m; k++) lact[k] = lmask[k] ? 1 : 0;
        nl = 0; for (let k = 0; k < m; k++) if (lact[k] && act[src[k]] && act[dst[k]]) alink[nl++] = k;
        const rs = []; for (let k = 0; k < na; k++) rs.push(rad[list[k]]);
        rs.sort((a, b) => a - b);
        // cell edge = contact distance of two typical-large disks, so most pairs live in the 3x3 neighbourhood
        cellSize = Math.max(8, 2 * (rs.length ? rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.92))] : 6) + o.pad);
        if (held >= 0 && !act[held]) { held = -1; alphaTarget = 0; }
        void ns;
        if (zkeys) zorder();
      }
      let zkeys = null;
      setActive(null);

      // Re-sort the active list along a Morton curve: consecutive nodes are spatial neighbours, so the quadtree walk and the
      // collision sweep hit the same cache lines (measured: see DESIGN_V2.md). Cheap: one native Float64Array sort.
      zkeys = new Float64Array(n);
      const spread = (v) => { v &= 0xffff; v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555; };
      function zorder() {
        if (na < 64) return;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < na; k++) { const i = list[k]; if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i]; if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i]; }
        const sc = 65535 / (Math.max(x1 - x0, y1 - y0) + 1e-9), keys = zkeys.subarray(0, na);
        for (let k = 0; k < na; k++) { const i = list[k]; keys[k] = ((spread(((x[i] - x0) * sc) | 0) | (spread(((y[i] - y0) * sc) | 0) << 1)) >>> 0) * 2097152 + i; }
        keys.sort();
        for (let k = 0; k < na; k++) list[k] = keys[k] % 2097152;
      }
      zorder();
      function projectLinks(a) {
        for (let e = 0; e < nl; e++) {
          const k = alink[e], s = src[k], t = dst[k];
          let dx = x[t] + vx[t] - x[s] - vx[s], dy = y[t] + vy[t] - y[s] - vy[s];
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1e-6) { dx = rnd() - 0.5; dy = rnd() - 0.5; d = Math.sqrt(dx * dx + dy * dy) || 1; }
          const l = (d - rest[k]) / d * o.linkK * lstr[k] * ((s === held || t === held) ? Math.max(a, o.heldLinkBoost) : a), b = lbias[k];
          dx *= l; dy *= l;
          if (!pin[t] && t !== held) { vx[t] -= dx * b; vy[t] -= dy * b; }
          if (!pin[s] && s !== held) { vx[s] += dx * (1 - b); vy[s] += dy * (1 - b); }
        }
      }

      function tick() {
        tickNo++;
        if (tickNo % 16 === 0) zorder();
        alpha += (alphaTarget - alpha) * o.alphaDecay;
        const a = alpha;
        // community centroids
        if (o.cohesion > 0) {
          csx.fill(0); csy.fill(0); csn.fill(0);
          for (let k = 0; k < na; k++) { const i = list[k], c = comm[i]; csx[c] += x[i]; csy[c] += y[i]; csn[c]++; }
        }
        let t0 = now();
        projectLinks(a);
        let t1 = now(); prof.links += t1 - t0;
        if (na > o.repelEveryAbove && (tickNo & 1)) replayRepel(); else repel(a);
        t0 = now(); prof.repel += t0 - t1;
        const g = o.gravity * a, zone = o.gravityZone, coh = o.cohesion * a;
        for (let k = 0; k < na; k++) {
          const i = list[k];
          if (pin[i] || i === held) continue;
          const d = Math.sqrt(x[i] * x[i] + y[i] * y[i]);
          if (d > 1e-9) { const s = g * Math.min(1, d / zone) / d; vx[i] -= x[i] * s; vy[i] -= y[i] * s; }   // |F| = g for d>zone: constant, not ∝ d or d²
          if (coh > 0) { const c = comm[i], cn = csn[c]; if (cn > 2) { vx[i] += (csx[c] / cn - x[i]) * coh; vy[i] += (csy[c] / cn - y[i]) * coh; } }
        }
        if (held >= 0) {   // bow wave: neighbours of a held node are shoved aside, harder the faster it is dragged
          const R = rad[held] * 3 + 36, sp = Math.sqrt(hvx * hvx + hvy * hvy), amp = o.push * (0.5 + 0.1 * Math.min(sp, 30));
          const hx = x[held], hy = y[held];
          for (let k = 0; k < na; k++) {
            const i = list[k]; if (i === held || pin[i]) continue;
            const dx = x[i] - hx, dy = y[i] - hy, d2 = dx * dx + dy * dy;
            if (d2 >= R * R || d2 < 1e-9) continue;
            const d = Math.sqrt(d2), f = (1 - d / R); const s = f * f * amp / d;
            vx[i] += dx * s; vy[i] += dy * s;
          }
        }
        // integrate (predict)
        const keep = alpha < o.alphaMin && alphaTarget === 0 ? 0.35 : 1 - o.friction, vm = o.vmax;   // cooled: extra damping so residual creep dies in a few ticks
        maxV2 = 0;
        for (let k = 0; k < na; k++) {
          const i = list[k];
          if (pin[i]) { vx[i] = vy[i] = 0; px[i] = x[i]; py[i] = y[i]; continue; }
          if (i === held) {
            const nx = x[i] + (htx - x[i]) * 0.6, ny = y[i] + (hty - y[i]) * 0.6;
            hvx = 0.5 * hvx + 0.5 * (nx - x[i]); hvy = 0.5 * hvy + 0.5 * (ny - y[i]);
            px[i] = nx; py[i] = ny; vx[i] = nx - x[i]; vy[i] = ny - y[i]; continue;
          }
          let ux = vx[i] * keep, uy = vy[i] * keep;
          const s2 = ux * ux + uy * uy;
          if (s2 > vm * vm) { const s = vm / Math.sqrt(s2); ux *= s; uy *= s; }
          vx[i] = ux; vy[i] = uy; px[i] = x[i] + ux; py[i] = y[i] + uy;
        }
        // collision on the predicted positions, then velocity picks up a share of the push (momentum transfer)
        const e = o.restitution;
        t1 = now(); prof.misc += t1 - t0;
        if (o.collideIter > 0 && na > 1) {
          buildGrid(px, py);
          for (let it = 0; it < o.collideIter; it++) if (sweep(px, py, o.collideStiff, 0, 0) === 0) break;   // nothing touching → skip the extra pass
        }
        prof.collide += now() - t1;
        for (let k = 0; k < na; k++) {
          const i = list[k];
          if (i === held || pin[i]) { x[i] = px[i]; y[i] = py[i]; continue; }
          const ex = px[i] - x[i] - vx[i], ey = py[i] - y[i] - vy[i];
          vx[i] += ex * e; vy[i] += ey * e;
          x[i] = px[i]; y[i] = py[i];
          const s2 = vx[i] * vx[i] + vy[i] * vy[i]; if (s2 > maxV2) maxV2 = s2;
        }
        // cooled and still → hard-resolve any residual overlap, then sleep (zero velocity)
        if (alpha < o.alphaMin && alphaTarget === 0 && held < 0 && maxV2 < 0.0016) {
          relax(40);
          for (let k = 0; k < na; k++) { vx[list[k]] = vy[list[k]] = 0; }
          awake = false; fresh = false;
        }
        return awake;
      }
      function relax(maxIt) {   // used to finish a layout: stiff 1.0 until no real overlap is left
        if (na < 2) return;
        for (let it = 0; it < maxIt; it++) {
          buildGrid(x, y);
          if (sweep(x, y, 1, 0, 0) === 0) break;
        }
      }
      function overlaps(tol) {   // number of pairs closer than ri+rj-tol (no pad), over active nodes
        buildGrid(x, y);
        return sweep(x, y, 0, 1, tol == null ? 0.5 : tol);
      }

      return {
        n, o, x, y, vx, vy, rad,
        get alpha() { return alpha; }, get awake() { return awake; }, get fresh() { return fresh; }, get tickNo() { return tickNo; }, get na() { return na; },
        get maxSpeed() { return Math.sqrt(maxV2); }, get held() { return held; },
        tick, relax, overlaps, setActive,
        reheat(a) { alpha = Math.max(alpha, a == null ? 0.5 : a); awake = true; },
        setParams(p) { Object.assign(o, p); awake = true; alpha = Math.max(alpha, 0.2); },
        grab(i, tx, ty) {
          if (i < 0 || i >= n || !act[i]) return;
          held = i; htx = tx; hty = ty; hvx = hvy = 0; alphaTarget = o.alphaTargetDrag; alpha = Math.max(alpha, o.grabAlpha); awake = true;
        },
        move(tx, ty) { htx = tx; hty = ty; awake = true; },
        release() {
          if (held < 0) return;
          const i = held; held = -1; alphaTarget = 0;
          let ux = hvx * o.fling, uy = hvy * o.fling; const s = Math.sqrt(ux * ux + uy * uy);
          if (s > o.vmax * 1.5) { ux *= o.vmax * 1.5 / s; uy *= o.vmax * 1.5 / s; }
          vx[i] = ux; vy[i] = uy; alpha = Math.max(alpha, o.releaseAlpha); awake = true;
        },
        setPin(i, on) { pin[i] = on ? 1 : 0; awake = true; },
        exportPos(out) { for (let i = 0; i < n; i++) { out[2 * i] = x[i]; out[2 * i + 1] = y[i]; } return out; },
        stats() { return { prof, n, active: na, links: nl, alpha, awake, tick: tickNo, maxSpeed: Math.sqrt(maxV2), cell: cellSize }; },
      };
    }
    return { create };
  }
  const SimCore = simCoreModule();

  // ── legacy pure helpers (kept for tests/layout.test.js and the window.HermesGraphLayout API) ──
  function buildQuad(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
      if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) + 1;
    const root = { x: x0, y: y0, s: size, m: 0, cx: 0, cy: 0, kids: null, body: null };
    const insert = (cell, n, depth) => {
      cell.cx = (cell.cx * cell.m + n.x) / (cell.m + 1);
      cell.cy = (cell.cy * cell.m + n.y) / (cell.m + 1);
      cell.m += 1;
      if (cell.m === 1) { cell.body = n; return; }
      if (!cell.kids) {
        cell.kids = [null, null, null, null];
        const b = cell.body; cell.body = null;
        if (depth < 40) place(cell, b, depth); else cell.body = b;
      }
      if (depth < 40) place(cell, n, depth);
    };
    const place = (cell, n, depth) => {
      const h = cell.s / 2;
      const qx = n.x >= cell.x + h ? 1 : 0, qy = n.y >= cell.y + h ? 1 : 0, q = qy * 2 + qx;
      if (!cell.kids[q]) cell.kids[q] = { x: cell.x + qx * h, y: cell.y + qy * h, s: h, m: 0, cx: 0, cy: 0, kids: null, body: null };
      insert(cell.kids[q], n, depth + 1);
    };
    for (const n of nodes) insert(root, n, 0);
    return root;
  }

  // World-space radius of a node (the physics collides disks of exactly this size; the renderer draws at least minPx).
  const worldRadius = (n) => 4 + Math.min(14, Math.sqrt(n.deg) * 1.8) + (n.type === 'memory' || n.type === 'skill' ? 2 : 0);
  // Cfg for SimCore from decoded node/edge objects.
  function simConfig(nodes, edges, opts) {
    const n = nodes.length, dense = new Map(), comm = new Int32Array(n), rad = new Float64Array(n);
    nodes.forEach((nd, i) => { if (!dense.has(nd.comm)) dense.set(nd.comm, dense.size); comm[i] = dense.get(nd.comm); rad[i] = worldRadius(nd); });
    const m = edges.length, src = new Int32Array(m), dst = new Int32Array(m), rest = new Float64Array(m), w = new Float64Array(m);
    edges.forEach((e, k) => {
      src[k] = e.s; dst[k] = e.t; w[k] = e.w;
      const gap = e.kind === 'contains' ? 6 : 8 + 30 * (1 - Math.min(1, e.w));
      rest[k] = rad[e.s] + rad[e.t] + gap;
    });
    // a 2D Coulomb gas packs tighter as n grows; without this, 5k+ nodes jam to contact (measured: median surface gap 3.0 = pad at 5k)
    const o = Object.assign({ repulsion: 220 * Math.pow(Math.max(1, n / 1000), 0.45) }, opts || {});
    return { n, rad, comm, ncomm: dense.size, src, dst, rest, w, opts: o };
  }

  // Old API: createSim(nodes, edges, opts) → { tick():bool, alpha, reheat(), o }. Nodes are plain objects
  // (x, y, vx, vy, fixed) so the unit tests and any external caller keep working; the SoA core does the work.
  function createSim(nodes, edges, opts) {
    const core = SimCore.create(simConfig(nodes, edges, opts));
    const pull = () => { for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; n.x = core.x[i]; n.y = core.y[i]; n.vx = core.vx[i]; n.vy = core.vy[i]; } };
    pull();
    const sim = {
      nodes, edges, core, o: core.o,
      get alpha() { return core.alpha; },
      tick() {
        for (let i = 0; i < nodes.length; i++) core.setPin(i, nodes[i].fixed);
        const awake = core.tick(); pull(); return awake;
      },
      reheat(v) { core.reheat(v || 0.5); },
    };
    return sim;
  }

  // Decode the sidecar's compact arrays into objects the layout/renderer use.
  function decode(payload) {
    const types = payload.types, kinds = payload.kinds;
    const nodes = payload.nodes.map((a, i) => ({
      i, id: a[0], type: types[a[1]], label: a[2], root: a[3], path: a[4], size: a[5], mtime: a[6],
      deg: a[7], comm: a[8], attrs: a[9] || {}, x: 0, y: 0, vx: 0, vy: 0, fixed: false,
    }));
    nodes.forEach(n => { n.r = worldRadius(n); });
    const edges = payload.edges.map(a => ({ s: a[0], t: a[1], kind: kinds[a[2]], w: a[3], line: a[4], sn: nodes[a[0]], tn: nodes[a[1]] }));
    const adj = nodes.map(() => []);
    edges.forEach((e, k) => { adj[e.s].push(k); adj[e.t].push(k); });
    return { nodes, edges, adj, types, kinds, stats: payload.stats || {}, truncated: !!payload.truncated, center: payload.center || null };
  }

  const api = { createSim, decode, buildQuad, simCoreModule, simConfig, worldRadius };
  if (typeof window === 'undefined') { module.exports = api; return; }
  window.HermesGraphLayout = api;
  if (window.__hermesGraphInit) return;
  window.__hermesGraphInit = true;

  // ── UI constants ───────────────────────────────────────────────────────────
  // light palette re-darkened where the v1 colours were < 3:1 against --bg (WCAG graphical-object contrast): session, entity, secret
  const LIGHT = { memory: '#2a78d6', skill: '#eb6834', session: '#12936a', entity: '#b87500', secret: '#d4608d', cron: '#008300', mcp_server: '#6250d6', tag: '#e34948' };
  const DARK = { memory: '#3987e5', skill: '#d95926', session: '#199e70', entity: '#c98500', secret: '#d55181', cron: '#008300', mcp_server: '#9085e9', tag: '#e66767' };
  // UI language: English by default, Portuguese when the browser locale is pt-*.
  const LOCALE_PT = (typeof navigator !== 'undefined' && /^pt\b/i.test(navigator.language || ''));
  const L10N = (en, pt) => (LOCALE_PT ? pt : en);

  const TYPE_LABEL = { file: L10N('File', 'Arquivo'), dir: L10N('Folder', 'Pasta'), memory: L10N('Memory', 'Memória'), skill: 'Skill', session: L10N('Session', 'Sessão'), entity: L10N('Entity', 'Entidade'), secret: L10N('Credential (name only)', 'Credencial (só nome)'), cron: 'Cron', mcp_server: 'MCP server', tag: 'Tag' };
  const KIND_LABEL = { contains: L10N('contains', 'contém'), md_link: L10N('md link', 'link md'), wikilink: 'wiki-link', embed: 'embed', import: 'import', exec: 'exec/source', mention: L10N('mention', 'menção'), similar: L10N('similar', 'similar'), tag: 'tag', entity: L10N('entity', 'entidade'), skill_use: L10N('session used skill', 'sessão usou skill'), cron_skill: 'cron→skill', cron_script: 'cron→script', mcp: 'MCP', skill_ref: L10N('skill file', 'arquivo da skill'), secret_ref: L10N('credential ref.', 'ref. credencial'), dup: L10N('duplicate', 'duplicado') };
  const DIRECTED = new Set(['contains', 'md_link', 'wikilink', 'embed', 'import', 'exec', 'skill_use', 'cron_skill', 'cron_script', 'mcp', 'skill_ref', 'secret_ref']);
  const NODE_BUDGET = 4500;      // Canvas2D fallback only: max nodes blitted per frame
  const MIN_PX = 2.2;            // a node is never drawn smaller than this radius (screen px) — legibility floor
  const LABEL_PX = 6.5;          // a node needs this drawn radius before it may carry a label
  const K_MIN = 0.05, K_MAX = 8; // zoom limits (shared by wheel and pinch)

  const ext = (window.hermesExt && window.hermesExt.register && window.hermesExt.register(EXT)) || null;
  const cfgGet = (k, d) => { try { const v = ext && ext.settings && ext.settings.get(k); return v == null ? d : v; } catch (_) { return d; } };
  const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} });
  const mqPhone = mq('(max-width: 640px)');   // same breakpoint the core uses for the mobile drawer/titlebar
  const mqReduce = mq('(prefers-reduced-motion: reduce)');
  const reduced = () => !!mqReduce.matches;

  const state = {
    open: false, data: null, sim: null, sel: null, hover: null, query: '', dirty: true,
    hiddenTypes: new Set(['dir']), hiddenKinds: new Set(['contains']), showOrphans: false, egoOf: null,
    view: { k: 1, x: 0, y: 0 }, colorBy: 'type', raf: 0, pollTimer: 0, drag: null, pinch: null, lastPT: 'mouse',
    W: 0, H: 0, dpr: 1, N: 0,
    pos: null, fade: null, fadeT: null, vis: null, rad: null, col: null, colIdx: null, pal: null, nb: null, order: null,
    posDirty: true, fadeDirty: true, fadeBusy: false, anim: null, pulseT0: 0, pulseUntil: 0, autoFit: true, lastFit: 0, held: null,
    dbg: {}, prof: { n: 0, render: 0, overlay: 0, aura: 0 }, theme: null, commTop: null, commCount: null, nComm: 0, commRgb: null, edges: null, focusEdges: null, physics: { gravity: 1, spread: 1 },
  };
  const ptrs = new Map();   // pointerId -> {x, y} client coords of every active pointer (multi-touch)
  let tapPrev = null, lastEgoAt = 0;   // double-tap bookkeeping (dblclick is unreliable on touch)

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Static icon markup built node-by-node (no innerHTML anywhere in this file except the pre-existing static rail glyph).
  function icon(paths, extra) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    paths.forEach(d => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    (extra || []).forEach(([cx, cy, r]) => { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); s.appendChild(c); });
    return s;
  }
  const ICONS = {
    search: () => icon(['M16 16l4.5 4.5'], [[11, 11, 6.5]]),
    sliders: () => icon(['M4 7h10M18 7h2M4 17h2M10 17h10'], [[16, 7, 2], [8, 17, 2]]),
    fit: () => icon(['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5']),
    close: () => icon(['M6 6l12 12M18 6L6 18']),
    back: () => icon(['M15 5l-7 7 7 7']),
  };

  // ── theme tokens (read once per theme change — never per frame) ──
  let _px;
  function rgbOf(c, fb) {   // any CSS colour → [r,g,b] via a 1×1 canvas (handles hex/rgb/hsl/color()/oklch)
    try {
      if (!_px) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; _px = cv.getContext('2d', { willReadFrequently: true }); }
      _px.clearRect(0, 0, 1, 1); _px.fillStyle = '#000'; _px.fillStyle = c; _px.fillRect(0, 0, 1, 1);
      const d = _px.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
    } catch (_) { return fb || [128, 128, 128]; }
  }
  const isDark = () => document.documentElement.classList.contains('dark');
  function readTheme() {
    const dark = isDark(), cs = getComputedStyle(document.documentElement);
    const g = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    const T = { dark, bg: g('--bg', dark ? '#0D0D1A' : '#FEFCF7'), surface: g('--surface', dark ? '#1A1A2E' : '#F3EEE3'), text: g('--text', dark ? '#FFF8DC' : '#1A1610'),
      muted: g('--muted', dark ? '#C0C0C0' : '#5C5344'), accent: g('--accent', dark ? '#FFD700' : '#B8860B'), border: g('--border', dark ? '#2A2A45' : '#E0D8C8') };
    ['bg', 'surface', 'text', 'muted', 'accent', 'border'].forEach(k => { T[k + 'Rgb'] = rgbOf(T[k]); });
    state.theme = T; if (gridEl) makeGridTile(); return T;
  }
  const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fb;
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
  function hslRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }
  const commRgbOf = (c, dark) => hslRgb(c * 47, 0.58, dark ? 0.62 : 0.46);
  const NEUTRAL = { dark: { file: '#6b7280', dir: null }, light: { file: '#7e8591', dir: null } };
  function nodeRGB(n, T) {
    if (state.colorBy === 'comm') return commRgbOf(n.comm, T.dark);
    if (n.type === 'dir') return T.mutedRgb;
    if (n.type === 'file') return rgbOf((T.dark ? NEUTRAL.dark : NEUTRAL.light).file);
    return rgbOf((T.dark ? DARK : LIGHT)[n.type] || T.muted, T.mutedRgb);
  }

  // ── simulation back-ends: Worker (blob:) with transferred Float32Array frames, or the same core on the main thread ──
  // Self-contained: this function's source text becomes the worker script (no outer references allowed).
  function workerBody(SimCore) {
    'use strict';
    let core = null, timer = 0, inflight = 0;
    const pool = [];
    function post() {
      const buf = pool.pop() || new Float32Array(2 * core.n);
      core.exportPos(buf); inflight++;
      self.postMessage({ t: 'frame', pos: buf, alpha: core.alpha, awake: core.awake, tick: core.tickNo }, [buf.buffer]);
    }
    function loop() {
      timer = 0;
      if (!core || !core.awake) return;
      const t0 = performance.now();
      let ticks = core.fresh ? 3 : core.alpha > 0.15 && core.held < 0 ? 2 : 1;   // first layout: time-lapse (3 ticks/frame); hot: 2; interaction: exactly 1 (60 Hz feel)
      while (ticks-- > 0) { if (!core.tick()) break; if (performance.now() - t0 > 14) break; }
      if (!core.awake || inflight < 3) post();                    // backpressure: skip a frame if the UI is behind; the final one always goes out
      if (core.awake) timer = setTimeout(loop, Math.max(0, 16 - (performance.now() - t0)));
    }
    const wake = () => { if (!timer && core && core.awake) timer = setTimeout(loop, 0); };
    self.onmessage = (e) => {
      const m = e.data;
      switch (m.t) {
        case 'init': core = SimCore.create(m.cfg); if (m.mask) core.setActive(m.mask, m.lmask); post(); break;
        case 'recycle': pool.push(m.pos); inflight = Math.max(0, inflight - 1); return;
        case 'mask': core.setActive(m.mask, m.lmask); core.reheat(m.alpha == null ? 0.3 : m.alpha); break;
        case 'grab': core.grab(m.i, m.x, m.y); break;
        case 'move': core.move(m.x, m.y); break;
        case 'release': core.release(); break;
        case 'reheat': core.reheat(m.alpha); break;
        case 'params': core.setParams(m.p); break;
        case 'q': { const ov = core.overlaps(0.5); self.postMessage({ t: 'stats', id: m.id, stats: core.stats(), ov }); return; }
      }
      wake();
    };
  }
  const WORKER_SRC = () => '"use strict";const SimCore=(' + simCoreModule.toString() + ')();(' + workerBody.toString() + ')(SimCore);';

  function makeWorkerSim(cfg, mask, hooks) {
    const url = URL.createObjectURL(new Blob([WORKER_SRC()], { type: 'text/javascript' }));
    const w = new Worker(url);   // throws SecurityError if the CSP forbids blob workers → caller falls back
    const sim = { kind: 'worker', awake: true, alpha: 1, tick: 0, latest: null, failed: false, qs: new Map(), qid: 0 };
    let gotFrame = false;
    const fail = () => { if (!sim.failed) { sim.failed = true; hooks.onFail && hooks.onFail(); } };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail(); };
    const watchdog = setTimeout(() => { if (!gotFrame) fail(); }, 4000);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'frame') {
        gotFrame = true; clearTimeout(watchdog);
        if (sim.latest) w.postMessage({ t: 'recycle', pos: sim.latest.pos }, [sim.latest.pos.buffer]);   // unread frame superseded: hand the buffer back
        sim.latest = m; sim.awake = m.awake; sim.alpha = m.alpha; sim.tick = m.tick; hooks.onFrame && hooks.onFrame();
      } else if (m.t === 'stats') { const r = sim.qs.get(m.id); if (r) { sim.qs.delete(m.id); r(m); } }
    };
    const T = [cfg.rad.buffer, cfg.comm.buffer, cfg.src.buffer, cfg.dst.buffer, cfg.rest.buffer, cfg.w.buffer];
    w.postMessage({ t: 'init', cfg, mask, lmask: hooks.lmask }, T);
    sim.cmd = (m) => { sim.awake = true; w.postMessage(m); };
    sim.poll = () => { const f = sim.latest; sim.latest = null; return f ? f.pos : null; };
    sim.recycle = (buf) => { w.postMessage({ t: 'recycle', pos: buf }, [buf.buffer]); };
    sim.busy = () => sim.awake;
    sim.query = () => new Promise((res) => { const id = ++sim.qid; sim.qs.set(id, res); w.postMessage({ t: 'q', id }); });
    sim.destroy = () => { clearTimeout(watchdog); w.terminate(); URL.revokeObjectURL(url); };
    return sim;
  }
  function makeLocalSim(cfg, mask, hooks) {
    const core = SimCore.create(cfg);
    if (mask) core.setActive(mask, hooks && hooks.lmask);
    const sim = { kind: 'main', core, awake: true, alpha: 1, tick: 0, buf: new Float32Array(2 * core.n), fresh: true };
    core.exportPos(sim.buf);
    sim.step = () => {   // same schedule as the worker: 2 ticks per frame while hot, 1 while interacting; hard budget so a big graph can't freeze the page
      if (!core.awake) return;
      const t0 = performance.now(); let ticks = core.fresh ? 3 : core.alpha > 0.15 && core.held < 0 ? 2 : 1;
      while (ticks-- > 0) { if (!core.tick()) break; if (performance.now() - t0 > 7) break; }
      core.exportPos(sim.buf); sim.fresh = true; sim.awake = core.awake; sim.alpha = core.alpha; sim.tick = core.tickNo;
    };
    sim.cmd = (m) => {
      switch (m.t) {
        case 'mask': core.setActive(m.mask, m.lmask); core.reheat(m.alpha == null ? 0.3 : m.alpha); break;
        case 'grab': core.grab(m.i, m.x, m.y); break;
        case 'move': core.move(m.x, m.y); break;
        case 'release': core.release(); break;
        case 'reheat': core.reheat(m.alpha); break;
        case 'params': core.setParams(m.p); break;
      }
      sim.awake = core.awake; sim.fresh = true;
    };
    sim.poll = () => { if (!sim.fresh) return null; sim.fresh = false; return sim.buf; };
    sim.recycle = () => {};
    sim.busy = () => core.awake;
    sim.query = () => Promise.resolve({ stats: core.stats(), ov: core.overlaps(0.5) });
    sim.destroy = () => {};
    return sim;
  }

  // ── renderers ──────────────────────────────────────────────────────────────
  // fc (frame context): { W, H, dpr, k, vx, vy, pos, fade, posDirty, fadeDirty, time, dim, edgeMul, theme, auras, nAuras, flow, minPx }
  const GLSL_HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const TEXW = 1024;
  const GL_SRC = {
    nodeVS: GLSL_HEAD + `
in vec2 aCorner; in vec3 aN; in vec4 aCol;
uniform sampler2D uPos; uniform vec2 uView; uniform vec3 uCam; uniform float uMin;
out vec2 vOff; out float vR; out float vGlow; out vec4 vCol; out float vFade;
void main(){
  int id = int(aN.x + 0.5);
  vec4 p = texelFetch(uPos, ivec2(id & ${TEXW - 1}, id >> 10), 0);
  float r = max(aN.y * uCam.z, uMin);
  float glow = aN.z * (r * 1.15 + 3.0);
  float h = r + glow + 1.5;
  float vis = step(0.01, p.z);
  vec2 c = uView * 0.5 + uCam.xy + p.xy * uCam.z;
  vec2 s = c + aCorner * h * vis;
  gl_Position = vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.0, 1.0);
  vOff = aCorner * h; vR = r; vGlow = glow; vCol = aCol; vFade = p.z;
}`,
    nodeFS: GLSL_HEAD + `
in vec2 vOff; in float vR; in float vGlow; in vec4 vCol; in float vFade;
uniform float uDark;
out vec4 o;
void main(){
  float d = length(vOff);
  float body = 1.0 - smoothstep(vR - 0.75, vR + 0.75, d);
  float t = clamp(d / max(vR, 0.001), 0.0, 1.0);
  vec3 base = vCol.rgb;
  vec3 lit = mix(base * 1.16 + 0.05, base * 0.84, t * t);
  float rim = smoothstep(vR - 1.7, vR - 0.5, d) * body;
  lit = mix(lit, mix(base, vec3(1.0), 0.38), rim * 0.5);
  float u = clamp((d - vR) / max(vGlow, 0.001), 0.0, 1.0);   // 0 at the rim → 1 at the quad edge, so the halo always dies before the quad ends
  float g = vGlow > 0.5 ? (1.0 - u) * (1.0 - u) * (1.0 - body) * (0.30 + 0.14 * uDark) : 0.0;
  float a = (body + g) * vFade * vCol.a;
  o = vec4(mix(base, lit, body) * a, a);
}`,
    edgeVS: GLSL_HEAD + `
in vec2 aQ; in vec2 aEnds; in vec4 aSt;
uniform sampler2D uPos; uniform vec2 uView; uniform vec3 uCam; uniform float uMul;
out float vAlong; out float vAcross; out float vHW; out float vA; out float vLen; out float vDir; out float vFlow;
void main(){
  int i0 = int(aEnds.x + 0.5), i1 = int(aEnds.y + 0.5);
  vec4 p0 = texelFetch(uPos, ivec2(i0 & ${TEXW - 1}, i0 >> 10), 0);
  vec4 p1 = texelFetch(uPos, ivec2(i1 & ${TEXW - 1}, i1 >> 10), 0);
  vec2 c0 = uView * 0.5 + uCam.xy + p0.xy * uCam.z, c1 = uView * 0.5 + uCam.xy + p1.xy * uCam.z;
  vec2 dir = c1 - c0; float len = length(dir); dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = aSt.y * 0.5 + 0.75;
  float f = min(p0.z, p1.z);
  float vis = step(0.01, f);
  vec2 s = mix(c0, c1, aQ.x) + nrm * aQ.y * hw * vis;
  gl_Position = vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.0, 1.0);
  vAlong = aQ.x; vAcross = aQ.y * hw; vHW = aSt.y * 0.5; vA = aSt.x * f * uMul; vLen = len;
  vDir = mod(aSt.z, 2.0); vFlow = aSt.z >= 2.0 ? 1.0 : 0.0;
}`,
    edgeFS: GLSL_HEAD + `
in float vAlong; in float vAcross; in float vHW; in float vA; in float vLen; in float vDir; in float vFlow;
uniform vec3 uInk; uniform float uTime;
out vec4 o;
void main(){
  float cov = 1.0 - smoothstep(vHW - 0.5, vHW + 0.75, abs(vAcross));
  float grad = mix(1.0, mix(0.45, 1.0, vAlong), vDir);
  float pulse = vFlow * (0.55 + 0.45 * sin(vAlong * vLen * 0.32 - uTime * 5.0));
  float a = clamp(vA * cov * grad * (1.0 + pulse * 0.9), 0.0, 1.0);
  o = vec4(uInk * a, a);
}`,
    auraVS: GLSL_HEAD + `
in vec2 aCorner; in vec4 aC; in vec4 aRGBA;
uniform vec2 uView; uniform vec3 uCam;
out vec2 vUV; out vec4 vCol;
void main(){
  vec2 c = uView * 0.5 + uCam.xy + aC.xy * uCam.z;
  vec2 s = c + aCorner * aC.z * uCam.z;
  gl_Position = vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.0, 1.0);
  vUV = aCorner; vCol = aRGBA;
}`,
    auraFS: GLSL_HEAD + `
in vec2 vUV; in vec4 vCol;
out vec4 o;
void main(){
  float d = length(vUV);
  float a = (1.0 - smoothstep(0.25, 1.0, d)); a *= a * vCol.a;
  o = vec4(vCol.rgb * a, a);
}`,
  };

  const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;
  function createGL(canvas, mode) {   // mode: 'auto' (refuse CPU-emulated GL: measured slower than Canvas2D there) | 'webgl' (force)
    let gl = null;
    try { gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false, powerPreference: 'high-performance' }); } catch (_) { gl = null; }
    if (!gl || typeof gl.createShader !== 'function' || typeof gl.drawArraysInstanced !== 'function') return null;
    if (mode !== 'webgl') {
      try { const x = gl.getExtension('WEBGL_debug_renderer_info'), name = x ? String(gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) : ''; if (SOFTWARE_GL.test(name)) { console.info('[' + EXT + '] software WebGL (' + name + ') → Canvas2D renderer'); return null; } } catch (_) { /* no debug info: trust the context */ }
    }
    const compile = (type, src) => {
      const s = gl.createShader(type); if (!s) throw new Error('createShader');
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram(); if (!p) throw new Error('createProgram');
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
      return p;
    };
    let pN, pE, pA;
    try { pN = program(GL_SRC.nodeVS, GL_SRC.nodeFS); pE = program(GL_SRC.edgeVS, GL_SRC.edgeFS); pA = program(GL_SRC.auraVS, GL_SRC.auraFS); } catch (e) { console.warn('[' + EXT + '] WebGL2 unavailable, using Canvas2D:', e && e.message); return null; }
    const U = (p, names) => { const o = {}; names.forEach(n => { o[n] = gl.getUniformLocation(p, n); }); return o; };
    const uN = U(pN, ['uPos', 'uView', 'uCam', 'uMin', 'uDark']), uE = U(pE, ['uPos', 'uView', 'uCam', 'uMul', 'uInk', 'uTime']), uA = U(pA, ['uView', 'uCam']);
    const buf = () => gl.createBuffer();
    const quadNode = buf(), quadEdge = buf(), nodeStatic = buf(), nodeColor = buf(), edgeBuf = buf(), focusBuf = buf(), auraBuf = buf();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadNode); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadEdge); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const vaoN = gl.createVertexArray(), vaoE = gl.createVertexArray(), vaoF = gl.createVertexArray(), vaoA = gl.createVertexArray();
    const attr = (prog, name, b, size, type, norm, stride, off, div) => {
      const l = gl.getAttribLocation(prog, name); if (l < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, type, norm, stride, off); gl.vertexAttribDivisor(l, div);
    };
    gl.bindVertexArray(vaoN);
    attr(pN, 'aCorner', quadNode, 2, gl.FLOAT, false, 0, 0, 0);
    attr(pN, 'aN', nodeStatic, 3, gl.FLOAT, false, 12, 0, 1);
    attr(pN, 'aCol', nodeColor, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1);
    const edgeVao = (vao, b) => { gl.bindVertexArray(vao); attr(pE, 'aQ', quadEdge, 2, gl.FLOAT, false, 0, 0, 0); attr(pE, 'aEnds', b, 2, gl.FLOAT, false, 24, 0, 1); attr(pE, 'aSt', b, 4, gl.FLOAT, false, 24, 8, 1); };
    edgeVao(vaoE, edgeBuf); edgeVao(vaoF, focusBuf);
    gl.bindVertexArray(vaoA);
    attr(pA, 'aCorner', quadNode, 2, gl.FLOAT, false, 0, 0, 0);
    attr(pA, 'aC', auraBuf, 4, gl.FLOAT, false, 32, 0, 1);
    attr(pA, 'aRGBA', auraBuf, 4, gl.FLOAT, false, 32, 16, 1);
    gl.bindVertexArray(null);
    const tex = gl.createTexture();
    let texData = null, texH = 0, nN = 0, nE = 0, nF = 0, dead = false;
    const r = {
      kind: 'webgl2', canvas,
      get lost() { return dead || gl.isContextLost(); },
      resize(w, h, dpr) { canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr)); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; },
      setNodes(N, order, rad, glow) {
        nN = N; const a = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) { const i = order[k]; a[3 * k] = i; a[3 * k + 1] = rad[i]; a[3 * k + 2] = glow[i]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeStatic); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
        texH = Math.max(1, Math.ceil(N / TEXW)); texData = new Float32Array(TEXW * texH * 4);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXW, texH, 0, gl.RGBA, gl.FLOAT, texData);
      },
      setColors(order, col) {   // col: Uint8Array(4N) in node-index order; the instance buffer is in draw (size) order
        const a = new Uint8Array(order.length * 4);
        for (let k = 0; k < order.length; k++) { const i = order[k]; a[4 * k] = col[4 * i]; a[4 * k + 1] = col[4 * i + 1]; a[4 * k + 2] = col[4 * i + 2]; a[4 * k + 3] = col[4 * i + 3]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeColor); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
      },
      setEdges(E) {
        const a = new Float32Array(E.n * 6);
        for (let k = 0; k < E.n; k++) { a[6 * k] = E.s[k]; a[6 * k + 1] = E.t[k]; a[6 * k + 2] = E.a[k]; a[6 * k + 3] = E.w[k]; a[6 * k + 4] = E.dir[k]; a[6 * k + 5] = 0; }
        nE = E.n; gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
      },
      setFocusEdges(E) {
        if (!E || !E.n) { nF = 0; return; }
        const a = new Float32Array(E.n * 6);
        for (let k = 0; k < E.n; k++) { a[6 * k] = E.s[k]; a[6 * k + 1] = E.t[k]; a[6 * k + 2] = E.a[k]; a[6 * k + 3] = E.w[k]; a[6 * k + 4] = E.dir[k] + 2; a[6 * k + 5] = 0; }
        nF = E.n; gl.bindBuffer(gl.ARRAY_BUFFER, focusBuf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
      },
      draw(fc) {
        if (gl.isContextLost() || !texData) return;
        const T = fc.theme;
        if (fc.posDirty || fc.fadeDirty) {
          const p = fc.pos, f = fc.fade;
          for (let i = 0, N = nN; i < N; i++) { const o = 4 * i; texData[o] = p[2 * i]; texData[o + 1] = p[2 * i + 1]; texData[o + 2] = f[i]; }
          gl.bindTexture(gl.TEXTURE_2D, tex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXW, texH, gl.RGBA, gl.FLOAT, texData);
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        if (fc.nAuras > 0) {
          gl.useProgram(pA); gl.uniform2f(uA.uView, fc.W, fc.H); gl.uniform3f(uA.uCam, fc.vx, fc.vy, fc.k);
          gl.bindVertexArray(vaoA); gl.bindBuffer(gl.ARRAY_BUFFER, auraBuf); gl.bufferData(gl.ARRAY_BUFFER, fc.auras.subarray(0, fc.nAuras * 8), gl.DYNAMIC_DRAW);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fc.nAuras);
        }
        gl.useProgram(pE); gl.uniform1i(uE.uPos, 0); gl.uniform2f(uE.uView, fc.W, fc.H); gl.uniform3f(uE.uCam, fc.vx, fc.vy, fc.k);
        gl.uniform1f(uE.uTime, fc.time * 0.001);
        const ink = T.textRgb; gl.uniform3f(uE.uInk, ink[0] / 255, ink[1] / 255, ink[2] / 255);
        if (nE > 0 && fc.edgeMul > 0) { gl.uniform1f(uE.uMul, fc.edgeMul * fc.dim); gl.bindVertexArray(vaoE); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nE); }
        if (nF > 0) { const ac = T.accentRgb; gl.uniform3f(uE.uInk, ac[0] / 255, ac[1] / 255, ac[2] / 255); gl.uniform1f(uE.uMul, 1); gl.bindVertexArray(vaoF); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nF); }
        gl.useProgram(pN); gl.uniform1i(uN.uPos, 0); gl.uniform2f(uN.uView, fc.W, fc.H); gl.uniform3f(uN.uCam, fc.vx, fc.vy, fc.k); gl.uniform1f(uN.uMin, fc.minPx); gl.uniform1f(uN.uDark, T.dark ? 1 : 0);
        gl.bindVertexArray(vaoN); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nN);
        gl.bindVertexArray(null);
      },
      destroy() { dead = true; try { const x = gl.getExtension('WEBGL_lose_context'); x && x.loseContext(); } catch (_) { /* already gone */ } },
    };
    return r;
  }

  function create2D(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;
    let N = 0, order = null, rad = null, glow = null, colIdx = null, pal = null, E = null, F = null;
    let eb = null, auraCv = null, auraCx = null;
    const sprites = new Map(), discs = new Map();   // palette idx -> glow sprite / (palette idx, size bucket) -> shaded disc (pre-rendered once: MDN "pre-render repeating objects")
    const BUCKETS = [1.5, 2.2, 3, 4, 5, 6.5, 8, 10, 13, 17, 22, 30];
    const bucketOf = (r) => { for (let i = 0; i < BUCKETS.length; i++) if (r <= BUCKETS[i] * 1.12) return BUCKETS[i]; return Math.min(r, 60); };
    const discSprite = (ci, bk, dpr) => {
      const key = ci * 1000 + Math.round(bk * 10); let s = discs.get(key); if (s) return s;
      const sz = Math.ceil((bk + 1.5) * 2 * dpr); s = document.createElement('canvas'); s.width = s.height = sz;
      const g = s.getContext('2d'), c = sz / 2, R = bk * dpr, [r0, g0, b0] = pal[ci].split(',').map(Number), cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
      const gr = g.createRadialGradient(c, c * 0.88, 0, c, c, R);
      gr.addColorStop(0, 'rgb(' + cl(r0 * 1.16 + 13) + ',' + cl(g0 * 1.16 + 13) + ',' + cl(b0 * 1.16 + 13) + ')'); gr.addColorStop(1, 'rgb(' + cl(r0 * 0.84) + ',' + cl(g0 * 0.84) + ',' + cl(b0 * 0.84) + ')');
      g.fillStyle = gr; g.beginPath(); g.arc(c, c, R, 0, 6.283185307); g.fill();
      if (R >= 4) { g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = Math.max(1, dpr * 0.8); g.beginPath(); g.arc(c, c, R - g.lineWidth / 2, 0, 6.283185307); g.stroke(); }
      discs.set(key, s); return s;
    };
    const glowSprite = (ci, rgb) => {
      let s = sprites.get(ci); if (s) return s;
      s = document.createElement('canvas'); s.width = s.height = 64; const g = s.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(' + rgb + ',0.55)'); gr.addColorStop(0.35, 'rgba(' + rgb + ',0.22)'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(ci, s); return s;
    };
    const r = {
      kind: 'canvas2d', canvas, lost: false,
      resize(w, h, dpr) { canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr)); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; },
      setNodes(n, ord, rd, gl_) { N = n; order = ord; rad = rd; glow = gl_; },
      setColors(ord, col, ci, p) { colIdx = ci; pal = p; sprites.clear(); discs.clear(); },
      setEdges(e) { E = e; },
      setFocusEdges(e) { F = e && e.n ? e : null; },
      draw(fc) {
        const T = fc.theme, W = canvas.width, H = canvas.height, dpr = W / fc.W, k = fc.k, vx = fc.W / 2 + fc.vx, vy = fc.H / 2 + fc.vy;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const pos = fc.pos, fade = fc.fade;
        if (fc.nAuras > 0) {   // community auras are soft by nature: paint them at 1/4 resolution and upscale once (fill cost ÷16)
          const aw = Math.max(1, Math.ceil(fc.W / 4)), ah = Math.max(1, Math.ceil(fc.H / 4));
          if (!auraCv) { auraCv = document.createElement('canvas'); auraCx = auraCv.getContext('2d'); }
          if (auraCv.width !== aw || auraCv.height !== ah) { auraCv.width = aw; auraCv.height = ah; }
          auraCx.setTransform(1, 0, 0, 1, 0, 0); auraCx.clearRect(0, 0, aw, ah); auraCx.setTransform(0.25, 0, 0, 0.25, 0, 0);
          for (let i = 0; i < fc.nAuras; i++) {
            const o = i * 8, cx = vx + fc.auras[o] * k, cy = vy + fc.auras[o + 1] * k, rr = fc.auras[o + 2] * k;
            if (cx + rr < 0 || cy + rr < 0 || cx - rr > fc.W || cy - rr > fc.H) continue;
            const rgb = Math.round(fc.auras[o + 4] * 255) + ',' + Math.round(fc.auras[o + 5] * 255) + ',' + Math.round(fc.auras[o + 6] * 255), al = fc.auras[o + 7];
            const g = auraCx.createRadialGradient(cx, cy, 0, cx, cy, rr); g.addColorStop(0, 'rgba(' + rgb + ',' + al + ')'); g.addColorStop(0.55, 'rgba(' + rgb + ',' + al * 0.35 + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
            auraCx.fillStyle = g; auraCx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
          }
          ctx.drawImage(auraCv, 0, 0, aw, ah, 0, 0, aw * 4, ah * 4);
        }
        // edges: one path per alpha class, one stroke each (batching = the single biggest Canvas2D win); typed scratch buffers, no per-frame garbage
        if (E && E.n && fc.edgeMul > 0) {
          const ink = T.textRgb, thin = E.n > 6000 && fc.fast, mul = fc.edgeMul * fc.dim;
          if (!eb || eb[0].length < E.n * 4) eb = [new Float32Array(E.n * 4), new Float32Array(E.n * 4), new Float32Array(E.n * 4)];
          const cnt = [0, 0, 0];
          ctx.lineWidth = 1; ctx.lineCap = 'butt';
          for (let e = 0; e < E.n; e++) {
            if (thin && (e & 3)) continue;   // big graph in motion: a quarter of the edges (sigma "hideEdgesOnMove" spirit, but graceful)
            const s = E.s[e], t = E.t[e];
            if (fade[s] < 0.02 || fade[t] < 0.02) continue;
            const ax = vx + pos[2 * s] * k, ay = vy + pos[2 * s + 1] * k, bx = vx + pos[2 * t] * k, by = vy + pos[2 * t + 1] * k;
            if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > fc.W && bx > fc.W) || (ay > fc.H && by > fc.H)) continue;
            const a = E.a[e] * mul * Math.min(fade[s], fade[t]) * (thin ? 2.2 : 1), bk = a < 0.07 ? 0 : a < 0.14 ? 1 : 2, q = eb[bk], j = cnt[bk];
            q[j] = ax; q[j + 1] = ay; q[j + 2] = bx; q[j + 3] = by; cnt[bk] = j + 4;
          }
          const al = thin ? [0.1, 0.22, 0.38] : [0.05, 0.11, 0.2];
          for (let b = 0; b < 3; b++) {
            const q = eb[b], n = cnt[b]; if (!n) continue;
            ctx.strokeStyle = 'rgba(' + ink[0] + ',' + ink[1] + ',' + ink[2] + ',' + al[b] + ')'; ctx.beginPath();
            for (let j = 0; j < n; j += 4) { ctx.moveTo(q[j], q[j + 1]); ctx.lineTo(q[j + 2], q[j + 3]); }
            ctx.stroke();
          }
        }
        if (F) {
          const ac = T.accentRgb; ctx.strokeStyle = 'rgb(' + ac[0] + ',' + ac[1] + ',' + ac[2] + ')'; ctx.lineWidth = 1.8; ctx.globalAlpha = 0.95; ctx.beginPath();
          for (let e = 0; e < F.n; e++) { const s = F.s[e], t = F.t[e]; ctx.moveTo(vx + pos[2 * s] * k, vy + pos[2 * s + 1] * k); ctx.lineTo(vx + pos[2 * t] * k, vy + pos[2 * t + 1] * k); }
          ctx.stroke(); ctx.globalAlpha = 1;
        }
        // nodes: pre-rendered shaded-disc sprites (per palette colour × size bucket) blitted in size order (hubs on top). drawImage of a
        // cached sprite measured ~3x cheaper than filling thousands of arc() subpaths in the software rasteriser.
        if (fc.noNodes) return;
        if (fc.fast) {   // motion on a big graph: one fillRect per node (measured 0.7 µs vs 4.4 µs for sprites/arcs), grouped by colour; full quality returns the moment it stops
          const P = pal.length, cn = new Int32Array(P + 1), idx = new Int32Array(N);
          for (let i = 0; i < N; i++) if (fade[i] > 0.5) cn[colIdx[i] + 1]++;
          for (let c = 0; c < P; c++) cn[c + 1] += cn[c];
          const cur = cn.slice(0, P);
          for (let kk = 0; kk < N; kk++) { const i = order[kk]; if (fade[i] > 0.5) idx[cur[colIdx[i]]++] = i; }
          for (let c = 0; c < P; c++) {
            if (cn[c] === cn[c + 1]) continue;
            ctx.fillStyle = 'rgb(' + pal[c] + ')';
            for (let j = cn[c]; j < cn[c + 1]; j++) {
              const i = idx[j], x = vx + pos[2 * i] * k, y = vy + pos[2 * i + 1] * k, r = Math.max(rad[i] * k, fc.minPx) * 0.9;
              if (x < -20 || y < -20 || x > fc.W + 20 || y > fc.H + 20) continue;
              ctx.fillRect(x - r, y - r, r * 2, r * 2);
            }
          }
          return;
        }
        // fallback LOD ("collapse"): a software 2D canvas blits ~4 µs/node, so cap the nodes drawn per frame (NODE_BUDGET) by dropping the
        // SMALLEST on-screen ones first (leaves); community auras + hubs + labels still carry the structure. The GL path has no such cap.
        let inView = 0;
        if (N > NODE_BUDGET) {
          for (let i = 0; i < N; i++) { if (fade[i] < 0.02) continue; const x = vx + pos[2 * i] * k, y = vy + pos[2 * i + 1] * k; if (x > -30 && y > -30 && x < fc.W + 30 && y < fc.H + 30) inView++; }
        }
        let skip = Math.max(0, inView - NODE_BUDGET), curA = -1;
        for (let kk = 0; kk < N; kk++) {
          const i = order[kk], f = fade[i];
          if (f < 0.02) continue;
          if (skip > 0 && f > 0.98) { const x0 = vx + pos[2 * i] * k, y0 = vy + pos[2 * i + 1] * k; if (x0 > -30 && y0 > -30 && x0 < fc.W + 30 && y0 < fc.H + 30) { skip--; continue; } }
          const x = vx + pos[2 * i] * k, y = vy + pos[2 * i + 1] * k, r = Math.max(rad[i] * k, fc.minPx);
          if (x < -30 || y < -30 || x > fc.W + 30 || y > fc.H + 30) continue;
          const fq = Math.round(f * 8) / 8; if (fq !== curA) { ctx.globalAlpha = fq; curA = fq; }
          if (glow[i] > 0.4 && r > 4) { const s = r * 3.2; ctx.drawImage(glowSprite(colIdx[i], pal[colIdx[i]]), x - s, y - s, s * 2, s * 2); }
          const bk = bucketOf(r), spr = discSprite(colIdx[i], bk, dpr), sz = (bk + 1.5) * 2 * (r / bk);   // sprite drawn at its own scale ±10%
          ctx.drawImage(spr, x - sz / 2, y - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1;
      },
      destroy() { /* GC */ },
    };
    return r;
  }

  // ── DOM / lifecycle ────────────────────────────────────────────────────────
  let overlay, canvas, uctx, side, banner, legendBox, keyBox, searchIn, searchWrap, statusEl, led, bar, toolsSlot, sheet, filterBtn, backBtn, stage, renderer = null, baseCv = null, rootSel;
  let warned = false;

  function makeRenderer(force2d) {
    const mode = String(cfgGet('renderer', window.__hwxGraphRenderer || 'auto')).toLowerCase();
    let cv = el('canvas', 'hwx-graph-gl'), r = force2d || mode === '2d' || mode === 'canvas2d' ? null : createGL(cv, mode);
    if (!r) { cv = el('canvas', 'hwx-graph-gl'); r = create2D(cv); }
    cv.setAttribute('aria-hidden', 'true');
    if (baseCv && baseCv.parentNode) { baseCv.parentNode.replaceChild(cv, baseCv); } else { stage.insertBefore(cv, canvas); }
    if (renderer) renderer.destroy();
    baseCv = cv; renderer = r;
    if (r.kind === 'webgl2') cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); makeRenderer(true); pushRendererData(); resize(); });
    stage.dataset.renderer = r.kind;
    return r;
  }
  function pushRendererData() {
    if (!renderer || !state.data) return;
    renderer.setNodes(state.N, state.order, state.rad, state.glow);
    renderer.setColors(state.order, state.col, state.colIdx, state.pal);
    if (state.edges) renderer.setEdges(state.edges);
    renderer.setFocusEdges(state.focusEdges);
    state.posDirty = state.fadeDirty = state.dirty = true;
  }

  function build() {
    overlay = el('div', 'hwx-graph-overlay'); overlay.id = 'hwx-graph-overlay'; overlay.hidden = true;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Graph');
    const mk = (label, fn, cls, ic, aria) => {
      const b = el('button', 'hwx-graph-btn' + (cls ? ' ' + cls : '')); b.type = 'button';
      if (ic) { b.appendChild(ICONS[ic]()); if (label) b.appendChild(el('span', 'hwx-graph-btxt', label)); } else b.textContent = label;
      if (aria) { b.setAttribute('aria-label', aria); b.title = aria; }
      b.addEventListener('click', fn); return b;
    };
    bar = el('div', 'hwx-graph-bar');
    const brand = el('div', 'hwx-graph-title'); led = el('span', 'hwx-graph-led'); brand.append(led, el('span', null, 'Graph')); bar.appendChild(brand);
    searchWrap = el('div', 'hwx-graph-searchwrap');
    const sb = mk('', () => toggleSearch(true), 'hwx-graph-iconbtn hwx-graph-searchbtn', 'search', L10N('Search nodes (/)', 'Buscar nó (/)'));
    searchIn = el('input', 'hwx-graph-search'); searchIn.type = 'search'; searchIn.placeholder = L10N('Search nodes (name, path)…', 'Buscar nó (nome, caminho)…');
    searchIn.setAttribute('aria-label', L10N('Search nodes', 'Buscar nó'));
    searchIn.addEventListener('input', () => { state.query = searchIn.value.trim().toLowerCase(); retarget(); loop(); });
    searchIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.data) { const m = state.data.nodes.find(n => state.vis[n.i] && matches(n)); if (m) select(m, true); }
      if (e.key === 'Escape') { e.stopPropagation(); searchIn.value = ''; state.query = ''; retarget(); toggleSearch(false); loop(); }
    });
    searchIn.addEventListener('blur', () => { if (!searchIn.value) toggleSearch(false); });
    searchWrap.append(sb, searchIn); bar.appendChild(searchWrap);
    backBtn = mk('', () => { state.egoOf = null; backBtn.hidden = true; load(rootSel.value); }, 'hwx-graph-back', 'back', L10N('Back to full graph', 'Voltar ao grafo completo'));
    backBtn.appendChild(el('span', 'hwx-graph-btxt', L10N('Full graph', 'Grafo completo'))); backBtn.hidden = true; backBtn.id = 'hwx-graph-back'; bar.appendChild(backBtn);
    bar.appendChild(el('span', 'hwx-graph-spacer'));
    statusEl = el('span', 'hwx-graph-status', ''); bar.appendChild(statusEl);
    filterBtn = mk(L10N('Filters', 'Filtros'), () => toggleSheet(), 'hwx-graph-filterbtn', 'sliders', L10N('Filters and options', 'Filtros e opções')); filterBtn.setAttribute('aria-expanded', 'false'); bar.appendChild(filterBtn);
    bar.appendChild(mk('', () => fit({ user: true }), 'hwx-graph-iconbtn hwx-graph-fitbtn', 'fit', L10N('Fit to screen', 'Ajustar à tela')));
    bar.appendChild(mk('', close, 'hwx-graph-iconbtn hwx-graph-close', 'close', L10N('Close', 'Fechar')));
    overlay.appendChild(bar);

    const body = el('div', 'hwx-graph-body');
    stage = el('div', 'hwx-graph-stage'); gridEl = el('div', 'hwx-graph-grid'); stage.appendChild(gridEl);
    canvas = el('canvas', 'hwx-graph-canvas'); canvas.tabIndex = 0; canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', L10N('Knowledge graph: files, memory, skills and sessions', 'Grafo de conhecimento: arquivos, memória, skills e sessões'));
    uctx = canvas.getContext('2d');
    stage.appendChild(canvas);
    makeRenderer(false);
    const fab = el('button', 'hwx-graph-btn hwx-graph-fab'); fab.type = 'button'; fab.setAttribute('aria-label', L10N('Fit to screen', 'Ajustar à tela')); fab.appendChild(ICONS.fit());
    fab.addEventListener('click', () => fit({ user: true })); stage.appendChild(fab);   // phone-only shortcut for "Ajustar" (hidden by CSS elsewhere)
    banner = el('div', 'hwx-graph-banner'); banner.hidden = true; stage.appendChild(banner);
    keyBox = el('div', 'hwx-graph-key'); stage.appendChild(keyBox);
    body.appendChild(stage);

    // filters + options live in a popover (desktop) / bottom sheet (≤900px): the bar stays one slim row
    sheet = el('div', 'hwx-graph-left'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', L10N('Filters and options', 'Filtros e opções'));
    const sheetHead = el('div', 'hwx-graph-sheet-head');
    sheetHead.appendChild(el('span', 'hwx-graph-sheet-title', L10N('Filters and options', 'Filtros e opções')));
    const sheetClose = el('button', 'hwx-graph-btn hwx-graph-sheet-close'); sheetClose.type = 'button'; sheetClose.setAttribute('aria-label', L10N('Close filters', 'Fechar filtros')); sheetClose.appendChild(ICONS.close());
    sheetClose.addEventListener('click', () => toggleSheet(false));
    sheetHead.appendChild(sheetClose); sheet.appendChild(sheetHead);
    toolsSlot = el('div', 'hwx-graph-tools-slot');
    const tools = el('div', 'hwx-graph-tools');
    const colorSel = el('select', 'hwx-graph-sel'); colorSel.setAttribute('aria-label', L10N('Colour by', 'Colorir por'));
    [['type', L10N('colour: type', 'cor: tipo')], ['comm', L10N('colour: community (Louvain)', 'cor: comunidade (Louvain)')]].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; colorSel.appendChild(o); });
    colorSel.addEventListener('change', () => { state.colorBy = colorSel.value; recolor(); renderLegend(); state.dirty = true; loop(); });
    tools.appendChild(colorSel);
    rootSel = el('select', 'hwx-graph-sel'); rootSel.setAttribute('aria-label', L10N('Scope', 'Escopo'));
    [['ws', L10N('scope: workspace + brain', 'escopo: workspace + cérebro')], ['ws,sk', L10N('+ skill files', '+ arquivos das skills')]].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; rootSel.appendChild(o); });
    rootSel.value = cfgGet('default_roots', 'ws');
    rootSel.addEventListener('change', () => load(rootSel.value));
    tools.appendChild(rootSel);
    const acts = el('div', 'hwx-graph-acts');
    acts.appendChild(mk(L10N('Fit', 'Ajustar'), () => fit({ user: true })));
    acts.appendChild(mk(L10N('Overview', 'Visão geral'), () => fit({ user: true, all: true })));
    acts.appendChild(mk('Re-layout', () => { if (state.sim) { state.sim.cmd({ t: 'reheat', alpha: 1 }); state.autoFit = true; loop(); } }));
    acts.appendChild(mk(L10N('Reindex', 'Reindexar'), reindex));
    tools.appendChild(acts);
    const mkRange = (label, key, min, max, base) => {
      const row = el('label', 'hwx-graph-range'), out = el('output', null, '1.0×'), inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = '0.05'; inp.value = '1'; inp.setAttribute('aria-label', label);
      inp.addEventListener('input', () => {
        const v = +inp.value; out.textContent = v.toFixed(1) + '×'; state.physics[key] = v;
        if (state.sim) { state.sim.cmd({ t: 'params', p: key === 'gravity' ? { gravity: base * v } : { repulsion: (typeof base === 'function' ? base() : base) * v } }); loop(); }
      });
      row.append(el('span', 'hwx-graph-rl', label), inp, out); return row;
    };
    tools.appendChild(mkRange(L10N('Gravity', 'Gravidade'), 'gravity', 0, 3, 0.30));
    tools.appendChild(mkRange(L10N('Spread', 'Espalhar'), 'spread', 0.3, 3, () => state.repBase));
    toolsSlot.appendChild(tools); sheet.appendChild(toolsSlot);
    legendBox = el('div', 'hwx-graph-legend'); sheet.appendChild(legendBox);
    body.appendChild(sheet);

    side = el('div', 'hwx-graph-side'); side.hidden = true; body.appendChild(side);
    overlay.appendChild(body);
    document.body.appendChild(overlay);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
    bindCanvas();
    readTheme();
    if (window.MutationObserver) new MutationObserver(() => { readTheme(); if (state.data) { recolor(); renderLegend(); } state.dirty = true; if (state.open) loop(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin', 'style', 'data-theme'] });
  }
  function toggleSheet(force) {
    const on = force == null ? !sheet.classList.contains('hwx-open') : !!force;
    sheet.classList.toggle('hwx-open', on); filterBtn.setAttribute('aria-expanded', String(on)); filterBtn.classList.toggle('hwx-on', on);
  }
  function toggleSearch(on) {
    searchWrap.classList.toggle('hwx-open', on);
    if (on) { searchIn.focus(); } else if (document.activeElement === searchIn) searchIn.blur();
  }

  function resize() {
    if (!canvas || !stage) return;
    const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    state.W = Math.max(1, r.width); state.H = Math.max(1, r.height); state.dpr = Math.min(dpr, 3);
    canvas.width = Math.max(1, Math.round(state.W * state.dpr)); canvas.height = Math.max(1, Math.round(state.H * state.dpr));
    canvas.style.width = state.W + 'px'; canvas.style.height = state.H + 'px';
    if (renderer) renderer.resize(state.W, state.H, Math.min(dpr, 2));   // GPU layer capped at 2× — beyond that is pure fill-rate cost
    state.dirty = state.posDirty = true; if (state.open) loop();
  }

  // ── data ───────────────────────────────────────────────────────────────────
  function showBanner(title, detail) {
    banner.hidden = false; banner.textContent = '';
    banner.appendChild(el('strong', null, title)); banner.appendChild(el('div', null, detail));
  }
  function diagnose(status) {
    if (status === 403) return [L10N('Sidecar proxy not approved (or WebUI has no password)', 'Proxy do sidecar não aprovado (ou WebUI sem senha)'), L10N('Settings → Extensions → Diagnostics → “Loopback sidecar” card → approve the proxy consent for hermes-graph. token-v1 requires WebUI authentication.', 'Configurações → Extensions → Diagnostics → card “Loopback sidecar” → aprovar consentimento do proxy para hermes-graph. token-v1 exige autenticação do WebUI.')];
    if (status === 401 || status === 503) return ['Sidecar recusou o token', 'Sidecar e WebUI precisam compartilhar o state dir (~/.hermes/webui). Reinicie hermes-graph-sidecar.'];
    if (status === 404) return [L10N('Extension not enabled', 'Extension não habilitada'), L10N('The manifest does not declare the hermes-graph sidecar, or the extension is disabled.', 'O manifest não declara o sidecar hermes-graph ou a extension está desabilitada.')];
    return [L10N('Sidecar is not responding', 'Sidecar não responde'), L10N('The proxy cannot reach 127.0.0.1:17803. Start it: systemctl --user enable --now hermes-graph-sidecar', 'O proxy não alcança 127.0.0.1:17803. Inicie: systemctl --user enable --now hermes-graph-sidecar') + (status ? ' (HTTP ' + status + ')' : '')];
  }
  async function getJSON(path) {
    const res = await fetch(BASE + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null; try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
    return { status: res.status, ok: res.ok, body };
  }

  async function load(roots) {
    clearTimeout(state.pollTimer);
    statusEl.textContent = L10N('loading…', 'carregando…');
    let r;
    try { r = await getJSON('/graph?roots=' + encodeURIComponent(roots || 'ws') + '&max_nodes=' + cfgGet('max_nodes', 3000)); }
    catch (_) { const [t, d] = diagnose(0); showBanner(t, d); statusEl.textContent = ''; return; }
    if (!r.ok && r.status !== 202) { const [t, d] = diagnose(r.status); showBanner(t, d); statusEl.textContent = ''; return; }
    if (r.status === 202 || !r.body || r.body.state !== 'ready') {
      showBanner(L10N('Indexing…', 'Indexando…'), L10N('The sidecar is building the first snapshot (cold run ~10 s for ~1000 files).', 'O sidecar está construindo o primeiro snapshot (a frio ~10 s para ~1000 arquivos).'));
      state.pollTimer = setTimeout(() => load(roots), 2500); return;
    }
    banner.hidden = true;
    setData(r.body);
  }

  async function loadEgo(node) {
    const r = await getJSON('/graph/ego?hops=2&id=' + encodeURIComponent(node.id));
    if (!r.ok || !r.body || !r.body.nodes) return;
    state.egoOf = node.id;
    backBtn.hidden = false;
    setData(r.body);
  }

  async function reindex() {
    statusEl.textContent = L10N('reindexing…', 'reindexando…');
    try { await fetch(BASE + '/reindex', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* surfaced by next load */ }
    setTimeout(() => load('ws'), 4000);
  }

  // ── filtering ──────────────────────────────────────────────────────────────
  const visible = (n) => !state.hiddenTypes.has(n.type) && (state.showOrphans || n.type !== 'file' || (n.attrs.sd || 0) > 0);
  const visibleNodes = () => state.data.nodes.filter(n => state.vis[n.i]);
  const matches = (n) => !state.query || n.label.toLowerCase().includes(state.query) || (n.path || '').toLowerCase().includes(state.query);

  function computeVis() { const nodes = state.data.nodes; for (let i = 0; i < nodes.length; i++) state.vis[i] = visible(nodes[i]) ? 1 : 0; state.auraDirty = true; }
  function linkMask() { const E = state.data.edges, m = new Uint8Array(E.length); for (let k = 0; k < E.length; k++) m[k] = state.hiddenKinds.has(E[k].kind) ? 0 : 1; return m; }
  function pushMask(alpha) { if (state.sim) { state.sim.cmd({ t: 'mask', mask: Uint8Array.from(state.vis), lmask: linkMask(), alpha: alpha == null ? 0.3 : alpha }); } }
  function onFiltersChanged() {
    computeVis(); pushMask(0.3); rebuildEdges(); refocus(); renderKey(); state.dirty = true; loop();
  }

  function rebuildEdges() {
    const E = state.data.edges, vis = state.vis, keep = [];
    for (let k = 0; k < E.length; k++) { const e = E[k]; if (!state.hiddenKinds.has(e.kind) && vis[e.s] && vis[e.t]) keep.push(k); }
    const n = keep.length, dens = Math.max(0.18, Math.min(1, 2800 / Math.max(1, n)));
    const o = { n, s: new Int32Array(n), t: new Int32Array(n), a: new Float32Array(n), w: new Float32Array(n), dir: new Uint8Array(n) };
    keep.forEach((k, j) => { const e = E[k]; o.s[j] = e.s; o.t[j] = e.t; o.a[j] = (0.13 + 0.22 * Math.min(1, e.w)) * (e.kind === 'similar' ? 0.6 : 1) * dens; o.w[j] = 1; o.dir[j] = DIRECTED.has(e.kind) ? 1 : 0; });
    state.edges = o; if (renderer) renderer.setEdges(o);
  }
  function buildFocusEdges() {
    const f = state.sel || state.hover;
    if (!f) { state.focusEdges = null; if (renderer) renderer.setFocusEdges(null); return; }
    const E = state.data.edges, keep = [];
    state.data.adj[f.i].forEach(k => { const e = E[k]; if (!state.hiddenKinds.has(e.kind) && state.vis[e.s] && state.vis[e.t]) keep.push(e); });
    const n = keep.length, o = { n, s: new Int32Array(n), t: new Int32Array(n), a: new Float32Array(n), w: new Float32Array(n), dir: new Uint8Array(n) };
    keep.forEach((e, j) => { o.s[j] = e.s; o.t[j] = e.t; o.a[j] = 0.9; o.w[j] = 1.8; o.dir[j] = DIRECTED.has(e.kind) ? 1 : 0; });
    state.focusEdges = o; if (renderer) renderer.setFocusEdges(o);
  }
  // focus (selection wins over hover) → neighbourhood mask → per-node target opacity; the frame loop eases toward it
  function refocus() {
    const f = state.sel || state.hover, N = state.N;
    if (f) { const nb = new Uint8Array(N); nb[f.i] = 1; state.data.adj[f.i].forEach(k => { const e = state.data.edges[k]; nb[e.s] = 1; nb[e.t] = 1; }); state.nb = nb; } else state.nb = null;
    buildFocusEdges(); retarget();
  }
  function retarget() {
    if (!state.data) return;
    const nodes = state.data.nodes, N = state.N, nb = state.nb, q = state.query;
    for (let i = 0; i < N; i++) {
      let t = state.vis[i] ? 1 : 0;
      if (t && nb && !nb[i]) t = 0.14;
      if (t && q && !matches(nodes[i])) t = Math.min(t, 0.12);
      state.fadeT[i] = t;
    }
    if (reduced()) { state.fade.set(state.fadeT); state.fadeDirty = true; } else state.fadeBusy = true;
    state.dirty = true; loop();
  }

  function renderLegend() {
    legendBox.textContent = '';
    if (!state.data) return;
    const T = state.theme || readTheme();
    legendBox.appendChild(el('div', 'hwx-graph-h', L10N('Node types', 'Tipos de nó')));
    const counts = {}; state.data.nodes.forEach(n => { counts[n.type] = (counts[n.type] || 0) + 1; });
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(t => {
      const row = el('label', 'hwx-graph-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !state.hiddenTypes.has(t);
      cb.addEventListener('change', () => { cb.checked ? state.hiddenTypes.delete(t) : state.hiddenTypes.add(t); onFiltersChanged(); });
      const sw = el('span', 'hwx-graph-sw'); sw.style.background = state.colorBy === 'comm' ? T.muted : 'rgb(' + nodeRGB({ type: t, comm: 0 }, Object.assign({}, T, { dark: T.dark })).join(',') + ')';
      row.append(cb, sw, el('span', 'hwx-graph-rl', TYPE_LABEL[t] || t), el('span', 'hwx-graph-rc', String(counts[t])));
      legendBox.appendChild(row);
    });
    const orow = el('label', 'hwx-graph-row');
    const ocb = el('input'); ocb.type = 'checkbox'; ocb.checked = state.showOrphans;
    ocb.addEventListener('change', () => { state.showOrphans = ocb.checked; onFiltersChanged(); });
    orow.append(ocb, el('span', 'hwx-graph-rl', L10N('Show orphan files', 'Mostrar arquivos órfãos')), el('span', 'hwx-graph-rc', String(state.data.nodes.filter(n => n.type === 'file' && !(n.attrs.sd > 0)).length)));
    legendBox.appendChild(orow);
    legendBox.appendChild(el('div', 'hwx-graph-h', L10N('Edge types', 'Tipos de aresta')));
    const kc = {}; state.data.edges.forEach(e => { kc[e.kind] = (kc[e.kind] || 0) + 1; });
    Object.keys(kc).sort((a, b) => kc[b] - kc[a]).forEach(k => {
      const row = el('label', 'hwx-graph-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !state.hiddenKinds.has(k);
      cb.addEventListener('change', () => { cb.checked ? state.hiddenKinds.delete(k) : state.hiddenKinds.add(k); onFiltersChanged(); });
      row.append(cb, el('span', 'hwx-graph-rl', KIND_LABEL[k] || k), el('span', 'hwx-graph-rc', String(kc[k])));
      legendBox.appendChild(row);
    });
    renderKey();
  }
  // tiny always-visible colour key (top types among the visible nodes) — the full legend/filters live in the popover
  function renderKey() {
    keyBox.textContent = '';
    if (!state.data || state.colorBy === 'comm') return;
    const T = state.theme || readTheme(), c = {};
    state.data.nodes.forEach(n => { if (state.vis[n.i]) c[n.type] = (c[n.type] || 0) + 1; });
    Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 6).forEach(t => {
      const it = el('span', 'hwx-graph-keyitem'), sw = el('span', 'hwx-graph-sw');
      sw.style.background = 'rgb(' + nodeRGB({ type: t, comm: 0 }, T).join(',') + ')';
      it.append(sw, el('span', null, TYPE_LABEL[t] || t)); keyBox.appendChild(it);
    });
  }

  function recolor() {
    if (!state.data) return;
    const T = state.theme || readTheme(), nodes = state.data.nodes, N = state.N, col = new Uint8Array(4 * N), ci = new Uint16Array(N), pal = [], map = new Map();
    for (let i = 0; i < N; i++) {
      const rgb = nodeRGB(nodes[i], T), key = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
      let id = map.get(key); if (id == null) { id = pal.length; pal.push(key); map.set(key, id); }
      ci[i] = id; col[4 * i] = rgb[0]; col[4 * i + 1] = rgb[1]; col[4 * i + 2] = rgb[2]; col[4 * i + 3] = 255;
    }
    state.col = col; state.colIdx = ci; state.pal = pal; state.auraDirty = true;
    if (renderer) renderer.setColors(state.order, col, ci, pal);
    state.dirty = true;
  }

  // ── simulation lifecycle ───────────────────────────────────────────────────
  function startSim(opts) {   // opts: { pos?, asleep? }
    const d = state.data, cfg = simConfig(d.nodes, d.edges, { seed: cfgGet('layout_seed', 12345) });
    state.repBase = cfg.opts.repulsion;
    if (opts && opts.pos) cfg.pos = opts.pos;
    if (opts && opts.asleep) cfg.asleep = true;
    const mask = Uint8Array.from(state.vis), hooks = { lmask: linkMask(), onFrame: loop, onFail: () => switchToMain() };
    let sim = null;
    if (typeof Worker === 'function' && typeof Blob === 'function' && cfgGet('physics_backend', window.__hwxGraphBackend || 'worker') !== 'main') {
      try { sim = makeWorkerSim(cfg, mask, hooks); } catch (e) { console.warn('[' + EXT + '] worker unavailable (' + (e && e.message) + '); physics on main thread'); sim = null; }
    }
    if (!sim) sim = makeLocalSim(cfg, mask, hooks);
    // the order matters: the old sim (if any) was destroyed by the caller
    state.sim = sim; state.simGot = false;
  }
  function switchToMain() {
    if (!state.data || !state.sim || state.sim.kind !== 'worker') return;
    console.warn('[' + EXT + '] physics worker failed; continuing on the main thread');
    state.sim.destroy();
    const d = state.data, cfg = simConfig(d.nodes, d.edges, { seed: cfgGet('layout_seed', 12345) });
    if (state.simGot) cfg.pos = Float32Array.from(state.pos);
    state.sim = makeLocalSim(cfg, Uint8Array.from(state.vis), { lmask: linkMask() }); loop();
  }
  function stopSim() {
    if (state.sim) { const buf = state.sim.poll(); if (buf) state.pos.set(buf); state.sim.destroy(); state.sim = null; }
  }

  function setData(payload) {
    stopSim();
    const d = decode(payload), N = d.nodes.length;
    state.data = d; state.N = N; state.sel = null; state.hover = null; state.held = null; side.hidden = true; state.nb = null; state.focusEdges = null;
    state.pos = new Float32Array(2 * N); state.fade = new Float32Array(N); state.fadeT = new Float32Array(N); state.vis = new Uint8Array(N);
    state.rad = Float32Array.from(d.nodes, n => n.r);
    state.glow = Float32Array.from(d.nodes, n => Math.min(1, Math.max(0, (n.deg - 6) / 40) + (n.type === 'memory' || n.type === 'skill' ? 0.3 : 0)));
    state.order = Int32Array.from({ length: N }, (_, i) => i).sort((a, b) => state.rad[a] - state.rad[b] || a - b);
    const dense = new Map(); d.nodes.forEach(n => { if (!dense.has(n.comm)) dense.set(n.comm, dense.size); n.ci = dense.get(n.comm); });
    state.nComm = dense.size; state.commTop = new Int32Array(dense.size).fill(-1);
    d.nodes.forEach(n => { const t = state.commTop[n.ci]; if (t < 0 || d.nodes[t].deg < n.deg) state.commTop[n.ci] = n.i; });
    computeVis(); state.fade.set(state.vis); state.fadeT.set(state.vis);
    readTheme(); recolor(); rebuildEdges();
    if (renderer) renderer.setNodes(N, state.order, state.rad, state.glow);
    pushRendererData();
    renderLegend();
    state.view = { k: 1, x: 0, y: 0 }; state.autoFit = true; state.anim = null; state.finalFit = false; state.firstFrame = true; state.lastFit = 0;
    startSim();
    const s = d.stats || {};
    statusEl.textContent = L10N(d.nodes.length + ' nodes · ' + d.edges.length + ' edges', d.nodes.length + ' nós · ' + d.edges.length + ' arestas') + (d.truncated ? L10N(' (truncated)', ' (truncado)') : '') + (s.elapsed_s ? L10N(' · index ', ' · índice ') + s.elapsed_s + 's' : '');
    statusEl.title = statusEl.textContent;
    loop();
  }
  // closing the overlay frees the worker; reopening rebuilds it asleep at the last positions (no re-layout)
  function resumeSim() { if (state.data && !state.sim) startSim({ pos: Float32Array.from(state.pos), asleep: true }); }

  // ── frame loop (stops completely when nothing moves) ───────────────────────
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  function loop() {
    if (state.raf || !state.open) return;
    state.raf = requestAnimationFrame(frame);
  }
  function frame(ts) {
    try { frameBody(ts); } catch (e) { state.raf = 0; if (!warned) { warned = true; console.warn('[' + EXT + '] frame error:', e && e.message); } }
  }
  function frameBody(ts) {
    state.raf = -1;   // sentinel: loop() calls made while we run (fit, select, …) must not start a second rAF chain (every vsync would draw twice)
    if (!state.open || !state.data || !renderer) { state.raf = 0; return; }
    const now = ts || performance.now();
    let again = false;
    const sim = state.sim;
    if (sim) {
      if (sim.step) sim.step(now);
      const buf = sim.poll();
      if (buf) { state.pos.set(buf); sim.recycle(buf); state.posDirty = state.dirty = true; state.simGot = true; state.auraDirty = true; if (state.firstFrame) { state.firstFrame = false; fit({ animate: false }); } }
      if (sim.busy()) again = true;
    }
    if (state.held) {
      const h = state.held; state.pos[2 * h.i] = h.x; state.pos[2 * h.i + 1] = h.y; state.posDirty = state.dirty = true; again = true;   // the held node sticks to the finger with zero latency
      if (h.dirty && sim) { h.dirty = false; sim.cmd({ t: 'move', x: h.x, y: h.y }); }
    }
    if (state.anim) {
      const a = state.anim, t = Math.min(1, (now - a.t0) / a.dur), e = easeOut(t);
      state.view.k = a.k0 * Math.pow(a.k1 / a.k0, e); state.view.x = a.x0 + (a.x1 - a.x0) * e; state.view.y = a.y0 + (a.y1 - a.y0) * e;
      state.dirty = true; if (t >= 1) state.anim = null; else again = true;
    }
    if (state.fadeBusy) {
      let busy = false; const f = state.fade, ft = state.fadeT;
      for (let i = 0, N = state.N; i < N; i++) { const d = ft[i] - f[i]; if (d > 0.008 || d < -0.008) { f[i] += d * 0.28; busy = true; } else f[i] = ft[i]; }
      state.fadeDirty = state.dirty = true; state.fadeBusy = busy; if (busy) again = true;
    }
    // camera follows the layout while it forms (until the user touches the view), then settles on the final framing
    if (state.autoFit && sim && !state.drag && !state.pinch && !state.anim) {
      if (sim.awake && now - state.lastFit > 500) { fit({ animate: true, dur: 700 }); state.lastFit = now; state.finalFit = false; }
      else if (!sim.awake && !state.finalFit) { fit({ animate: true, dur: 600 }); state.finalFit = true; state.autoFit = false; }
    }
    if (now < state.pulseUntil) { state.dirty = true; again = true; }
    if (statusEl) { const live = !!(sim && sim.awake); if (live !== state.live) { state.live = live; led.classList.toggle('hwx-live', live); } }
    if (state.dirty) { draw(now); state.dirty = false; }
    state.raf = again || state.fadeBusy ? requestAnimationFrame(frame) : 0;
  }

  // community auras: centroid + rms radius over visible members (recomputed only when positions/filters changed)
  function computeAuras() {
    if (!state.auraDirty && state.auras) return;
    const C = state.nComm, nodes = state.data.nodes, N = state.N, pos = state.pos, vis = state.vis;
    const sx = new Float64Array(C), sy = new Float64Array(C), cnt = new Int32Array(C), s2 = new Float64Array(C);
    for (let i = 0; i < N; i++) if (vis[i]) { const c = nodes[i].ci; sx[c] += pos[2 * i]; sy[c] += pos[2 * i + 1]; cnt[c]++; }
    for (let i = 0; i < N; i++) if (vis[i]) { const c = nodes[i].ci, dx = pos[2 * i] - sx[c] / cnt[c], dy = pos[2 * i + 1] - sy[c] / cnt[c]; s2[c] += dx * dx + dy * dy; }
    const out = [], T = state.theme;
    for (let c = 0; c < C; c++) {
      if (cnt[c] < 5) continue;
      out.push({ c, cx: sx[c] / cnt[c], cy: sy[c] / cnt[c], r: Math.min(3000, Math.sqrt(s2[c] / cnt[c]) * 1.7 + 14), n: cnt[c] });
    }
    out.sort((a, b) => b.n - a.n); if (out.length > 40) out.length = 40;   // the 40 biggest communities: auras are fill-rate bound, small ones add noise not information
    state.auraList = out; state.commCount = cnt; state.auraDirty = false;
    state.auras = new Float32Array(Math.max(1, out.length) * 8);
    void T;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  function draw(now) {
    const T = state.theme || readTheme(), v = state.view, k = v.k, focus = state.sel || state.hover, tA = performance.now();
    computeAuras();
    const A = state.auraList, buf = state.auras, boost = 1 + Math.max(0, Math.min(1, (0.7 - k) / 0.7)) * 0.9, base = (T.dark ? 0.16 : 0.12) * boost * (focus ? 0.5 : 1);
    for (let j = 0; j < A.length; j++) {
      const a = A[j], rgb = commRgbOf(a.c, T.dark), o = j * 8;
      buf[o] = a.cx; buf[o + 1] = a.cy; buf[o + 2] = a.r; buf[o + 3] = 0; buf[o + 4] = rgb[0] / 255; buf[o + 5] = rgb[1] / 255; buf[o + 6] = rgb[2] / 255; buf[o + 7] = base;
    }
    const moving = !!((state.drag && !state.drag.node) || state.pinch || state.anim || (state.N > 3000 && state.sim && state.sim.awake));
    const simAwake = !!(state.sim && state.sim.awake), fc = { busy: simAwake || !!state.anim || !!state.pinch || !!(state.drag && !state.drag.node), fast: state.N > 3000 && (moving || state.fadeBusy), W: state.W, H: state.H, dpr: state.dpr, k, vx: v.x, vy: v.y, pos: state.pos, fade: state.fade, posDirty: state.posDirty, fadeDirty: state.fadeDirty, time: now,
      dim: focus ? 0.3 : 1, edgeMul: lerp(0.55, 1, Math.max(0, Math.min(1, k / 0.9))), theme: T, auras: buf, nAuras: state.dbg.noAuras ? 0 : A.length, minPx: MIN_PX, moving };
    if (state.dbg.noEdges) fc.edgeMul = 0;
    fc.noNodes = !!state.dbg.noNodes;
    const t0 = performance.now();
    try { renderer.draw(fc); } catch (e) { if (!warned) { warned = true; console.warn('[' + EXT + '] render error:', e && e.message); } }
    const t1 = performance.now();
    state.posDirty = state.fadeDirty = false;
    try { drawOverlay(fc, now); } catch (e) { if (!warned) { warned = true; console.warn('[' + EXT + '] overlay error:', e && e.message); } }
    const t2 = performance.now();
    paintBackdrop(v);
    const P = state.prof; P.n++; P.render += t1 - t0; P.overlay += t2 - t1; P.aura += t0 - tA;
  }
  let lastBg = '', gridEl = null;
  // Dot grid = a pre-rendered tile on its own layer that is only TRANSLATED/SCALED (compositor-only). Animating `background-position`
  // instead repaints the whole stage every frame (measured: 49 → 60 fps on the software rasteriser when removed).
  function makeGridTile() {
    if (!gridEl) return;
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 96; const g = cv.getContext('2d'), c = (state.theme || readTheme()).textRgb;
      g.fillStyle = 'rgba(' + c.join(',') + ',' + (state.theme.dark ? 0.2 : 0.16) + ')'; g.beginPath(); g.arc(48, 48, 2.1, 0, 6.2832); g.fill();
      gridEl.style.backgroundImage = 'url(' + cv.toDataURL('image/png') + ')';
    } catch (_) { /* canvas stubbed or blocked: plain background, no grid */ }
  }
  function paintBackdrop(v) {
    if (!gridEl) return;
    let sp = 48 * v.k; if (!(sp > 0)) return;
    while (sp < 28) sp *= 2; while (sp >= 56) sp /= 2;
    const ox = state.W / 2 + v.x, oy = state.H / 2 + v.y, m = (a) => ((a % sp) + sp) % sp;
    const key = sp.toFixed(2) + '|' + ox.toFixed(1) + '|' + oy.toFixed(1); if (key === lastBg) return; lastBg = key;
    gridEl.style.transform = 'translate3d(' + (m(ox - sp / 2) - sp).toFixed(1) + 'px,' + (m(oy - sp / 2) - sp).toFixed(1) + 'px,0) scale(' + (sp / 48).toFixed(4) + ')';
  }

  // ── overlay: community names, hover/selection halos, node labels with collision avoidance ──
  const rectHit = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  function drawOverlay(fc, now) {
    const c = uctx; if (!c) return;
    const dpr = state.dpr, T = fc.theme, k = fc.k, ox = fc.W / 2 + fc.vx, oy = fc.H / 2 + fc.vy, d = state.data, pos = state.pos, rad = state.rad, fade = state.fade;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const placed = [], text = (s, x, y, alpha, font, color) => {
      c.font = font; let w = 0; try { w = c.measureText(s).width || s.length * 6; } catch (_) { w = s.length * 6; }
      const r = [x - 2, y - 9, w + 4, 18];
      for (let i = 0; i < placed.length; i++) if (rectHit(r, placed[i])) return false;
      placed.push(r); c.globalAlpha = alpha; c.lineWidth = 3; c.strokeStyle = 'rgba(' + T.bgRgb.join(',') + ',0.85)'; c.strokeText(s, x, y); c.fillStyle = color; c.fillText(s, x, y); c.globalAlpha = 1; return true;
    };
    c.textBaseline = 'middle'; c.lineJoin = 'round';
    const focus = state.sel || state.hover, mk = (n) => ({ x: ox + pos[2 * n.i] * k, y: oy + pos[2 * n.i + 1] * k, r: Math.max(rad[n.i] * k, MIN_PX) });
    // 1. community names while zoomed out (fade out as the nodes become legible)
    const la = Math.max(0, Math.min(1, (0.8 - k) / 0.3));
    if (la > 0.02 && state.auraList) {
      const top = state.auraList.slice().sort((a, b) => b.n - a.n).slice(0, mqPhone.matches ? 7 : 12);
      for (const a of top) {
        if (a.n < 8 || state.commTop[a.c] < 0) continue;
        const tn = d.nodes[state.commTop[a.c]], s = clip(tn.label, 20), x = ox + a.cx * k, y = oy + a.cy * k;
        if (x < 0 || y < 0 || x > fc.W || y > fc.H) continue;
        let w = 0; try { c.font = '600 11px system-ui, sans-serif'; w = c.measureText(s).width || 0; } catch (_) { w = 0; }
        text(s, Math.max(4, Math.min(fc.W - w - 4, x - w / 2)), y - a.r * k * 0.45, 0.8 * la * (focus ? 0.4 : 1), '600 11px system-ui, sans-serif', 'rgb(' + T.textRgb.join(',') + ')');
      }
    }
    // 2. halos: hovered (soft elevation) and selected (pulse then steady ring) — drawn as full discs above the GPU layer
    const disc = (n, scale, ring) => {
      const p = mk(n), r = p.r * scale, col = state.col, ac = T.accentRgb;
      const g = c.createRadialGradient(p.x, p.y, r * 0.6, p.x, p.y, r * 3.2); g.addColorStop(0, 'rgba(' + ac.join(',') + ',0.30)'); g.addColorStop(1, 'rgba(' + ac.join(',') + ',0)');
      c.fillStyle = g; c.beginPath(); c.arc(p.x, p.y, r * 3.2, 0, 6.2832); c.fill();
      c.fillStyle = 'rgb(' + col[4 * n.i] + ',' + col[4 * n.i + 1] + ',' + col[4 * n.i + 2] + ')'; c.beginPath(); c.arc(p.x, p.y, r, 0, 6.2832); c.fill();
      c.lineWidth = ring; c.strokeStyle = 'rgb(' + ac.join(',') + ')'; c.beginPath(); c.arc(p.x, p.y, r + 2.5, 0, 6.2832); c.stroke();
      return p;
    };
    if (state.hover && state.hover !== state.sel && fade[state.hover.i] > 0.3) disc(state.hover, 1.18, 1.5);
    if (state.sel && fade[state.sel.i] > 0.3) {
      const p = disc(state.sel, 1.1, 2.2), t = (now - state.pulseT0) / 1700;
      if (t >= 0 && t < 1 && !reduced()) {
        for (let w = 0; w < 2; w++) { const u = (t * 2 - w * 0.5); if (u < 0 || u > 1) continue; c.globalAlpha = (1 - u) * 0.7; c.lineWidth = 2; c.strokeStyle = 'rgb(' + T.accentRgb.join(',') + ')'; c.beginPath(); c.arc(p.x, p.y, p.r + 4 + 26 * easeOut(u), 0, 6.2832); c.stroke(); }
        c.globalAlpha = 1;
      }
    }
    // 3. node labels: selected / hovered / neighbours / search hits / the biggest nodes — greedy placement, no overlaps
    const cand = [], nb = state.nb, searching = !!state.query, ink = 'rgb(' + T.textRgb.join(',') + ')';
    const F = '11px system-ui, sans-serif', FB = '600 12px system-ui, sans-serif';
    const nodes = d.nodes, N = state.N;
    for (let i = 0; i < N; i++) {
      if (!state.vis[i] || fade[i] < 0.3) continue;
      const n = nodes[i], special = n === state.sel || n === state.hover, hit = searching && matches(n), near = nb && nb[i] && k > 0.35;
      const rpx = Math.max(rad[i] * k, MIN_PX);
      if (!(special || hit || near || (rpx >= LABEL_PX && !fc.busy))) continue;   // while things move, only the focused/matching labels are drawn (text raster is the costliest overlay op)
      const x = ox + pos[2 * i] * k, y = oy + pos[2 * i + 1] * k;
      if (x < -40 || y < -20 || x > fc.W + 40 || y > fc.H + 20) continue;
      cand.push({ n, x, y, r: rpx, p: special ? 1e6 : hit ? 1e5 + n.deg : near ? 1e4 + n.deg : n.deg + rpx });
    }
    cand.sort((a, b) => b.p - a.p);
    for (let j = 0, shown = 0; j < cand.length && shown < 90; j++) {
      const q = cand[j], big = q.p >= 1e4;
      if (text(clip(q.n.label, big ? 40 : 26), q.x + q.r + 5, q.y, big ? 1 : Math.min(1, fade[q.n.i]), big ? FB : F, ink)) shown++;
    }
  }

  // ── view ───────────────────────────────────────────────────────────────────
  function animateView(to, dur) {
    const v = state.view;
    if (reduced() || dur === 0) { state.view = { k: to.k, x: to.x, y: to.y }; state.anim = null; state.dirty = true; loop(); return; }
    state.anim = { t0: performance.now(), dur: dur || 520, k0: v.k, x0: v.x, y0: v.y, k1: to.k, x1: to.x, y1: to.y }; loop();
  }
  // Fit: robust bounding box (1.5%…98.5% — a few flung-out stragglers must not shrink the whole graph) with a legibility floor:
  // never zoom out below the k at which the median node is MIN_LEGIBLE px wide; if that cuts nodes off, centre on the median instead.
  function fit(o) {
    o = o || {};
    if (!state.data || !state.N || !state.W) return;
    if (o.user) { state.autoFit = false; }
    const xs = [], ys = [], rs = [];
    for (let i = 0; i < state.N; i++) if (state.vis[i]) { xs.push(state.pos[2 * i]); ys.push(state.pos[2 * i + 1]); rs.push(state.rad[i]); }
    if (!xs.length) return;
    const n = xs.length, srt = (a) => Float64Array.from(a).sort(), sx = srt(xs), sy = srt(ys), sr = srt(rs);
    const lo = n > 60 ? Math.floor(n * 0.015) : 0, hi = n > 60 ? Math.ceil(n * 0.985) - 1 : n - 1;
    const med = sr[n >> 1], x0 = sx[lo] - med, x1 = sx[hi] + med, y0 = sy[lo] - med, y1 = sy[hi] + med;
    const pad = mqPhone.matches ? 20 : 48, W = state.W, H = state.H;
    let k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0), 3);
    const floor = o.all ? K_MIN : Math.max(0.12, Math.min(1, 3 / med)), floored = k < floor;
    k = Math.max(K_MIN, Math.min(K_MAX, Math.max(k, floor)));
    const cx = floored ? sx[n >> 1] : (x0 + x1) / 2, cy = floored ? sy[n >> 1] : (y0 + y1) / 2;
    state.fitInfo = { k, floored, kFit: Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0)), floor };
    animateView({ k, x: -cx * k, y: -cy * k }, o.animate === false ? 0 : (o.dur || 520));
  }

  // ── interaction ────────────────────────────────────────────────────────────
  function toWorld(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - r.width / 2 - state.view.x) / state.view.k, y: (ev.clientY - r.top - r.height / 2 - state.view.y) / state.view.k };
  }
  function pick(ev) {
    if (!state.data) return null;
    const p = toWorld(ev), k = state.view.k, slop = (ev.pointerType === 'touch' ? 14 : 4) / k;   // a fingertip is ~10× coarser than a cursor
    let best = null, bd = Infinity;
    const pos = state.pos, rad = state.rad, vis = state.vis, fade = state.fade, minW = MIN_PX / k;
    for (let i = 0, N = state.N; i < N; i++) {
      if (!vis[i] || fade[i] < 0.02) continue;   // dimmed nodes stay pickable (clicking one re-focuses); only hidden ones are skipped
      const dx = pos[2 * i] - p.x, dy = pos[2 * i + 1] - p.y, d2 = dx * dx + dy * dy, r = Math.max(rad[i], minW) + slop;
      if (d2 < r * r && d2 < bd) { best = state.data.nodes[i]; bd = d2; }
    }
    return best;
  }
  const clampK = (k) => Math.max(K_MIN, Math.min(K_MAX, k));   // shared by wheel and pinch
  function userView() { state.autoFit = false; state.anim = null; }
  function zoomAt(cx, cy, k0) {
    userView();
    const r = canvas.getBoundingClientRect(), k = clampK(k0);
    const mx = cx - r.left - r.width / 2, my = cy - r.top - r.height / 2;
    state.view.x = mx - (mx - state.view.x) * (k / state.view.k); state.view.y = my - (my - state.view.y) * (k / state.view.k);
    state.view.k = k; state.dirty = true; loop();
  }
  // Two-finger gesture: the world point that was under the fingers' midpoint stays under it (zoom + two-finger pan).
  const twoPtrs = () => { const it = ptrs.values(); return [it.next().value, it.next().value]; };
  function releaseHeld(dr) { dr = dr || state.drag; if (dr && dr.grabbed && state.sim) state.sim.cmd({ t: 'release' }); if (state.held) state.held = null; if (dr) dr.grabbed = false; }
  function startPinch() {
    const [a, b] = twoPtrs();
    releaseHeld(); userView();
    state.drag = null; state.hover = null; hideTip();
    const r = canvas.getBoundingClientRect(), k = state.view.k;
    const mx = (a.x + b.x) / 2 - r.left - r.width / 2, my = (a.y + b.y) / 2 - r.top - r.height / 2;
    state.pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k0: k, wx: (mx - state.view.x) / k, wy: (my - state.view.y) / k };
  }
  function updatePinch() {
    const [a, b] = twoPtrs(), p = state.pinch, r = canvas.getBoundingClientRect();
    const k = clampK(p.k0 * Math.hypot(a.x - b.x, a.y - b.y) / p.d0);
    const mx = (a.x + b.x) / 2 - r.left - r.width / 2, my = (a.y + b.y) / 2 - r.top - r.height / 2;
    state.view.k = k; state.view.x = mx - p.wx * k; state.view.y = my - p.wy * k;
    state.dirty = true; loop();
  }
  function setHover(h) {
    if (h === state.hover) return;
    state.hover = h; canvas.style.cursor = h ? 'pointer' : 'default'; refocus();
  }
  function endPointer(ev, cancelled) {
    if (!ptrs.delete(ev.pointerId)) return;
    if (state.pinch) {
      if (ptrs.size >= 2) startPinch();   // a third finger lifted: re-anchor on the remaining pair
      else {
        state.pinch = null;
        if (ptrs.size === 1) { const p = ptrs.values().next().value; state.drag = { node: null, sx: p.x, sy: p.y, vx: state.view.x, vy: state.view.y, moved: true }; }   // remaining finger keeps panning, never taps
      }
      loop(); return;
    }
    const dr = state.drag; state.drag = null;
    if (dr && dr.grabbed) { releaseHeld(dr); }   // let go: the node keeps the gesture's velocity and glides on (inertia), neighbours settle around it
    if (dr && !dr.moved && !cancelled) {
      const now = performance.now();
      if (ev.pointerType === 'touch' && dr.node && tapPrev && tapPrev.node === dr.node && now - tapPrev.t < 350) {
        tapPrev = null; lastEgoAt = now; loadEgo(dr.node);   // double-tap → ego graph
      } else {
        tapPrev = ev.pointerType === 'touch' && dr.node ? { node: dr.node, t: now } : null;
        select(dr.node);
      }
    }
    loop();
  }
  function bindCanvas() {
    canvas.addEventListener('pointerdown', (ev) => {
      state.lastPT = ev.pointerType;
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* pointer already gone */ }
      if (ev.pointerType === 'mouse') ptrs.clear();   // a mouse is always a single pointer; drop any entry left by a lost pointerup
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ptrs.size >= 2) { if (!state.pinch) startPinch(); loop(); return; }
      const n = pick(ev);
      state.drag = { node: n, sx: ev.clientX, sy: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false, grabbed: false };
      if (ev.pointerType === 'touch') { state.hover = null; hideTip(); }
      loop();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.pinch) { if (ptrs.size >= 2) updatePinch(); return; }
      const dr = state.drag, touch = ev.pointerType === 'touch';
      if (dr) {
        if (Math.abs(ev.clientX - dr.sx) + Math.abs(ev.clientY - dr.sy) > (touch ? 10 : 3)) dr.moved = true;   // finger jitter must not swallow a tap
        if (dr.moved) {
          if (dr.node) {
            const p = toWorld(ev);
            if (!dr.grabbed && state.sim) {   // first real movement: pick the node up (a plain tap never touches the physics)
              const i = dr.node.i; dr.off = { x: state.pos[2 * i] - p.x, y: state.pos[2 * i + 1] - p.y }; dr.grabbed = true; hideTip();
              state.held = { i, x: state.pos[2 * i], y: state.pos[2 * i + 1], dirty: false };
              state.sim.cmd({ t: 'grab', i, x: state.held.x, y: state.held.y });
            }
            if (state.held) { state.held.x = p.x + dr.off.x; state.held.y = p.y + dr.off.y; state.held.dirty = true; }
          } else { userView(); state.view.x = dr.vx + ev.clientX - dr.sx; state.view.y = dr.vy + ev.clientY - dr.sy; }
        }
        state.dirty = true; loop(); return;
      }
      if (touch) return;   // no hover (and no sticky tooltip) on touch
      const h = pick(ev);
      if (h !== state.hover) { setHover(h); showTip(h, ev); }
      else if (h) showTip(h, ev);
    });
    canvas.addEventListener('pointerup', (ev) => endPointer(ev, false));
    canvas.addEventListener('pointercancel', (ev) => endPointer(ev, true));
    canvas.addEventListener('dblclick', (ev) => { if (performance.now() - lastEgoAt < 600) return; const n = pick(ev); if (n) loadEgo(n); });
    canvas.addEventListener('contextmenu', (ev) => { if (state.lastPT === 'touch') ev.preventDefault(); });   // long-press must not pop a menu mid-gesture
    canvas.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'touch') return; if (state.hover) setHover(null); hideTip(); });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      zoomAt(ev.clientX, ev.clientY, state.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
    canvas.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') select(null); });
    // The core opens the phone drawer on a rightward touch-drag that starts within 80px of the left edge
    // (boot.js _onPwaSidebarSwipeStart, window-level capture). Over the canvas that drag is a pan, so cancel the
    // core's pending swipe state once the touch reaches us. Guarded: only touches an existing core global.
    canvas.addEventListener('touchstart', () => { try { if (typeof _pwaSidebarSwipe !== 'undefined') _pwaSidebarSwipe = null; } catch (_) { /* core internals changed: edge-swipe stays core-owned */ } }, { passive: true });
  }

  let tip;
  function showTip(n, ev) {
    if (!n) { hideTip(); return; }
    if (!tip) { tip = el('div', 'hwx-graph-tip'); stage.appendChild(tip); }
    const r = stage.getBoundingClientRect();
    tip.textContent = (TYPE_LABEL[n.type] || n.type) + ' · ' + n.label.slice(0, 80) + ' · grau ' + n.deg;
    tip.style.left = Math.max(4, Math.min(r.width - 260, ev.clientX - r.left + 12)) + 'px'; tip.style.top = (ev.clientY - r.top + 12) + 'px'; tip.hidden = false;
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function select(n, center) {
    state.sel = n;
    state.pulseT0 = performance.now(); state.pulseUntil = n && !reduced() ? state.pulseT0 + 1700 : 0;
    refocus(); renderSide();
    if (n && center) { state.autoFit = false; const k = state.view.k; animateView({ k, x: -state.pos[2 * n.i] * k, y: -state.pos[2 * n.i + 1] * k }, 480); }
    state.dirty = true; loop();
  }

  function renderSide() {
    const n = state.sel; side.textContent = '';
    if (!n) { side.hidden = true; return; }
    side.hidden = false;
    const head = el('div', 'hwx-graph-sh');
    const sw = el('span', 'hwx-graph-sw'); sw.style.background = 'rgb(' + state.col[4 * n.i] + ',' + state.col[4 * n.i + 1] + ',' + state.col[4 * n.i + 2] + ')';
    const sideClose = el('button', 'hwx-graph-btn hwx-graph-side-close'); sideClose.type = 'button'; sideClose.setAttribute('aria-label', L10N('Close details', 'Fechar detalhes')); sideClose.appendChild(ICONS.close());   // phone bottom-sheet only (hidden by CSS elsewhere)
    sideClose.addEventListener('click', () => select(null));
    head.append(sw, el('span', 'hwx-graph-sht', TYPE_LABEL[n.type] || n.type), sideClose);
    side.appendChild(head);
    side.appendChild(el('div', 'hwx-graph-name', n.label));
    const meta = [];
    if (n.path) meta.push(['caminho', (n.root ? n.root + ':' : '') + n.path]);
    if (n.size) meta.push(['tamanho', fmtSize(n.size)]);
    if (n.mtime) meta.push(['modificado', new Date(n.mtime * 1000).toLocaleString()]);
    meta.push(['grau', String(n.deg)], ['comunidade', '#' + n.comm]);
    ['desc', 'schedule', 'model', 'ekind', 'dups'].forEach(k => { if (n.attrs[k]) meta.push([k, String(n.attrs[k])]); });
    if (n.attrs.missing) meta.push(['obs', L10N('referenced name; file missing or ignored', 'nome referenciado, arquivo não existe/foi ignorado')]);
    meta.forEach(([k, v]) => { const r = el('div', 'hwx-graph-meta'); r.append(el('span', 'hwx-graph-mk', k), el('span', 'hwx-graph-mv', v)); side.appendChild(r); });
    const actions = el('div', 'hwx-graph-actions');
    const ego = el('button', 'hwx-graph-btn', 'Ego (2 hops)'); ego.type = 'button'; ego.addEventListener('click', () => loadEgo(n)); actions.appendChild(ego);
    if (n.type === 'file' && n.root === 'ws' && typeof window.openFile === 'function') {
      const ob = el('button', 'hwx-graph-btn', L10N('Open in workspace', 'Abrir no workspace')); ob.type = 'button';
      ob.addEventListener('click', () => { try { window.openFile(n.path); } catch (_) { /* needs an active session on this workspace */ } });
      actions.appendChild(ob);
    }
    side.appendChild(actions);
    // neighbours grouped by edge kind, with evidence line
    const groups = {};
    state.data.adj[n.i].forEach(k => { const e = state.data.edges[k]; (groups[e.kind] = groups[e.kind] || []).push(e); });
    Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length).forEach(kind => {
      side.appendChild(el('div', 'hwx-graph-h', (KIND_LABEL[kind] || kind) + ' (' + groups[kind].length + ')'));
      groups[kind].sort((a, b) => b.w - a.w).slice(0, 12).forEach(e => {
        const o = e.sn === n ? e.tn : e.sn;
        const row = el('button', 'hwx-graph-nb'); row.type = 'button';
        row.append(el('span', null, o.label.slice(0, 44)), el('span', 'hwx-graph-ln', (e.line ? 'L' + e.line + ' · ' : '') + e.w.toFixed(2)));
        row.addEventListener('click', () => select(o, true));
        side.appendChild(row);
      });
    });
  }

  // ── open / close / entry point ─────────────────────────────────────────────
  function open() {
    if (!overlay) build();
    overlay.hidden = false; state.open = true;
    const btn = document.getElementById('hwx-graph-rail'); if (btn) btn.classList.add('active');
    readTheme(); resize();
    if (!state.data) load(cfgGet('default_roots', 'ws'));
    else { resumeSim(); recolor(); state.dirty = state.posDirty = state.fadeDirty = true; loop(); }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onNavClick, true);
  }
  function close() {
    if (!overlay) return;
    releaseHeld(); overlay.hidden = true; state.open = false;
    toggleSheet(false); toggleSearch(false); ptrs.clear(); state.pinch = null; state.drag = null; tapPrev = null; hideTip();
    stopSim();   // free the worker; reopening restores the same positions asleep
    document.removeEventListener('click', onNavClick, true);
    const btn = document.getElementById('hwx-graph-rail'); if (btn) btn.classList.remove('active');
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(state.pollTimer);
  }
  function onKey(ev) {
    const t = ev.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); toggleSearch(true); return; }
    if (ev.key !== 'Escape' || document.activeElement === searchIn) return;
    if (sheet.classList.contains('hwx-open')) toggleSheet(false); else close();
  }
  // Phone: picking another destination in the core drawer (Chat, Tasks, a conversation…) must not leave the graph
  // painted over it. The graph's own mirrored entry is a toggle handled by its own click handler.
  function onNavClick(ev) {
    if (!mqPhone.matches || !ev.target || !ev.target.closest) return;
    const t = ev.target.closest('.sidebar-nav .nav-tab, .sidebar .session-item');
    if (t && !t.closest('[data-nav-action-mirror="hwx-graph-rail"]')) close();
  }

  function railButton() {
    if (document.getElementById('hwx-graph-rail')) return true;
    const rail = document.querySelector('.rail');
    if (!rail) return false;
    const btn = el('button', 'rail-btn nav-tab has-tooltip hwx-graph-rail'); btn.id = 'hwx-graph-rail'; btn.type = 'button';
    btn.dataset.tooltip = 'Graph'; btn.setAttribute('aria-label', L10N('Graph — files and memory', 'Graph — arquivos e memória'));
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8 7l8 1M7.5 8l1 8M16.5 10l-6 6.5"/></svg>';   // static markup, no data interpolated
    btn.addEventListener('click', (ev) => { ev.preventDefault(); state.open ? close() : open(); });
    const spacer = rail.querySelector('.rail-spacer');
    spacer ? rail.insertBefore(btn, spacer) : rail.appendChild(btn);
    return true;
  }

  // independent overlap audit on the main thread (does NOT ask the physics core): pairs of visible nodes closer than ri+rj-tol
  function auditOverlaps(tol) {
    const N = state.N, pos = state.pos, rad = state.rad, vis = state.vis, cell = 48, g = new Map(); let pairs = 0;
    tol = tol == null ? 0.5 : tol;
    for (let i = 0; i < N; i++) if (vis[i]) { const key = Math.floor(pos[2 * i] / cell) * 100003 + Math.floor(pos[2 * i + 1] / cell); const a = g.get(key); a ? a.push(i) : g.set(key, [i]); }
    for (let i = 0; i < N; i++) if (vis[i]) {
      const cx = Math.floor(pos[2 * i] / cell), cy = Math.floor(pos[2 * i + 1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of (g.get((cx + dx) * 100003 + cy + dy) || [])) {
        if (j <= i) continue;
        const d = Math.hypot(pos[2 * i] - pos[2 * j], pos[2 * i + 1] - pos[2 * j + 1]);
        if (d < rad[i] + rad[j] - tol) pairs++;
      }
    }
    return pairs;
  }
  function install(attempt) {
    if (railButton()) { window.HermesGraphExtension = { version: '0.3.0', open, close, debug: {   // read-only snapshot helpers for the browser verification scripts
      snapshot: () => ({ open: state.open, view: Object.assign({}, state.view), sel: state.sel && state.sel.id, egoOf: state.egoOf, hover: !!state.hover, sheet: !!(sheet && sheet.classList.contains('hwx-open')), nodes: state.data ? state.data.nodes.length : 0, visible: state.data ? visibleNodes().length : 0,
        renderer: renderer && renderer.kind, sim: state.sim && { kind: state.sim.kind, awake: state.sim.awake, alpha: state.sim.alpha, tick: state.sim.tick }, raf: !!state.raf, fit: state.fitInfo || null }),
      screenNodes: () => {   // visible nodes (highest degree first) with client coords and drawn radius in px
        const r = canvas.getBoundingClientRect(), k = state.view.k;
        return visibleNodes().sort((a, b) => b.deg - a.deg).map(v => ({ id: v.id, deg: v.deg, r: Math.max(state.rad[v.i] * k, MIN_PX), x: r.left + r.width / 2 + state.view.x + state.pos[2 * v.i] * k, y: r.top + r.height / 2 + state.view.y + state.pos[2 * v.i + 1] * k }));
      },
      nodeAt: (rank) => window.HermesGraphExtension.debug.screenNodes()[rank || 0],
      worldPos: (id) => { const n = state.data && state.data.nodes.find(x => x.id === id); return n ? { x: state.pos[2 * n.i], y: state.pos[2 * n.i + 1], r: state.rad[n.i] } : null; },
      worldNeighbours: (id) => { const n = state.data.nodes.find(x => x.id === id); return n ? Array.from(new Set(state.data.adj[n.i].map(k => { const e = state.data.edges[k]; return (e.s === n.i ? e.t : e.s); }))).filter(j => state.vis[j]).map(j => ({ id: state.data.nodes[j].id, x: state.pos[2 * j], y: state.pos[2 * j + 1] })) : []; },
      audit: auditOverlaps, flags: state.dbg, typeRgb: (t) => nodeRGB({ type: t, comm: 0 }, state.theme || readTheme()), prof: () => { const P = state.prof, o = { frames: P.n, renderMs: P.render / Math.max(1, P.n), overlayMs: P.overlay / Math.max(1, P.n), auraMs: P.aura / Math.max(1, P.n) }; P.n = P.render = P.overlay = P.aura = 0; return o; },
      allPos: () => Array.from(state.pos), indexOf: (id) => (state.data ? state.data.nodes.findIndex(x => x.id === id) : -1),
      physics: () => (state.sim ? state.sim.query() : Promise.resolve(null)),
      fit: (all) => fit({ all: !!all, animate: false, user: true }),
      setView: (v) => { userView(); Object.assign(state.view, v); state.dirty = true; loop(); },
    } }; return; }
    if (attempt < 80) setTimeout(() => install(attempt + 1), 150);
    else console.warn('[' + EXT + '] rail not found; not installed');
  }
  install(0);
})();
