// Búsqueda por nombre exacto o parecido (tolera tildes, mayúsculas y
// pequeñas faltas de ortografía) en español, inglés o por id.

export const DIMENSIONS = { 0: 'Mundo normal', 1: 'Nether', 2: 'End' };

export const ENCHANTS = {
  0: 'Protección', 1: 'Protección contra el fuego', 2: 'Caída de pluma', 3: 'Protección contra explosiones',
  4: 'Protección contra proyectiles', 5: 'Espinas', 6: 'Respiración', 7: 'Agilidad acuática',
  8: 'Afinidad acuática', 9: 'Filo', 10: 'Castigo', 11: 'Perdición de los artrópodos', 12: 'Empuje',
  13: 'Aspecto ígneo', 14: 'Botín', 15: 'Eficiencia', 16: 'Toque de seda', 17: 'Irrompibilidad',
  18: 'Fortuna', 19: 'Poder', 20: 'Retroceso', 21: 'Llama', 22: 'Infinidad', 23: 'Suerte marina',
  24: 'Atracción', 25: 'Paso helado', 26: 'Reparación', 27: 'Maldición de ligamiento',
  28: 'Maldición de desaparición', 29: 'Empalamiento', 30: 'Propulsión acuática', 31: 'Lealtad',
  32: 'Canalización', 33: 'Disparo múltiple', 34: 'Perforación', 35: 'Carga rápida',
  36: 'Velocidad de alma', 37: 'Sigilo rápido', 38: 'Ráfaga de viento', 39: 'Densidad', 40: 'Brecha',
  41: 'Embestida',
};

// Nombres alternativos de encantamientos (inglés y otras traducciones) para la búsqueda.
const ENCHANT_ALIASES = {
  0: 'protection', 1: 'fire protection', 2: 'feather falling', 3: 'blast protection',
  4: 'projectile protection', 5: 'thorns', 6: 'respiration', 7: 'depth strider', 8: 'aqua affinity afinidad al agua',
  9: 'sharpness afilado', 10: 'smite aporrear', 11: 'bane of arthropods', 12: 'knockback derribar', 13: 'fire aspect',
  14: 'looting saqueo', 15: 'efficiency', 16: 'silk touch toque sedoso', 17: 'unbreaking irrompible', 18: 'fortune',
  19: 'power', 20: 'punch puñetazo', 21: 'flame', 22: 'infinity', 23: 'luck of the sea', 24: 'lure',
  25: 'frost walker', 26: 'mending', 27: 'curse of binding vinculacion', 28: 'curse of vanishing desvanecimiento',
  29: 'impaling empalar', 30: 'riptide corriente', 31: 'loyalty', 32: 'channeling', 33: 'multishot',
  34: 'piercing penetrante', 35: 'quick charge', 36: 'soul speed', 37: 'swift sneak', 38: 'wind burst',
  39: 'density', 40: 'breach', 41: 'lunge',
};

export const CONTAINERS = {
  Chest: 'Cofre', Barrel: 'Barril', ShulkerBox: 'Caja de Shulker', Hopper: 'Tolva', Furnace: 'Horno',
  BlastFurnace: 'Alto horno', Smoker: 'Ahumador', Dispenser: 'Dispensador', Dropper: 'Soltador',
  BrewingStand: 'Soporte para pociones', ItemFrame: 'Marco', GlowItemFrame: 'Marco luminoso',
  Lectern: 'Atril', Jukebox: 'Tocadiscos', Campfire: 'Fogata', SoulCampfire: 'Fogata de almas',
  ChiseledBookshelf: 'Librería cincelada', DecoratedPot: 'Vasija decorada', Crafter: 'Fabricador',
  BrushableBlock: 'Bloque sospechoso', Cauldron: 'Caldero', EnderChest: 'Cofre de Ender', Beacon: 'Faro',
  Shelf: 'Estante', Vault: 'Bóveda', TrialSpawner: 'Generador de desafío',
};

export const PLAYER_SECTIONS = {
  Inventory: 'Inventario', Armor: 'Armadura', Offhand: 'Mano secundaria', Mainhand: 'Mano',
  EnderChestInventory: 'Cofre de Ender', PlayerUIItems: 'Cursor / mesa de trabajo',
};

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/§./g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

export function shortId(id) {
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
}

