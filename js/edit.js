// Edición segura de un mundo: copia todos los ficheros originales sin tocarlos
// y añade un .log de LevelDB con órdenes de borrado. Al abrir el mundo,
// Minecraft aplica esos borrados. Lo usan «Borrar chunks» y «Borrar estructuras».

import { deletionBatch, encodeLog, logRecords } from './leveldb.js';
import { buildZip, storedEntry } from './zip.js';

/** Fichero .log con los borrados (en lotes para no crear uno gigante). */
export function buildDeletionLog(keys, firstSeq) {
  const BATCH = 20000;
  const batches = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(deletionBatch(keys.slice(i, i + BATCH), firstSeq + i));
  return encodeLog(batches);
}

/** Comprueba que el .log generado se lee y contiene exactamente esos borrados. */
export function verifyDeletionLog(log, keys) {
  let count = 0;
  for (const rec of logRecords(log)) count += new DataView(rec.buffer, rec.byteOffset + 8, 4).getUint32(0, true);
  if (count !== keys.length) throw new Error('Comprobación fallida del registro de borrado.');
}

/** Nombre del .log nuevo: un número mayor que cualquier fichero existente. */
export function newLogName(scan) {
  const next = Math.max(scan.maxFileNumber + 1, scan.manifest?.nextFile || 0);
  return String(next).padStart(6, '0') + '.log';
}

/**
 * @param source { kind:'zip', zip } (de openZip) o { kind:'folder', files:[{path, file}] }
 * @param prefix carpeta del mundo dentro del archivo ('' si está en la raíz)
 * @param scan resultado de un escaneo estricto ({ maxSeq, maxFileNumber, manifest })
 * @param keys Array<Uint8Array> claves de LevelDB a borrar
 * @param skipPaths rutas del archivo que no se copian (p. ej. .mcstructure de packs)
 */
export async function buildWorldWithDeletions(source, prefix, scan, keys, { skipPaths = new Set(), onProgress = () => {} } = {}) {
  const entries = [];
  let logPath = null;
  if (keys.length) {
    const log = buildDeletionLog(keys, scan.maxSeq + 1);
    verifyDeletionLog(log, keys);
    logPath = prefix + 'db/' + newLogName(scan);
    entries.push(storedEntry(logPath, log));
  }
  const originals = [];
  if (source.kind === 'zip') {
    for (const e of source.zip.entries) {
      if (e.name === logPath) throw new Error('Conflicto de nombres al crear el registro de borrado.');
      if (skipPaths.has(e.name)) continue;
      originals.push({ ...e, data: await source.zip.raw(e) });
    }
  } else {
    let i = 0;
    for (const { path, file } of source.files) {
      if (path === logPath) throw new Error('Conflicto de nombres al crear el registro de borrado.');
      onProgress(++i / source.files.length);
      if (skipPaths.has(path)) continue;
      const e = storedEntry(path, new Uint8Array(await file.arrayBuffer()));
      e.data = file; // el navegador lee el File al guardar, sin duplicarlo en memoria
      originals.push(e);
    }
  }
  const all = [...originals, ...entries];
  return { blob: buildZip(all), mcworld: mcworldOf(all, prefix), keys: keys.length, logPath };
}

/**
 * .mcworld para abrir con Minecraft (móvil, consola, PC): solo los ficheros del
 * mundo y con level.dat en la raíz, aunque en el original estuvieran dentro de
 * una carpeta (p. ej. «ybHBK9W9eIM=/» o «worlds/MiMundo/» de un servidor).
 * Devuelve null si no hay mundo (prefix null) o no hay level.dat.
 */
export function mcworldOf(entries, prefix) {
  if (prefix === null || prefix === undefined) return null;
  const inside = entries
    .filter((e) => e.name.startsWith(prefix) && e.name.length > prefix.length)
    .map((e) => ({ ...e, name: e.name.slice(prefix.length) }));
  if (!inside.some((e) => e.name === 'level.dat')) return null;
  // application/octet-stream: así el móvil no le cambia la extensión .mcworld por .zip
  return buildZip(inside, 'application/octet-stream');
}
