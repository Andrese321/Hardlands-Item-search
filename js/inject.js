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

/**
 * Nombre corto sugerido para nombres largos de descargas
 * («eva-01-evangeli-u5wh26fb» → «eva-01»). Devuelve null si ya es corto.
 */
export function shortName(name) {
  if (name.length <= 16) return null;
  const parts = name.split(/[-_]+/).filter(Boolean);
  // fuera trozos con pinta de código aleatorio (letras y números mezclados, 6+ caracteres)
  const clean = parts.filter((p) => !(p.length >= 6 && /[a-z]/.test(p) && /[0-9]/.test(p)));
  const filler = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'of', 'the', 'and', 'a']);
  let out = '';
  for (const p of clean.length ? clean : parts) {
    out = out ? `${out}-${p}` : p;
    if (out.length >= 6 && !filler.has(p)) break; // no terminar en «del», «de»...
  }
  return out && out !== name ? out.slice(0, 16) : null;
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
export function buildMcpack(structures, { packName = 'Estructuras', icon = null, loader = true } = {}) {
  const manifest = packManifest({
    name: packName,
    description: `${structures.length} ${structures.length === 1 ? 'estructura' : 'estructuras'}: ` +
      structures.map((s) => structureId(s.name)).join(', ') + (loader ? ` · /scriptevent ${LOADER_EVENT} <nombre>` : ''),
    loader,
  });
  const enc = new TextEncoder();
  const files = [storedEntry('manifest.json', enc.encode(JSON.stringify(manifest, null, 2)))];
  if (icon) files.push(storedEntry('pack_icon.png', icon));
  if (loader) files.push(storedEntry('scripts/main.js', enc.encode(loaderScript(structures.map((s) => ({ name: s.name, size: s.info?.size || s.size || [1, 1, 1] }))))));
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

// ---------------------------------------------------------------- cargador automático (addon con script)
//
// Problema: con /structure load, las partes de una estructura grande que caen en
// chunks no cargados se quedan «en cola» y no aparecen hasta que alguien se acerca.
// Solución: un script (API estable @minecraft/server 1.12.0, Minecraft 1.21.0+) que
//   1. crea áreas de carga (ticking areas) que cubren toda la zona,
//   2. espera a que todos los chunks estén cargados, mostrando el progreso,
//   3. coloca la estructura entera y después quita las áreas de carga.
// Uso en el juego: /scriptevent hardlands:cargar <nombre> [90|180|270]
//                  /scriptevent hardlands:lista

export const LOADER_EVENT = 'hardlands:cargar';
export const LOADER_LIST_EVENT = 'hardlands:lista';
export const SCRIPT_API = '1.12.0';
// Identificadores fijos del cargador que se mete dentro de un mundo (así no se duplica).
export const WORLD_LOADER_UUIDS = ['8f2b6c1e-4d3a-4f6b-9a1e-5c7d2e8b3f40', 'c41e9a7d-2b5f-4e8c-a3d6-9f0b1e7c5a28', '5d8a3f2c-7e1b-4c9d-8f6a-2b4e0c9d7a13'];

/** Código del script (scripts/main.js). `structures`: Array<{ name, size: [x, y, z] }>. */
export function loaderScript(structures) {
  const list = Object.fromEntries(structures.map((s) => [s.name, s.size]));
  return `// Cargador de estructuras Hardlands (creado con la app Hardlands).
// Con los trucos activados:
//   /scriptevent ${LOADER_EVENT} <nombre> [90|180|270]   coloca la estructura centrada donde estás
//   /scriptevent ${LOADER_LIST_EVENT}                    muestra las estructuras disponibles
// Antes de colocarla carga toda la zona con áreas de carga temporales, para que
// aparezca entera aunque sea muy grande.
import { world, system } from '@minecraft/server';

/** @type {Record<string, number[]>} */
const STRUCTURES = ${JSON.stringify(list)};
const AREA = 'hardlands_carga_';
const LOCK = 'hardlands_bloqueo';
const ROTATIONS = { 0: 'None', 90: 'Rotate90', 180: 'Rotate180', 270: 'Rotate270' };
const MAX_AREA_CHUNKS = 100; // límite del juego por área de carga
const MAX_AREAS = 8;

/** @param {import('@minecraft/server').Player | undefined} player @param {string} text */
function tell(player, text) {
  try {
    if (player) player.sendMessage(text);
    else world.sendMessage(text);
  } catch (e) {
    // jugador desconectado
  }
}

/** @param {import('@minecraft/server').Player} player @param {string} text */
function bar(player, text) {
  try {
    player.onScreenDisplay.setActionBar(text);
  } catch (e) {
    // jugador desconectado
  }
}

/** @param {import('@minecraft/server').Dimension} dimension @param {string} command */
function run(dimension, command) {
  try {
    dimension.runCommand(command);
    return true;
  } catch (e) {
    return false;
  }
}

// Bloqueo compartido: si hay varios paquetes con este cargador, solo actúa uno.
function lock() {
  const old = world.scoreboard.getObjective(LOCK);
  if (old) {
    const since = Number(old.displayName);
    if (Date.now() - since < 120000) return false;
    world.scoreboard.removeObjective(LOCK);
  }
  world.scoreboard.addObjective(LOCK, String(Date.now()));
  return true;
}

function unlock() {
  try {
    world.scoreboard.removeObjective(LOCK);
  } catch (e) {
    // ya no existe
  }
}

/** Para comparar nombres sin fijarse en mayúsculas, guiones ni «mystructure:». @param {string} s */
function norm(s) {
  return s.toLowerCase().replace(/^mystructure:/, '').replace(/[^a-z0-9]/g, '');
}

/** Estructuras conocidas: las de este paquete y las guardadas en el mundo. @returns {Map<string, string>} nombre → id */
function knownStructures() {
  const known = new Map();
  for (const n of Object.keys(STRUCTURES)) known.set(n, 'mystructure:' + n);
  try {
    for (const id of world.structureManager.getWorldStructureIds()) {
      known.set(id.startsWith('mystructure:') ? id.slice(12) : id, id);
    }
  } catch (e) {
    // no se pudieron listar las del mundo
  }
  return known;
}

/**
 * Busca la estructura por nombre exacto o aproximado («eva01» encuentra
 * «eva-01-evangeli-u5wh26fb»). @param {string} input
 * @returns {{ id: string, name: string, many: string[] | null } | undefined}
 */
function resolve(input) {
  const known = knownStructures();
  const want = norm(input);
  const entries = [...known.entries()];
  for (const test of [(/** @type {string} */ n) => n === want, (/** @type {string} */ n) => n.startsWith(want), (/** @type {string} */ n) => n.includes(want)]) {
    const found = want ? entries.filter(([name]) => test(norm(name))) : [];
    if (found.length === 1) return { name: found[0][0], id: found[0][1], many: null };
    if (found.length > 1) return { name: '', id: '', many: found.map(([name]) => name) };
  }
  // estructuras de otros paquetes: solo con el nombre exacto
  const id = input.includes(':') ? input : 'mystructure:' + input;
  if (world.structureManager.get(id)) return { id, name: input, many: null };
  return undefined;
}

/** @param {string} id @returns {number[] | undefined} */
function sizeOf(id) {
  const short = id.startsWith('mystructure:') ? id.slice(12) : id;
  if (STRUCTURES[short]) return STRUCTURES[short];
  const s = world.structureManager.get(id);
  return s ? [s.size.x, s.size.y, s.size.z] : undefined;
}

/** @param {import('@minecraft/server').Player | undefined} player */
function listStructures(player) {
  const names = [...knownStructures().keys()];
  tell(player, '§eEstructuras disponibles: §f' + (names.length
    ? names.map((n) => n + (STRUCTURES[n] ? ' (' + STRUCTURES[n].join('×') + ')' : '')).join(', ')
    : 'ninguna'));
  tell(player, '§7Uso: /scriptevent ${LOADER_EVENT} <nombre> [90|180|270] · vale escribir solo el principio del nombre.');
}

/** @param {import('@minecraft/server').Player} player @param {string} name @param {number} angle */
function load(player, name, angle) {
  const found = resolve(name);
  if (!found) {
    tell(player, '§cNo encuentro la estructura «' + name + '».');
    listStructures(player);
    return;
  }
  if (found.many) {
    tell(player, '§eHay varias estructuras que coinciden: §f' + found.many.join(', ') + '§e. Escribe un nombre más completo.');
    return;
  }
  const id = found.id;
  if (norm(found.name) !== norm(name)) tell(player, '§7Usando «' + found.name + '».');
  const size = sizeOf(id);
  if (!size) {
    tell(player, '§cNo se pudo leer el tamaño de «' + id + '».');
    return;
  }
  const rotation = ROTATIONS[angle] || 'None';
  const turned = angle === 90 || angle === 270;
  const sx = turned ? size[2] : size[0];
  const sy = size[1];
  const sz = turned ? size[0] : size[2];
  const dimension = player.dimension;
  const range = dimension.heightRange;
  if (sy > range.max - range.min) {
    tell(player, '§cMide ' + sy + ' bloques de alto y no cabe en esta dimensión.');
    return;
  }
  if (!lock()) {
    tell(player, '§eYa se está cargando una estructura. Espera a que termine.');
    return;
  }

  // Centrada donde está el jugador si es grande; si no, con una esquina en sus pies.
  const p = player.location;
  const big = sx > 32 || sz > 32;
  const x = Math.floor(p.x) - (big ? Math.floor(sx / 2) : 0);
  const z = Math.floor(p.z) - (big ? Math.floor(sz / 2) : 0);
  let y = Math.floor(p.y);
  if (y + sy > range.max) y = range.max - sy;
  if (y < range.min) y = range.min;

  // Chunks que ocupa
  const cx0 = Math.floor(x / 16);
  const cz0 = Math.floor(z / 16);
  const cx1 = Math.floor((x + sx - 1) / 16);
  const cz1 = Math.floor((z + sz - 1) / 16);
  const chunks = [];
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) chunks.push({ x: cx * 16 + 8, y, z: cz * 16 + 8 });

  // Áreas de carga en franjas de como mucho 100 chunks
  for (let i = 0; i < MAX_AREAS; i++) run(dimension, 'tickingarea remove ' + AREA + i);
  const width = cx1 - cx0 + 1;
  const rowsPerArea = Math.max(1, Math.floor(MAX_AREA_CHUNKS / width));
  let areas = 0;
  if (width <= MAX_AREA_CHUNKS) {
    for (let r = cz0; r <= cz1 && areas < MAX_AREAS; r += rowsPerArea) {
      const r1 = Math.min(cz1, r + rowsPerArea - 1);
      if (run(dimension, 'tickingarea add ' + cx0 * 16 + ' ' + y + ' ' + r * 16 + ' ' + (cx1 * 16 + 15) + ' ' + y + ' ' + (r1 * 16 + 15) + ' ' + AREA + areas)) areas++;
    }
  }
  const coveredAll = areas > 0 && areas * rowsPerArea >= cz1 - cz0 + 1;
  tell(player, '§eCargando la zona de «' + id + '» (' + chunks.length + ' chunks)…' + (coveredAll ? '' : ' §7(es muy grande: una parte aparecerá al acercarte)'));

  let tries = 0;
  const handle = system.runInterval(() => {
    tries++;
    let loaded = 0;
    for (const c of chunks) {
      try {
        if (dimension.getBlock(c)) loaded++;
      } catch (e) {
        // chunk aún sin cargar
      }
    }
    bar(player, '§eCargando la zona: ' + loaded + '/' + chunks.length + ' chunks');
    if (loaded < chunks.length && tries < 240) return; // como mucho ~1 minuto
    system.clearRun(handle);
    try {
      world.structureManager.place(id, dimension, { x, y, z }, { rotation: /** @type {any} */ (rotation), includeEntities: true, includeBlocks: true });
      bar(player, '§a¡Estructura colocada!');
      tell(player, '§aListo: «' + id + '» colocada en ' + x + ' ' + y + ' ' + z +
        (loaded < chunks.length ? ' §7(algunos chunks no se cargaron a tiempo: esa parte aparecerá al acercarte)' : '') + '.');
    } catch (e) {
      tell(player, '§cNo se pudo colocar «' + id + '»: ' + e);
    }
    // Se deja la zona cargada unos segundos para que termine de guardarse
    system.runTimeout(() => {
      for (let i = 0; i < MAX_AREAS; i++) run(dimension, 'tickingarea remove ' + AREA + i);
      unlock();
    }, 100);
  }, 5);
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== '${LOADER_EVENT}' && event.id !== '${LOADER_LIST_EVENT}') return;
  const source = event.sourceEntity;
  const player = source && source.typeId === 'minecraft:player' ? /** @type {import('@minecraft/server').Player} */ (source) : undefined;
  if (event.id === '${LOADER_LIST_EVENT}') {
    listStructures(player);
    return;
  }
  const args = event.message.trim().split(/\\s+/).filter((a) => a);
  if (!player) {
    tell(undefined, '§cEscribe el comando desde el chat del juego (como jugador).');
    return;
  }
  if (!args.length) {
    listStructures(player);
    return;
  }
  const angle = Number(args[1] || 0);
  if (![0, 90, 180, 270].includes(angle)) {
    tell(player, '§cEl giro tiene que ser 90, 180 o 270.');
    return;
  }
  load(player, args[0], angle);
});
`;
}

/** manifest.json de un paquete con estructuras y (opcional) el cargador automático. */
export function packManifest({ name, description, uuids = [newUuid(), newUuid(), newUuid()], loader = true }) {
  const manifest = {
    format_version: 2,
    header: { name, description, uuid: uuids[0], version: [1, 0, 0], min_engine_version: [1, 21, 0] },
    modules: [{ type: 'data', uuid: uuids[1], version: [1, 0, 0] }],
  };
  if (loader) {
    manifest.modules.push({ type: 'script', language: 'javascript', uuid: uuids[2], entry: 'scripts/main.js', version: [1, 0, 0] });
    manifest.dependencies = [{ module_name: '@minecraft/server', version: SCRIPT_API }];
  }
  return manifest;
}

/**
 * Ficheros para meter el cargador automático DENTRO de un mundo: el paquete en
 * behavior_packs/hardlands_cargador/ y su entrada en world_behavior_packs.json
 * (se conserva lo que ya hubiera). Usa identificadores fijos, así que volver a
 * meterlo reemplaza el anterior en vez de duplicarlo.
 * @param existingJson contenido actual de world_behavior_packs.json (o null)
 */
export function worldLoaderFiles(prefix, structures, existingJson = null, icon = null) {
  const enc = new TextEncoder();
  const dir = prefix + 'behavior_packs/hardlands_cargador/';
  const manifest = packManifest({
    name: 'Cargador de estructuras Hardlands',
    description: `/scriptevent ${LOADER_EVENT} <nombre> · carga la zona y coloca la estructura entera`,
    uuids: WORLD_LOADER_UUIDS,
    loader: true,
  });
  let packs = [];
  try {
    const parsed = existingJson ? JSON.parse(new TextDecoder().decode(existingJson)) : [];
    if (Array.isArray(parsed)) packs = parsed;
  } catch {
    packs = [];
  }
  packs = packs.filter((p) => p && p.pack_id !== WORLD_LOADER_UUIDS[0]);
  packs.push({ pack_id: WORLD_LOADER_UUIDS[0], version: [1, 0, 0] });
  const files = [
    { path: dir + 'manifest.json', bytes: enc.encode(JSON.stringify(manifest, null, 2)) },
    { path: dir + 'scripts/main.js', bytes: enc.encode(loaderScript(structures)) },
    { path: prefix + 'world_behavior_packs.json', bytes: enc.encode(JSON.stringify(packs, null, 2)) },
  ];
  if (icon) files.push({ path: dir + 'pack_icon.png', bytes: icon });
  return files;
}
