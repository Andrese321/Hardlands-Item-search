import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openZip } from '../js/zip.js';
import { scanWorld, findWorlds } from '../js/world.js';
import { prepare, search, normalize, score, groupByPlace } from '../js/search.js';
import { readTable } from '../js/leveldb.js';

const names = JSON.parse(readFileSync(new URL('../data/names_es.json', import.meta.url)));
const zipBlob = new Blob([readFileSync(new URL('./fixtures/test_world.mcworld', import.meta.url))]);

async function loadIndex() {
  const zip = await openZip(zipBlob);
  const files = zip.entries.map((e) => ({ path: e.name, size: e.size, read: () => zip.read(e) }));
  const worlds = findWorlds(files.map((f) => f.path));
  assert.deepEqual(worlds, ['']);
  return scanWorld(files, worlds[0]);
}

const indexPromise = loadIndex();

function where(index, id) {
  return index.items.filter((i) => i.id === 'minecraft:' + id).map((i) => ({ ...i, place: index.locations[i.loc] }));
}

test('las tablas usan compresión zlib de Mojang y se leen', async () => {
  const zip = await openZip(zipBlob);
  const ldb = zip.entries.find((e) => e.name.endsWith('.ldb'));
  const bytes = await zip.read(ldb);
  let n = 0;
  readTable(bytes, () => n++);
  assert.ok(n > 1000);
});

test('nombre del mundo y estadísticas', async () => {
  const index = await indexPromise;
  assert.equal(index.worldName, 'Mundo de prueba');
  assert.equal(index.players.length, 2);
  assert.equal(index.stats.lootChests, 1);
  assert.deepEqual(index.warnings, []);
});

test('cofres en las tres dimensiones y contenido de shulkers', async () => {
  const index = await indexPromise;
  const netherite = where(index, 'netherite_ingot');
  assert.equal(netherite.length, 1);
  assert.equal(netherite[0].count, 32);
  assert.deepEqual(netherite[0].via, ['minecraft:purple_shulker_box']);
  assert.deepEqual([netherite[0].place.x, netherite[0].place.y, netherite[0].place.z], [10, 64, -5]);
  assert.equal(netherite[0].place.label, 'Cofre del tesoro');

  const gold = where(index, 'gold_ingot')[0];
  assert.equal(gold.place.type, 'Hopper');
  assert.equal(gold.place.dim, 1);
  assert.equal(where(index, 'dragon_breath')[0].place.dim, 2);
  assert.equal(where(index, 'elytra').length, 2);
});

test('borrados y sobrescrituras del .log se respetan', async () => {
  const index = await indexPromise;
  assert.equal(where(index, 'beacon').length, 0, 'el cofre borrado no debe aparecer');
  assert.equal(where(index, 'apple').length, 0, 'la versión antigua no debe aparecer');
  assert.equal(where(index, 'golden_apple')[0].count, 2);
});

test('entidades antiguas y modernas, sin ofertas de aldeanos', async () => {
  const index = await indexPromise;
  const emerald = where(index, 'emerald');
  assert.equal(emerald.length, 1, 'las ofertas del aldeano no cuentan');
  assert.equal(emerald[0].place.type, 'minecraft:chest_minecart');
  assert.equal(where(index, 'diamond_pickaxe').length, 0);

  const totem = where(index, 'totem_of_undying')[0];
  assert.equal(totem.place.type, 'minecraft:item');
  assert.deepEqual([totem.place.x, totem.place.y, totem.place.z], [15, 63, -8]);

  const donkeyDiamond = where(index, 'diamond').find((d) => d.place.type === 'minecraft:donkey');
  assert.equal(donkeyDiamond.place.dim, 1);
  assert.equal(donkeyDiamond.place.label, 'Burrito');
});

test('inventarios de jugadores, armadura y cofre de Ender', async () => {
  const index = await indexPromise;
  const diamonds = where(index, 'diamond').filter((d) => d.place.kind === 'player');
  const sections = diamonds.map((d) => d.place.section).sort();
  assert.deepEqual(sections, ['EnderChestInventory', 'Inventory']);
  const local = index.players.find((p) => p.local);
  assert.deepEqual([local.x, local.y, local.z], [100, 64, -41]);
  const other = index.players.find((p) => !p.local);
  assert.equal(other.dim, 1);
  assert.equal(where(index, 'diamond_chestplate')[0].place.section, 'Armor');
});

test('búsqueda exacta, parecida, en español y por encantamiento', async () => {
  const index = await indexPromise;
  const prep = prepare(index, names);

  const exact = search(index, prep, 'diamante');
  assert.equal(exact[0].id, 'minecraft:diamond');
  assert.ok(exact[0].exact);
  assert.equal(exact[0].total, 5 + 7 + 2 + 64 + 20);
  // también aparecen parecidos (espada de diamante, bloque de diamante...)
  assert.ok(exact.some((g) => g.id === 'minecraft:diamond_sword'));

  const typo = search(index, prep, 'netherita');
  assert.ok(typo.some((g) => g.id === 'minecraft:netherite_ingot'), 'tolera faltas: ' + typo.map((g) => g.id));

  assert.equal(search(index, prep, 'elytra')[0].id, 'minecraft:elytra');
  assert.equal(search(index, prep, 'Excalibur')[0].id, 'minecraft:diamond_sword');
  assert.equal(search(index, prep, 'totem')[0].id, 'minecraft:totem_of_undying');

  const ench = search(index, prep, 'filo');
  assert.ok(ench.some((g) => g.id === 'minecraft:netherite_sword'));

  const onlyPlayers = search(index, prep, 'diamante', { kind: 'player' });
  assert.equal(onlyPlayers[0].total, 84);

  const nether = search(index, prep, 'elytra', { dim: '1' });
  assert.equal(nether[0].records.length, 1);

  const inv = search(index, prep, '', { player: 'player_server_1b2c3d4e-0000-4000-8000-000000000001' });
  assert.equal(inv.length, 2);

  const places = groupByPlace(index, exact[0].records);
  const chest = places.find((p) => p.loc.type === 'Chest');
  assert.equal(chest.count, 12, 'dos montones en el mismo cofre se suman');
});

test('normalización y puntuación', () => {
  assert.equal(normalize('Lingote de Inframundita'), 'lingote de inframundita');
  assert.equal(normalize('Poción'), 'pocion');
  assert.equal(score('pocion', 'pocion'), 1);
  assert.ok(score('espda', 'espada de diamante') > 0.55);
  assert.equal(score('zzzz', 'espada de diamante'), 0);
});

test('findWorlds detecta mundos en subcarpetas', () => {
  assert.deepEqual(
    findWorlds(['worlds/Hardlands/db/CURRENT', 'worlds/Hardlands/levelname.txt', 'otra/cosa.txt']),
    ['worlds/Hardlands/'],
  );
});
