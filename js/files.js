// Explorador de archivos del mundo y extracción de estructuras (.mcstructure).
//
// Las estructuras que se guardan con un bloque de estructuras (modo «Guardar»)
// quedan dentro de la base de datos del mundo, en claves
// "structuretemplate_<espacio>:<nombre>". El valor es exactamente el mismo NBT
// que un fichero .mcstructure, así que basta con copiarlo a un fichero.

import { scanLevelDb, keyToString } from './leveldb.js';
import { readNbt } from './nbt.js';

const PREFIX = 'structuretemplate_';
const PREFIX_BYTES = Array.from(PREFIX, (c) => c.charCodeAt(0));

function isStructureKey(k) {
  if (k.length <= PREFIX_BYTES.length || k[0] !== 0x73) return false; // 's'
  for (let i = 0; i < PREFIX_BYTES.length; i++) if (k[i] !== PREFIX_BYTES[i]) return false;
  return true;
}

const utf8 = new TextDecoder('utf-8');

/** Datos básicos de un .mcstructure (tamaño, bloques, entidades...). */
export function describeStructure(bytes) {
  const nbt = readNbt(bytes);
  if (!nbt || typeof nbt !== 'object' || !Array.isArray(nbt.size)) throw new Error('No es una estructura válida.');
  const size = nbt.size.map(Number);
  const s = nbt.structure || {};
  const palette = s.palette?.default?.block_palette || [];
  const indices = Array.isArray(s.block_indices?.[0]) ? s.block_indices[0] : [];
  const airIdx = new Set();
  palette.forEach((b, i) => {
    if (b?.name === 'minecraft:air' || b?.name === 'minecraft:structure_void') airIdx.add(i);
  });
  let blocks = 0;
  for (const i of indices) if (i >= 0 && !airIdx.has(i)) blocks++;
  const counts = new Map();
  for (const i of indices) {
    if (i < 0 || airIdx.has(i)) continue;
    const name = palette[i]?.name || '?';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    size,
    blocks,
    entities: Array.isArray(s.entities) ? s.entities.length : 0,
    blockEntities: Object.keys(s.palette?.default?.block_position_data || {}).length,
    origin: Array.isArray(nbt.structure_world_origin) ? nbt.structure_world_origin.map(Number) : null,
    top,
  };
}

/** Nombre de fichero seguro para una estructura ("mystructure:casa" -> "casa.mcstructure"). */
export function structureFileName(id, used = new Set()) {
  const [ns, name] = id.includes(':') ? id.split(/:(.*)/s) : ['', id];
  let base = (ns && ns !== 'mystructure' ? `${ns}_${name}` : name) || 'estructura';
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'estructura';
  let file = base + '.mcstructure';
  for (let n = 2; used.has(file.toLowerCase()); n++) file = `${base} (${n}).mcstructure`;
  used.add(file.toLowerCase());
  return file;
}

/**
 * Busca las estructuras guardadas en la base de datos del mundo.
 * @returns Array<{ id, file, bytes, info|null, error|null }>
 */
export async function findStructures(dbFiles, { onProgress = () => {} } = {}) {
  const latest = new Map(); // id -> { seq, value }
  const onEntry = (key, seq, value) => {
    if (!isStructureKey(key)) return;
    const id = utf8.decode(key.subarray(PREFIX_BYTES.length));
    const prev = latest.get(id);
    if (!prev || prev.seq < seq) latest.set(id, { seq, value: value ? value.slice() : null });
  };
  const { warnings } = await scanLevelDb(dbFiles, { onEntry, onProgress });
  const used = new Set();
  const out = [];
  for (const [id, { value }] of [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!value) continue; // borrada
    let info = null;
    let error = null;
    try {
      info = describeStructure(value);
    } catch (e) {
      error = e.message;
    }
    out.push({ id, file: structureFileName(id, used), bytes: value, info, error });
  }
  return { structures: out, warnings };
}

/** Árbol de carpetas a partir de una lista de rutas. */
export function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], size: 0, count: 0 };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    node.size += f.size;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) {
        node.dirs.set(name, { name, path: parts.slice(0, i + 1).join('/') + '/', dirs: new Map(), files: [], size: 0, count: 0 });
      }
      node = node.dirs.get(name);
      node.size += f.size;
      node.count++;
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path, size: f.size });
  }
  return root;
}

export { keyToString };
