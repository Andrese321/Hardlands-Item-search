// Trabajo pesado del explorador de archivos (fuera del hilo de la interfaz).

import { openZip, buildZip, storedEntry } from './zip.js';
import { findWorlds } from './world.js';
import { findStructures, describeStructure, structureFileName } from './files.js';

let entries = []; // { path, size, read() }
let structures = []; // { id, file, source, path?, bytes?, info, error }

const status = (text) => postMessage({ type: 'status', text });

async function open(data) {
  status('Abriendo archivo…');
  if (data.zip) {
    const zip = await openZip(data.zip);
    entries = zip.entries.map((e) => ({ path: e.name, size: e.size, read: () => zip.read(e) }));
  } else {
    entries = data.files.map((f) => ({
      path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
      size: f.size,
      read: async () => new Uint8Array(await f.arrayBuffer()),
    }));
  }
  postMessage({ type: 'files', files: entries.map(({ path, size }) => ({ path, size })) });
  const worlds = findWorlds(entries.map((e) => e.path));
  if (worlds.length > 1) postMessage({ type: 'choose', worlds });
  else await scan(worlds[0] ?? null);
}

async function scan(prefix) {
  structures = [];
  const warnings = [];
  let worldName = '';
  if (prefix !== null) {
    const dbPrefix = prefix + 'db/';
    const db = entries
      .filter((e) => e.path.startsWith(dbPrefix) && !e.path.slice(dbPrefix.length).includes('/'))
      .map((e) => ({ name: e.path.slice(dbPrefix.length), size: e.size, read: e.read }));
    const ln = entries.find((e) => e.path === prefix + 'levelname.txt');
    if (ln) {
      try {
        worldName = new TextDecoder().decode(await ln.read()).trim();
      } catch {
        /* sin nombre */
      }
    }
    worldName ||= prefix.replace(/\/$/, '').split('/').pop() || 'Mundo';
    status('Buscando estructuras guardadas…');
    try {
      const res = await findStructures(db, { onProgress: (value) => postMessage({ type: 'progress', value }) });
      warnings.push(...res.warnings);
      structures = res.structures.map((s) => ({ ...s, source: 'world' }));
    } catch (e) {
      warnings.push('No se pudo leer la base de datos del mundo: ' + e.message);
    }
  }

  // .mcstructure sueltos dentro del archivo (packs de comportamiento, etc.)
  const used = new Set(structures.map((s) => s.file.toLowerCase()));
  for (const e of entries) {
    if (!/\.mcstructure$/i.test(e.path)) continue;
    let info = null;
    let error = null;
    try {
      info = describeStructure(await e.read());
    } catch (err) {
      error = err.message;
    }
    const base = e.path.split('/').pop().replace(/\.mcstructure$/i, '');
    structures.push({ id: base, file: structureFileName(base, used), source: 'pack', path: e.path, info, error });
  }

  postMessage({
    type: 'scanned',
    worldName,
    warnings,
    structures: structures.map(({ bytes, ...rest }) => rest),
  });
}

async function structureBytes(s) {
  if (s.bytes) return s.bytes;
  return entries.find((e) => e.path === s.path).read();
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      await open(data);
    } else if (data.type === 'scan') {
      await scan(data.prefix);
    } else if (data.type === 'file') {
      const e = entries.find((x) => x.path === data.path);
      const bytes = await e.read();
      postMessage({ type: 'download', name: data.path.split('/').pop(), blob: new Blob([bytes]) });
    } else if (data.type === 'structure') {
      const s = structures[data.index];
      postMessage({ type: 'download', name: s.file, blob: new Blob([await structureBytes(s)]) });
    } else if (data.type === 'allStructures') {
      status('Preparando el .zip…');
      const files = [];
      for (const s of structures) {
        if (s.error) continue;
        const folder = s.source === 'world' ? 'guardadas/' : 'packs/';
        files.push(storedEntry(folder + s.file, await structureBytes(s)));
      }
      postMessage({ type: 'download', name: `${data.name || 'estructuras'}.zip`, blob: buildZip(files) });
    }
  } catch (e) {
    postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
