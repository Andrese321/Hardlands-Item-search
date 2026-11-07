// Lector (solo lectura) de la variante de LevelDB que usa Minecraft Bedrock.
//
// Mojang usa LevelDB normal pero comprime los bloques con zlib:
//   tipo 2 = zlib con cabecera, tipo 4 = zlib "raw" (deflate sin cabecera).
// También se admite snappy (tipo 1) y bloques sin comprimir (tipo 0).
//
// No hace falta toda la maquinaria de LevelDB: leemos todas las tablas
// (.ldb/.sst) y los registros (.log) vivos, y para cada clave nos quedamos
// con la versión de número de secuencia más alto (si es un borrado, la clave
// no existe).

import { inflateSync, unzlibSync } from '../vendor/fflate.js';

// ---------- utilidades ----------

function readVarint(bytes, pos) {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Error('LevelDB: varint truncado');
    const b = bytes[pos++];
    result += (b & 0x7f) * mul;
    if (b < 0x80) return [result, pos];
    mul *= 128;
  }
  throw new Error('LevelDB: varint no válido');
}

function readLenPrefixed(bytes, pos) {
  const [len, p] = readVarint(bytes, pos);
  if (p + len > bytes.length) throw new Error('LevelDB: dato truncado');
  return [bytes.subarray(p, p + len), p + len];
}

function u32(bytes, pos) {
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
}

// Número de 56 bits (secuencia) guardado en 7 bytes little-endian.
function u56(bytes, pos) {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 7; i++) {
    v += bytes[pos + i] * mul;
    mul *= 256;
  }
  return v;
}

export function keyToString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function stringToKey(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- CRC32C (para descartar registros dañados en los .log) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function unmaskCrc(masked) {
  const rot = (masked - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

// ---------- snappy ----------

function snappyDecompress(src) {
  let [len, pos] = readVarint(src, 0);
  const out = new Uint8Array(len);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let l = tag >>> 2;
      if (l >= 60) {
        const nb = l - 59;
        l = 0;
        for (let i = 0; i < nb; i++) l |= src[pos++] << (8 * i);
      }
      l += 1;
      out.set(src.subarray(pos, pos + l), op);
      pos += l;
      op += l;
    } else {
      let l;
      let off;
      if (kind === 1) {
        l = ((tag >>> 2) & 7) + 4;
        off = ((tag >>> 5) << 8) | src[pos++];
      } else if (kind === 2) {
        l = (tag >>> 2) + 1;
        off = src[pos] | (src[pos + 1] << 8);
        pos += 2;
      } else {
        l = (tag >>> 2) + 1;
        off = u32(src, pos);
        pos += 4;
      }
      if (off === 0 || off > op) throw new Error('snappy: desplazamiento no válido');
      for (let i = 0; i < l; i++, op++) out[op] = out[op - off];
    }
  }
  return out;
}

function decompressBlock(raw, type) {
  switch (type) {
    case 0: return raw;
    case 1: return snappyDecompress(raw);
    case 2: return unzlibSync(raw);
    case 4: return inflateSync(raw);
    default: throw new Error('LevelDB: compresión desconocida ' + type);
  }
}

// ---------- formato de registro (.log y MANIFEST) ----------

const LOG_BLOCK = 32768;

export function* logRecords(bytes) {
  let pos = 0;
  let parts = null;
  while (pos + 7 <= bytes.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK);
    if (left < 7) {
      pos += left;
      continue;
    }
    const len = bytes[pos + 4] | (bytes[pos + 5] << 8);
    const type = bytes[pos + 6];
    const start = pos + 7;
    const end = start + len;
    if (type === 0 || end > bytes.length || len > left - 7) {
      // Relleno o registro truncado: saltar al siguiente bloque.
      parts = null;
      pos += left;
      continue;
    }
    const expected = unmaskCrc(u32(bytes, pos));
    // El CRC cubre el byte de tipo y los datos.
    const ok = crc32c(bytes, pos + 6, end) === expected;
    pos = end;
    if (!ok) {
      parts = null;
      continue;
    }
    const data = bytes.subarray(start, end);
    if (type === 1) {
      parts = null;
      yield data;
    } else if (type === 2) {
      parts = [data];
    } else if (type === 3) {
      if (parts) parts.push(data);
    } else if (type === 4) {
      if (parts) {
        parts.push(data);
        yield concat(parts);
      }
      parts = null;
    } else {
      parts = null;
    }
  }
}

