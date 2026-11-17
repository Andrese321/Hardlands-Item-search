// Trabajo pesado del buscador por semilla (fuera del hilo de la interfaz).

import { loadBiomes, findStructures, parseSeed } from './seedfinder.js';
import { openZip } from './zip.js';
import { readNbt } from './nbt.js';

let biomesPromise = null;

function biomes() {
  biomesPromise ||= fetch(new URL('../vendor/cubiomes.wasm', import.meta.url))
    .then((res) => {
      if (!res.ok) throw new Error('No se pudo cargar el generador de biomas.');
      return res.arrayBuffer();
    })
    .then(loadBiomes);
  return biomesPromise;
}

/** Semilla y punto de aparición guardados en level.dat. */
export function readLevelDat(bytes) {
  // Cabecera de 8 bytes (versión y tamaño) y después NBT little-endian.
  const nbt = readNbt(bytes.subarray(8));
  if (!nbt || nbt.RandomSeed === undefined) throw new Error('El level.dat no contiene la semilla.');
  return {
    seed: BigInt.asIntN(64, BigInt(nbt.RandomSeed)).toString(),
    name: typeof nbt.LevelName === 'string' ? nbt.LevelName : '',
    spawnX: Number.isFinite(Number(nbt.SpawnX)) ? Number(nbt.SpawnX) : null,
    spawnZ: Number.isFinite(Number(nbt.SpawnZ)) ? Number(nbt.SpawnZ) : null,
  };
}

async function levelDatFrom(data) {
  let candidates;
  if (data.zip && /\.dat$/i.test(data.zip.name || '')) {
    return readLevelDat(new Uint8Array(await data.zip.arrayBuffer()));
  }
  if (data.zip) {
    const zip = await openZip(data.zip);
    candidates = zip.entries
      .filter((e) => /(^|\/)level\.dat$/.test(e.name))
      .map((e) => ({ path: e.name, read: () => zip.read(e) }));
  } else {
    candidates = data.files
      .map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), file: f }))
      .filter((f) => /(^|\/)level\.dat$/.test(f.path))
      .map((f) => ({ path: f.path, read: async () => new Uint8Array(await f.file.arrayBuffer()) }));
  }
  if (!candidates.length) throw new Error('No se encontró el archivo level.dat en ese mundo.');
  candidates.sort((a, b) => a.path.length - b.path.length);
  return readLevelDat(await candidates[0].read());
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'search') {
        const b = await biomes();
        const t = performance.now();
        const out = findStructures(b, { ...data.opts, seed: parseSeed(data.opts.seed) },
          (value) => postMessage({ type: 'progress', value }));
        postMessage({ type: 'done', ...out, ms: Math.round(performance.now() - t) });
      } else if (data.type === 'readSeed') {
        postMessage({ type: 'seed', ...(await levelDatFrom(data)) });
      }
    } catch (e) {
      postMessage({ type: 'error', message: e?.message || String(e) });
    }
  };
}
