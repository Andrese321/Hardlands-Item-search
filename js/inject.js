// Meter estructuras (.mcstructure sueltos) en Minecraft, de dos formas:
//
// 1. Un paquete de comportamiento (.mcpack) con las estructuras en «structures/».
//    Sirve para cualquier mundo, Realm o servidor; hay que activarlo en el mundo.
// 2. Dentro de un mundo: se escriben en su base de datos con la clave
//    «structuretemplate_mystructure:<nombre>», igual que hace el bloque de
//    estructuras al guardar. No hace falta activar ningún paquete.
//
// En los dos casos se cargan en el juego con /structure load mystructure:<nombre> ~ ~ ~
// (Minecraft busca primero en el mundo y después en los paquetes).

import { describeStructure } from './files.js';
import { buildZip, storedEntry } from './zip.js';

export const NAMESPACE = 'mystructure';

/** Nombre válido para el juego a partir del nombre del fichero ("Mi Casa (2).mcstructure" → "mi_casa_2"). */
export function structureName(fileName) {
  const base = String(fileName || '')
    .replace(/\.mcstructure$/i, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'estructura';
}

/** Hace únicos los nombres añadiendo _2, _3... */
export function uniqueNames(names) {
  const used = new Set();
  return names.map((n) => {
    let name = n;
    for (let i = 2; used.has(name); i++) name = `${n}_${i}`;
    used.add(name);
    return name;
  });
}

/**
 * Comprueba que el fichero sea un .mcstructure de Bedrock.
 * @returns info de describeStructure (tamaño, bloques...)
 */
export function checkStructureFile(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new Error('Es una estructura de Java (.nbt comprimido): Bedrock no puede cargarla.');
  }
  if (bytes[0] !== 0x0a) throw new Error('No es un archivo .mcstructure.');
  let info;
  try {
    info = describeStructure(bytes);
  } catch {
    throw new Error('No es un .mcstructure válido (no se pudo leer).');
  }
  if (!info.size.every((n) => Number.isInteger(n) && n > 0)) throw new Error('El .mcstructure tiene un tamaño no válido.');
  return info;
}

export const structureId = (name) => `${NAMESPACE}:${name}`;

/** Clave de LevelDB donde el juego guarda una estructura. */
export function structureKey(name) {
  return new TextEncoder().encode('structuretemplate_' + structureId(name));
}

/** Escrituras para meter las estructuras en la base de datos del mundo. */
export function injectionRecords(structures) {
  return structures.map((s) => ({ key: structureKey(s.name), value: s.bytes }));
}

export function newUuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Crea un paquete de comportamiento (.mcpack) con las estructuras.
 * @param structures Array<{ name, bytes }>
 * @param opts.packName nombre que se verá en Minecraft
 * @param opts.icon PNG opcional para el icono del paquete
 */
export function buildMcpack(structures, { packName = 'Estructuras', icon = null } = {}) {
  const manifest = {
    format_version: 2,
    header: {
      name: packName,
      description: `${structures.length} ${structures.length === 1 ? 'estructura' : 'estructuras'}: ` +
        structures.map((s) => structureId(s.name)).join(', '),
      uuid: newUuid(),
      version: [1, 0, 0],
      min_engine_version: [1, 20, 0],
    },
    modules: [{ type: 'data', uuid: newUuid(), version: [1, 0, 0] }],
  };
  const files = [storedEntry('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)))];
  if (icon) files.push(storedEntry('pack_icon.png', icon));
  for (const s of structures) files.push(storedEntry(`structures/${s.name}.mcstructure`, s.bytes));
  // application/octet-stream: así el móvil no cambia la extensión .mcpack por .zip
  return { blob: buildZip(files, 'application/octet-stream'), manifest };
}

/**
 * Comando para pegar la estructura, ajustado a su tamaño:
 * - si es grande (más de 32 bloques de ancho), centrada donde está el jugador;
 * - si es muy alta, empezando a una altura con la que no se salga del mundo (Y máx. 319).
 * @param size [x, y, z] de la estructura
 * @returns { cmd, notes: [] }
 */
export function loadCommand(name, size = [1, 1, 1]) {
  const [sx, sy, sz] = size;
  const notes = [];
  const center = sx > 32 || sz > 32;
  const x = center ? `~-${Math.floor(sx / 2)}` : '~';
  const z = center ? `~-${Math.floor(sz / 2)}` : '~';
  const maxY = 320 - sy; // el bloque más alto queda en Y + alto - 1 ≤ 319
  let y = '~';
  if (sy > 160) {
    y = String(Math.min(64, maxY));
    notes.push(`Mide ${sy} bloques de alto: tiene que empezar en Y ${maxY} o más abajo para no salirse del mundo, por eso el comando usa Y ${y}.`);
  } else if (sy > 64) {
    notes.push(`Mide ${sy} bloques de alto: ponte por debajo de Y ${maxY} antes de usarlo, o no cabrá.`);
  }
  if (center) {
    notes.push(`Mide ${sx} × ${sz} bloques: el comando la centra donde estás (más ancha de 64, el bloque de estructuras no puede cargarla; usa el comando).`);
  } else {
    notes.push('Aparece con una esquina en tus pies y se extiende hacia +X y +Z.');
  }
  notes.push('Todo lo que haya en ese espacio se reemplaza (también por aire): ponla en una zona despejada.');
  return { cmd: `/structure load ${structureId(name)} ${x} ${y} ${z}`, notes };
}
