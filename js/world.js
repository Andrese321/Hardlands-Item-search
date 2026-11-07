// Convierte la base de datos de un mundo Bedrock en un índice de objetos:
// dónde está cada objeto (contenedor, entidad o jugador) y cuántos hay.

import { readLevelDb, keyToString } from './leveldb.js';
import { readNbt, readNbtList } from './nbt.js';

const TAG_BLOCK_ENTITY = 49; // 0x31
const TAG_ENTITY = 50; // 0x32 (formato antiguo, antes de 1.18.30)

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const P_ACTOR = ascii('actorprefix');
const P_DIGP = ascii('digp');
const P_PLAYER = ascii('player_');
const P_LOCAL = ascii('~local_player');

function startsWith(key, prefix) {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

function i32(bytes, pos) {
  return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
}

function isChunkTag(key) {
  if (key.length === 9) return key[8] === TAG_BLOCK_ENTITY || key[8] === TAG_ENTITY;
  if (key.length === 13) {
    const dim = i32(key, 8);
    return (dim === 1 || dim === 2) && (key[12] === TAG_BLOCK_ENTITY || key[12] === TAG_ENTITY);
  }
  return false;
}

export function wantKey(key) {
  if (isChunkTag(key)) return true;
  const c = key[0];
  if (c === 0x61) return key.length === 19 && startsWith(key, P_ACTOR); // a
  if (c === 0x64) return (key.length === 12 || key.length === 16) && startsWith(key, P_DIGP); // d
  if (c === 0x70) return startsWith(key, P_PLAYER); // p
  if (c === 0x7e) return startsWith(key, P_LOCAL); // ~
  return false;
}

function hex(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// Claves que contienen objetos que NO son posesiones reales (p. ej. las
// ofertas de comercio de los aldeanos).
const EXCLUDED_KEYS = new Set(['Offers', 'persistingOffers', 'Recipes', 'buyA', 'buyB', 'sell']);

function isItem(o) {
  return (
    typeof o.Name === 'string' &&
    o.Name !== '' &&
    o.Name !== 'minecraft:air' &&
    typeof o.Count === 'number' &&
    o.Count > 0
  );
}

function num(v) {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : undefined;
}

function itemInfo(o) {
  const tag = o.tag && typeof o.tag === 'object' ? o.tag : null;
  const info = { id: o.Name, count: o.Count };
  const dmg = num(o.Damage);
  if (dmg) info.damage = dmg;
  if (tag) {
    const custom = tag.display && typeof tag.display.Name === 'string' ? tag.display.Name : null;
    if (custom) info.name = custom;
    if (Array.isArray(tag.ench) && tag.ench.length) {
      info.ench = tag.ench
        .filter((e) => e && typeof e === 'object')
        .map((e) => [num(e.id) ?? -1, num(e.lvl) ?? 0]);
    }
  }
  return info;
}

/**
 * Recorre un NBT y llama a emit(item, via, section) por cada objeto.
 * `via` = lista de ids de los objetos que lo contienen (p. ej. una caja de
 * shulker dentro de un cofre). `section` = clave de primer nivel
 * (Inventory, Armor, EnderChestInventory, Items...).
 */
export function collectItems(node, emit, via = [], section = null, depth = 0) {
  if (depth > 64 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) if (el && typeof el === 'object') collectItems(el, emit, via, section, depth + 1);
    return;
  }
  if (isItem(node)) {
    emit(itemInfo(node), via, section);
    const inner = [...via, node.Name];
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && !EXCLUDED_KEYS.has(k)) collectItems(v, emit, inner, section, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (!v || typeof v !== 'object' || EXCLUDED_KEYS.has(k)) continue;
    collectItems(v, emit, via, section ?? k, depth + 1);
  }
}

function floorPos(pos) {
  if (!Array.isArray(pos) || pos.length < 3) return null;
  const v = pos.map((n) => Math.floor(Number(n)));
  return v.every(Number.isFinite) ? v : null;
}

/** Busca mundos dentro de una lista de rutas (de un ZIP o una carpeta). */
export function findWorlds(paths) {
  const prefixes = new Map();
  for (const p of paths) {
    const m = /^(.*\/)?db\/[^/]+$/.exec(p);
    if (!m) continue;
    const prefix = m[1] || '';
    prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
  }
  return [...prefixes.keys()];
}

/**
 * Escanea un mundo.
 * @param files Array<{path, size, read()}> rutas relativas (con "/").
 * @param prefix carpeta del mundo dentro de `files` ('' si está en la raíz).
 */
export async function scanWorld(files, prefix = '', { onProgress = () => {}, onStatus = () => {} } = {}) {
  const dbPrefix = prefix + 'db/';
  const dbFiles = files
    .filter((f) => f.path.startsWith(dbPrefix) && !f.path.slice(dbPrefix.length).includes('/'))
    .map((f) => ({ name: f.path.slice(dbPrefix.length), size: f.size, read: f.read }));
  if (!dbFiles.length) throw new Error('No se encontró la carpeta db/ del mundo.');

  let worldName = '';
  const levelname = files.find((f) => f.path === prefix + 'levelname.txt');
  if (levelname) {
    try {
      worldName = new TextDecoder().decode(await levelname.read()).trim();
    } catch {
      /* sin nombre */
    }
  }
  if (!worldName) worldName = prefix.replace(/\/$/, '').split('/').pop() || 'Mundo';

  onStatus('Leyendo la base de datos del mundo…');
  const { entries, warnings } = await readLevelDb(dbFiles, {
    wantKey,
    onProgress: (p) => onProgress(p * 0.9),
  });

  onStatus('Buscando objetos…');
  const locations = [];
  const locIndex = new Map();
  const items = [];
  const players = [];
  const stats = { containers: 0, entities: 0, players: 0, lootChests: 0, stacks: 0, total: 0, errors: 0 };

  const location = (key, data) => {
    let i = locIndex.get(key);
    if (i === undefined) {
      i = locations.length;
      locations.push(data);
      locIndex.set(key, i);
    }
    return i;
  };

  const add = (info, loc, via) => {
    info.loc = loc;
    if (via.length) info.via = via;
    items.push(info);
    stats.stacks++;
    stats.total += info.count;
  };

  // Dimensión de cada entidad moderna (actorprefix), sacada de las claves digp.
  const actorDim = new Map();
  for (const [k, value] of entries) {
    if (!k.startsWith('digp')) continue;
    const dim = k.length === 16 ? i32(Uint8Array.from(k, (c) => c.charCodeAt(0)), 12) : 0;
    for (let p = 0; p + 8 <= value.length; p += 8) actorDim.set(hex(value, p, p + 8), dim);
  }

  const handleEntity = (nbt, dim) => {
    if (!nbt || typeof nbt !== 'object') return;
    const type = typeof nbt.identifier === 'string' ? nbt.identifier : 'desconocida';
    const pos = floorPos(nbt.Pos);
    let found = 0;
    const base = { kind: 'entity', type, dim, x: pos?.[0], y: pos?.[1], z: pos?.[2] };
    if (typeof nbt.CustomName === 'string' && nbt.CustomName) base.label = nbt.CustomName;
    collectItems(nbt, (info, via, section) => {
      const loc = location(`e|${nbt.UniqueID ?? Math.random()}|${type}|${pos}|${dim}`, base);
      add(info, loc, via);
      found++;
    });
    if (found) stats.entities++;
  };

  let processed = 0;
  const totalEntries = entries.size || 1;

  for (const [k, value] of entries) {
    processed++;
    if (processed % 2000 === 0) onProgress(0.9 + 0.1 * (processed / totalEntries));
    try {
      const len = k.length;
      const isChunk = (len === 9 || len === 13) && !k.startsWith('~') && !k.startsWith('play');
      if (isChunk) {
        const kb = Uint8Array.from(k, (c) => c.charCodeAt(0));
        const dim = len === 13 ? i32(kb, 8) : 0;
        const tag = kb[len - 1];
        const list = readNbtList(value);
        if (tag === TAG_BLOCK_ENTITY) {
          for (const be of list) {
            if (!be || typeof be !== 'object') continue;
            const type = typeof be.id === 'string' ? be.id : 'Bloque';
            if (be.LootTable && !(Array.isArray(be.Items) && be.Items.length)) stats.lootChests++;
            const x = num(be.x);
            const y = num(be.y);
            const z = num(be.z);
            const base = { kind: 'container', type, dim, x, y, z };
            if (typeof be.CustomName === 'string' && be.CustomName) base.label = be.CustomName;
            let found = 0;
            collectItems(be, (info, via) => {
              add(info, location(`c|${dim}|${x}|${y}|${z}|${type}`, base), via);
              found++;
            });
            if (found) stats.containers++;
          }
        } else {
          for (const ent of list) handleEntity(ent, dim);
        }
      } else if (k.startsWith('actorprefix')) {
        const id = hex(Uint8Array.from(k.slice(11), (c) => c.charCodeAt(0)), 0, 8);
        handleEntity(readNbt(value), actorDim.get(id) ?? 0);
      } else if (k === '~local_player' || k.startsWith('player_server_')) {
        const nbt = readNbt(value);
        if (!nbt) continue;
        const pos = floorPos(nbt.Pos);
        const dim = num(nbt.DimensionId) ?? 0;
        const player = {
          id: k,
          local: k === '~local_player',
          dim,
          x: pos?.[0],
          y: pos != null ? pos[1] - 1 : undefined, // Pos es la altura de los ojos aprox.
          z: pos?.[2],
          stacks: 0,
          total: 0,
        };
        players.push(player);
        stats.players++;
        collectItems(nbt, (info, via, section) => {
          const loc = location(`p|${k}|${section}`, { kind: 'player', player: k, section: section || 'Inventory', dim, x: player.x, y: player.y, z: player.z });
          add(info, loc, via);
          player.stacks++;
          player.total += info.count;
        });
      }
    } catch (e) {
      stats.errors++;
      if (stats.errors <= 5) warnings.push(`Dato dañado en la clave ${printable(k)}: ${e.message}`);
    }
  }
  if (stats.errors > 5) warnings.push(`${stats.errors} entradas dañadas en total se han ignorado.`);

  players.sort((a, b) => (a.local === b.local ? b.total - a.total : a.local ? -1 : 1));
  onProgress(1);

  return {
    version: 1,
    worldName,
    scannedAt: Date.now(),
    items,
    locations,
    players,
    stats,
    warnings,
  };
}

function printable(k) {
  return [...k].map((c) => (c >= ' ' && c <= '~' ? c : '·')).join('').slice(0, 40);
}

export { keyToString };
