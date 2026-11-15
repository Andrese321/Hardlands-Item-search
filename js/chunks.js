// Borrado de chunks de un mundo Bedrock.
//
// Cómo funciona: no se reescribe la base de datos. Se añade al mundo un
// fichero .log nuevo de LevelDB con órdenes de borrado para todas las claves
// de los chunks elegidos (terreno, cofres, entidades...). Al abrir el mundo,
// Minecraft aplica ese registro y, como esos chunks ya no existen, los vuelve
// a generar desde la semilla cuando alguien se acerca.
//
// El resto de ficheros se copian sin tocar, así que el riesgo es mínimo.

import { scanLevelDb, keyToString } from './leveldb.js';
import { buildWorldWithDeletions } from './edit.js';
import { readNbt, readNbtList } from './nbt.js';

// Etiquetas de registros de chunk (Data3D=43 ... ActorDigestVersion=65, LegacyVersion=118).
const MIN_TAG = 43;
const MAX_TAG = 65;
const LEGACY_VERSION = 118;
const SUBCHUNK = 47;
const BLOCK_ENTITY = 49;
// Un chunk "real" tiene versión o terreno; evita confundir otras claves con chunks.
const REAL_TAGS = new Set([43, 44, 45, 46, 47, 48, 118]);

const NO_INDEX = 0x100;

function i32(b, p) {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
}

function isTag(t) {
  return (t >= MIN_TAG && t <= MAX_TAG) || t === LEGACY_VERSION;
}

/** Interpreta una clave de chunk: {x, z, dim, tag, index} o null. */
export function parseChunkKey(k) {
  const len = k.length;
  let dim = 0;
  let tagPos;
  if (len === 9 || len === 10) {
    tagPos = 8;
  } else if (len === 13 || len === 14) {
    dim = i32(k, 8);
    if (dim !== 1 && dim !== 2) return null;
    tagPos = 12;
  } else {
    return null;
  }
  const tag = k[tagPos];
  if (!isTag(tag)) return null;
  const hasIndex = len === tagPos + 2;
  if (hasIndex !== (tag === SUBCHUNK)) return null;
  return { x: i32(k, 0), z: i32(k, 4), dim, tag, index: hasIndex ? k[tagPos + 1] : NO_INDEX };
}

export function chunkKey(x, z, dim, tag, index = NO_INDEX) {
  const len = (dim ? 13 : 9) + (index === NO_INDEX ? 0 : 1);
  const k = new Uint8Array(len);
  const dv = new DataView(k.buffer);
  dv.setInt32(0, x, true);
  dv.setInt32(4, z, true);
  if (dim) dv.setInt32(8, dim, true);
  const p = dim ? 12 : 8;
  k[p] = tag;
  if (index !== NO_INDEX) k[p + 1] = index;
  return k;
}

function digpKey(x, z, dim) {
  const k = new Uint8Array(dim ? 16 : 12);
  k.set([0x64, 0x69, 0x67, 0x70]); // "digp"
  const dv = new DataView(k.buffer);
  dv.setInt32(4, x, true);
  dv.setInt32(8, z, true);
  if (dim) dv.setInt32(12, dim, true);
  return k;
}

const ACTOR = Array.from('actorprefix', (c) => c.charCodeAt(0));

