// Lector mínimo de ZIP (también .mcworld, que es un ZIP) que lee cada fichero
// bajo demanda desde un Blob/File, sin cargar todo el archivo en memoria.

import { inflateSync } from '../vendor/fflate.js';

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function dv(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(view, pos) {
  return view.getUint32(pos, true) + view.getUint32(pos + 4, true) * 4294967296;
}

const utf8 = new TextDecoder('utf-8');

export async function openZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557 + 20);
  const tail = await readRange(blob, size - tailLen, size);
  const tv = dv(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un ZIP/.mcworld válido.');

  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === 0x07064b50) {
      const z64Offset = u64(tv, loc + 8);
      const z64 = await readRange(blob, z64Offset, z64Offset + 56);
      const zv = dv(z64);
      if (zv.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 no válido.');
      count = u64(zv, 32);
      cdSize = u64(zv, 40);
      cdOffset = u64(zv, 48);
    }
  }

  const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
  const cv = dv(cd);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const time = cv.getUint16(p + 12, true);
    const date = cv.getUint16(p + 14, true);
    const crc = cv.getUint32(p + 16, true);
    let compSize = cv.getUint32(p + 20, true);
    let uncompSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let localOffset = cv.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    // Campo extra ZIP64
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cv.getUint16(e, true);
      const len = cv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompSize === 0xffffffff) { uncompSize = u64(cv, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cv, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cv, q); q += 8; }
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({ name, size: uncompSize, compSize, method, localOffset, flags, time, date, crc });
  }

  async function dataStart(entry) {
    const header = await readRange(blob, entry.localOffset, entry.localOffset + 30);
    const hv = dv(header);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP dañado: ' + entry.name);
    return entry.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  }

  // Datos comprimidos tal cual están en el ZIP (sin copiarlos a memoria).
  async function raw(entry) {
    const start = await dataStart(entry);
    return blob.slice(start, start + entry.compSize);
  }

  async function read(entry) {
    const start = await dataStart(entry);
    const data = await readRange(blob, start, start + entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return entry.size > 0 ? inflateSync(data, { out: new Uint8Array(entry.size) }) : inflateSync(data);
    throw new Error('Método de compresión ZIP no soportado (' + entry.method + ') en ' + entry.name);
  }

  return { entries, read, raw };
}

// ---------------------------------------------------------------- escritura

let CRC32_TABLE;
export function crc32(bytes) {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Fichero nuevo, guardado sin comprimir. */
export function storedEntry(name, bytes) {
  const { time, date } = dosDateTime();
  return { name, data: bytes, method: 0, crc: crc32(bytes), size: bytes.length, compSize: bytes.length, flags: 0, time, date };
}

const MAX32 = 0xffffffff;

function setU64(view, pos, v) {
  view.setUint32(pos, v % 4294967296, true);
  view.setUint32(pos + 4, Math.floor(v / 4294967296), true);
}

/**
 * Crea un ZIP como Blob. Cada entrada lleva `data` (Blob o Uint8Array) ya
 * comprimida según `method`, con su crc y tamaños. Los Blob originales no se
 * copian a memoria: el navegador los encadena.
 *
 * Si algún tamaño o posición pasa de 4 GB (o hay más de 65 535 ficheros) se usa
 * ZIP64, la ampliación del formato para archivos grandes. `forceZip64` lo
 * fuerza siempre (para las pruebas).
 */
export function buildZip(entries, type = 'application/zip', { forceZip64 = false } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const flags = (e.flags & ~0x0008) | 0x0800; // sin descriptor de datos; nombre en UTF-8
    const big = forceZip64 || e.size >= MAX32 || e.compSize >= MAX32;
    const farOffset = forceZip64 || offset >= MAX32;
    const version = big || farOffset ? 45 : 20;

    // Cabecera local (con extra ZIP64 de 20 bytes si el fichero es grande).
    const lh = new Uint8Array(30 + name.length + (big ? 20 : 0));
    const lv = dv(lh);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, version, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, big ? MAX32 : e.compSize, true);
    lv.setUint32(22, big ? MAX32 : e.size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, big ? 20 : 0, true);
    lh.set(name, 30);
    if (big) {
      const x = 30 + name.length;
      lv.setUint16(x, 0x0001, true);
      lv.setUint16(x + 2, 16, true);
      setU64(lv, x + 4, e.size);
      setU64(lv, x + 12, e.compSize);
    }

    // Entrada del directorio central: el extra ZIP64 lleva solo los campos que no caben.
    const extra = [];
    if (big) extra.push(e.size, e.compSize);
    if (farOffset) extra.push(offset);
    const ch = new Uint8Array(46 + name.length + (extra.length ? 4 + 8 * extra.length : 0));
    const cv = dv(ch);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, version, true);
    cv.setUint16(6, version, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, big ? MAX32 : e.compSize, true);
    cv.setUint32(24, big ? MAX32 : e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length ? 4 + 8 * extra.length : 0, true);
    cv.setUint32(42, farOffset ? MAX32 : offset, true);
    ch.set(name, 46);
    if (extra.length) {
      const x = 46 + name.length;
      cv.setUint16(x, 0x0001, true);
      cv.setUint16(x + 2, 8 * extra.length, true);
      extra.forEach((v, i) => setU64(cv, x + 4 + 8 * i, v));
    }
    central.push(ch);

    parts.push(lh, e.data);
    offset += lh.length + e.compSize;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const tail = [];
  const zip64 = forceZip64 || entries.length > 0xffff || cdSize >= MAX32 || offset >= MAX32;
  if (zip64) {
    // Registro de fin ZIP64 + localizador
    const z = new Uint8Array(56);
    const zv = dv(z);
    zv.setUint32(0, 0x06064b50, true);
    setU64(zv, 4, 44);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    setU64(zv, 24, entries.length);
    setU64(zv, 32, entries.length);
    setU64(zv, 40, cdSize);
    setU64(zv, 48, offset);
    const loc = new Uint8Array(20);
    const locv = dv(loc);
    locv.setUint32(0, 0x07064b50, true);
    setU64(locv, 8, offset + cdSize);
    locv.setUint32(16, 1, true);
    tail.push(z, loc);
  }
  const end = new Uint8Array(22);
  const ev = dv(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip64 ? 0xffff : entries.length, true);
  ev.setUint16(10, zip64 ? 0xffff : entries.length, true);
  ev.setUint32(12, zip64 ? MAX32 : cdSize, true);
  ev.setUint32(16, zip64 ? MAX32 : offset, true);
  tail.push(end);
  return new Blob([...parts, ...central, ...tail], { type });
}
