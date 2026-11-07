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
    const method = cv.getUint16(p + 10, true);
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
    entries.push({ name, size: uncompSize, compSize, method, localOffset });
  }

  async function read(entry) {
    const header = await readRange(blob, entry.localOffset, entry.localOffset + 30);
    const hv = dv(header);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP dañado: ' + entry.name);
    const start = entry.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const data = await readRange(blob, start, start + entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return entry.size > 0 ? inflateSync(data, { out: new Uint8Array(entry.size) }) : inflateSync(data);
    throw new Error('Método de compresión ZIP no soportado (' + entry.method + ') en ' + entry.name);
  }

  return { entries, read };
}
