// Vista satélite: lee los bloques de los chunks y calcula qué se ve desde
// arriba (o, en «corte», el suelo que hay por debajo de una altura Y, útil en
// el Nether, que tiene techo de roca madre).
//
// Formato de un subchunk de Bedrock (clave de chunk con etiqueta 47 + índice Y):
//   versión 8/9: [8|9] [nº de capas] ([índice Y] si es 9) capa...
//   versión 1:   [1] capa
//   capa: [bits por bloque << 1 | 0] palabras uint32 LE · [tamaño de paleta int32]
//         paleta = NBT little-endian {name, states, version}
//   Si bits = 0 hay un solo bloque y no hay palabras ni tamaño de paleta.
//   Orden de los 4096 bloques: XZY  →  índice = (x << 8) | (z << 4) | y.
// La capa 2 (si existe) guarda el agua de los bloques anegados.

import { NbtReader } from './nbt.js';
import { scanLevelDbNewestFirst } from './leveldb.js';

// ---------------------------------------------------------------- estilos de bloque

export const KIND_AIR = 0;
export const KIND_WATER = 1;
export const KIND_LAVA = 2;
export const KIND_SOLID = 3;
export const KIND_WATER_PLANT = 4; // algas, kelp, corales: se ven como agua si están anegados
export const KIND_UNKNOWN = 5; // subchunk en formato antiguo (anterior a 2018)

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light']);
const WATER_PLANTS = /^(seagrass|tall_seagrass|kelp|kelp_plant|sea_pickle|.*coral_fan|.*coral_wall_fan|.*_coral|bubble_column)$/;

const COLORS16 = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];
const COLOR_BASES = {
  wool: 'wool', carpet: 'carpet', concrete: 'concrete', concrete_powder: 'concrete_powder',
  stained_glass: 'stained_glass', stained_glass_pane: 'stained_glass_pane',
  stained_hardened_clay: 'terracotta', shulker_box: 'shulker_box',
};
const STONE_TYPES = {
  stone: 'stone', granite: 'granite', granite_smooth: 'polished_granite', diorite: 'diorite',
  diorite_smooth: 'polished_diorite', andesite: 'andesite', andesite_smooth: 'polished_andesite',
};

/** Nombre moderno de un bloque antiguo con variantes (lana por color, tablones por madera...). */
function modernName(short, entry) {
  const st = entry.states && typeof entry.states === 'object' ? entry.states : {};
  const val = typeof entry.val === 'number' ? entry.val : null;
  const pick = (list, stateName) => {
    let v = st[stateName];
    if (v === undefined && val !== null) v = list[val];
    if (v === 'silver') v = 'light_gray';
    return typeof v === 'string' ? v : null;
  };
  if (COLOR_BASES[short]) {
    const c = pick(COLORS16, 'color');
    if (c) return `${c}_${COLOR_BASES[short]}`;
  }
  if (short === 'planks') {
    const w = pick(WOODS, 'wood_type');
    if (w) return `${w}_planks`;
  }
  if (short === 'log' || short === 'log2') {
    const w = short === 'log' ? pick(WOODS.slice(0, 4), 'old_log_type') : pick(['acacia', 'dark_oak'], 'new_log_type');
    if (w) return `${w}_log`;
  }
  if (short === 'leaves' || short === 'leaves2') {
    const w = short === 'leaves' ? pick(WOODS.slice(0, 4), 'old_leaf_type') : pick(['acacia', 'dark_oak'], 'new_leaf_type');
    if (w) return `${w}_leaves`;
  }
  if (short === 'stone') {
    const s = pick(Object.keys(STONE_TYPES), 'stone_type');
    if (s) return STONE_TYPES[s] || 'stone';
  }
  if (short === 'sand' && pick(['normal', 'red'], 'sand_type') === 'red') return 'red_sand';
  if (short === 'dirt' && pick(['normal', 'coarse'], 'dirt_type') === 'coarse') return 'coarse_dirt';
  if (short === 'grass') return 'grass_block';
  return null;
}

