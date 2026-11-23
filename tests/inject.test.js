import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { openZip } from '../js/zip.js';
import { findStructures } from '../js/files.js';
import { scanWorld } from '../js/world.js';
import { buildWorldWithChanges } from '../js/edit.js';
import {
  structureName, uniqueNames, checkStructureFile, buildMcpack, injectionRecords, structureId,
} from '../js/inject.js';

const zip = await openZip(new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]));
const PACK = 'behavior_packs/Pack Hardlands/structures/puente.mcstructure';
const puente = await zip.read(zip.entries.find((e) => e.name === PACK));
const dbOf = (z) => z.entries.filter((e) => e.name.startsWith('db/')).map((e) => ({ name: e.name.slice(3), size: e.size, read: () => z.read(e) }));
const { structures: original } = await findStructures(dbOf(zip));
const casa = original.find((s) => s.id === 'mystructure:casa').bytes;

test('nombres válidos para el juego', () => {
  assert.equal(structureName('Mi Casa (2).mcstructure'), 'mi_casa_2');
  assert.equal(structureName('Torre Ñandú.MCSTRUCTURE'), 'torre_nandu');
  assert.equal(structureName('???.mcstructure'), 'estructura');
  assert.deepEqual(uniqueNames(['a', 'a', 'b', 'a']), ['a', 'a_2', 'b', 'a_3']);
  assert.equal(structureId('casa'), 'mystructure:casa');
});

test('comprueba que el archivo sea un .mcstructure de Bedrock', () => {
  assert.deepEqual(checkStructureFile(puente).size, [1, 4, 1]);
  assert.throws(() => checkStructureFile(gzipSync(Buffer.from(puente))), /Java/);
  assert.throws(() => checkStructureFile(new TextEncoder().encode('hola')), /No es un archivo .mcstructure/);
  assert.throws(() => checkStructureFile(Uint8Array.from([10, 0, 0, 0])), /válido/);
});

test('crea un .mcpack con manifest, icono y estructuras', async () => {
  const icon = Uint8Array.from([137, 80, 78, 71]);
  const { blob, manifest } = buildMcpack([{ name: 'puente', bytes: puente }, { name: 'casa', bytes: casa }], { packName: 'Mis cosas', icon });
  const pack = await openZip(new Blob([await blob.arrayBuffer()]));
  assert.deepEqual(pack.entries.map((e) => e.name), ['manifest.json', 'pack_icon.png', 'scripts/main.js', 'structures/puente.mcstructure', 'structures/casa.mcstructure']);
  const m = JSON.parse(new TextDecoder().decode(await pack.read(pack.entries[0])));
  assert.deepEqual(m, manifest);
  assert.equal(m.header.name, 'Mis cosas');
  assert.equal(m.modules[0].type, 'data');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(m.header.uuid, uuid);
  assert.match(m.modules[0].uuid, uuid);
  assert.notEqual(m.header.uuid, m.modules[0].uuid);
  assert.deepEqual(Buffer.from(await pack.read(pack.entries[3])), Buffer.from(puente));
  // cargador automático: módulo de script con la API estable 1.12.0
  const script = m.modules.find((x) => x.type === 'script');
  assert.equal(script.entry, 'scripts/main.js');
  assert.deepEqual(m.dependencies, [{ module_name: '@minecraft/server', version: '1.12.0' }]);
  assert.match(new TextDecoder().decode(await pack.read(pack.entries[2])), /hardlands:cargar/);
  // sin cargador: solo datos
  const plain = buildMcpack([{ name: 'x', bytes: puente }], { loader: false }).manifest;
  assert.equal(plain.modules.length, 1);
  assert.equal(plain.dependencies, undefined);
  // cada paquete lleva identificadores nuevos
  assert.notEqual(buildMcpack([{ name: 'x', bytes: puente }]).manifest.header.uuid, m.header.uuid);
});

test('mete estructuras dentro del mundo (una nueva y otra que reemplaza)', async () => {
  const db = dbOf(zip);
  const { scan } = await findStructures(db);
  const list = [{ name: 'puente_nuevo', bytes: puente }, { name: 'casa', bytes: puente }];
  const out = await buildWorldWithChanges({ kind: 'zip', zip }, '', scan, injectionRecords(list));
  const bytes = Buffer.from(await out.mcworld.arrayBuffer());
  mkdirSync(new URL('../.test-output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.test-output/con-estructuras.mcworld', import.meta.url), bytes);

  const edited = await openZip(new Blob([bytes]));
  const { structures } = await findStructures(dbOf(edited));
  const byId = Object.fromEntries(structures.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['hardlands:torre', 'mystructure:casa', 'mystructure:puente_nuevo']);
  assert.deepEqual(Buffer.from(byId['mystructure:puente_nuevo'].bytes), Buffer.from(puente));
  assert.deepEqual(Buffer.from(byId['mystructure:casa'].bytes), Buffer.from(puente), 'la casa se reemplaza');
  // el resto del mundo sigue igual
  const files = (z) => z.entries.map((e) => ({ path: e.name, size: e.size, read: () => z.read(e) }));
  const before = await scanWorld(files(zip));
  const after = await scanWorld(files(edited));
  assert.equal(after.stats.total, before.stats.total);
});

