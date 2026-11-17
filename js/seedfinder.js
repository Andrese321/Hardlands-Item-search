// Buscador de estructuras por semilla para Minecraft Bedrock (1.18+).
//
// Posición de las estructuras: Bedrock divide el mundo en regiones de
// `spacing` chunks y coloca un intento de estructura por región. La posición
// dentro de la región sale de un generador Mersenne Twister (MT19937) sembrado
// con   semilla + salt - 245998635·regiónZ - 1724254968·regiónX   (32 bits).
// Algoritmo y constantes: Earthcomputer/bedrockified y hhhxiao/MCBEStructureFinder.
//
// Que el intento genere estructura depende del bioma. Desde 1.18 los biomas
// son iguales en Bedrock y Java, y se calculan con cubiomes (WebAssembly).

// ---------------------------------------------------------------- biomas

export const BIOME_NAMES = {
  0: 'Océano', 1: 'Llanura', 2: 'Desierto', 3: 'Colinas azotadas por el viento', 4: 'Bosque', 5: 'Taiga',
  6: 'Pantano', 7: 'Río', 10: 'Océano helado', 11: 'Río helado', 12: 'Llanura nevada', 14: 'Campos de champiñones',
  16: 'Playa', 21: 'Jungla', 23: 'Jungla dispersa', 24: 'Océano profundo', 25: 'Costa rocosa', 26: 'Playa nevada',
  27: 'Bosque de abedules', 29: 'Bosque oscuro', 30: 'Taiga nevada', 32: 'Taiga de pinos antiguos',
  34: 'Bosque azotado por el viento', 35: 'Sabana', 36: 'Meseta de sabana', 37: 'Badlands', 38: 'Badlands arboladas',
  44: 'Océano cálido', 45: 'Océano templado', 46: 'Océano frío', 47: 'Océano cálido profundo',
  48: 'Océano templado profundo', 49: 'Océano frío profundo', 50: 'Océano helado profundo',
  129: 'Llanura de girasoles', 131: 'Colinas de grava azotadas por el viento', 132: 'Bosque de flores',
  140: 'Picos de hielo', 155: 'Bosque de abedules antiguos', 160: 'Taiga de abetos antiguos',
  163: 'Sabana azotada por el viento', 165: 'Badlands erosionadas', 168: 'Jungla de bambú', 177: 'Pradera',
  178: 'Arboleda', 179: 'Laderas nevadas', 180: 'Picos escarpados', 181: 'Picos helados', 182: 'Picos rocosos',
  184: 'Manglar', 185: 'Arboleda de cerezos', 186: 'Jardín pálido',
};

const DEEP_OCEANS = [24, 47, 48, 49, 50];
const OCEANS_AND_RIVERS = [0, 10, 44, 45, 46, ...DEEP_OCEANS, 7, 11];
// Biomas donde generan aldeas en Bedrock.
const VILLAGE_BIOMES = [1, 129, 35, 2, 5, 30, 12, 177];
// Puestos de saqueadores: los biomas de aldea más los de montaña.
const OUTPOST_BIOMES = [...VILLAGE_BIOMES, 178, 179, 180, 181, 182, 185];

// ---------------------------------------------------------------- estructuras

// spacing: tamaño de la región (chunks). range: spacing - separación.
// tri: posición «triangular» (media de dos números al azar por eje).
// checks: [[radioEnBloques, biomasPermitidos], ...] alrededor del centro del chunk.
export const STRUCTURES = {
  monument: {
    name: 'Monumento oceánico', plural: 'monumentos oceánicos', spacing: 32, range: 27, salt: 10387313, tri: true,
    checks: [[0, DEEP_OCEANS], [16, DEEP_OCEANS], [29, OCEANS_AND_RIVERS]],
  },
  outpost: {
    name: 'Puesto de saqueadores', plural: 'puestos de saqueadores', spacing: 80, range: 56, salt: 165745296, tri: true,
    checks: [[0, OUTPOST_BIOMES]],
  },
  village: {
    name: 'Aldea', plural: 'aldeas', spacing: 34, range: 26, salt: 10387312, tri: true,
    checks: [[0, VILLAGE_BIOMES]],
  },
  mansion: {
    name: 'Mansión del bosque', plural: 'mansiones del bosque', spacing: 80, range: 60, salt: 10387319, tri: true,
    checks: [[0, [29, 186]], [32, [29, 186]]],
  },
  desert_temple: {
    name: 'Templo del desierto', plural: 'templos del desierto', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [2]]],
  },
  jungle_temple: {
    name: 'Templo de la jungla', plural: 'templos de la jungla', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [21, 168]]],
  },
  witch_hut: {
    name: 'Cabaña de bruja', plural: 'cabañas de bruja', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [6]]],
  },
  igloo: {
    name: 'Iglú', plural: 'iglús', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [12, 30, 179]]],
  },
};