// Color aproximado para bloques sin textura conocida (addons, versiones futuras...).
const GUESSES = [
  [/water/, '3a7bd5'], [/lava|magma/, 'd9691a'], [/leaves/, '547921'], [/grass|moss|vine|fern|bush|azalea/, '698940'],
  [/sand/, 'dbcfa3'], [/snow|powder_snow/, 'f4f8f8'], [/ice/, '92b8fe'], [/netherrack|nylium|wart/, '7a2a2a'],
  [/basalt|blackstone/, '3a3a40'], [/deepslate|tuff/, '57575a'], [/end_stone|purpur/, 'd8d49c'],
  [/plank|log|wood|stem|hyphae|door|fence|stair|slab/, '9a7a4a'], [/dirt|mud|clay|path|farmland|podzol/, '866043'],
  [/copper/, 'b8693e'], [/gold/, 'f2d34a'], [/iron/, 'd8d8d8'], [/diamond/, '5ad8d0'], [/glass/, 'c0dde0'],
  [/brick/, '985a4a'], [/stone|cobble|rock|ore/, '7e7e7e'],
];

let COLORS = {};
/** Tabla nombre → color (data/block_colors.json). */
export function setBlockColors(colors) {
  COLORS = colors || {};
  styleIndex.clear();
  styleColor.length = 0;
  styleKind.length = 0;
  addStyle('·air', 0, KIND_AIR);
  addStyle('·water', 0x3a7bd5, KIND_WATER);
  addStyle('·unknown', 0x8a8a8a, KIND_UNKNOWN);
}

const styleIndex = new Map();
export const styleColor = [];
export const styleKind = [];

function addStyle(key, color, kind) {
  const id = styleColor.length;
  styleColor.push(color);
  styleKind.push(kind);
  styleIndex.set(key, id);
  return id;
}

export const STYLE_AIR = 0;
export const STYLE_WATER = 1;
export const STYLE_UNKNOWN = 2;
setBlockColors({});

/** Estilo (color + tipo) de una entrada de paleta. Devuelve un número pequeño. */
export function styleOf(entry) {
  const name = entry && typeof entry.name === 'string' ? entry.name : '';
  const st = entry && entry.states && typeof entry.states === 'object' ? entry.states : null;
  const key = name + '|' + (st ? (st.color ?? st.wood_type ?? st.old_log_type ?? st.new_log_type ?? st.old_leaf_type ?? st.new_leaf_type ?? st.stone_type ?? st.sand_type ?? st.dirt_type ?? '') : entry?.val ?? '');
  const known = styleIndex.get(key);
  if (known !== undefined) return known;

  const short = name.replace(/^minecraft:/, '');
  let kind = KIND_SOLID;
  if (!name || AIR_NAMES.has(short) || short.startsWith('light_block')) kind = KIND_AIR;
  else if (short === 'water' || short === 'flowing_water') kind = KIND_WATER;
  else if (short === 'lava' || short === 'flowing_lava') kind = KIND_LAVA;
  else if (WATER_PLANTS.test(short)) kind = KIND_WATER_PLANT;

  let hex = null;
  const modern = name.startsWith('minecraft:') ? modernName(short, entry || {}) : null;
  if (modern) hex = COLORS['minecraft:' + modern];
  hex ||= COLORS[name];
  if (!hex) {
    for (const [re, c] of GUESSES) {
      if (re.test(short)) {
        hex = c;
        break;
      }
    }
  }
  return addStyle(key, parseInt(hex || '8a8a8a', 16), kind);
}

// ---------------------------------------------------------------- subchunks

class Layer {
  constructor(bits, words, styles) {
    this.bits = bits;
    this.words = words;
    this.styles = styles; // Uint16Array: índice de paleta → estilo
    this.perWord = bits ? Math.floor(32 / bits) : 0;
    this.mask = bits ? (bits === 32 ? 0xffffffff : (1 << bits) - 1) : 0;
    let allAir = true;
    for (const s of styles) if (styleKind[s] !== KIND_AIR) allAir = false;
    this.allAir = allAir;
    this.single = bits === 0 || styles.length === 1 ? styles[0] : -1;
  }

