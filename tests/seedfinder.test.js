import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBiomes, findStructures, parseSeed, mtFirst, attemptInRegion, STRUCTURES } from '../js/seedfinder.js';
import { readLevelDat } from '../js/seed-worker.js';
import { openZip } from '../js/zip.js';

const biomes = await loadBiomes(readFileSync(new URL('../vendor/cubiomes.wasm', import.meta.url)));

function nearest(seedText, type, radius = 1500) {
  const out = findStructures(biomes, { seed: parseSeed(seedText), a: type, radius, limit: 20 });
  return out.results.map((r) => [r.a.x, r.a.z]);
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

test('búsqueda de parejas: distancia, orden y sin repetidos', () => {
  const seed = parseSeed('1722026622528246853');
  const opts = { seed, a: 'village', b: 'outpost', maxChunks: 10, radius: 10000, limit: 300 };
  const { results } = findStructures(biomes, opts);
  assert.ok(results.length >= 4);
  const outposts = findStructures(biomes, { seed, a: 'outpost', radius: 12000, limit: 5000 }).results.map((q) => [q.a.x, q.a.z]);
  const villages = findStructures(biomes, { seed, a: 'village', radius: 12000, limit: 5000 }).results.map((q) => [q.a.x, q.a.z]);
  let prev = 0;
  for (const r of results) {
    assert.equal(r.a.name, 'Aldea');
    assert.equal(r.b.name, 'Puesto de saqueadores');
    const d = Math.hypot(r.a.chunkX - r.b.chunkX, r.a.chunkZ - r.b.chunkZ);
    assert.ok(d <= 10 && d >= prev - 1e-9, 'ordenadas de más juntas a más separadas');
    prev = d;
    assert.equal(r.blocks, Math.round(d * 16));
    // cada estructura de la pareja aparece también al listar ese tipo por separado
    assert.ok(has(villages, r.a.x, r.a.z));
    assert.ok(has(outposts, r.b.x, r.b.z));
  }
  // el orden de los dos tipos no cambia las parejas encontradas
  const swapped = findStructures(biomes, { ...opts, a: 'outpost', b: 'village' }).results;
  assert.deepEqual(swapped.map((r) => [r.b.x, r.b.z, r.a.x, r.a.z]), results.map((r) => [r.a.x, r.a.z, r.b.x, r.b.z]));
  // con menos distancia hay menos parejas
  const fewer = findStructures(biomes, { ...opts, maxChunks: 6 }).results;
  assert.ok(fewer.length < results.length && fewer.every((r) => r.chunks <= 6));
});

test('monumento junto a puesto de saqueadores (pareja rara, lejos del origen)', () => {
  const { results } = findStructures(biomes, {
    seed: parseSeed('1722026622528246853'), a: 'monument', b: 'outpost', maxChunks: 10,
    centerX: 225500, centerZ: 23300, radius: 3000,
  });
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].a.x, results[0].a.z, results[0].b.x, results[0].b.z], [225496, 23272, 225624, 23304]);
  assert.equal(results[0].chunks, 8.2);
});

test('mismo tipo dos veces: monumento doble, cada pareja una sola vez', () => {
  const { results } = findStructures(biomes, {
    seed: parseSeed('1722026622528246853'), a: 'monument', b: 'monument', maxChunks: 10,
    centerX: -139400, centerZ: -234500, radius: 3000,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chunks, 6);
  assert.deepEqual([results[0].a.x, results[0].a.z].join(), '-139416,-234584');
  assert.deepEqual([results[0].b.x, results[0].b.z].join(), '-139416,-234488');
});

test('lee la semilla y la aparición de level.dat', async () => {
  const zip = await openZip(new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]));
  const info = readLevelDat(await zip.read(zip.entries.find((e) => e.name === 'level.dat')));
  assert.deepEqual(info, { seed: '1722026622528246853', name: 'Mundo de prueba', spawnX: -120, spawnZ: 48 });
});