// ---------------------------------------------------------------- MT19937

const MT = new Uint32Array(402);

// Primeros `n` (≤4) números del Mersenne Twister sembrado con `seed`.
export function mtFirst(seed, n, out) {
  let prev = seed >>> 0;
  MT[0] = prev;
  const last = 397 + n;
  for (let i = 1; i <= last; i++) {
    prev = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    if (i <= n || i >= 397) MT[i < 397 ? i : i - 397 + 5] = prev;
  }
  for (let i = 0; i < n; i++) {
    const y0 = (MT[i] & 0x80000000) | (MT[i + 1] & 0x7fffffff);
    let y = MT[i + 5] ^ (y0 >>> 1) ^ (y0 & 1 ? 0x9908b0df : 0);
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    out[i] = y >>> 0;
  }
}

const R = new Uint32Array(4);

/** Chunk del intento de estructura en la región (rx, rz): [chunkX, chunkZ]. */
export function attemptInRegion(cfg, seed32, rx, rz) {
  const s = (seed32 + cfg.salt + Math.imul(rz, -245998635) + Math.imul(rx, -1724254968)) >>> 0;
  let ox;
  let oz;
  if (cfg.tri) {
    mtFirst(s, 4, R);
    ox = ((R[0] % cfg.range) + (R[1] % cfg.range)) >> 1;
    oz = ((R[2] % cfg.range) + (R[3] % cfg.range)) >> 1;
  } else {
    mtFirst(s, 2, R);
    ox = R[0] % cfg.range;
    oz = R[1] % cfg.range;
  }
  return [rx * cfg.spacing + ox, rz * cfg.spacing + oz];
}

// ---------------------------------------------------------------- semilla

/** Interpreta una semilla numérica (admite negativos y 64 bits). */
export function parseSeed(text) {
  const t = String(text).trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error('La semilla tiene que ser un número (por ejemplo -1234567890).');
  const v = BigInt(t);
  if (v < -(2n ** 63n) || v >= 2n ** 64n) throw new Error('La semilla es demasiado larga.');
  const u = BigInt.asUintN(64, v);
  return { lo: Number(u & 0xffffffffn), hi: Number(u >> 32n), text: BigInt.asIntN(64, v).toString() };
}

// ---------------------------------------------------------------- biomas (cubiomes)

