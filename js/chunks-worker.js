// Trabajo pesado de la herramienta de borrar chunks (fuera del hilo de la interfaz).

import { openArchive } from './archive.js';
import { findWorlds } from './world.js';
import { analyzeChunks, selectChunks, buildEditedWorld } from './chunks.js';
import { setBlockColors, renderDimension } from './terrain.js';

let source = null; // { kind:'zip', zip } | { kind:'folder', files:[{path, file}] }
let paths = [];
let prefix = '';
let analysis = null;
let dbFiles = null;
let terrainReq = 0; // petición de vista satélite en curso (las anteriores se cancelan)
let colorsLoaded = null;

function loadColors() {
  colorsLoaded ||= fetch(new URL('../data/block_colors.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then(setBlockColors);
  return colorsLoaded;
}

async function terrain({ req, dim, mode, res = 16 }) {
  terrainReq = req;
  await loadColors();
  if (!dbFiles || req !== terrainReq) return;
  const out = await renderDimension(dbFiles, dim, mode, {
    res,
    shouldStop: () => req !== terrainReq,
    onProgress: (value) => req === terrainReq && postMessage({ type: 'terrainProgress', req, value }),
  });
  if (!out || req !== terrainReq) return;
  postMessage({ type: 'terrain', req, dim, mode, res: out.res, chunks: out.chunks, tiles: out.tiles }, out.tiles.map((t) => t.data.buffer));
}

const progress = (value) => postMessage({ type: 'progress', value });
let lastPct = -1;
function unpackProgress(p) {
  const pct = Math.floor(p * 100);
  if (pct === lastPct) return;
  lastPct = pct;
  postMessage({ type: 'status', text: `Descomprimiendo el archivo… ${pct} %` });
  progress(p);
}
const status = (text) => postMessage({ type: 'status', text });

function readerFor(path) {
  if (source.kind === 'zip') {
    const e = source.zip.entries.find((x) => x.name === path);
    return { size: e.size, read: () => source.zip.read(e) };
  }
  const f = source.files.find((x) => x.path === path).file;
  return { size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) };
}

async function analyze(p) {
  prefix = p;
  const dbPrefix = prefix + 'db/';
  dbFiles = paths
    .filter((x) => x.startsWith(dbPrefix) && !x.slice(dbPrefix.length).includes('/'))
    .map((x) => ({ name: x.slice(dbPrefix.length), ...readerFor(x) }));

  let worldName = prefix.replace(/\/$/, '').split('/').pop() || 'Mundo';
  if (paths.includes(prefix + 'levelname.txt')) {
    try {
      worldName = new TextDecoder().decode(await readerFor(prefix + 'levelname.txt').read()).trim() || worldName;
    } catch {
      /* sin nombre */
    }
  }

  status('Leyendo los chunks del mundo…');
  analysis = await analyzeChunks(dbFiles, { onProgress: progress });

  // Resumen compacto para dibujar el mapa: por dimensión [x, z, contenedores, objetos]...
  const dims = {};
  for (const ch of analysis.chunks.values()) {
    if (!ch.real) continue;
    (dims[ch.dim] ||= []).push(ch.x, ch.z, ch.containers, ch.items);
  }
  const packed = {};
  const transfer = [];
  for (const [d, arr] of Object.entries(dims)) {
    packed[d] = Int32Array.from(arr);
    transfer.push(packed[d].buffer);
  }
  postMessage({ type: 'analyzed', worldName, dims: packed, players: analysis.players }, transfer);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      status('Abriendo archivo…');
      if (data.zip) {
        const arc = await openArchive(data.zip, { onProgress: unpackProgress });
        source = arc.editSource;
        paths = arc.entries.map((e) => e.name);
      } else {
        const files = data.files.map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), file: f }));
        source = { kind: 'folder', files };
        paths = files.map((f) => f.path);
      }
      const worlds = findWorlds(paths);
      if (!worlds.length) throw new Error('No se encontró ningún mundo (falta la carpeta "db").');
      if (worlds.length === 1) await analyze(worlds[0]);
      else postMessage({ type: 'choose', worlds });
    } else if (data.type === 'analyze') {
      await analyze(data.prefix);
    } else if (data.type === 'terrain') {
      try {
        await terrain(data);
      } catch (e) {
        postMessage({ type: 'terrainError', req: data.req, message: e?.message || String(e) });
      }
    } else if (data.type === 'build') {
      status('Creando el mundo modificado…');
      const chunks = selectChunks(analysis, data.selection);
      const out = await buildEditedWorld(source, prefix, analysis, chunks, { onProgress: progress });
      postMessage({ type: 'built', blob: out.blob, mcworld: out.mcworld, nested: prefix !== '', chunks: chunks.length, keys: out.keys, actors: out.actors });
    }
  } catch (e) {
    postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
