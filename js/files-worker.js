// Trabajo pesado del explorador de archivos (fuera del hilo de la interfaz).

import { buildZip, storedEntry } from './zip.js';
import { openArchive } from './archive.js';
import { findWorlds } from './world.js';
import { findStructures, describeStructure, structureFileName } from './files.js';
import { buildWorldWithDeletions, buildWorldWithChanges } from './edit.js';
import { injectionRecords, structureId, worldLoaderFiles } from './inject.js';

let entries = []; // { path, size, read() }
let structures = []; // { id, key?, file, source, path?, bytes?, info, error }
let source = null; // { kind:'zip', zip } | { kind:'folder', files:[{path, file}] }
let prefix = null; // carpeta del mundo dentro del archivo
let scanInfo = null; // datos del escaneo para poder crear una copia con borrados
let canEdit = false;
let editBlocked = ''; // motivo por el que no se puede borrar
let worldName = '';
let pendingInject = null; // estructuras a meter cuando termine de abrirse el mundo

const status = (text) => postMessage({ type: 'status', text });

async function open(data) {
  status('Abriendo archivo…');
  if (data.zip) {
    let lastPct = -1;
    const arc = await openArchive(data.zip, {
      onProgress: (p) => {
        const pct = Math.floor(p * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        status(`Descomprimiendo el archivo… ${pct} %`);
        postMessage({ type: 'progress', value: p });
      },
    });
    source = arc.editSource;
    entries = arc.entries.map((e) => ({ path: e.name, size: e.size, read: () => arc.read(e) }));
  } else {
    const files = data.files.map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), file: f }));
    source = { kind: 'folder', files };
    entries = files.map(({ path, file }) => ({
      path,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    }));
  }
  postMessage({ type: 'files', files: entries.map(({ path, size }) => ({ path, size })) });
  const worlds = findWorlds(entries.map((e) => e.path));
  if (worlds.length > 1) postMessage({ type: 'choose', worlds });
  else await scan(worlds[0] ?? null);
}

async function scan(worldPrefix) {
  prefix = worldPrefix;
  scanInfo = null;
  canEdit = false;
  editBlocked = '';
  structures = [];
  const warnings = [];
  worldName = '';
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
      scanInfo = res.scan;
      // Solo se permite borrar si la base de datos se ha leído entera y sin errores.
      canEdit = !res.warnings.length && !!res.scan.manifest;
      if (!canEdit) {
        editBlocked = 'La base de datos del mundo no se pudo leer entera (' +
          (res.warnings[0] || 'falta el MANIFEST') + '). Para no estropear el mundo, no se puede borrar nada de él.';
      }
    } catch (e) {
      warnings.push('No se pudo leer la base de datos del mundo: ' + e.message);
      editBlocked = 'No se pudo leer la base de datos del mundo: ' + e.message;
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
    canEdit: canEdit || prefix === null,
    editBlocked,
    structures: structures.map(({ bytes, key, ...rest }) => rest),
  });

  if (pendingInject) {
    const { structures: list, loader, icon } = pendingInject;
    pendingInject = null;
    await inject(list, { loader, icon });
  }
}

/** Mete estructuras (.mcstructure) en la base de datos del mundo abierto. */
async function inject(list, { loader = false, icon = null } = {}) {
  if (prefix === null) throw new Error('Ese archivo no contiene un mundo de Minecraft (falta la carpeta «db»).');
  if (!canEdit) throw new Error(editBlocked || 'No se puede editar este mundo.');
  status('Metiendo las estructuras en el mundo…');
  const existing = new Set(structures.filter((s) => s.source === 'world').map((s) => s.id));
  const ids = list.map((s) => structureId(s.name));
  let extraFiles = [];
  if (loader) {
    const current = entries.find((e) => e.path === prefix + 'world_behavior_packs.json');
    extraFiles = worldLoaderFiles(prefix, list.map((s) => ({ name: s.name, size: s.size })), current ? await current.read() : null, icon);
  }
  const out = await buildWorldWithChanges(source, prefix, scanInfo, injectionRecords(list), {
    extraFiles,
    onProgress: (value) => postMessage({ type: 'progress', value }),
  });
  postMessage({
    type: 'injected', blob: out.blob, mcworld: out.mcworld, nested: !!prefix, worldName,
    ids, replaced: ids.filter((id) => existing.has(id)), loader,
  });
}

async function structureBytes(s) {
  if (s.bytes) return s.bytes;
  return entries.find((e) => e.path === s.path).read();
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      pendingInject = data.inject || null;
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
    } else if (data.type === 'delete') {
      const chosen = data.indices.map((i) => structures[i]).filter(Boolean);
      if (!chosen.length) throw new Error('No hay estructuras seleccionadas.');
      status('Creando la copia del mundo…');
      const keys = chosen.filter((s) => s.source === 'world').map((s) => s.key);
      if (keys.length && !canEdit) throw new Error('No se puede editar este mundo: su base de datos no se pudo leer entera.');
      const skipPaths = new Set(chosen.filter((s) => s.source === 'pack').map((s) => s.path));
      const out = await buildWorldWithDeletions(source, prefix ?? '', scanInfo ?? { maxSeq: 0, maxFileNumber: 0 }, keys, {
        skipPaths,
        onProgress: (value) => postMessage({ type: 'progress', value }),
      });
      postMessage({ type: 'deleted', blob: out.blob, mcworld: out.mcworld, nested: !!prefix, world: keys.length, packs: skipPaths.size, names: chosen.map((s) => s.id) });
    } else if (data.type === 'inject') {
      await inject(data.structures, { loader: data.loader, icon: data.icon });
    }
  } catch (e) {
    pendingInject = null;
    postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
