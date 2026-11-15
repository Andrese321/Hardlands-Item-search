import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openZip } from '../js/zip.js';
import { findStructures, describeStructure, structureFileName, buildTree } from '../js/files.js';
import { readNbt } from '../js/nbt.js';

const blob = new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]);

test('extrae las estructuras guardadas como .mcstructure', async () => {
  const zip = await openZip(blob);
  const db = zip.entries.filter((e) => e.name.startsWith('db/')).map((e) => ({ name: e.name.slice(3), size: e.size, read: () => zip.read(e) }));
  const { structures, warnings } = await findStructures(db);
  assert.deepEqual(warnings, []);
  assert.deepEqual(structures.map((s) => [s.id, s.file]), [
    ['hardlands:torre', 'hardlands_torre.mcstructure'],
    ['mystructure:casa', 'casa.mcstructure'],
  ]);
  const casa = structures[1];
  assert.deepEqual(casa.info.size, [3, 2, 3]);
  assert.equal(casa.info.blocks, 9); // 8 de piedra + 1 cofre, el aire no cuenta
  assert.equal(casa.info.blockEntities, 1);
  assert.deepEqual(casa.info.origin, [10, 64, -5]);
  assert.deepEqual(casa.info.top[0], ['minecraft:stone', 8]);
  // El fichero es el NBT tal cual: lo que Minecraft espera de un .mcstructure.
  const nbt = readNbt(casa.bytes);
  assert.equal(nbt.format_version, 1);
  assert.equal(nbt.structure.palette.default.block_position_data['4'].block_entity_data.Items[0].Count, 9);
});

test('los .mcstructure de los packs se reconocen y el árbol de carpetas es correcto', async () => {
  const zip = await openZip(blob);
  const e = zip.entries.find((x) => x.name.endsWith('.mcstructure'));
  assert.equal(e.name, 'behavior_packs/Pack Hardlands/structures/puente.mcstructure');
  assert.deepEqual(describeStructure(await zip.read(e)).size, [1, 4, 1]);
  const tree = buildTree(zip.entries.map((x) => ({ path: x.name, size: x.size })));
  assert.deepEqual([...tree.dirs.keys()].sort(), ['behavior_packs', 'db']);
  assert.equal(tree.count, zip.entries.length);
  assert.equal(tree.dirs.get('db').files.length, 5);
});

test('nombres de fichero seguros y sin repetir', () => {
  const used = new Set();
  assert.equal(structureFileName('mystructure:casa', used), 'casa.mcstructure');
  assert.equal(structureFileName('mystructure:Casa', used), 'Casa (2).mcstructure');
  assert.equal(structureFileName('a:b/c?d', used), 'a_b_c_d.mcstructure');
});