/** Carga cubiomes.wasm. `bytes` = contenido del fichero vendor/cubiomes.wasm. */
export async function loadBiomes(bytes) {
  const wasi = {
    fd_close: () => 0, fd_fdstat_get: () => 0, fd_seek: () => 0, fd_write: () => 0,
    proc_exit: () => { throw new Error('cubiomes terminó de forma inesperada'); },
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  const e = instance.exports;
  e._initialize();
  const maskPtr = e.mask_ptr();
  let current = null;
  let seedKey = null;
  return {
    setSeed(seed) {
      if (seedKey === seed.text) return;
      e.seed_init(seed.lo, seed.hi);
      seedKey = seed.text;
    },
    biomeAt(x, z) { return e.biome_at(x, z); },
    /** ¿Todos los biomas del cuadrado de radio r alrededor de (x, z) están en `allowed`? */
    areaOnly(x, z, r, allowed) {
      if (current !== allowed) {
        const mask = new Uint8Array(e.memory.buffer, maskPtr, 256);
        mask.fill(0);
        for (const id of allowed) mask[id] = 1;
        current = allowed;
      }
      return e.area_only(x, z, r) === 1;
    },
  };
}

// ---------------------------------------------------------------- búsqueda
//
// La búsqueda se reparte en tareas independientes (franjas de regiones) para
// poder ejecutarlas en varios hilos. Cada tarea calcula los intentos de su
// franja, descarta los que no tienen otra estructura cerca (barato) y solo
// entonces comprueba el bioma (caro).

const LIMIT = 300;

const gridKey = (cfg) => `${cfg.spacing}|${cfg.range}|${cfg.salt}|${cfg.tri ? 1 : 0}`;

const masks = new Map();
function maskOf(allowed) {
  let m = masks.get(allowed);
  if (!m) {
    m = new Uint8Array(256);
    for (const id of allowed) m[id] = 1;
    masks.set(allowed, m);
  }
  return m;
}

/** Ventana de regiones de una misma rejilla de colocación, con sus intentos. */
class Grid {
  constructor(cfg, seed32, rx0, rx1, rz0, rz1) {
    Object.assign(this, { cfg, rx0, rx1, rz0, rz1, w: rx1 - rx0 + 1, h: rz1 - rz0 + 1 });
    const n = this.w * this.h;
    this.xs = new Int32Array(n);
    this.zs = new Int32Array(n);
    this.biome = new Int16Array(n).fill(-2);
    this.state = new Map(); // tipo -> Uint8Array (0 sin comprobar, 1 válido, 2 no válido)
    this.checked = 0;
    let i = 0;
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++, i++) {
        const [x, z] = attemptInRegion(cfg, seed32, rx, rz);
        this.xs[i] = x;
        this.zs[i] = z;
      }
    }
  }

  index(rx, rz) {
    return (rz - this.rz0) * this.w + (rx - this.rx0);
  }

  viable(biomes, type, i) {
    let st = this.state.get(type);
    if (!st) this.state.set(type, (st = new Uint8Array(this.w * this.h)));
    if (st[i]) return st[i] === 1;
    const x = this.xs[i] * 16 + 8;
    const z = this.zs[i] * 16 + 8;
    let b = this.biome[i];
    if (b === -2) {
      b = biomes.biomeAt(x, z);
      this.biome[i] = b;
      this.checked++;
    }
    let ok = true;
    for (const [r, allowed] of STRUCTURES[type].checks) {
      if (r === 0 ? !(b >= 0 && b < 256 && maskOf(allowed)[b]) : !biomes.areaOnly(x, z, r, allowed)) {
        ok = false;
        break;
      }
    }
    st[i] = ok ? 1 : 2;
    return ok;
  }

  point(i) {
    return { x: this.xs[i] * 16 + 8, z: this.zs[i] * 16 + 8, biome: this.biome[i] };
  }
}

/** Lista acotada: se queda con los `limit` mejores según `cmp`. */
class Top {
  constructor(cmp, limit = LIMIT) {
    Object.assign(this, { cmp, limit, items: [] });
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.limit * 4) this.trim();
  }

  trim() {
    this.items.sort(this.cmp);
    if (this.items.length > this.limit) this.items.length = this.limit;
    return this.items;
  }
}

// Desempate fijo para que el resultado no dependa del orden en que terminan las tareas.
const tie = (p, q) => {
  const a = p.a || p;
  const b = q.a || q;
  return a.x - b.x || a.z - b.z || (p.b && q.b ? p.b.x - q.b.x || p.b.z - q.b.z : 0) || (p.type || '').localeCompare(q.type || '');
};
const bySize = (p, q) => q.size - p.size || p.span - q.span || p.fromCenter - q.fromCenter || tie(p, q);
const byCenter = (p, q) => p.fromCenter - q.fromCenter || tie(p, q);
const byPair = (p, q) => p.chunks - q.chunks || p.fromCenter - q.fromCenter || tie(p, q);

function normalize(opts) {
  const o = {
    mode: 'multi', types: null, a: null, b: null, maxChunks: 10, centerX: 0, centerZ: 0, radius: 5000, ...opts,
  };
  o.maxChunks = Math.max(1, Math.min(40, Math.round(o.maxChunks)));
  if (o.mode === 'multi') {
    o.types = (o.types && o.types.length ? o.types : Object.keys(STRUCTURES)).filter((t) => STRUCTURES[t]);
    if (!o.types.length) throw new Error('Estructura desconocida.');
  } else {
    if (!STRUCTURES[o.a] || (o.b && !STRUCTURES[o.b])) throw new Error('Estructura desconocida.');
    if (!o.b) o.mode = 'single';
  }
  return o;
}

