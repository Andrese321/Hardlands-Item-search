import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBiomes, search, planTasks, runTask, mergeResults, parseSeed, mtFirst, attemptInRegion, STRUCTURES } from '../js/seedfinder.js';
import { readLevelDat } from '../js/seed-worker.js';
import { openZip } from '../js/zip.js';

const biomes = await loadBiomes(readFileSync(new URL('../vendor/cubiomes.wasm', import.meta.url)));
const SEED = '1722026622528246853';

function nearest(seedText, type, radius = 1500, centerX = 0, centerZ = 0) {
  const out = search(biomes, { mode: 'single', seed: parseSeed(seedText), a: type, radius, centerX, centerZ });
  return out.center.map((r) => [r.a.x, r.a.z]);
}
const has = (list, x, z) => list.some(([a, b]) => a === x && b === z);

test('Mersenne Twister: valores de referencia de MT19937', () => {
  const out = new Uint32Array(4);
  mtFirst(5489, 4, out);
  assert.deepEqual([...out], [3499211612, 581869302, 3890346734, 3586334585]);
});

test('semillas: negativas, de 64 bits y no válidas', () => {
  assert.deepEqual(parseSeed('16'), { lo: 16, hi: 0, text: '16' });
  assert.deepEqual(parseSeed('-1'), { lo: 0xffffffff, hi: 0xffffffff, text: '-1' });
  assert.equal(parseSeed(' -4504155221468820465 ').text, '-4504155221468820465');
  assert.throws(() => parseSeed('hola'));
});

// Posiciones publicadas en listas de semillas de Bedrock 1.21 (coordenadas del juego).
test('monumentos oceánicos: coinciden con semillas publicadas', () => {
  assert.ok(has(nearest('-4504155221468820465', 'monument'), -376, 40));
  assert.ok(has(nearest('1722026622528246853', 'monument'), 120, 728));
});

test('puestos de saqueadores: coinciden con semillas publicadas', () => {
  assert.ok(has(nearest('1722026622528246853', 'outpost'), -792, 280));
  assert.ok(has(nearest('-4480392380484671680', 'outpost'), 376, 552));
  // Publicado como (386, 191): la posición dentro del chunk; el centro del chunk es (392, 184).
  assert.ok(has(nearest('300746916', 'outpost'), 392, 184));
});

test('aldeas y cabañas de bruja: coinciden con semillas publicadas', () => {
  assert.ok(has(nearest('847743344719097', 'village', 600), 72, 40));
  assert.ok(has(nearest('-4504155221468820465', 'witch_hut'), -360, -488));
});

test('los intentos caen dentro de su región y respetan la separación', () => {
  for (const cfg of Object.values(STRUCTURES)) {
    for (const [rx, rz] of [[0, 0], [-1, -1], [5, -7], [-300, 200]]) {
      const [x, z] = attemptInRegion(cfg, 123456789, rx, rz);
      assert.ok(x >= rx * cfg.spacing && x < rx * cfg.spacing + cfg.range);
      assert.ok(z >= rz * cfg.spacing && z < rz * cfg.spacing + cfg.range);
    }
  }
});

test('parejas de estructuras diferentes: distancia, orden y sin repetidos', () => {
  const seed = parseSeed(SEED);
  const opts = { mode: 'pairs', seed, a: 'village', b: 'outpost', maxChunks: 10, radius: 10000 };
  const out = search(biomes, opts);
  assert.ok(out.total >= 4 && out.pair.length === out.total);
  const outposts = nearest(SEED, 'outpost', 12000);
  const villages = nearest(SEED, 'village', 12000);
  let prev = 0;
  for (const r of out.pair) {
    assert.equal(r.a.name, 'Aldea');
    assert.equal(r.b.name, 'Puesto de saqueadores');
    const d = Math.hypot(r.a.x - r.b.x, r.a.z - r.b.z) / 16;
    assert.ok(d <= 10 && d >= prev - 1e-9, 'ordenadas de más juntas a más separadas');
    prev = d;
    assert.equal(r.blocks, Math.round(d * 16));
    // cada estructura de la pareja aparece también al listar ese tipo por separado
    assert.ok(has(villages, r.a.x, r.a.z));
    assert.ok(has(outposts, r.b.x, r.b.z));
  }
  // la otra ordenación tiene las mismas parejas, de más cerca a más lejos del centro
  assert.deepEqual(out.center.map((r) => r.fromCenter), out.pair.map((r) => r.fromCenter).sort((x, y) => x - y));
  // el orden de los dos tipos no cambia las parejas encontradas
  const swapped = search(biomes, { ...opts, a: 'outpost', b: 'village' }).pair;
  assert.deepEqual(swapped.map((r) => [r.b.x, r.b.z, r.a.x, r.a.z]), out.pair.map((r) => [r.a.x, r.a.z, r.b.x, r.b.z]));
  // con menos distancia hay menos parejas; con más (hasta 40 chunks), más
  const fewer = search(biomes, { ...opts, maxChunks: 6 });
  assert.ok(fewer.total < out.total && fewer.pair.every((r) => r.chunks <= 6));
  const more = search(biomes, { ...opts, maxChunks: 40 });
  assert.ok(more.total > out.total && more.pair.every((r) => r.chunks <= 40));
  for (const r of out.pair) assert.ok(more.pair.some((q) => q.a.x === r.a.x && q.a.z === r.a.z && q.b.x === r.b.x && q.b.z === r.b.z));
});

