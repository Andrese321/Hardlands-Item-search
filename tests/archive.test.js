import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openArchive, splitArchiveName, TarParser } from '../js/archive.js';
import { findWorlds, scanWorld } from '../js/world.js';
import { analyzeChunks, selectChunks, buildEditedWorld } from '../js/chunks.js';
import { findStructures } from '../js/files.js';
import { openZip } from '../js/zip.js';

const load = (name) => new Blob([readFileSync(new URL('./fixtures/' + name, import.meta.url))]);
const LONG = 'behavior_packs/' + 'Pack con un nombre larguísimo para probar rutas de más de cien letras '.repeat(2) + '/manifest.json';

async function contents(arc, prefix = '') {
  const out = {};
  for (const e of arc.entries) {
    if (!e.name.startsWith(prefix)) continue;
    out[e.name.slice(prefix.length)] = Buffer.from(await arc.read(e)).toString('base64');
  }
  return out;
}

test('tar.gz (PAX) y tar (GNU) tienen los mismos ficheros que el .mcworld', async () => {
  const zip = await openArchive(load('test_world.mcworld'));
  assert.equal(zip.kind, 'zip');
  const expected = await contents(zip);

  const progress = [];
  const tgz = await openArchive(load('test_world.tar.gz'), { onProgress: (p) => progress.push(p) });
  assert.equal(tgz.kind, 'tar');
  assert.ok(progress.length && progress.at(-1) === 1);
  const names = tgz.entries.map((e) => e.name);
  assert.ok(names.includes('server.properties'));
  assert.ok(names.includes('worlds/Hardlands/' + LONG), 'ruta larga (PAX)');
  assert.ok(!names.some((n) => n.endsWith('/') || n.startsWith('./')), 'sin carpetas ni «./»');
  const got = await contents(tgz, 'worlds/Hardlands/');
  delete got[LONG];
  assert.deepEqual(got, expected);

  const gnu = await openArchive(load('test_world_gnu.tar'));
  assert.ok(gnu.entries.some((e) => e.name === 'Hardlands/' + LONG), 'ruta larga (GNU)');
  const got2 = await contents(gnu, 'Hardlands/');
  delete got2[LONG];
  assert.deepEqual(got2, expected);
});

test('el lector de tar aguanta trozos de cualquier tamaño', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/test_world_gnu.tar', import.meta.url)));
  for (const size of [1, 7, 511, 512, 513, 100000]) {
    const p = new TarParser();
    for (let i = 0; i < bytes.length; i += size) p.push(bytes.subarray(i, i + size));
    assert.equal(p.entries.length, 12, `trozos de ${size}`);
  }
});

test('formatos no válidos dan un error claro', async () => {
  await assert.rejects(openArchive(new Blob(['hola, esto no es un mundo'])), /Formato de archivo no reconocido/);
  const broken = new Uint8Array(readFileSync(new URL('./fixtures/test_world.tar.gz', import.meta.url))).slice(0, 3000);
  await assert.rejects(openArchive(new Blob([broken])), /tar\.gz/);
});

test('las herramientas funcionan con un .tar.gz', async () => {
  const arc = await openArchive(load('test_world.tar.gz'));
  const files = arc.entries.map((e) => ({ path: e.name, size: e.size, read: () => arc.read(e) }));
  const [prefix] = findWorlds(files.map((f) => f.path));
  assert.equal(prefix, 'worlds/Hardlands/');

  // buscar objetos
  const index = await scanWorld(files, prefix);
  assert.equal(index.worldName, 'Mundo de prueba');
  assert.ok(index.items.some((i) => i.id === 'minecraft:netherite_ingot'));

  // estructuras
  const db = files.filter((f) => f.path.startsWith(prefix + 'db/')).map((f) => ({ name: f.path.slice(prefix.length + 3), size: f.size, read: f.read }));
  const { structures } = await findStructures(db);
  assert.equal(structures.length, 2);

  // borrar chunks: .zip con la estructura original y .mcworld con el mundo en la raíz
  const a = await analyzeChunks(db);
  const chosen = selectChunks(a, { dim: 0, zones: [[0, -1, 0, -1]], mode: 'inside' });
  const out = await buildEditedWorld(arc.editSource, prefix, a, chosen);
  const zipOut = await openZip(new Blob([await out.blob.arrayBuffer()]));
  assert.ok(zipOut.entries.some((e) => e.name === 'server.properties'));
  const mcBytes = Buffer.from(await out.mcworld.arrayBuffer());
  mkdirSync(new URL('../.test-output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.test-output/desde-targz.mcworld', import.meta.url), mcBytes);
  const mc = await openZip(new Blob([mcBytes]));
  assert.ok(mc.entries.some((e) => e.name === 'level.dat'));
  assert.ok(!mc.entries.some((e) => e.name === 'server.properties'));
  const after = await scanWorld((await openArchive(new Blob([mcBytes]))).entries.map((e) => ({ path: e.name, size: e.size, read: () => mc.read(e) })));
  assert.ok(!after.items.some((i) => i.id === 'minecraft:netherite_ingot'));
});

test('nombres de salida', () => {
  assert.deepEqual(splitArchiveName('backup-2026.tar.gz'), { base: 'backup-2026', ext: '.zip' });
  assert.deepEqual(splitArchiveName('mundo.tgz'), { base: 'mundo', ext: '.zip' });
  assert.deepEqual(splitArchiveName('Mi Mundo.mcworld'), { base: 'Mi Mundo', ext: '.mcworld' });
  assert.deepEqual(splitArchiveName('copia.ZIP'), { base: 'copia', ext: '.zip' });
});