// Regiones de `cfg` que tocan el cuadrado de búsqueda ampliado `margin` chunks.
function regionRange(cfg, o, margin) {
  const c0x = Math.floor((o.centerX - o.radius) / 16) - margin;
  const c1x = Math.floor((o.centerX + o.radius) / 16) + margin;
  const c0z = Math.floor((o.centerZ - o.radius) / 16) - margin;
  const c1z = Math.floor((o.centerZ + o.radius) / 16) + margin;
  // un intento de la región r está en [r·spacing, r·spacing + range)
  return {
    rx0: Math.floor((c0x - cfg.range + 1) / cfg.spacing), rx1: Math.floor(c1x / cfg.spacing),
    rz0: Math.floor((c0z - cfg.range + 1) / cfg.spacing), rz1: Math.floor(c1z / cfg.spacing),
  };
}

/** Divide una búsqueda en tareas independientes (de unas `taskRegions` regiones cada una). */
export function planTasks(options, taskRegions = 120000) {
  const o = normalize(options);
  const tasks = [];
  const strips = (cfg, extra, margin) => {
    const r = regionRange(cfg, o, margin);
    const cols = r.rx1 - r.rx0 + 1;
    const rows = Math.max(2, Math.floor(taskRegions / cols));
    for (let a = r.rz0; a <= r.rz1; a += rows) tasks.push({ ...extra, rz0: a, rz1: Math.min(r.rz1, a + rows - 1) });
  };
  if (o.mode === 'multi') {
    const grids = new Map();
    for (const t of o.types) {
      const k = gridKey(STRUCTURES[t]);
      if (!grids.has(k)) grids.set(k, []);
      grids.get(k).push(t);
    }
    for (const types of grids.values()) strips(STRUCTURES[types[0]], { kind: 'multi', types }, o.maxChunks);
  } else if (o.mode === 'pairs') {
    // Se recorre el tipo más escaso (regiones más grandes).
    const swap = STRUCTURES[o.b].spacing > STRUCTURES[o.a].spacing;
    const [outer, inner] = swap ? [o.b, o.a] : [o.a, o.b];
    strips(STRUCTURES[outer], { kind: 'pairs', outer, inner, swap }, o.maxChunks);
  } else {
    strips(STRUCTURES[o.a], { kind: 'single', type: o.a }, 0);
  }
  return { options: o, tasks };
}

function inSquare(o, x, z) {
  return Math.abs(x - o.centerX) <= o.radius && Math.abs(z - o.centerZ) <= o.radius;
}

// Cliques máximos (Bron–Kerbosch) entre estructuras a `max2` de distancia.
function cliques(R, P, X, adjacent, emit) {
  if (!P.length) {
    if (!X.length && R.length > 1) emit(R);
    return;
  }
  const rest = P.slice();
  const excluded = X.slice();
  for (const v of P) {
    cliques([...R, v], rest.filter((u) => u !== v && adjacent(u, v)), excluded.filter((u) => adjacent(u, v)), adjacent, emit);
    rest.splice(rest.indexOf(v), 1);
    excluded.push(v);
  }
}

