import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openZip, buildZip, storedEntry } from '../js/zip.js';
import { scanWorld } from '../js/world.js';

const fixture = new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]);

test('ZIP64 forzado: el mundo se copia entero y se lee igual', async () => {
  const src = await openZip(fixture);
  const entries = [];
  for (const e of src.entries) entries.push({ ...e, data: await src.raw(e) });
  entries.push(storedEntry('nuevo.txt', new TextEncoder().encode('hola')));
  const bytes = Buffer.from(await buildZip(entries, 'application/zip', { forceZip64: true }).arrayBuffer());
  mkdirSync(new URL('../.test-output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.test-output/zip64-forzado.zip', import.meta.url), bytes);

  const back = await openZip(new Blob([bytes]));
  assert.deepEqual(back.entries.map((e) => [e.name, e.size]), entries.map((e) => [e.name, e.size]));
  for (let i = 0; i < src.entries.length; i++) {
    assert.deepEqual(Buffer.from(await back.read(back.entries[i])), Buffer.from(await src.read(src.entries[i])));
  }
  const world = await scanWorld(back.entries.map((e) => ({ path: e.name, size: e.size, read: () => back.read(e) })));
  assert.equal(world.worldName, 'Mundo de prueba');
});

// El caso real de más de 4 GB se prueba en el navegador (Node no puede leer
// partes de un Blob más allá de 4 GB): ver tests/browser-zip64.html.
