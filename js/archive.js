// Abre un archivo de mundo sea cual sea su formato: .mcworld / .zip, .tar.gz /
// .tgz (copias de seguridad de muchos hostings) o .tar.
//
// El ZIP se lee bajo demanda. El tar.gz no permite saltar a un fichero, así
// que se descomprime de principio a fin en streaming y cada fichero se guarda
// como un Blob (el navegador puede mantenerlos en disco en vez de en memoria).

import { openZip } from './zip.js';
import { Gunzip } from '../vendor/fflate.js';

const BLOCK = 512;
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

function cstr(bytes, start, len, decoder = utf8) {
  let end = start;
  while (end < start + len && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(start, end));
}

function octal(bytes, start, len) {
  if (bytes[start] & 0x80) {
    // codificación base-256 (ficheros de más de 8 GB)
    let v = bytes[start] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + bytes[start + i];
    return v;
  }
  const s = latin1.decode(bytes.subarray(start, start + len)).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(b) {
  for (let i = 0; i < BLOCK; i++) if (b[i]) return false;
  return true;
}

function checksumOk(h) {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === stored;
}

function cleanName(name) {
  return name.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

// Cabecera PAX: registros «<longitud> clave=valor\n». La longitud cuenta BYTES
// (no letras), así que se recorre en bytes para no romper nombres con tildes.
function parsePax(bytes) {
  const out = {};
  let pos = 0;
  while (pos < bytes.length) {
    let sp = pos;
    while (sp < bytes.length && bytes[sp] !== 0x20) sp++;
    const len = parseInt(latin1.decode(bytes.subarray(pos, sp)), 10);
    if (!len || sp >= bytes.length) break;
    const rec = utf8.decode(bytes.subarray(sp + 1, pos + len - 1)); // sin el «\n» final
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Lector de tar en streaming: se le pasan trozos con push() y devuelve los ficheros. */
export class TarParser {
  constructor() {
    this.entries = [];
    this.buf = new Uint8Array(0); // cabecera a medio llegar
    this.cur = null; // fichero en curso: { name, size, left, parts, keep }
    this.pad = 0; // relleno hasta el siguiente bloque de 512
    this.longName = null;
    this.pax = null;
    this.done = false;
  }

  push(chunk) {
    let pos = 0;
    while (pos < chunk.length && !this.done) {
      if (this.cur) {
        const n = Math.min(this.cur.left, chunk.length - pos);
        if (n) this.cur.parts.push(chunk.slice(pos, pos + n));
        this.cur.left -= n;
        pos += n;
        if (this.cur.left === 0) this.finishEntry();
        continue;
      }
      if (this.pad) {
        const n = Math.min(this.pad, chunk.length - pos);
        this.pad -= n;
        pos += n;
        continue;
      }
      const need = BLOCK - this.buf.length;
      const take = chunk.subarray(pos, pos + need);
      const merged = new Uint8Array(this.buf.length + take.length);
      merged.set(this.buf);
      merged.set(take, this.buf.length);
      this.buf = merged;
      pos += take.length;
      if (this.buf.length === BLOCK) {
        const header = this.buf;
        this.buf = new Uint8Array(0);
        this.header(header);
      }
    }
  }

  header(h) {
    if (isZeroBlock(h)) {
      this.done = true; // fin del archivo (dos bloques a cero)
      return;
    }
    if (!checksumOk(h)) throw new Error('El archivo .tar está dañado o no es un .tar.');
    const type = String.fromCharCode(h[156] || 48);
    let size = octal(h, 124, 12);
    let name = cstr(h, 0, 100);
    if (latin1.decode(h.subarray(257, 262)) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    if (this.pax?.path) name = this.pax.path;
    if (this.pax?.size) size = Number(this.pax.size);
    if (this.longName !== null) name = this.longName;
    if (type !== 'L' && type !== 'x' && type !== 'g') {
      this.longName = null;
      this.pax = null;
    }
    const keep = type === '0' || type === '7';
    this.cur = { name: cleanName(name), size, left: size, parts: [], type, keep };
    if (size === 0) this.finishEntry();
  }

  finishEntry() {
    const e = this.cur;
    this.cur = null;
    this.pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
    if (e.type === 'L') {
      this.longName = cstr(concatParts(e.parts), 0, e.size);
    } else if (e.type === 'x') {
      this.pax = parsePax(concatParts(e.parts));
    } else if (e.keep && e.name && !e.name.endsWith('/')) {
      this.entries.push({ name: e.name, size: e.size, blob: new Blob(e.parts) });
    }
  }
}

function concatParts(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function head(blob, n) {
  return new Uint8Array(await blob.slice(0, n).arrayBuffer());
}

/** Lee un Blob a trozos llamando a onChunk; avisa del progreso (0..1). */
async function readChunks(blob, onChunk, onProgress) {
  const reader = blob.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    onChunk(value);
    onProgress(done / (blob.size || 1));
  }
}

async function untar(blob, gz, onProgress) {
  const parser = new TarParser();
  if (!gz) {
    await readChunks(blob, (c) => parser.push(c), onProgress);
  } else if (typeof DecompressionStream === 'function') {
    let read = 0;
    const counter = new TransformStream({
      transform(chunk, ctrl) {
        read += chunk.length;
        onProgress(read / (blob.size || 1));
        ctrl.enqueue(chunk);
      },
    });
    const reader = blob.stream().pipeThrough(counter).pipeThrough(new DecompressionStream('gzip')).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } else {
    // navegadores antiguos: descompresión en JavaScript
    const gunzip = new Gunzip((chunk) => parser.push(chunk));
    await readChunks(blob, (c) => gunzip.push(c), onProgress);
    gunzip.push(new Uint8Array(0), true);
  }
  if (!parser.entries.length) throw new Error('El archivo .tar no contiene ficheros.');
  return parser.entries;
}

/**
 * Abre un .mcworld/.zip, .tar.gz/.tgz o .tar (se detecta por el contenido).
 * @returns {
 *   kind: 'zip' | 'tar',
 *   entries: Array<{ name, size }>,
 *   read(entry): Promise<Uint8Array>,
 *   editSource: fuente para crear una copia modificada (ver edit.js)
 * }
 */
export async function openArchive(blob, { onProgress = () => {} } = {}) {
  const b = await head(blob, 512);
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const zip = await openZip(blob);
    return { kind: 'zip', entries: zip.entries, read: (e) => zip.read(e), editSource: { kind: 'zip', zip } };
  }
  const gz = b[0] === 0x1f && b[1] === 0x8b;
  const tar = b.length >= 512 && latin1.decode(b.subarray(257, 262)) === 'ustar';
  if (!gz && !tar && !(b.length >= 512 && checksumOk(b))) {
    throw new Error('Formato de archivo no reconocido. Usa un .mcworld, .zip, .tar.gz o .tar.');
  }
  let entries;
  try {
    entries = await untar(blob, gz, onProgress);
  } catch (e) {
    throw new Error((gz ? 'No se pudo leer el .tar.gz: ' : 'No se pudo leer el .tar: ') + e.message);
  }
  return {
    kind: 'tar',
    entries,
    read: async (e) => new Uint8Array(await e.blob.arrayBuffer()),
    editSource: { kind: 'folder', files: entries.map((e) => ({ path: e.name, file: e.blob })) },
  };
}

/** Nombre sin extensión de archivo de mundo, y si era un .mcworld. */
export function splitArchiveName(name) {
  const m = /^(.*?)(\.mcworld|\.zip|\.tar\.gz|\.tgz|\.tar)?$/i.exec(name || 'mundo');
  return { base: m[1] || 'mundo', ext: (m[2] || '').toLowerCase() === '.mcworld' ? '.mcworld' : '.zip' };
}