function runMulti(biomes, o, task) {
  const cfg = STRUCTURES[task.types[0]];
  const N = o.maxChunks;
  const max2 = N * N;
  const own = regionRange(cfg, o, N);
  const dr = Math.floor((N + cfg.range - 1) / cfg.spacing); // regiones vecinas que pueden estar a N chunks
  const g = new Grid(cfg, o.seed.lo, own.rx0 - dr, own.rx1 + dr, task.rz0 - dr, task.rz1 + dr);
  const { xs, zs } = g;
  const adjacent = (i, j) => {
    const dx = xs[i] - xs[j];
    const dz = zs[i] - zs[j];
    return dx * dx + dz * dz <= max2;
  };
  const counts = {};
  const best = {}; // mejor grupo de cada tipo (más grande y, a igual tamaño, más junto)
  const tops = { size: new Top(bySize), center: new Top(byCenter), center3: new Top(byCenter) };

  for (let rz = task.rz0; rz <= task.rz1; rz++) {
    for (let rx = own.rx0; rx <= own.rx1; rx++) {
      const i = g.index(rx, rz);
      const near = [];
      for (let jz = rz - dr; jz <= rz + dr; jz++) {
        for (let jx = rx - dr; jx <= rx + dr; jx++) {
          const j = g.index(jx, jz);
          if (j !== i && adjacent(i, j)) near.push(j);
        }
      }
      if (!near.length) continue;
      for (const type of task.types) {
        if (!g.viable(biomes, type, i)) continue;
        const later = [];
        const earlier = [];
        for (const j of near) if (g.viable(biomes, type, j)) (j > i ? later : earlier).push(j);
        if (!later.length) continue;
        cliques([i], later, earlier, adjacent, (members) => {
          let sx = 0;
          let sz = 0;
          let span2 = 0;
          for (let a = 0; a < members.length; a++) {
            sx += xs[members[a]];
            sz += zs[members[a]];
            for (let b = a + 1; b < members.length; b++) {
              const dx = xs[members[a]] - xs[members[b]];
              const dz = zs[members[a]] - zs[members[b]];
              span2 = Math.max(span2, dx * dx + dz * dz);
            }
          }
          const cx = Math.round((sx / members.length) * 16 + 8);
          const cz = Math.round((sz / members.length) * 16 + 8);
          if (!inSquare(o, cx, cz)) return;
          const size = members.length;
          const span = Math.sqrt(span2);
          counts[type] ||= {};
          counts[type][size] = (counts[type][size] || 0) + 1;
          const group = {
            type, size, span: Math.round(span * 10) / 10, blocks: Math.round(span * 16), x: cx, z: cz,
            fromCenter: Math.round(Math.hypot(cx - o.centerX, cz - o.centerZ)),
            members: members.map((m) => g.point(m)),
          };
          if (!best[type] || bySize(group, best[type]) < 0) best[type] = group;
          tops.size.push(group);
          tops.center.push(group);
          if (size >= 3) tops.center3.push(group);
        });
      }
    }
  }
  return {
    kind: 'multi', counts, best, checked: g.checked,
    size: tops.size.trim(), center: tops.center.trim(), center3: tops.center3.trim(),
  };
}

function runPairs(biomes, o, task) {
  const O = STRUCTURES[task.outer];
  const I = STRUCTURES[task.inner];
  const N = o.maxChunks;
  const max2 = N * N;
  const own = regionRange(O, o, N);
  const sameGrid = gridKey(O) === gridKey(I);
  const sameType = task.outer === task.inner;
  // Ventana de la rejilla interior que cubre la franja ampliada N chunks.
  const iw = {
    rx0: Math.floor((own.rx0 * O.spacing - N - I.range + 1) / I.spacing), rx1: Math.floor(((own.rx1 + 1) * O.spacing + N) / I.spacing),
    rz0: Math.floor((task.rz0 * O.spacing - N - I.range + 1) / I.spacing), rz1: Math.floor(((task.rz1 + 1) * O.spacing + N) / I.spacing),
  };
  const gi = new Grid(I, o.seed.lo, iw.rx0, iw.rx1, iw.rz0, iw.rz1);
  const go = sameGrid ? gi : new Grid(O, o.seed.lo, own.rx0, own.rx1, task.rz0, task.rz1);
  const outerFirst = O.checks.length <= I.checks.length;
  const tops = { pair: new Top(byPair), center: new Top(byCenter) };
  let total = 0;

  for (let rz = task.rz0; rz <= task.rz1; rz++) {
    for (let rx = own.rx0; rx <= own.rx1; rx++) {
      const i = go.index(rx, rz);
      const ox = go.xs[i];
      const oz = go.zs[i];
      const jx1 = Math.floor((ox + N) / I.spacing);
      const jz1 = Math.floor((oz + N) / I.spacing);
      for (let jz = Math.floor((oz - N - I.range + 1) / I.spacing); jz <= jz1; jz++) {
        for (let jx = Math.floor((ox - N - I.range + 1) / I.spacing); jx <= jx1; jx++) {
          const j = gi.index(jx, jz);
          const dx = gi.xs[j] - ox;
          const dz = gi.zs[j] - oz;
          const d2 = dx * dx + dz * dz;
          if (d2 > max2) continue;
          if (sameGrid && (j === i || (sameType && j < i))) continue; // el mismo intento, o pareja ya contada
          const ok = outerFirst
            ? go.viable(biomes, task.outer, i) && gi.viable(biomes, task.inner, j)
            : gi.viable(biomes, task.inner, j) && go.viable(biomes, task.outer, i);
          if (!ok) continue;
          const po = { ...go.point(i), name: O.name };
          const pi = { ...gi.point(j), name: I.name };
          const mx = (po.x + pi.x) / 2;
          const mz = (po.z + pi.z) / 2;
          if (!inSquare(o, mx, mz)) continue;
          const dist = Math.sqrt(d2);
          const pair = {
            a: task.swap ? pi : po, b: task.swap ? po : pi,
            chunks: Math.round(dist * 10) / 10, blocks: Math.round(dist * 16),
            fromCenter: Math.round(Math.hypot(mx - o.centerX, mz - o.centerZ)),
          };
          total++;
          tops.pair.push(pair);
          tops.center.push(pair);
        }
      }
    }
  }
  return { kind: 'pairs', total, checked: go.checked + (sameGrid ? 0 : gi.checked), pair: tops.pair.trim(), center: tops.center.trim() };
}

