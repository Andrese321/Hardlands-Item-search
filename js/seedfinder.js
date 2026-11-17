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
    name: 'Monumento oceánico', spacing: 32, range: 27, salt: 10387313, tri: true,
    checks: [[0, DEEP_OCEANS], [16, DEEP_OCEANS], [29, OCEANS_AND_RIVERS]],
  },
  outpost: {
    name: 'Puesto de saqueadores', spacing: 80, range: 56, salt: 165745296, tri: true,
    checks: [[0, OUTPOST_BIOMES]],
  },
  village: {
    name: 'Aldea', spacing: 34, range: 26, salt: 10387312, tri: true,
    checks: [[0, VILLAGE_BIOMES]],
  },
  mansion: {
    name: 'Mansión del bosque', spacing: 80, range: 60, salt: 10387319, tri: true,
    checks: [[0, [29, 186]], [32, [29, 186]]],
  },
  desert_temple: {
    name: 'Templo del desierto', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [2]]],
  },
  jungle_temple: {
    name: 'Templo de la jungla', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [21, 168]]],
  },
  witch_hut: {
    name: 'Cabaña de bruja', spacing: 32, range: 24, salt: 14357617, tri: false,
    checks: [[0, [6]]],
  },
  igloo: {
    name: 'Iglú', spacing: 32, range: 24, salt: 14357617, tri: false,
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
  return {
    setSeed(seed) { e.seed_init(seed.lo, seed.hi); },
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

function viable(biomes, cfg, cx, cz) {
  const x = cx * 16 + 8;
  const z = cz * 16 + 8;
  for (const [r, allowed] of cfg.checks) if (!biomes.areaOnly(x, z, r, allowed)) return false;
  return true;
}

// ---------------------------------------------------------------- búsqueda

const key = (x, z) => x + ',' + z;

/**
 * Busca estructuras en una semilla.
 *
 * @param opts.seed       resultado de parseSeed
 * @param opts.a          tipo de estructura (clave de STRUCTURES)
 * @param opts.b          segundo tipo, o null para listar solo `a`
 * @param opts.maxChunks  distancia máxima entre las dos (en chunks)
 * @param opts.centerX/Z  centro de la búsqueda (bloques)
 * @param opts.radius     radio de la búsqueda (bloques)
 * @param opts.limit      máximo de resultados
 * @returns { results, checked, truncated }
 */
export function findStructures(biomes, opts, onProgress = () => {}) {
  const { seed, a, b = null, maxChunks = 10, centerX = 0, centerZ = 0, radius = 5000, limit = 300 } = opts;
  const A = STRUCTURES[a];
  const B = b ? STRUCTURES[b] : null;
  if (!A || (b && !B)) throw new Error('Estructura desconocida.');
  biomes.setSeed(seed);
  const seed32 = seed.lo;

  const ccx = Math.floor(centerX / 16);
  const ccz = Math.floor(centerZ / 16);
  const rad = Math.ceil(radius / 16);
  const inRange = (x, z) => Math.abs(x - ccx) <= rad && Math.abs(z - ccz) <= rad;

  const cache = new Map();
  let checked = 0;
  const isViable = (type, cfg, x, z) => {
    const k = type + key(x, z);
    let v = cache.get(k);
    if (v === undefined) {
      v = viable(biomes, cfg, x, z);
      cache.set(k, v);
      checked++;
    }
    return v;
  };
  const describe = (cfg, x, z) => ({
    name: cfg.name, x: x * 16 + 8, z: z * 16 + 8, chunkX: x, chunkZ: z,
    biome: biomes.biomeAt(x * 16 + 8, z * 16 + 8),
  });

  const results = [];
  const regions = (cfg) => ({
    x0: Math.floor((ccx - rad) / cfg.spacing), x1: Math.floor((ccx + rad) / cfg.spacing),
    z0: Math.floor((ccz - rad) / cfg.spacing), z1: Math.floor((ccz + rad) / cfg.spacing),
  });

  if (!B) {
    // Solo una estructura: las más cercanas al centro.
    const r = regions(A);
    const all = [];
    for (let rz = r.z0; rz <= r.z1; rz++) {
      for (let rx = r.x0; rx <= r.x1; rx++) {
        const [x, z] = attemptInRegion(A, seed32, rx, rz);
        if (inRange(x, z)) all.push([x, z, Math.hypot(x - ccx, z - ccz)]);
      }
    }
    all.sort((p, q) => p[2] - q[2]);
    for (let i = 0; i < all.length && results.length < limit; i++) {
      const [x, z, d] = all[i];
      if (i % 200 === 0) onProgress(i / all.length);
      if (isViable(a, A, x, z)) results.push({ a: describe(A, x, z), fromCenter: Math.round(d * 16) });
    }
    return { results, checked, truncated: results.length >= limit };
  }

  // Dos estructuras: se recorre la más escasa (regiones más grandes) y se
  // miran las regiones de la otra que quedan a `maxChunks` de distancia.
  const swap = B.spacing > A.spacing;
  const [outer, outerType, inner, innerType] = swap ? [B, b, A, a] : [A, a, B, b];
  const same = a === b;
  const r = regions(outer);
  const max2 = maxChunks * maxChunks;
  const pairs = [];
  const rows = r.z1 - r.z0 + 1;
  for (let rz = r.z0; rz <= r.z1; rz++) {
    if ((rz - r.z0) % 8 === 0) onProgress(0.5 * ((rz - r.z0) / rows));
    for (let rx = r.x0; rx <= r.x1; rx++) {
      const [ox, oz] = attemptInRegion(outer, seed32, rx, rz);
      if (!inRange(ox, oz)) continue;
      const ix0 = Math.floor((ox - maxChunks) / inner.spacing);
      const ix1 = Math.floor((ox + maxChunks) / inner.spacing);
      const iz0 = Math.floor((oz - maxChunks) / inner.spacing);
      const iz1 = Math.floor((oz + maxChunks) / inner.spacing);
      for (let jz = iz0; jz <= iz1; jz++) {
        for (let jx = ix0; jx <= ix1; jx++) {
          const [ix, iz] = attemptInRegion(inner, seed32, jx, jz);
          const d2 = (ix - ox) * (ix - ox) + (iz - oz) * (iz - oz);
          if (d2 > max2) continue;
          if (same && (d2 === 0 || ix < ox || (ix === ox && iz < oz))) continue; // cada pareja una vez
          if (innerType !== outerType && d2 === 0 && inner.salt === outer.salt) continue; // mismo intento, otro bioma
          pairs.push([ox, oz, ix, iz, d2]);
        }
      }
    }
  }
  pairs.sort((p, q) => p[4] - q[4] || Math.hypot(p[0] - ccx, p[1] - ccz) - Math.hypot(q[0] - ccx, q[1] - ccz));

  for (let i = 0; i < pairs.length && results.length < limit; i++) {
    if (i % 50 === 0) onProgress(0.5 + 0.5 * (i / pairs.length));
    const [ox, oz, ix, iz, d2] = pairs[i];
    // Primero la comprobación más barata.
    const outerFirst = outer.checks.length <= inner.checks.length;
    const ok = outerFirst
      ? isViable(outerType, outer, ox, oz) && isViable(innerType, inner, ix, iz)
      : isViable(innerType, inner, ix, iz) && isViable(outerType, outer, ox, oz);
    if (!ok) continue;
    const pa = swap ? describe(A, ix, iz) : describe(A, ox, oz);
    const pb = swap ? describe(B, ox, oz) : describe(B, ix, iz);
    const dist = Math.sqrt(d2);
    results.push({
      a: pa, b: pb,
      chunks: Math.round(dist * 10) / 10,
      blocks: Math.round(dist * 16),
      fromCenter: Math.round(Math.hypot((pa.x + pb.x) / 2 - centerX, (pa.z + pb.z) / 2 - centerZ)),
    });
  }
  onProgress(1);
  return { results, checked, candidates: pairs.length, truncated: results.length >= limit };
}