  /** Estilo del bloque en el índice XZY `i`. */
  get(i) {
    if (this.single >= 0) return this.single;
    const w = this.words[(i / this.perWord) | 0];
    const p = (w >>> ((i % this.perWord) * this.bits)) & this.mask;
    return p < this.styles.length ? this.styles[p] : STYLE_AIR;
  }
}

function readLayer(bytes, r) {
  const header = bytes[r.pos++];
  if (header & 1) throw new Error('capa en formato de red');
  const bits = header >> 1;
  if (![0, 1, 2, 3, 4, 5, 6, 8, 16].includes(bits)) throw new Error('bits por bloque no válidos: ' + bits);
  let words = null;
  if (bits) {
    const perWord = Math.floor(32 / bits);
    const n = Math.ceil(4096 / perWord);
    const end = r.pos + n * 4;
    if (end > bytes.length) throw new Error('subchunk truncado');
    words = new Uint32Array(bytes.slice(r.pos, end).buffer);
    r.pos = end;
  }
  let count = 1;
  if (bits) {
    count = new DataView(bytes.buffer, bytes.byteOffset + r.pos, 4).getInt32(0, true);
    r.pos += 4;
    if (count < 1 || count > 4096) throw new Error('paleta no válida');
  }
  const nbt = new NbtReader(bytes, r.pos);
  const styles = new Uint16Array(count);
  for (let k = 0; k < count; k++) styles[k] = styleOf(nbt.root());
  r.pos = nbt.pos;
  return new Layer(bits, words, styles);
}

/** Decodifica un subchunk. Devuelve { layers } (o { unknown: true } si es de formato antiguo). */
export function decodeSubChunk(bytes) {
  const version = bytes[0];
  const r = { pos: 1 };
  let count = 1;
  if (version === 8 || version === 9) {
    count = bytes[r.pos++];
    if (version === 9) r.pos++;
  } else if (version !== 1) {
    return { unknown: true, layers: [] };
  }
  const layers = [];
  for (let k = 0; k < count && k < 2; k++) layers.push(readLayer(bytes, r));
  return { layers };
}

// ---------------------------------------------------------------- columnas

export const NO_HEIGHT = -32768;

/**
 * Calcula qué se ve en las columnas de un chunk.
 * @param subs Map<índiceY, Uint8Array> subchunks (valor de LevelDB) del chunk
 * @param mode { type: 'top' } o { type: 'slice', y }
 * @param res columnas por lado: 16 (todas), 8 (una de cada 2×2) o 4 (una de cada 4×4).
 *        En mundos enormes se usa menos para que la vista quepa en la memoria del móvil.
 * @returns { h: Int16Array, c: Uint16Array, d: Uint8Array } altura, estilo y profundidad de agua
 *          (res × res valores, fila a fila de norte a sur)
 */