// Recorre un WriteBatch: llama a cb(key, seq, value|null).
function readWriteBatch(data, cb) {
  if (data.length < 12) return;
  const seq = u32(data, 0) + u32(data, 4) * 4294967296;
  const count = u32(data, 8);
  let pos = 12;
  for (let i = 0; i < count && pos < data.length; i++) {
    const tag = data[pos++];
    let key;
    [key, pos] = readLenPrefixed(data, pos);
    if (tag === 1) {
      let value;
      [value, pos] = readLenPrefixed(data, pos);
      cb(key, seq + i, value);
    } else if (tag === 0) {
      cb(key, seq + i, null);
    } else {
      throw new Error('LevelDB: WriteBatch no válido');
    }
  }
}

// ---------- MANIFEST ----------

export function parseManifest(bytes) {
  const live = new Map(); // número de fichero -> nivel
  let logNumber = 0;
  let prevLogNumber = 0;
  for (const rec of logRecords(bytes)) {
    let pos = 0;
    while (pos < rec.length) {
      let tag;
      [tag, pos] = readVarint(rec, pos);
      switch (tag) {
        case 1: [, pos] = readLenPrefixed(rec, pos); break; // comparador
        case 2: [logNumber, pos] = readVarint(rec, pos); break;
        case 3: [, pos] = readVarint(rec, pos); break; // siguiente fichero
        case 4: [, pos] = readVarint(rec, pos); break; // última secuencia
        case 5: [, pos] = readVarint(rec, pos); [, pos] = readLenPrefixed(rec, pos); break;
        case 6: {
          let num;
          [, pos] = readVarint(rec, pos);
          [num, pos] = readVarint(rec, pos);
          live.delete(num);
          break;
        }
        case 7: {
          let level;
          let num;
          [level, pos] = readVarint(rec, pos);
          [num, pos] = readVarint(rec, pos);
          [, pos] = readVarint(rec, pos); // tamaño
          [, pos] = readLenPrefixed(rec, pos);
          [, pos] = readLenPrefixed(rec, pos);
          live.set(num, level);
          break;
        }
        case 9: [prevLogNumber, pos] = readVarint(rec, pos); break;
        default:
          throw new Error('MANIFEST: etiqueta desconocida ' + tag);
      }
    }
  }
  return { liveTables: new Set(live.keys()), logNumber, prevLogNumber };
}

// ---------- tablas .ldb / .sst ----------

const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

function readBlock(file, handle) {
  const [offset, size] = handle;
  if (offset + size + 5 > file.length) throw new Error('LevelDB: bloque fuera de rango');
  const raw = file.subarray(offset, offset + size);
  return decompressBlock(raw, file[offset + size]);
}

function* blockEntries(block) {
  if (block.length < 4) return;
  const numRestarts = u32(block, block.length - 4);
  const limit = block.length - 4 - 4 * numRestarts;
  let pos = 0;
  let prev = new Uint8Array(0);
  while (pos < limit) {
    let shared;
    let nonShared;
    let valueLen;
    [shared, pos] = readVarint(block, pos);
    [nonShared, pos] = readVarint(block, pos);
    [valueLen, pos] = readVarint(block, pos);
    if (shared > prev.length || pos + nonShared + valueLen > limit) throw new Error('LevelDB: entrada de bloque no válida');
    const key = new Uint8Array(shared + nonShared);
    key.set(prev.subarray(0, shared));
    key.set(block.subarray(pos, pos + nonShared), shared);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    prev = key;
    yield [key, value];
  }
}

function decodeHandle(bytes, pos = 0) {
  let offset;
  let size;
  [offset, pos] = readVarint(bytes, pos);
  [size, pos] = readVarint(bytes, pos);
  return [[offset, size], pos];
}