test('estructuras grandes: el registro se reparte en varios bloques', async () => {
  const { scan } = await findStructures(dbOf(zip));
  const big = new Uint8Array(3 * 1024 * 1024); // valor de 3 MB (solo para el formato del registro)
  big.set(puente);
  const out = await buildWorldWithChanges({ kind: 'zip', zip }, '', scan, injectionRecords([{ name: 'grande', bytes: big }]));
  const edited = await openZip(new Blob([await out.mcworld.arrayBuffer()]));
  const { structures } = await findStructures(dbOf(edited));
  const g = structures.find((s) => s.id === 'mystructure:grande');
  assert.equal(g.bytes.length, big.length);
  assert.deepEqual(Buffer.from(g.bytes.subarray(0, puente.length)), Buffer.from(puente));
});

test('comando ajustado al tamaño de la estructura', async () => {
  const { loadCommand } = await import('../js/inject.js');
  // pequeña: esquina en los pies
  assert.equal(loadCommand('casa', [3, 2, 3]).cmd, '/structure load mystructure:casa ~ ~ ~');
  // grande y muy alta (como un Eva-01 de 80 × 256 × 87): centrada y empezando en Y 64
  const eva = loadCommand('eva01', [80, 256, 87]);
  assert.equal(eva.cmd, '/structure load mystructure:eva01 ~-40 64 ~-43');
  assert.ok(eva.notes.some((n) => /Y 64/.test(n)));
  assert.ok(eva.notes.some((n) => /80 × 87/.test(n)));
  // alta pero no tanto: sin altura fija, con aviso
  const tall = loadCommand('torre', [10, 100, 10]);
  assert.equal(tall.cmd, '/structure load mystructure:torre ~ ~ ~');
  assert.ok(tall.notes.some((n) => /Y 220/.test(n)));
  // 320 bloques de alto: solo cabe desde Y 0
  assert.equal(loadCommand('alta', [5, 320, 5]).cmd, '/structure load mystructure:alta ~ 0 ~');
});

test('cargador automático dentro del mundo: paquete activado, sin duplicados y conservando otros paquetes', async () => {
  const { worldLoaderFiles, WORLD_LOADER_UUIDS } = await import('../js/inject.js');
  const { scan } = await findStructures(dbOf(zip));
  const existing = new TextEncoder().encode(JSON.stringify([{ pack_id: 'otro-pack', version: [2, 0, 0] }]));
  const list = [{ name: 'eva01', bytes: puente, size: [80, 256, 87] }];
  const extraFiles = worldLoaderFiles('', list, existing);
  const out = await buildWorldWithChanges({ kind: 'zip', zip }, '', scan, injectionRecords(list), { extraFiles });
  const edited = await openZip(new Blob([await out.mcworld.arrayBuffer()]));
  const read = async (name) => new TextDecoder().decode(await edited.read(edited.entries.find((e) => e.name === name)));
  const manifest = JSON.parse(await read('behavior_packs/hardlands_cargador/manifest.json'));
  assert.equal(manifest.header.uuid, WORLD_LOADER_UUIDS[0]);
  assert.deepEqual(manifest.dependencies, [{ module_name: '@minecraft/server', version: '1.12.0' }]);
  assert.match(await read('behavior_packs/hardlands_cargador/scripts/main.js'), /"eva01":\[80,256,87\]/);
  const packs = JSON.parse(await read('world_behavior_packs.json'));
  assert.deepEqual(packs, [{ pack_id: 'otro-pack', version: [2, 0, 0] }, { pack_id: WORLD_LOADER_UUIDS[0], version: [1, 0, 0] }]);
  // una sola copia de cada fichero
  const names = edited.entries.map((e) => e.name);
  assert.equal(names.length, new Set(names).size);
  // volver a meterlo no lo duplica
  const again = JSON.parse(new TextDecoder().decode(worldLoaderFiles('', list, new TextEncoder().encode(JSON.stringify(packs))).find((f) => f.path === 'world_behavior_packs.json').bytes));
  assert.equal(again.filter((p) => p.pack_id === WORLD_LOADER_UUIDS[0]).length, 1);
  // mundo dentro de una carpeta: las rutas llevan la carpeta
  assert.ok(worldLoaderFiles('worlds/Hardlands/', list).every((f) => f.path.startsWith('worlds/Hardlands/')));
});