export function renderColumns(subs, mode, res = 16) {
  const n = res * res;
  const step = 16 / res;
  const h = new Int16Array(n).fill(NO_HEIGHT);
  const c = new Uint16Array(n);
  const d = new Uint8Array(n);
  if (!subs.size) return { h, c, d };

  const decoded = new Map();
  const get = (idx) => {
    let s = decoded.get(idx);
    if (s === undefined) {
      const raw = subs.get(idx);
      if (!raw) s = null;
      else {
        try {
          s = decodeSubChunk(raw);
        } catch {
          s = { unknown: true, layers: [] };
        }
      }
      decoded.set(idx, s);
    }
    return s;
  };

  const idxs = [...subs.keys()];
  const maxIdx = Math.max(...idxs);
  const minIdx = Math.min(...idxs);
  const top = mode.type === 'slice' ? Math.min(mode.y, maxIdx * 16 + 15) : maxIdx * 16 + 15;
  const bottom = minIdx * 16;

  for (let col = 0; col < n; col++) {
    const x = (col % res) * step;
    const z = Math.floor(col / res) * step;
    const base = (x << 8) | (z << 4);
    let waterTop = NO_HEIGHT;
    let state = 0; // corte: 0 inicio, 1 dentro de bloques, 2 en aire
    for (let Y = top; Y >= bottom; Y--) {
      const s = get(Y >> 4);
      let style = STYLE_AIR;
      let water1 = false;
      if (s) {
        if (s.unknown) {
          style = STYLE_UNKNOWN;
        } else {
          const l0 = s.layers[0];
          const l1 = s.layers[1];
          if (l0.allAir && (!l1 || l1.allAir)) {
            // subchunk vacío: saltar hasta el de abajo
            if (mode.type === 'slice' && state !== 2) state = 2;
            Y = (Y >> 4) * 16;
            continue;
          }
          const i = base | (Y & 15);
          style = l0.get(i);
          if (l1 && !l1.allAir) water1 = styleKind[l1.get(i)] === KIND_WATER;
        }
      }
      const kind = styleKind[style];

      if (mode.type === 'slice') {
        const empty = kind === KIND_AIR && !water1;
        if (state === 0) state = empty ? 2 : 1;
        else if (state === 1) {
          if (empty) state = 2;
        } else if (!empty) {
          h[col] = Y;
          c[col] = water1 && kind !== KIND_SOLID && kind !== KIND_LAVA ? STYLE_WATER : style;
          break;
        }
        continue;
      }

      if (kind === KIND_AIR && !water1) continue;
      const isWater = kind === KIND_WATER || (water1 && (kind === KIND_AIR || kind === KIND_WATER_PLANT));
      if (isWater) {
        if (waterTop === NO_HEIGHT) waterTop = Y;
        continue;
      }
      if (waterTop !== NO_HEIGHT) {
        h[col] = waterTop;
        c[col] = STYLE_WATER;
        d[col] = Math.min(255, waterTop - Y);
      } else {
        h[col] = Y;
        c[col] = style;
      }
      break;
    }
    if (h[col] === NO_HEIGHT && waterTop !== NO_HEIGHT) {
      h[col] = waterTop;
      c[col] = STYLE_WATER;
      d[col] = 64;
    }
  }
  return { h, c, d };
}

// ---------------------------------------------------------------- imagen

export const TILE_CHUNKS = 16; // cada tesela de imagen cubre 16×16 chunks (256×256 píxeles)

/**
 * Convierte las columnas de todos los chunks en teselas RGBA con sombreado de
 * relieve (luz desde el noroeste).
 * @param chunks Map<"x,z", {h, c, d}> (res × res columnas por chunk)
 * @param res píxeles por lado de chunk (16 = un píxel por bloque)
 * @returns Array<{ tx, tz, data: Uint8ClampedArray }> teselas de (TILE_CHUNKS·res)² píxeles
 */
