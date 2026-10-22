// node scripts/test-hermes-graph-layout.mjs — physics core v2: determinism, hard collision, constant-magnitude gravity, inertia, push, sleep.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// assets/graph.js is a browser asset: with no `window` it exports its API through
// `module.exports`. The library repo is "type": "module", so a plain `require()`
// would load it as ESM; evaluate it with a CommonJS shim instead (no DOM needed).
const SRC = readFileSync(
  fileURLToPath(new URL('../extensions/hermes-graph/assets/graph.js', import.meta.url)), 'utf8');
const mod = { exports: {} };
new Function('window', 'document', 'module', 'exports', SRC)(undefined, undefined, mod, mod.exports);
const L = mod.exports;
const Core = L.simCoreModule();

// small deterministic community graph (n nodes, ~3n edges)
function graph(n, seed = 5) {
  let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const C = Math.max(3, Math.round(n / 40)), rad = new Float64Array(n), comm = new Int32Array(n), src = [], dst = [], w = [], rest = [], deg = new Int32Array(n);
  for (let i = 0; i < n; i++) { comm[i] = Math.floor(rnd() * C); rad[i] = 4 + Math.floor(rnd() * 6); }
  const add = (a, b) => { if (a !== b) { src.push(a); dst.push(b); w.push(0.3 + rnd() * 0.7); rest.push(rad[a] + rad[b] + 14); deg[a]++; deg[b]++; } };
  for (let i = 1; i < n; i++) { for (let k = 0; k < 2; k++) { const j = Math.floor(rnd() * i); add(i, comm[j] === comm[i] || rnd() < 0.2 ? j : Math.floor(rnd() * i)); } }
  return { n, rad, comm, ncomm: C, src: Int32Array.from(src), dst: Int32Array.from(dst), rest: Float64Array.from(rest), w: Float64Array.from(w) };
}
const run = (core, max = 900) => { let t = 0; while (t < max && core.tick()) t++; return t; };

