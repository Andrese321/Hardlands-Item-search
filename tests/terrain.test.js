import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { openZip } from '../js/zip.js';
import {
  setBlockColors, renderDimension, renderColumns, composeTiles, decodeSubChunk,
  styleColor, styleKind, styleOf, NO_HEIGHT, STYLE_WATER, KIND_AIR,
} from '../js/terrain.js';

const COLORS = JSON.parse(readFileSync(new URL('../data/block_colors.json', import.meta.url)));
setBlockColors(COLORS);
const hex = (name) => parseInt(COLORS['minecraft:' + name], 16);

const zip = await openZip(new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]));
const db = zip.entries.filter((e) => e.name.startsWith('db/')).map((e) => ({ name: e.name.slice(3), size: e.size, read: () => zip.read(e) }));

/** Lee el resultado de la columna (wx, wz) del mapa: { h, color, depth }. */
async function columns(dim, mode) {
  const chunks = new Map();
  // renderDimension compone teselas; para mirar alturas exactas se usa su resultado intermedio
  const out = await renderDimension(db, dim, mode, { keepColumns: chunks });
  return { out, at: (wx, wz) => {
    const ch = chunks.get(Math.floor(wx / 16) + ',' + Math.floor(wz / 16));
    if (!ch) return null;
    const i = ((wz & 15) << 4) | (wx & 15);
    return { h: ch.h[i], color: styleColor[ch.c[i]], water: ch.c[i] === STYLE_WATER, depth: ch.d[i] };
  } };
}

// Igual que en generate_world.py
const surface = (wx, wz) => 66 + ((wx * 3 + wz * 7) % 9) - (wx < 16 && wz < 16 ? 4 : 0);

test('base de datos real del juego (mundo plano): hierba sobre tierra y roca madre', async () => {
  const dir = new URL('./fixtures/real_flat_db/', import.meta.url);
  const files = readdirSync(dir).map((name) => ({
    name, size: statSync(new URL(name, dir)).size, read: async () => new Uint8Array(readFileSync(new URL(name, dir))),
  }));
  const keep = new Map();
  const out = await renderDimension(files, 0, { type: 'top' }, { keepColumns: keep });
  assert.equal(out.chunks, 57);
  for (const ch of keep.values()) {
    for (let i = 0; i < 256; i++) {
      assert.equal(ch.h[i], 3);
      assert.equal(styleColor[ch.c[i]], hex('grass_block'));
    }
  }
});

test('superficie del mundo normal: relieve, huecos entre subchunks y bloques de piedra', async () => {
  const { at } = await columns(0, { type: 'top' });
  // zona con relieve (fuera del lago); si la hierba queda por debajo de y 64 se ve el deepslate de y -49
  for (const [wx, wz] of [[20, 3], [40, 50], [62, 63], [17, 30], [2, 2], [1, 14]]) {
    const h = surface(wx, wz);
    const c = at(wx, wz);
    if (h >= 64) {
      assert.deepEqual([c.h, c.color], [h, hex('grass_block')], `columna ${wx},${wz}`);
    } else {
      assert.deepEqual([c.h, c.color], [-49, hex('deepslate')], `columna ${wx},${wz}`);
    }
  }
  // chunks de piedra
  assert.deepEqual([at(160, 160).h, at(160, 160).color], [79, hex('stone')]);
  assert.deepEqual([at(-300, 150).h, at(-300, 150).color], [79, hex('stone')]);
});

test('agua: profundidad hasta el fondo y kelp anegado', async () => {
  const { at } = await columns(0, { type: 'top' });
  const lake = at(5, 5);
  assert.ok(lake.water);
  assert.deepEqual([lake.h, lake.depth], [74, 8]);
  const kelp = at(6, 6); // kelp con agua en la segunda capa: se ve como agua
  assert.ok(kelp.water);
  assert.deepEqual([kelp.h, kelp.depth], [74, 8]);
});

test('versiones: gana la más nueva entre registro, nivel 0 y niveles profundos', async () => {
  const { at } = await columns(0, { type: 'top' });
  // torre reemplazada por una más baja
  assert.deepEqual([at(24, 24).h, at(24, 24).color], [82, hex('red_wool')]);
  // subchunk borrado en el registro: el oro desaparece
  assert.equal(at(32, 32).color, hex('grass_block'));
  assert.equal(at(32, 32).h, surface(32, 32));
  // subchunk nuevo solo en el registro
  assert.deepEqual([at(63, 63).h, at(63, 63).color], [80, hex('diamond_block')]);
});