export function composeTiles(chunks, mode, res = 16) {
  const TILE_PX = TILE_CHUNKS * res;
  const step = 16 / res;
  const tiles = new Map();
  const heightAt = (cx, cz, x, z, fallback) => {
    if (x < 0) {
      cx--;
      x += res;
    }
    if (z < 0) {
      cz--;
      z += res;
    }
    const ch = chunks.get(cx + ',' + cz);
    const v = ch ? ch.h[z * res + x] : NO_HEIGHT;
    return v === NO_HEIGHT ? fallback : v;
  };
  for (const [key, ch] of chunks) {
    const comma = key.indexOf(',');
    const cx = Number(key.slice(0, comma));
    const cz = Number(key.slice(comma + 1));
    const tx = Math.floor(cx / TILE_CHUNKS);
    const tz = Math.floor(cz / TILE_CHUNKS);
    const tkey = tx + ',' + tz;
    let tile = tiles.get(tkey);
    if (!tile) {
      tile = { tx, tz, data: new Uint8ClampedArray(TILE_PX * TILE_PX * 4) };
      tiles.set(tkey, tile);
    }
    const ox = (cx - tx * TILE_CHUNKS) * res;
    const oz = (cz - tz * TILE_CHUNKS) * res;
    for (let col = 0; col < res * res; col++) {
      const x = col % res;
      const z = Math.floor(col / res);
      const p = ((oz + z) * TILE_PX + ox + x) * 4;
      const hh = ch.h[col];
      if (hh === NO_HEIGHT) {
        if (mode.type === 'slice') {
          tile.data[p] = 24;
          tile.data[p + 1] = 12;
          tile.data[p + 2] = 12;
          tile.data[p + 3] = 255;
        }
        continue;
      }
      const style = ch.c[col];
      const rgb = styleColor[style];
      let f;
      if (style === STYLE_WATER) {
        f = 1.05 - Math.min(ch.d[col], 30) / 30 * 0.45;
      } else {
        const hn = heightAt(cx, cz, x, z - 1, hh);
        const hw = heightAt(cx, cz, x - 1, z, hh);
        const dh = (hh - hn + (hh - hw)) / step; // con menos resolución, las vecinas están más lejos
        f = 1 + Math.max(-6, Math.min(6, dh)) * 0.055;
      }
      tile.data[p] = ((rgb >> 16) & 255) * f;
      tile.data[p + 1] = ((rgb >> 8) & 255) * f;
      tile.data[p + 2] = (rgb & 255) * f;
      tile.data[p + 3] = 255;
    }
  }
  return [...tiles.values()];
}

// ---------------------------------------------------------------- mundo completo

function i32(b, p) {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
}

/**
 * Calcula la vista satélite de una dimensión entera.
 * @param dbFiles ficheros de la carpeta db/ ({name, size, read})
 * @param dim 0 mundo normal, 1 Nether, 2 End
 * @param mode { type: 'top' } o { type: 'slice', y }
 * @returns { tiles, chunks } o null si se canceló
 */
export async function renderDimension(dbFiles, dim, mode, { onProgress = () => {}, shouldStop = () => false, keepColumns = null, res = 16 } = {}) {
  const keyLen = dim ? 14 : 10;
  const tagPos = dim ? 12 : 8;
  const wantKey = (k) => k.length === keyLen && k[tagPos] === 47 && (!dim || i32(k, 8) === dim);

  const seen = new Map(); // "x,z" -> Uint8Array con los índices Y ya vistos (la versión más nueva gana)
  const result = new Map(); // "x,z" -> { h, c, d }
  let groupKey = null;
  let group = new Map();

  const flush = () => {
    if (groupKey !== null && group.size) {
      const cols = renderColumns(group, mode, res);
      const prev = result.get(groupKey);
      if (!prev) result.set(groupKey, cols);
      else {
        // el chunk está repartido en varios ficheros: se combina columna a columna
        for (let i = 0; i < res * res; i++) {
          if (cols.h[i] > prev.h[i]) {
            prev.h[i] = cols.h[i];
            prev.c[i] = cols.c[i];
            prev.d[i] = cols.d[i];
          }
        }
      }
    }
    groupKey = null;
    group = new Map();
  };

  const onEntry = (key, seq, value) => {
    const cid = i32(key, 0) + ',' + i32(key, 4);
    if (cid !== groupKey) {
      flush();
      groupKey = cid;
    }
    const idx = (key[tagPos + 1] << 24) >> 24; // con signo: el mundo normal empieza en -4
    let flags = seen.get(cid);
    if (!flags) seen.set(cid, (flags = new Uint8Array(64)));
    if (flags[idx + 32]) return;
    flags[idx + 32] = 1;
    if (value) group.set(idx, value);
  };

  const finished = await scanLevelDbNewestFirst(dbFiles, {
    wantKey, onEntry, onSourceEnd: flush, shouldStop, onProgress: (p) => onProgress(p * 0.95),
  });
  if (!finished) return null;
  flush();
  if (keepColumns) for (const [k, v] of result) keepColumns.set(k, v); // para las pruebas
  const tiles = composeTiles(result, mode, res);
  onProgress(1);
  return { tiles, chunks: result.size, res };
}