// 1. deterministic: same seed, same cfg → bit-identical layout
{
  const a = Core.create(graph(300)), b = Core.create(graph(300));
  for (let t = 0; t < 150; t++) { a.tick(); b.tick(); }
  assert.deepEqual(Array.from(a.x), Array.from(b.x)); assert.deepEqual(Array.from(a.y), Array.from(b.y));
  const c = Core.create(Object.assign(graph(300), { opts: { seed: 99 } })); for (let t = 0; t < 150; t++) c.tick();
  assert.notDeepEqual(Array.from(a.x), Array.from(c.x));
}
// 2. settles, sleeps, and ends with ZERO overlapping disks (tolerance 0.5 world units) — 1000 nodes
{
  const core = Core.create(graph(1000)); const ticks = run(core, 1500);
  assert.ok(!core.awake, 'did not go to sleep in 1500 ticks'); assert.ok(ticks < 1500);
  for (let i = 0; i < 1000; i++) assert.ok(Number.isFinite(core.x[i]) && Number.isFinite(core.y[i]));
  assert.equal(core.overlaps(0.5), 0, 'overlapping disks after settle');
  assert.ok(core.maxSpeed < 0.05, 'residual creep ' + core.maxSpeed);
  console.log(`  1000 nodes: asleep after ${ticks} ticks, overlaps=0`);
}
// 3. gravity is constant-magnitude: an isolated node at 300 and at 900 units gets the SAME inward kick (not 3x / 9x)
{
  const mk = (d) => { const c = Core.create({ n: 1, rad: [5], comm: [0], ncomm: 1, src: [], dst: [], rest: [], w: [], pos: Float32Array.from([d, 0]), opts: { repulsion: 0, cohesion: 0, friction: 0 } }); c.tick(); return -c.vx[0]; };
  const k1 = mk(300), k2 = mk(900);
  assert.ok(k1 > 0 && Math.abs(k1 / k2 - 1) < 1e-9, `gravity not constant: ${k1} vs ${k2}`);
  const near = mk(10); assert.ok(near < k1, 'gravity must ease to 0 inside the softening zone (no jitter at the centre)');
}
// 4. inertia + push: grab a node, drag it through a neighbour, release → it keeps gliding and the neighbour got shoved
{
  const n = 2, cfg = { n, rad: [8, 8], comm: [0, 0], ncomm: 1, src: [], dst: [], rest: [], w: [], pos: Float32Array.from([0, 0, 40, 0]), opts: { gravity: 0, repulsion: 0, cohesion: 0 } };
  const c = Core.create(cfg); c.reheat(0.3); for (let t = 0; t < 5; t++) c.tick();
  c.grab(0, c.x[0], c.y[0]);
  for (let t = 0; t < 14; t++) { c.move(c.x[0] + 4, 0); c.tick(); }   // drag right at ~2.4 units/tick towards the other disk
  assert.ok(c.x[1] > 41, 'neighbour was not pushed: x1=' + c.x[1]);
  const xRel = c.x[0], v = c.vx[0]; assert.ok(v > 1, 'held node has no velocity to hand over: ' + v);
  c.release(); const v0 = c.vx[0];
  assert.ok(v0 > v, 'fling gain not applied');
  for (let t = 0; t < 30; t++) c.tick();
  assert.ok(c.x[0] - xRel > 6, 'no glide after release: moved ' + (c.x[0] - xRel));
  for (let t = 0; t < 1500 && c.tick(); t++);
  assert.ok(c.overlaps(0.5) === 0, 'overlap after the shove');
  assert.ok(c.vx[0] === 0, 'must be asleep (zero velocity) at the end');
}
// 5. hidden nodes are inert: they neither collide nor attract
{
  const cfg = { n: 3, rad: [8, 8, 8], comm: [0, 0, 0], ncomm: 1, src: [0], dst: [1], rest: [30], w: [1], pos: Float32Array.from([0, 0, 2, 0, 500, 500]), opts: { gravity: 0, repulsion: 0, cohesion: 0 } };
  const c = Core.create(cfg); c.setActive(Uint8Array.from([1, 0, 1]), null);   // node 1 hidden, sits on top of node 0
  for (let t = 0; t < 30; t++) c.tick();
  assert.equal(c.x[1], 2, 'hidden node moved'); assert.ok(Math.abs(c.x[0]) < 1e-9, 'hidden node pushed a visible one');
  const dist = (k) => Math.hypot(k.x[0] - k.x[1], k.y[0] - k.y[1]);
  const lin = Core.create(cfg); lin.setActive(Uint8Array.from([1, 1, 0]), null); for (let t = 0; t < 800 && lin.tick(); t++);
  assert.ok(Math.abs(dist(lin) - 30) < 1, 'spring should settle at its rest length, got ' + dist(lin));
  const off = Core.create(cfg); off.setActive(Uint8Array.from([1, 1, 0]), Uint8Array.from([0])); for (let t = 0; t < 800 && off.tick(); t++);   // edge kind hidden → link masked off
  assert.ok(Math.abs(dist(off) - 30) > 2 && dist(off) >= 16, 'masked link still pulls: ' + dist(off));
}
// 6. old API still works (createSim over plain objects) and converges
{
  const d = L.decode({ types: ['file'], kinds: ['mention'], nodes: Array.from({ length: 60 }, (_, i) => ['n' + i, 0, 'n' + i, 'ws', 'p', 0, 0, 3, i % 3, {}]), edges: Array.from({ length: 90 }, (_, i) => [i % 60, (i * 7 + 1) % 60, 0, 0.5, 0]) });
  const sim = L.createSim(d.nodes, d.edges); let t = 0; while (sim.tick() && t < 1500) t++;
  assert.ok(t < 1500 && d.nodes.every(n => Number.isFinite(n.x)));
  d.nodes[0].fixed = true; const x0 = d.nodes[0].x; sim.reheat(1); for (let i = 0; i < 20; i++) sim.tick(); assert.equal(d.nodes[0].x, x0, 'fixed node moved');
}
console.log('ok — hermes-graph layout: determinism, collision-free settle, constant gravity, inertia+push, inert hidden nodes, legacy API');