test('Nether: desde arriba se ve el techo; con corte se ve el suelo de las cuevas', async () => {
  const top = await columns(1, { type: 'top' });
  assert.deepEqual([top.at(-120, 190).h, top.at(-120, 190).color], [127, hex('netherrack')]);

  const cut = await columns(1, { type: 'slice', y: 100 });
  assert.deepEqual([cut.at(-120, 190).h, cut.at(-120, 190).color], [40, hex('crimson_nylium')]);
  // columna de basalto (x 3, z 3 de cada chunk)
  assert.deepEqual([cut.at(-125, 179).h, cut.at(-125, 179).color], [60, hex('basalt')]);
  // corte en el aire: mismo suelo
  assert.equal((await columns(1, { type: 'slice', y: 70 })).at(-120, 190).h, 40);
  // corte dentro de roca maciza hasta la lava: no hay suelo con aire encima
  assert.equal((await columns(1, { type: 'slice', y: 35 })).at(-120, 190).h, NO_HEIGHT);
  assert.equal(cut.out.chunks, 9);
});

test('teselas: color exacto en terreno llano y sombreado de relieve', async () => {
  const { out } = await columns(0, { type: 'top' });
  const pixel = (wx, wz) => {
    const tx = Math.floor(wx / 256);
    const tz = Math.floor(wz / 256);
    const t = out.tiles.find((q) => q.tx === tx && q.tz === tz);
    if (!t) return null;
    const p = (((wz - tz * 256) * 256) + (wx - tx * 256)) * 4;
    return [t.data[p], t.data[p + 1], t.data[p + 2], t.data[p + 3]];
  };
  const stone = hex('stone');
  assert.deepEqual(pixel(160, 160), [(stone >> 16) & 255, (stone >> 8) & 255, stone & 255, 255]);
  // en la zona con relieve, una columna más alta que sus vecinas norte y oeste se ve más clara
  const grass = hex('grass_block');
  let brighter = 0;
  let darker = 0;
  for (let wx = 17; wx < 63; wx++) {
    for (let wz = 17; wz < 63; wz++) {
      const h = surface(wx, wz);
      if (wx === 24 && wz === 24) continue;
      const d = h - surface(wx, wz - 1) + (h - surface(wx - 1, wz));
      const g = pixel(wx, wz)[1];
      if (d > 0) brighter += g > ((grass >> 8) & 255) ? 1 : 0;
      if (d < 0) darker += g < ((grass >> 8) & 255) ? 1 : 0;
    }
  }
  assert.ok(brighter > 100 && darker > 100);
  // fuera de los chunks generados no se pinta nada (ni hay tesela, o es transparente)
  assert.equal(pixel(5000, 5000), null);
  assert.equal(pixel(-321 - 16, 0)[3], 0);
});

test('estilos: nombres antiguos con variantes y bloques desconocidos', () => {
  const style = (entry) => styleColor[styleOf(entry)];
  assert.equal(style({ name: 'minecraft:wool', states: { color: 'red' } }), hex('red_wool'));
  assert.equal(style({ name: 'minecraft:wool', states: { color: 'silver' } }), hex('light_gray_wool'));
  assert.equal(style({ name: 'minecraft:planks', states: { wood_type: 'spruce' } }), hex('spruce_planks'));
  assert.equal(style({ name: 'minecraft:planks', val: 2 }), hex('birch_planks'));
  assert.equal(style({ name: 'minecraft:stained_hardened_clay', states: { color: 'blue' } }), hex('blue_terracotta'));
  assert.equal(style({ name: 'minecraft:grass', states: {} }), hex('grass_block'));
  assert.equal(styleKind[styleOf({ name: 'minecraft:light_block_15' })], KIND_AIR);
  assert.equal(styleKind[styleOf({ name: 'minecraft:air' })], KIND_AIR);
  // bloques de addons: color aproximado por el nombre, o gris
  assert.equal(style({ name: 'miaddon:mossy_stone_tiles' }), 0x698940);
  assert.equal(style({ name: 'miaddon:cosa_rara' }), 0x8a8a8a);
});

test('subchunk dañado o de formato antiguo no rompe la vista', () => {
  assert.ok(decodeSubChunk(Uint8Array.from([0, 1, 2, 3])).unknown);
  const cols = renderColumns(new Map([[4, Uint8Array.from([8, 1, 255, 1, 2])]]), { type: 'top' });
  assert.equal(cols.h.length, 256);
  assert.ok(composeTiles(new Map(), { type: 'top' }).length === 0);
});
