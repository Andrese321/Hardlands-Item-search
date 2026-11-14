import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openZip } from '../js/zip.js';
import { scanWorld } from '../js/world.js';
import {
  analyzeChunks, selectChunks, buildEditedWorld, parseChunkKey, chunkKey, blocksToChunkZone, inZones,
} from '../js/chunks.js';

const original = new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]);

async function filesOf(blob) {
  const zip = await openZip(blob);
  return { zip, files: zip.entries.map((e) => ({ path: e.name, size: e.size, read: () => zip.read(e) })) };
}

const dbFiles = (files) => files.filter((f) => f.path.startsWith('db/')).map((f) => ({ name: f.path.slice(3), size: f.size, read: f.read }));

test('claves de chunk: ida y vuelta', () => {
  for (const [x, z, dim, tag, idx] of [[0, -1, 0, 44, 256], [-7, 12, 1, 47, 252], [123456, -98765, 2, 49, 256]]) {
    const p = parseChunkKey(chunkKey(x, z, dim, tag, idx));
    assert.deepEqual([p.x, p.z, p.dim, p.tag, p.index], [x, z, dim, tag, idx]);
  }
  assert.equal(parseChunkKey(new TextEncoder().encode('~local_player')), null);
  assert.equal(parseChunkKey(new TextEncoder().encode('dimension0')), null);
  assert.deepEqual(blocksToChunkZone(10, -5, -17, 40), [-2, -1, 0, 2]);
  assert.ok(inZones(0, -1, [[-2, -1, 0, 2]]));
});

test('analiza chunks, contenedores y jugadores', async () => {
  const { files } = await filesOf(original);
  const a = await analyzeChunks(dbFiles(files));
  const overworld = [...a.chunks.values()].filter((c) => c.dim === 0 && c.real);
  assert.equal(overworld.length, 1600);
  const c = a.chunks.get('0,0,-1');
  assert.equal(c.containers, 2); // cofre + barril (el de botín está vacío)
  assert.equal(a.players.length, 2);
});

test('borrar un chunk elimina terreno, cofres y entidades solo de ese chunk', async () => {
  const { zip, files } = await filesOf(original);
  const a = await analyzeChunks(dbFiles(files));
  const chosen = selectChunks(a, { dim: 0, zones: [blocksToChunkZone(0, -16, 15, -1)], mode: 'inside' });
  assert.deepEqual(chosen.map((c) => [c.x, c.z]), [[0, -1]]);

  const out = await buildEditedWorld({ kind: 'zip', zip }, '', a, chosen);
  assert.equal(out.actors, 1);
  const edited = new Blob([await out.blob.arrayBuffer()]);
  mkdirSync(new URL('../.test-output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.test-output/edited.mcworld', import.meta.url), Buffer.from(await edited.arrayBuffer()));

  const before = await scanWorld((await filesOf(original)).files);
  const after = await scanWorld((await filesOf(edited)).files);
  const ids = (idx) => idx.items.map((i) => i.id);
  // Del chunk (0,-1): cofre, barril, vagoneta y tótem tirado en el suelo.
  for (const gone of ['minecraft:netherite_ingot', 'minecraft:elytra', 'minecraft:emerald', 'minecraft:totem_of_undying']) {
    assert.ok(ids(before).includes(gone));
  }
  for (const gone of ['minecraft:netherite_ingot', 'minecraft:emerald', 'minecraft:totem_of_undying']) {
    assert.ok(!ids(after).includes(gone), gone + ' debería haberse borrado');
  }
  // El resto sigue: elytra del jugador, tolva del Nether, burro, inventarios.
  assert.equal(after.items.filter((i) => i.id === 'minecraft:elytra').length, 1);
  assert.ok(ids(after).includes('minecraft:gold_ingot'));
  assert.ok(ids(after).includes('minecraft:dragon_breath'));
  assert.equal(after.players.length, 2);

  const a2 = await analyzeChunks(dbFiles((await filesOf(edited)).files));
  assert.ok(a2.maxSeq > a.maxSeq);
});

test('borrar todo excepto una zona', async () => {
  const { zip, files } = await filesOf(original);
  const a = await analyzeChunks(dbFiles(files));
  const keep = [blocksToChunkZone(-32, -32, 31, 31)]; // 4x4 chunks
  const chosen = selectChunks(a, { dim: 0, zones: keep, mode: 'outside' });
  assert.equal(chosen.length, 1600 - 16);
  const out = await buildEditedWorld({ kind: 'zip', zip }, '', a, chosen);
  const edited = new Blob([await out.blob.arrayBuffer()]);
  writeFileSync(new URL('../.test-output/edited-outside.mcworld', import.meta.url), Buffer.from(await edited.arrayBuffer()));
  const a2 = await analyzeChunks(dbFiles((await filesOf(edited)).files));
  // analyzeChunks también ve las versiones antiguas: comprobamos con el lector real.
  const after = await scanWorld((await filesOf(edited)).files);
  assert.ok(after.items.some((i) => i.id === 'minecraft:netherite_ingot'), 'el chunk (0,-1) está dentro de la zona protegida');
  assert.ok(a2.maxSeq >= a.maxSeq + chosen.length);
});