export function prettyId(id) {
  return shortId(id)
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function itemLabel(id, names) {
  const ns = id.startsWith('minecraft:') ? names?.items?.[shortId(id)] : null;
  return ns || prettyId(id);
}

export function entityLabel(id, names) {
  const s = shortId(id);
  return (id.startsWith('minecraft:') && names?.entities?.[s]) || prettyId(id);
}

export function enchantLabel(id, lvl) {
  const name = ENCHANTS[id] ?? `Encantamiento ${id}`;
  const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][lvl] ?? String(lvl);
  return roman ? `${name} ${roman}` : name;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function wordSimilarity(q, w) {
  if (w.startsWith(q)) return 1;
  const max = q.length <= 4 ? 1 : q.length <= 7 ? 2 : 3;
  // compara con la palabra entera y con su comienzo (por si aún se está escribiendo)
  const d = Math.min(levenshtein(q, w, max), levenshtein(q, w.slice(0, q.length), max));
  if (d > max) return 0;
  return 1 - d / Math.max(q.length, 1);
}

/** Puntuación 0..1 de lo bien que `text` (normalizado) encaja con `q` (normalizado). */
export function score(q, text) {
  if (!q || !text) return 0;
  if (text === q) return 1;
  if (text.startsWith(q)) return 0.94;
  if ((' ' + text).includes(' ' + q)) return 0.9;
  if (text.includes(q)) return 0.8;
  const qw = q.split(' ');
  const tw = text.split(' ');
  if (qw.every((t) => tw.some((w) => w.startsWith(t)))) return 0.78;
  // Parecido: cada palabra de la búsqueda debe parecerse a alguna del nombre.
  let sum = 0;
  for (const t of qw) {
    if (t.length < 3) {
      if (!tw.some((w) => w.startsWith(t))) return 0;
      sum += 1;
      continue;
    }
    let best = 0;
    for (const w of tw) best = Math.max(best, wordSimilarity(t, w));
    if (best < 0.6) return 0;
    sum += best;
  }
  return 0.45 + 0.3 * (sum / qw.length);
}

export const EXACT = 0.88;
const MIN_SCORE = 0.55;

/**
 * Prepara textos de búsqueda para un índice (una vez por mundo).
 */
export function prepare(index, names) {
  const ids = new Map();
  for (const it of index.items) {
    if (!ids.has(it.id)) {
      const label = itemLabel(it.id, names);
      ids.set(it.id, {
        label,
        texts: [...new Set([normalize(label), normalize(prettyId(it.id)), normalize(it.id)])],
      });
    }
  }
  return { ids };
}

function enchantText(ench) {
  return normalize(ench.map(([id]) => `${ENCHANTS[id] ?? ''} ${ENCHANT_ALIASES[id] ?? ''}`).join(' '));
}

/**
 * @returns Array<{id,label,score,exact,reason,total,records:[item...]}>
 */
export function search(index, prepared, query, filters = {}) {
  const q = normalize(query);
  const { kind = 'all', dim = 'all', player = null } = filters;
  if (!q && !player) return [];

  const idScores = new Map();
  for (const [id, { texts }] of prepared.ids) {
    idScores.set(id, q ? Math.max(...texts.map((t) => score(q, t))) : 1);
  }

  const groups = new Map();
  for (const it of index.items) {
    const loc = index.locations[it.loc];
    if (kind !== 'all' && loc.kind !== kind) continue;
    if (dim !== 'all' && String(loc.dim) !== String(dim)) continue;
    if (player && loc.player !== player) continue;

    let s = idScores.get(it.id) || 0;
    let reason = null;
    if (q && it.name) {
      const cs = score(q, normalize(it.name));
      if (cs > s) {
        s = cs;
        reason = 'name';
      }
    }
    if (q && it.ench && s < EXACT) {
      const es = score(q, enchantText(it.ench));
      if (es >= 0.78 && es * 0.95 > s) {
        s = es * 0.95;
        reason = 'ench';
      }
    }
    if (s < MIN_SCORE) continue;

    let g = groups.get(it.id);
    if (!g) {
      g = { id: it.id, label: prepared.ids.get(it.id).label, score: 0, reasons: new Set(), total: 0, records: [] };
      groups.set(it.id, g);
    }
    g.score = Math.max(g.score, s);
    if (reason) g.reasons.add(reason);
    g.total += it.count;
    g.records.push(it);
  }

  return [...groups.values()]
    .map((g) => ({ ...g, exact: g.score >= EXACT }))
    .sort((a, b) => b.score - a.score || b.total - a.total || a.label.localeCompare(b.label));
}

/** Agrupa los registros de un resultado por lugar (mismo cofre / mismo jugador). */
export function groupByPlace(index, records) {
  const places = new Map();
  for (const it of records) {
    const key = it.loc + '|' + (it.via ? it.via.join('>') : '');
    let p = places.get(key);
    if (!p) {
      p = { loc: index.locations[it.loc], via: it.via || [], count: 0, items: [] };
      places.set(key, p);
    }
    p.count += it.count;
    p.items.push(it);
  }
  return [...places.values()].sort((a, b) => b.count - a.count);
}