function runSingle(biomes, o, task) {
  const cfg = STRUCTURES[task.type];
  const own = regionRange(cfg, o, 0);
  const g = new Grid(cfg, o.seed.lo, own.rx0, own.rx1, task.rz0, task.rz1);
  const top = new Top(byCenter);
  let total = 0;
  for (let i = 0; i < g.xs.length; i++) {
    const x = g.xs[i] * 16 + 8;
    const z = g.zs[i] * 16 + 8;
    if (!inSquare(o, x, z) || !g.viable(biomes, task.type, i)) continue;
    total++;
    top.push({ a: { ...g.point(i), name: cfg.name }, fromCenter: Math.round(Math.hypot(x - o.centerX, z - o.centerZ)) });
  }
  return { kind: 'single', total, checked: g.checked, center: top.trim() };
}

/** Ejecuta una tarea de planTasks. `options` = las opciones normalizadas del plan. */
export function runTask(biomes, options, task) {
  biomes.setSeed(options.seed);
  if (task.kind === 'multi') return runMulti(biomes, options, task);
  if (task.kind === 'pairs') return runPairs(biomes, options, task);
  return runSingle(biomes, options, task);
}

/** Junta los resultados de todas las tareas. */
export function mergeResults(options, parts) {
  const out = { mode: options.mode, checked: 0 };
  const cat = (key, cmp) => {
    const top = new Top(cmp);
    for (const p of parts) for (const item of p[key] || []) top.push(item);
    return top.trim();
  };
  for (const p of parts) out.checked += p.checked;
  if (options.mode === 'multi') {
    out.counts = {};
    out.best = {};
    for (const p of parts) {
      for (const [type, group] of Object.entries(p.best)) {
        if (!out.best[type] || bySize(group, out.best[type]) < 0) out.best[type] = group;
      }
      for (const [type, sizes] of Object.entries(p.counts)) {
        out.counts[type] ||= {};
        for (const [size, n] of Object.entries(sizes)) out.counts[type][size] = (out.counts[type][size] || 0) + n;
      }
    }
    out.types = options.types;
    out.size = cat('size', bySize);
    out.center = cat('center', byCenter);
    out.center3 = cat('center3', byCenter);
  } else if (options.mode === 'pairs') {
    out.total = parts.reduce((s, p) => s + p.total, 0);
    out.pair = cat('pair', byPair);
    out.center = cat('center', byCenter);
  } else {
    out.total = parts.reduce((s, p) => s + p.total, 0);
    out.center = cat('center', byCenter);
  }
  return out;
}

/** Búsqueda completa en un solo hilo (pruebas y navegadores sin varios hilos). */
export function search(biomes, options, onProgress = () => {}) {
  const plan = planTasks(options);
  const parts = plan.tasks.map((task, i) => {
    const r = runTask(biomes, plan.options, task);
    onProgress((i + 1) / plan.tasks.length);
    return r;
  });
  return mergeResults(plan.options, parts);
}
