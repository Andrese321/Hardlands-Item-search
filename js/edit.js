// Edición segura de un mundo: copia todos los ficheros originales sin tocarlos
// y añade un .log de LevelDB con los cambios (borrados o escrituras). Al abrir
// el mundo, Minecraft aplica ese registro. Lo usan «Borrar chunks», «Borrar
// estructuras» y «Meter estructuras».

import { writeBatch, encodeLog, logRecords } from './leveldb.js';
import { buildZip, storedEntry } from './zip.js';

/**
 * Fichero .log con los cambios, en lotes para no crear uno gigante.
 * @param records Array<{ key: Uint8Array, value: Uint8Array | null }> (null = borrar)
 */
export function buildChangeLog(records, firstSeq) {
  const MAX_RECORDS = 20000;
  const MAX_BYTES = 4 * 1024 * 1024;
  const batches = [];
  let start = 0;
  while (start < records.length) {
    let end = start;
    let bytes = 0;
    while (end < records.length && end - start < MAX_RECORDS && (end === start || bytes < MAX_BYTES)) {
      bytes += records[end].key.length + (records[end].value?.length || 0);
      end++;
    }
    batches.push(writeBatch(records.slice(start, end), firstSeq + start));
    start = end;
  }
  return encodeLog(batches);
}

/** Fichero .log con borrados. */
export function buildDeletionLog(keys, firstSeq) {
  return buildChangeLog(keys.map((key) => ({ key, value: null })), firstSeq);
}

/** Comprueba que el .log generado se lee y contiene exactamente esos cambios. */
export function verifyDeletionLog(log, records) {
  let count = 0;
  for (const rec of logRecords(log)) count += new DataView(rec.buffer, rec.byteOffset + 8, 4).getUint32(0, true);
  if (count !== records.length) throw new Error('Comprobación fallida del registro de cambios.');
}

/** Nombre del .log nuevo: un número mayor que cualquier fichero existente. */
export function newLogName(scan) {
  const next = Math.max(scan.maxFileNumber + 1, scan.manifest?.nextFile || 0);
  return String(next).padStart(6, '0') + '.log';
}

/**
 * Copia del mundo con borrados de claves de LevelDB.
 * @param source { kind:'zip', zip } (de openZip) o { kind:'folder', files:[{path, file}] }
 * @param prefix carpeta del mundo dentro del archivo ('' si está en la raíz)
 * @param scan resultado de un escaneo estricto ({ maxSeq, maxFileNumber, manifest })
 * @param keys Array<Uint8Array> claves de LevelDB a borrar
 * @param skipPaths rutas del archivo que no se copian (p. ej. .mcstructure de packs)
 */
export function buildWorldWithDeletions(source, prefix, scan, keys, opts = {}) {
  return buildWorldWithChanges(source, prefix, scan, keys.map((key) => ({ key, value: null })), opts);
}

/**
 * Copia del mundo con cambios en LevelDB (escrituras y borrados).
 * @param records Array<{ key, value | null }>
 */
export async function buildWorldWithChanges(source, prefix, scan, records, { skipPaths = new Set(), onProgress = () => {} } = {}) {
  const entries = [];
  let logPath = null;
  if (records.length) {
    const log = buildChangeLog(records, scan.maxSeq + 1);
    verifyDeletionLog(log, records);
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
  return { blob: buildZip(all), mcworld: mcworldOf(all, prefix), keys: records.length, logPath };
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
