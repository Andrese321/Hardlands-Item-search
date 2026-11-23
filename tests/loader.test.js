// Prueba el script del cargador automático con un Minecraft simulado: el
// módulo «@minecraft/server» se sustituye por uno falso que registra lo que el
// script hace (comandos, colocación de la estructura, mensajes) y deja que los
// chunks se «carguen» unos ticks después de crear el área de carga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loaderScript } from '../js/inject.js';

const dir = mkdtempSync(join(tmpdir(), 'hardlands-cargador-'));
mkdirSync(join(dir, 'node_modules/@minecraft/server'), { recursive: true });
writeFileSync(join(dir, 'node_modules/@minecraft/server/package.json'), '{"name":"@minecraft/server","type":"module","main":"index.js"}');
writeFileSync(join(dir, 'node_modules/@minecraft/server/index.js'), `
const h = () => globalThis.__mc;
export const world = {
  get structureManager() { return h().structureManager; },
  get scoreboard() { return h().scoreboard; },
  sendMessage: (t) => h().messages.push(['mundo', t]),
};
export const system = {
  afterEvents: { scriptEventReceive: { subscribe: (fn) => h().listeners.push(fn) } },
  runInterval: (fn, ticks) => h().schedule(fn, ticks, true),
  runTimeout: (fn, ticks) => h().schedule(fn, ticks, false),
  clearRun: (id) => h().cancel(id),
};
`);
let n = 0;

/** Mundo simulado. `loadDelay`: ticks que tardan los chunks en cargar tras crear el área. */
function harness({ loadDelay = 30, structures = {}, dim = { min: -64, max: 320 } } = {}) {
  const mc = {
    tick: 0, tasks: [], nextId: 1, listeners: [], messages: [], bars: [], commands: [], placed: [],
    areas: new Map(), // nombre -> { x0, z0, x1, z1, readyAt }
    objectives: new Map(),
    schedule(fn, ticks, repeat) {
      const id = mc.nextId++;
      mc.tasks.push({ id, fn, ticks, repeat, at: mc.tick + ticks });
      return id;
    },
    cancel(id) {
      mc.tasks = mc.tasks.filter((t) => t.id !== id);
    },
    advance(ticks) {
      for (let i = 0; i < ticks; i++) {
        mc.tick++;
        for (const t of [...mc.tasks]) {
          if (t.at !== mc.tick || !mc.tasks.includes(t)) continue;
          if (t.repeat) t.at += t.ticks;
          else mc.cancel(t.id);
          t.fn();
        }
      }
    },
    scoreboard: {
      getObjective: (id) => mc.objectives.get(id),
      addObjective: (id, displayName) => {
        if (mc.objectives.has(id)) throw new Error('ya existe');
        const o = { id, displayName };
        mc.objectives.set(id, o);
        return o;
      },
      removeObjective: (id) => mc.objectives.delete(id),
    },
    structureManager: {
      get: (id) => (structures[id] ? { size: { x: structures[id][0], y: structures[id][1], z: structures[id][2] } } : undefined),
      place: (id, dimension, location, options) => {
        if (location.y < dim.min) throw new Error('fuera del mundo');
        mc.placed.push({ id, location, options, tick: mc.tick });
      },
    },
  };
  const loaded = (x, z) => [...mc.areas.values()].some((a) => mc.tick >= a.readyAt && x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1);
  mc.dimension = {
    heightRange: dim,
    runCommand(cmd) {
      mc.commands.push(cmd);
      const add = /^tickingarea add (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(cmd);
      if (add) {
        const [x0, , z0, x1, , z1] = add.slice(1, 7).map(Number);
        mc.areas.set(add[7], { x0, z0, x1, z1, readyAt: mc.tick + loadDelay });
        return { successCount: 1 };
      }
      const rm = /^tickingarea remove (\S+)$/.exec(cmd);
      if (rm) {
        if (!mc.areas.delete(rm[1])) throw new Error('no existe');
        return { successCount: 1 };
      }
      throw new Error('comando desconocido');
    },
    getBlock(loc) {
      return loaded(loc.x, loc.z) ? { typeId: 'minecraft:air' } : undefined;
    },
  };
  mc.player = {
    typeId: 'minecraft:player',
    location: { x: 100.5, y: 70, z: -200.5 },
    dimension: mc.dimension,
    sendMessage: (t) => mc.messages.push(['jugador', t]),
    onScreenDisplay: { setActionBar: (t) => mc.bars.push(t) },
  };
  mc.send = (id, message, source = mc.player) => {
    for (const fn of mc.listeners) fn({ id, message, sourceEntity: source });
  };
  globalThis.__mc = mc;
  return mc;
}

async function loadScript(structures) {
  const file = join(dir, `main-${++n}.js`);
  writeFileSync(file, loaderScript(structures));
  await import(pathToFileURL(file).href);
}

test('carga toda la zona, espera y coloca la estructura centrada y a una altura que cabe', async () => {
  const mc = harness({ loadDelay: 40 });
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]);
  mc.send('hardlands:cargar', 'eva01');
  // x: 100 - 40 = 60 … 139 → chunks 3..8; z: -201 - 43 = -244 … -158 → chunks -16..-10 (6 × 7 = 42)
  const add = mc.commands.filter((c) => c.startsWith('tickingarea add'));
  assert.deepEqual(add, ['tickingarea add 48 64 -256 143 64 -145 hardlands_carga_0']);
  assert.match(mc.messages.at(-1)[1], /42 chunks/);
  mc.advance(20);
  assert.equal(mc.placed.length, 0, 'todavía no: la zona se está cargando');
  assert.match(mc.bars.at(-1), /0\/42/);
  mc.advance(40);
  assert.equal(mc.placed.length, 1);
  const p = mc.placed[0];
  assert.equal(p.id, 'mystructure:eva01');
  assert.deepEqual(p.location, { x: 60, y: 64, z: -244 }); // 70 + 256 > 320 → Y 64
  assert.equal(p.options.rotation, 'None');
  assert.match(mc.messages.at(-1)[1], /Listo/);
  assert.ok(!mc.messages.at(-1)[1].includes('no se cargaron'));
  // a los 5 segundos se quitan las áreas de carga y el bloqueo
  mc.advance(100);
  assert.equal(mc.areas.size, 0);
  assert.equal(mc.objectives.size, 0);
});