function startsWith(k, prefix) {
  if (k.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (k[i] !== prefix[i]) return false;
  return true;
}

// Cada registro de un chunk se guarda como 2 caracteres: etiqueta + índice
// de subchunk (o NO_INDEX). Comprobación alineada para no confundir tokens.
function hasToken(s, a, b) {
  for (let i = 0; i < s.length; i += 2) if (s.charCodeAt(i) === a && s.charCodeAt(i + 1) === b) return true;
  return false;
}

const id = (dim, x, z) => `${dim},${x},${z}`;

/**
 * Analiza un mundo: qué chunks existen, cuáles tienen contenedores y dónde
 * están los jugadores.
 * @param dbFiles Array<{name,size,read}> ficheros de la carpeta db/
 */
export async function analyzeChunks(dbFiles, { onProgress = () => {} } = {}) {
  const chunks = new Map(); // id -> { dim, x, z, tokens, real, beSeq, containers, items }
  const digp = new Map(); // id -> { seq, value }
  const players = new Map(); // clave -> { seq, value }

  const onEntry = (key, seq, value) => {
    const c = parseChunkKey(key);
    if (c) {
      const cid = id(c.dim, c.x, c.z);
      let ch = chunks.get(cid);
      if (!ch) {
        ch = { dim: c.dim, x: c.x, z: c.z, tokens: '', real: false, beSeq: -1, containers: 0, items: 0 };
        chunks.set(cid, ch);
      }
      if (!hasToken(ch.tokens, c.tag, c.index)) ch.tokens += String.fromCharCode(c.tag, c.index);
      if (REAL_TAGS.has(c.tag)) ch.real = true;
      if (c.tag === BLOCK_ENTITY && seq > ch.beSeq) {
        ch.beSeq = seq;
        ch.containers = 0;
        ch.items = 0;
        if (value) {
          try {
            for (const be of readNbtList(value)) {
              if (be && Array.isArray(be.Items) && be.Items.length) {
                ch.containers++;
                for (const it of be.Items) if (it && typeof it.Count === 'number') ch.items += it.Count;
              }
            }
          } catch {
            /* dato dañado: se ignora para el resumen */
          }
        }
      }
      return;
    }
    const k0 = key[0];
    if (k0 === 0x64 && (key.length === 12 || key.length === 16) && key[1] === 0x69 && key[2] === 0x67 && key[3] === 0x70) {
      const dim = key.length === 16 ? i32(key, 12) : 0;
      const cid = id(dim, i32(key, 4), i32(key, 8));
      const prev = digp.get(cid);
      if (!prev || prev.seq < seq) digp.set(cid, { seq, value: value ? value.slice() : null });
      return;
    }
    if ((k0 === 0x7e || k0 === 0x70) && key.length < 80) {
      const s = keyToString(key);
      if (s === '~local_player' || s.startsWith('player_server_')) {
        const prev = players.get(s);
        if (!prev || prev.seq < seq) players.set(s, { seq, value: value ? value.slice() : null });
      }
    }
  };

  const scan = await scanLevelDb(dbFiles, { onEntry, onProgress, strict: true });

  const playerList = [];
  for (const [pid, { value }] of players) {
    if (!value) continue;
    try {
      const nbt = readNbt(value);
      const pos = nbt?.Pos;
      if (Array.isArray(pos) && pos.length >= 3) {
        playerList.push({ id: pid, dim: Number(nbt.DimensionId ?? 0), x: Math.floor(pos[0]), z: Math.floor(pos[2]) });
      }
    } catch {
      /* jugador ilegible */
    }
  }

  return { chunks, digp, players: playerList, maxSeq: scan.maxSeq, maxFileNumber: scan.maxFileNumber, manifest: scan.manifest };
}

/** ¿Está el chunk (cx, cz) dentro de alguna zona [cx1, cz1, cx2, cz2]? */
export function inZones(cx, cz, zones) {
  for (const [x1, z1, x2, z2] of zones) {
    if (cx >= Math.min(x1, x2) && cx <= Math.max(x1, x2) && cz >= Math.min(z1, z2) && cz <= Math.max(z1, z2)) return true;
  }
  return false;
}

/** Convierte una zona en bloques (dos esquinas) a zona en chunks. */
export function blocksToChunkZone(x1, z1, x2, z2) {
  return [Math.floor(Math.min(x1, x2) / 16), Math.floor(Math.min(z1, z2) / 16), Math.floor(Math.max(x1, x2) / 16), Math.floor(Math.max(z1, z2) / 16)];
}

/**
 * Elige los chunks a borrar.
 * @param mode 'inside' (borrar lo que está dentro de las zonas) o 'outside' (borrar todo menos las zonas)
 */
export function selectChunks(analysis, { dim, zones, mode }) {
  const out = [];
  for (const ch of analysis.chunks.values()) {
    if (ch.dim !== dim || !ch.real) continue;
    const inside = inZones(ch.x, ch.z, zones);
    if ((mode === 'inside') === inside) out.push(ch);
  }
  return out;
}

/** Todas las claves de LevelDB que hay que borrar para eliminar esos chunks. */
export function keysForChunks(analysis, chunks) {
  const keys = [];
  let actors = 0;
  for (const ch of chunks) {
    for (let i = 0; i < ch.tokens.length; i += 2) {
      keys.push(chunkKey(ch.x, ch.z, ch.dim, ch.tokens.charCodeAt(i), ch.tokens.charCodeAt(i + 1)));
    }
    const d = analysis.digp.get(id(ch.dim, ch.x, ch.z));
    if (d) {
      keys.push(digpKey(ch.x, ch.z, ch.dim));
      if (d.value) {
        for (let p = 0; p + 8 <= d.value.length; p += 8) {
          const k = new Uint8Array(19);
          k.set(ACTOR);
          k.set(d.value.subarray(p, p + 8), 11);
          keys.push(k);
          actors++;
        }
      }
    }
  }
  return { keys, actors };
}

/**
 * Crea el mundo modificado como Blob ZIP con todo lo original más el .log de borrado.
 * @param source { kind:'zip', zip } (de openZip) o { kind:'folder', files:[{path, file}] }
 */
export async function buildEditedWorld(source, prefix, analysis, chunks, opts = {}) {
  const { keys, actors } = keysForChunks(analysis, chunks);
  if (!keys.length) throw new Error('No hay chunks que borrar con esa selección.');
  const out = await buildWorldWithDeletions(source, prefix, analysis, keys, opts);
  return { ...out, actors };
}