test('monumento junto a puesto de saqueadores (pareja rara, lejos del origen)', () => {
  const out = search(biomes, {
    mode: 'pairs', seed: parseSeed(SEED), a: 'monument', b: 'outpost', maxChunks: 10,
    centerX: 225500, centerZ: 23300, radius: 3000,
  });
  assert.equal(out.total, 1);
  const r = out.pair[0];
  assert.deepEqual([r.a.x, r.a.z, r.b.x, r.b.z], [225496, 23272, 225624, 23304]);
  assert.equal(r.chunks, 8.2);
});

// Comprobación independiente: todas las estructuras válidas de la zona y fuerza bruta.
function bruteGroups(type, maxChunks, opts) {
  const pts = nearest(SEED, type, opts.radius + maxChunks * 16 + 16, opts.centerX, opts.centerZ);
  const adj = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) / 16 <= maxChunks + 1e-9;
  const groups = [];
  const n = pts.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const m = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) m.push(i);
    if (m.length < 2 || !m.every((i) => m.every((j) => i === j || adj(pts[i], pts[j])))) continue;
    // máximo: ningún otro punto es vecino de todos
    if (pts.some((p, k) => !m.includes(k) && m.every((i) => adj(p, pts[i])))) continue;
    const cx = Math.round(m.reduce((s, i) => s + pts[i][0], 0) / m.length);
    const cz = Math.round(m.reduce((s, i) => s + pts[i][1], 0) / m.length);
    if (Math.abs(cx - opts.centerX) > opts.radius || Math.abs(cz - opts.centerZ) > opts.radius) continue;
    groups.push(m.map((i) => pts[i].join()).sort().join(' '));
  }
  return groups.sort();
}

test('estructuras múltiples: los grupos coinciden con una búsqueda por fuerza bruta', () => {
  let nonEmpty = 0;
  for (const [type, maxChunks, centerX, centerZ, radius] of [
    ['monument', 40, 1000, 0, 1500],
    ['witch_hut', 40, 240000, -129800, 900],
    ['village', 40, 0, 0, 1200],
    ['monument', 10, -139400, -234500, 1500],
  ]) {
    const opts = { mode: 'multi', seed: parseSeed(SEED), types: [type], maxChunks, centerX, centerZ, radius };
    const out = search(biomes, opts);
    const found = out.size.map((g) => g.members.map((m) => [m.x, m.z].join()).sort().join(' ')).sort();
    assert.deepEqual(found, bruteGroups(type, maxChunks, opts), `${type} a ${maxChunks} chunks`);
    nonEmpty += found.length ? 1 : 0;
    const total = Object.values(out.counts[type] || {}).reduce((s, n) => s + n, 0);
    assert.equal(total, found.length);
    for (const g of out.size) {
      assert.equal(g.size, g.members.length);
      assert.ok(g.span <= maxChunks);
    }
  }
  assert.equal(nonEmpty, 4, 'todos los casos tienen algún grupo');
});

test('estructuras múltiples: monumento doble y todos los tipos a la vez', () => {
  const base = { mode: 'multi', seed: parseSeed(SEED), maxChunks: 10, centerX: -139400, centerZ: -234500, radius: 3000 };
  const one = search(biomes, { ...base, types: ['monument'] });
  assert.deepEqual(one.counts, { monument: { 2: 1 } });
  assert.equal(one.size[0].span, 6);
  assert.deepEqual(one.size[0].members.map((m) => [m.x, m.z].join()).sort(), ['-139416,-234488', '-139416,-234584']);
  // con todos los tipos se encuentra lo mismo para los monumentos
  const all = search(biomes, { ...base, types: null });
  assert.deepEqual(all.counts.monument, { 2: 1 });
  assert.equal(all.types.length, Object.keys(STRUCTURES).length);
  // los grupos de 3 o más salen primero al ordenar por tamaño
  const big = search(biomes, { ...base, types: ['monument'], maxChunks: 40, centerX: 0, centerZ: 0, radius: 20000 });
  const sizes = big.size.map((g) => g.size);
  assert.deepEqual(sizes, [...sizes].sort((x, y) => y - x));
  assert.ok(big.center3.every((g) => g.size >= 3));
});

test('repartir en tareas da lo mismo que hacerlo de una vez', () => {
  const opts = { mode: 'multi', seed: parseSeed(SEED), types: ['monument', 'witch_hut', 'igloo'], maxChunks: 24, radius: 60000 };
  const plan = planTasks(opts, 5000);
  assert.ok(plan.tasks.length > 10, 'la búsqueda se divide en varias tareas');
  // en otro orden y con otra instancia del generador de biomas, como harían varios hilos
  const parts = [...plan.tasks].reverse().map((t) => runTask(biomes, plan.options, t));
  const merged = mergeResults(plan.options, parts);
  const whole = search(biomes, opts);
  assert.deepEqual(merged.counts, whole.counts);
  assert.deepEqual(merged.size, whole.size);
  assert.deepEqual(merged.center, whole.center);
  assert.ok(whole.size.length > 20, 'hay grupos que comparar');
});

test('lee la semilla y la aparición de level.dat', async () => {
  const zip = await openZip(new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]));
  const info = readLevelDat(await zip.read(zip.entries.find((e) => e.name === 'level.dat')));
  assert.deepEqual(info, { seed: '1722026622528246853', name: 'Mundo de prueba', spawnX: -120, spawnZ: 48 });
});