test('giro de 90 grados: intercambia ancho y fondo', async () => {
  const mc = harness({ loadDelay: 5 });
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]);
  mc.send('hardlands:cargar', 'eva01 90');
  mc.advance(20);
  assert.deepEqual(mc.placed[0].location, { x: 100 - 43, y: 64, z: -201 - 40 });
  assert.equal(mc.placed[0].options.rotation, 'Rotate90');
});

test('estructura pequeña: esquina en los pies del jugador', async () => {
  const mc = harness({ loadDelay: 1 });
  await loadScript([{ name: 'casa', size: [3, 2, 3] }]);
  mc.send('hardlands:cargar', 'casa');
  mc.advance(10);
  assert.deepEqual(mc.placed[0].location, { x: 100, y: 70, z: -201 });
});

test('una segunda orden mientras carga se rechaza (y la misma estructura en otro paquete no se duplica)', async () => {
  const mc = harness({ loadDelay: 10 });
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]);
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]); // dos paquetes con el cargador
  mc.send('hardlands:cargar', 'eva01');
  assert.ok(mc.messages.some(([, t]) => /Ya se está cargando/.test(t)));
  mc.advance(200);
  assert.equal(mc.placed.length, 1, 'solo se coloca una vez');
  // terminado: se puede volver a usar
  mc.send('hardlands:cargar', 'eva01');
  mc.advance(30);
  assert.equal(mc.placed.length, 2);
});

test('estructuras guardadas en el mundo (no incluidas en el paquete) y errores', async () => {
  const mc = harness({ loadDelay: 1, structures: { 'mystructure:torre': [5, 40, 5] } });
  await loadScript([]);
  mc.send('hardlands:cargar', 'torre');
  mc.advance(10);
  assert.equal(mc.placed[0].id, 'mystructure:torre');
  mc.advance(120);
  mc.send('hardlands:cargar', 'no_existe');
  assert.match(mc.messages.at(-1)[1], /No encuentro/);
  mc.send('hardlands:cargar', 'torre 45');
  assert.match(mc.messages.at(-1)[1], /90, 180 o 270/);
  mc.send('hardlands:lista', '');
  assert.ok(mc.messages.some(([, t]) => /Uso: \/scriptevent hardlands:cargar/.test(t)));
});

test('no cabe en el Nether (128 de alto) y aviso si la zona no termina de cargar', async () => {
  const nether = harness({ dim: { min: 0, max: 128 } });
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]);
  nether.send('hardlands:cargar', 'eva01');
  assert.match(nether.messages.at(-1)[1], /no cabe/);
  assert.equal(nether.objectives.size, 0, 'sin bloqueo colgado');

  const slow = harness({ loadDelay: 100000 });
  await loadScript([{ name: 'eva01', size: [80, 256, 87] }]);
  slow.send('hardlands:cargar', 'eva01');
  slow.advance(5 * 241);
  assert.equal(slow.placed.length, 1, 'tras ~1 minuto se coloca igualmente (el juego la termina al acercarse)');
  assert.match(slow.messages.at(-1)[1], /no se cargaron a tiempo/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
