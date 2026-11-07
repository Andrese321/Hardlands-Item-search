// Trabajo pesado (descomprimir y leer el mundo) fuera del hilo de la interfaz.

import { openZip } from './zip.js';
import { findWorlds, scanWorld } from './world.js';

let files = null;

async function fromZip(file) {
  const zip = await openZip(file);
  return zip.entries.map((e) => ({ path: e.name, size: e.size, read: () => zip.read(e) }));
}

function fromFolder(list) {
  return list.map((f) => {
    // webkitRelativePath = "MiMundo/db/000005.ldb": quitamos la carpeta elegida
    // solo si con ella no se encuentra el mundo (se resuelve en findWorlds).
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    return { path, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) };
  });
}

async function scan(prefix) {
  const index = await scanWorld(files, prefix, {
    onProgress: (p) => postMessage({ type: 'progress', value: p }),
    onStatus: (text) => postMessage({ type: 'status', text }),
  });
  postMessage({ type: 'done', index });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      postMessage({ type: 'status', text: 'Abriendo archivo…' });
      if (data.zip) {
        files = await fromZip(data.zip);
      } else {
        files = fromFolder(data.files);
      }
      const worlds = findWorlds(files.map((f) => f.path));
      if (!worlds.length) {
        throw new Error(
          'No se encontró ningún mundo. El archivo debe contener la carpeta "db" del mundo ' +
            '(un .mcworld, el .zip de una copia de seguridad o la carpeta del mundo).',
        );
      }
      if (worlds.length === 1) {
        await scan(worlds[0]);
      } else {
        postMessage({ type: 'choose', worlds });
      }
    } else if (data.type === 'scan') {
      await scan(data.prefix);
    }
  } catch (e) {
    postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