export function readTable(file, cb) {
  if (file.length < 48) throw new Error('LevelDB: tabla demasiado pequeña');
  const footer = file.subarray(file.length - 48);
  for (let i = 0; i < 8; i++) {
    if (footer[40 + i] !== MAGIC[i]) throw new Error('LevelDB: firma de tabla no válida');
  }
  let p = 0;
  [, p] = decodeHandle(footer, p); // metaindex
  const [indexHandle] = decodeHandle(footer, p);
  const index = readBlock(file, indexHandle);
  for (const [, handleBytes] of blockEntries(index)) {
    const [handle] = decodeHandle(handleBytes);
    const block = readBlock(file, handle);
    for (const [ikey, value] of blockEntries(block)) {
      if (ikey.length < 8) continue;
      const n = ikey.length - 8;
      const type = ikey[n];
      const seq = u56(ikey, n + 1);
      cb(ikey.subarray(0, n), seq, type === 1 ? value : null);
    }
  }
}

// ---------- API pública ----------

function fileNumber(name) {
  const m = /^(\d+)\.(ldb|sst|log)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

/**
 * Lee la base de datos y devuelve Map<claveComoTexto, Uint8Array> con los
 * valores actuales de las claves que acepte `wantKey(keyBytes)`.
 *
 * @param {Array<{name:string,size:number,read:()=>Promise<Uint8Array>}>} files
 *        ficheros de la carpeta db/ (solo el nombre, sin ruta)
 */
export async function readLevelDb(files, { wantKey = () => true, onProgress = () => {} } = {}) {
  const byName = new Map(files.map((f) => [f.name, f]));
  let manifest = null;
  const warnings = [];

  try {
    const current = byName.get('CURRENT');
    if (current) {
      const name = new TextDecoder().decode(await current.read()).trim();
      const mf = byName.get(name);
      if (mf) manifest = parseManifest(await mf.read());
    }
  } catch (e) {
    warnings.push('No se pudo leer el MANIFEST (' + e.message + '); se leerán todos los ficheros.');
    manifest = null;
  }

  const tables = [];
  const logs = [];
  for (const f of files) {
    const num = fileNumber(f.name);
    if (num < 0) continue;
    if (/\.log$/.test(f.name)) {
      if (!manifest || num >= manifest.logNumber || (manifest.prevLogNumber && num === manifest.prevLogNumber)) logs.push(f);
    } else if (!manifest || manifest.liveTables.has(num)) {
      tables.push(f);
    }
  }
  if (manifest) {
    const present = new Set(tables.map((f) => fileNumber(f.name)));
    const missing = [...manifest.liveTables].filter((n) => !present.has(n));
    if (missing.length) warnings.push(`Faltan ${missing.length} ficheros .ldb: el mundo puede estar incompleto.`);
  }

  const entries = new Map();
  const put = (key, seq, value) => {
    if (!wantKey(key)) return;
    const k = keyToString(key);
    const prev = entries.get(k);
    if (prev && prev.seq > seq) return;
    entries.set(k, { seq, value: value ? value.slice() : null });
  };

  const total = [...tables, ...logs].reduce((s, f) => s + (f.size || 0), 0) || 1;
  let done = 0;
  let failed = 0;

  for (const f of tables) {
    try {
      readTable(await f.read(), put);
    } catch (e) {
      failed++;
      warnings.push(`No se pudo leer ${f.name}: ${e.message}`);
    }
    done += f.size || 0;
    onProgress(done / total);
  }
  // Orden por número para que, a igual secuencia, gane el más reciente.
  logs.sort((a, b) => fileNumber(a.name) - fileNumber(b.name));
  for (const f of logs) {
    try {
      for (const rec of logRecords(await f.read())) {
        try {
          readWriteBatch(rec, put);
        } catch {
          // registro dañado: se ignora
        }
      }
    } catch (e) {
      warnings.push(`No se pudo leer ${f.name}: ${e.message}`);
    }
    done += f.size || 0;
    onProgress(done / total);
  }

  if (tables.length + logs.length === 0) throw new Error('La carpeta db/ no contiene datos de LevelDB.');
  if (tables.length && failed === tables.length) throw new Error('No se pudo leer ninguna tabla de la base de datos.');

  const result = new Map();
  for (const [k, { value }] of entries) if (value) result.set(k, value);
  return { entries: result, warnings };
}
