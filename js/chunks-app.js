import './version.js';
import { inZones, blocksToChunkZone } from './chunks.js';
import { TILE_CHUNKS } from './terrain.js';
import { DIMENSIONS } from './search.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('es-ES');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const state = {
  worker: null,
  fileName: 'mundo',
  ext: '.zip',
  worldName: '',
  dims: {}, // dim -> Int32Array [x, z, contenedores, objetos]...
  players: [],
  dim: 0,
  zones: { 0: [], 1: [], 2: [] }, // rectángulos en chunks: [x1, z1, x2, z2]
  painted: { 0: new Set(), 1: new Set(), 2: new Set() }, // chunks pintados "x,z"
  exists: {}, // dim -> Set("x,z") de chunks generados
  history: [], // para «Deshacer»
  mode: 'inside',
  tool: 'move',
  brush: 1,
  view: null, // { cx, cz, scale } (scale = píxeles por chunk)
  firstCorner: null, // [bx, bz] en bloques
  downloadUrl: null,
  // vista satélite: modo por dimensión y teselas ya calculadas
  viewMode: { 0: 'top', 1: 'slice', 2: 'top' },
  sliceY: { 0: 40, 1: 100, 2: 60 },
  tiles: new Map(), // "dim|modo" -> { tiles: Map("tx,tz" -> canvas), chunks }
  terrainReq: 0,
  terrainKey: null,
};

// ---------------------------------------------------------------- pantallas

function show(screen) {
  for (const id of ['screen-load', 'screen-progress', 'screen-choose', 'screen-edit']) $(id).hidden = id !== screen;
  $('error').hidden = true;
}

function showError(message) {
  show('screen-load');
  $('error-text').textContent = message;
  $('error').hidden = false;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

$('btn-error').addEventListener('click', () => ($('error').hidden = true));
$('btn-change').addEventListener('click', () => show('screen-load'));

// ---------------------------------------------------------------- worker

function startWorker() {
  state.worker?.terminate();
  const w = new Worker(new URL('./chunks-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') $('progress-bar').style.width = `${Math.round(data.value * 100)}%`;
    else if (data.type === 'status') $('progress-status').textContent = data.text;
    else if (data.type === 'choose') chooseWorld(data.worlds);
    else if (data.type === 'analyzed') onAnalyzed(data);
    else if (data.type === 'built') onBuilt(data);
    else if (data.type === 'terrainProgress') onTerrainProgress(data);
    else if (data.type === 'terrain') onTerrain(data);
    else if (data.type === 'terrainError') onTerrainError(data);
    else if (data.type === 'error') {
      if (!$('screen-edit').hidden || state.building) {
        state.building = false;
        show('screen-edit');
        updateSummary();
        $('result').hidden = false;
        $('result').replaceChildren(h('strong', { class: 'danger' }, 'No se pudo crear el mundo: '), data.message);
      } else {
        showError(data.message);
      }
    }
  };
  w.onerror = (e) => showError('Error interno: ' + (e.message || 'el navegador no pudo ejecutar la herramienta.'));
  state.worker = w;
  return w;
}

function progressScreen() {
  show('screen-progress');
  $('progress-bar').style.width = '0%';
  $('progress-status').textContent = 'Preparando…';
}

function open(message, name) {
  const m = /^(.*?)(\.mcworld|\.zip)?$/i.exec(name || 'mundo');
  state.fileName = m[1] || 'mundo';
  state.ext = (m[2] || '.zip').toLowerCase();
  progressScreen();
  startWorker().postMessage(message);
}

$('input-zip').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) open({ type: 'open', zip: f }, f.name);
});

$('input-folder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const root = (files[0].webkitRelativePath || '').split('/')[0] || 'mundo';
  open({ type: 'open', files }, root + '.zip');
});

function chooseWorld(worlds) {
  show('screen-choose');
  $('world-list').replaceChildren(
    ...worlds.map((prefix) =>
      h('button', {
        class: 'btn',
        onclick: () => {
          progressScreen();
          state.worker.postMessage({ type: 'analyze', prefix });
        },
      }, prefix.replace(/\/$/, '') || '(carpeta principal)'),
    ),
  );
}

function onAnalyzed(data) {
  state.worldName = data.worldName;
  state.dims = data.dims;
  state.players = data.players;
  state.zones = { 0: [], 1: [], 2: [] };
  state.painted = { 0: new Set(), 1: new Set(), 2: new Set() };
  state.history = [];
  state.tiles = new Map();
  state.terrainKey = null;
  state.exists = {};
  for (const [d, arr] of Object.entries(data.dims)) {
    const set = new Set();
    for (let i = 0; i < arr.length; i += 4) set.add(arr[i] + ',' + arr[i + 1]);
    state.exists[d] = set;
  }
  state.firstCorner = null;
  $('world-name').textContent = data.worldName;
  const counts = Object.entries(data.dims).map(([d, a]) => `${DIMENSIONS[d] ?? d}: ${fmt.format(a.length / 4)}`);
  $('world-stats').textContent = 'Chunks generados · ' + (counts.join(' · ') || 'ninguno');
  for (const opt of $('dim').options) opt.disabled = !data.dims[opt.value];
  state.dim = data.dims[0] ? 0 : Number(Object.keys(data.dims)[0] ?? 0);
  $('dim').value = String(state.dim);
  $('result').hidden = true;
  $('confirm').checked = false;
  show('screen-edit');
  fitView();
  syncViewControls();
  renderZones();
  updateSummary();
  requestTerrain();
}

// ---------------------------------------------------------------- selección

const chunkId = (x, z) => x + ',' + z;

function isMarked(x, z) {
  return state.painted[state.dim].has(chunkId(x, z)) || inZones(x, z, state.zones[state.dim]);
}

function hasSelection() {
  return state.painted[state.dim].size > 0 || state.zones[state.dim].length > 0;
}

function selection() {
  const arr = state.dims[state.dim] || new Int32Array(0);
  let chunks = 0;
  let containers = 0;
  let items = 0;
  if (hasSelection()) {
    for (let i = 0; i < arr.length; i += 4) {
      if ((state.mode === 'inside') === isMarked(arr[i], arr[i + 1])) {
        chunks++;
        containers += arr[i + 2];
        items += arr[i + 3];
      }
    }
  }
  return { chunks, containers, items, total: arr.length / 4 };
}

function updateSummary() {
  const s = selection();
  const box = $('summary');
  if (!hasSelection()) {
    box.replaceChildren('Marca chunks en el mapa (Pintar o Rectángulo) o añade una zona por coordenadas.');
  } else {
    const parts = [
      h('div', {}, 'Se borrarán ', h('strong', {}, fmt.format(s.chunks)), ` de ${fmt.format(s.total)} chunks del ${DIMENSIONS[state.dim]} ` +
        `(≈ ${fmt.format(s.chunks * 256)} bloques²).`),
    ];
    if (s.containers) {
      parts.push(h('div', { class: 'danger' },
        `⚠ Se perderán ${fmt.format(s.containers)} contenedores con ${fmt.format(s.items)} objetos (cofres, barriles…).`));
    } else if (s.chunks) {
      parts.push(h('div', {}, 'No hay cofres con objetos en esos chunks.'));
    }
    const playersIn = state.players.filter((p) => p.dim === state.dim &&
      (state.mode === 'inside') === isMarked(Math.floor(p.x / 16), Math.floor(p.z / 16)));
    if (playersIn.length) {
      parts.push(h('div', {}, `${playersIn.length === 1 ? 'Hay 1 jugador' : `Hay ${playersIn.length} jugadores`} desconectados en esa zona: ` +
        'al entrar aparecerán en el terreno nuevo (podrían quedar dentro de un bloque).'));
    }
    box.replaceChildren(...parts);
  }
  $('btn-build').disabled = !(s.chunks && $('confirm').checked);
  $('undo').disabled = !state.history.length;
  $('clear-sel').disabled = !hasSelection();
  drawMap();
}

function addZone(zone) {
  state.zones[state.dim].push(zone);
  state.history.push({ type: 'zone', dim: state.dim, zone });
  $('result').hidden = true;
  renderZones();
  updateSummary();
}

function zoneText(z) {
  const n = (z[2] - z[0] + 1) * (z[3] - z[1] + 1);
  return `X ${z[0] * 16}…${z[2] * 16 + 15} · Z ${z[1] * 16}…${z[3] * 16 + 15} (${fmt.format(n)} ${n === 1 ? 'chunk' : 'chunks'})`;
}

function renderZones() {
  const list = $('zones');
  const zones = state.zones[state.dim];
  const painted = state.painted[state.dim].size;
  list.replaceChildren(
    ...(painted ? [h('li', {},
      h('span', {}, `Chunks pintados en el mapa: ${fmt.format(painted)}`),
      h('button', {
        class: 'btn small',
        onclick: () => {
          state.history.push({ type: 'clear', dim: state.dim, painted: new Set(state.painted[state.dim]), zones: [] });
          state.painted[state.dim] = new Set();
          renderZones();
          updateSummary();
        },
      }, 'Quitar'))] : []),
    ...zones.map((z, i) =>
      h('li', {},
        h('span', {}, zoneText(z)),
        h('button', {
          class: 'btn small',
          onclick: () => {
            zones.splice(i, 1);
            renderZones();
            updateSummary();
          },
        }, 'Quitar')),
    ),
  );
}

$('form-rect').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const v = ['x1', 'z1', 'x2', 'z2'].map((k) => Math.trunc(Number(f.get(k))));
  if (v.some((n) => !Number.isFinite(n))) return;
  addZone(blocksToChunkZone(...v));
  e.target.reset();
});

$('form-radius').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const [x, z, r] = ['x', 'z', 'r'].map((k) => Math.trunc(Number(f.get(k))));
  if (![x, z, r].every(Number.isFinite) || r < 1) return;
  addZone(blocksToChunkZone(x - r, z - r, x + r, z + r));
  e.target.reset();
});

$('dim').addEventListener('change', (e) => {
  state.dim = Number(e.target.value);
  state.firstCorner = null;
  $('result').hidden = true;
  fitView();
  syncViewControls();
  renderZones();
  updateSummary();
  requestTerrain();
});

for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', () => {
    state.mode = document.querySelector('input[name=mode]:checked').value;
    $('result').hidden = true;
    updateSummary();
  });
}
$('confirm').addEventListener('change', updateSummary);

// ---------------------------------------------------------------- herramientas

const HINTS = {
  move: 'Arrastra para moverte y pellizca con dos dedos para acercar. Elige «Pintar» para marcar chunks.',
  paint: 'Pasa el dedo por los chunks que quieres marcar. Con dos dedos te mueves y haces zoom.',
  erase: 'Pasa el dedo por los chunks que quieres desmarcar. Con dos dedos te mueves y haces zoom.',
  rect: 'Toca dos esquinas para marcar un rectángulo. Arrastra para moverte.',
};

function setTool(tool) {
  state.tool = tool;
  state.firstCorner = null;
  for (const b of $('tools').querySelectorAll('button')) {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  canvas.className = 'tool-' + tool;
  $('map-hint').textContent = HINTS[tool];
  drawMap();
}

$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]');
  if (b) setTool(b.dataset.tool);
});
$('brush').addEventListener('change', (e) => (state.brush = Number(e.target.value)));

$('undo').addEventListener('click', () => {
  const last = state.history.pop();
  if (!last) return;
  if (last.type === 'paint') {
    const set = state.painted[last.dim];
    for (const [id, was] of last.changes) {
      if (was) set.add(id);
      else set.delete(id);
    }
  } else if (last.type === 'zone') {
    const zones = state.zones[last.dim];
    const i = zones.lastIndexOf(last.zone);
    if (i >= 0) zones.splice(i, 1);
  } else if (last.type === 'clear') {
    state.painted[last.dim] = last.painted;
    state.zones[last.dim] = last.zones;
  }
  $('result').hidden = true;
  renderZones();
  updateSummary();
});

$('clear-sel').addEventListener('click', () => {
  if (!hasSelection()) return;
  state.history.push({ type: 'clear', dim: state.dim, painted: state.painted[state.dim], zones: state.zones[state.dim] });
  state.painted[state.dim] = new Set();
  state.zones[state.dim] = [];
  $('result').hidden = true;
  renderZones();
  updateSummary();
  toast('Selección borrada (puedes deshacerlo)');
});

// Pinta o borra con el pincel alrededor del chunk (cx, cz).
function brushAt(stroke, cx, cz) {
  const set = state.painted[state.dim];
  const exists = state.exists[state.dim] || new Set();
  const r = Math.floor(state.brush / 2);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const id = chunkId(cx + dx, cz + dz);
      if (!exists.has(id)) continue;
      const was = set.has(id);
      if (was === stroke.add) continue;
      if (!stroke.changes.has(id)) stroke.changes.set(id, was);
      if (stroke.add) set.add(id);
      else set.delete(id);
    }
  }
}

// Recorre la línea entre dos chunks para que no queden huecos al pasar el dedo deprisa.
function brushLine(stroke, x0, z0, x1, z1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    brushAt(stroke, Math.round(x0 + (x1 - x0) * t), Math.round(z0 + (z1 - z0) * t));
  }
}

// ---------------------------------------------------------------- crear

$('btn-build').addEventListener('click', () => {
  const s = selection();
  const what = state.mode === 'inside' ? 'marcados' : 'sin marcar';
  const msg = `Se borrarán ${fmt.format(s.chunks)} chunks ${what} en el ${DIMENSIONS[state.dim]}` +
    (s.containers ? `, con ${fmt.format(s.containers)} contenedores y ${fmt.format(s.items)} objetos` : '') +
    '.\n\nSe creará un archivo nuevo; el original no se toca. ¿Continuar?';
  if (!window.confirm(msg)) return;
  state.building = true;
  progressScreen();
  state.worker.postMessage({
    type: 'build',
    selection: { dim: state.dim, zones: state.zones[state.dim], painted: [...state.painted[state.dim]], mode: state.mode },
  });
});

function onBuilt(data) {
  state.building = false;
  show('screen-edit');
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(data.blob);
  const name = `${state.fileName}-chunks-borrados${state.ext}`;
  const sizeMb = (data.blob.size / 1048576).toFixed(1);
  const result = $('result');
  result.hidden = false;
  result.replaceChildren(
    h('h2', {}, 'Mundo modificado listo'),
    h('p', {}, `Se han borrado ${fmt.format(data.chunks)} chunks (${fmt.format(data.keys)} registros` +
      (data.actors ? `, ${fmt.format(data.actors)} entidades` : '') + `). Archivo: ${sizeMb} MB.`),
    h('a', { class: 'btn primary', href: state.downloadUrl, download: name }, 'Descargar ' + name),
    h('ol', { class: 'result-steps' },
      h('li', {}, 'Con el servidor apagado, sube este archivo como copia de seguridad a restaurar (o reemplaza la carpeta del mundo con su contenido).'),
      h('li', {}, 'Enciende el servidor. Los chunks borrados se generarán de nuevo cuando alguien se acerque.'),
      h('li', {}, 'Si algo no va bien, restaura tu copia original.')),
    h('p', { class: 'small muted' }, 'Nota: la primera vez que se abra el mundo, Minecraft aplicará los borrados y el archivo del servidor quedará ya limpio.'),
  );
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Mundo modificado listo para descargar');
}

// ---------------------------------------------------------------- vista satélite

function terrainMode() {
  const m = state.viewMode[state.dim];
  return m === 'slice' ? { type: 'slice', y: state.sliceY[state.dim] } : { type: 'top' };
}

const terrainKey = (dim, mode) => `${dim}|${mode.type === 'slice' ? 'y' + mode.y : 'top'}`;

function syncViewControls() {
  const m = state.viewMode[state.dim];
  $('view-mode').value = m;
  $('slice-field').hidden = m !== 'slice';
  const range = { 0: [-63, 319], 1: [1, 126], 2: [1, 255] }[state.dim] || [-63, 319];
  $('slice-y').min = range[0];
  $('slice-y').max = range[1];
  $('slice-y').value = state.sliceY[state.dim];
  $('slice-y-label').textContent = `Y ${state.sliceY[state.dim]}`;
}

function requestTerrain() {
  const m = state.viewMode[state.dim];
  $('map-loading').hidden = true;
  if (m === 'grid' || !state.worker || !state.dims[state.dim]) return;
  const mode = terrainMode();
  const key = terrainKey(state.dim, mode);
  state.terrainKey = key;
  if (state.tiles.has(key)) {
    drawMap();
    return;
  }
  const req = ++state.terrainReq;
  $('map-loading').hidden = false;
  $('map-loading').textContent = 'Cargando vista satélite…';
  state.worker.postMessage({ type: 'terrain', req, dim: state.dim, mode });
}

function onTerrainProgress(data) {
  if (data.req !== state.terrainReq) return;
  $('map-loading').textContent = `Cargando vista satélite… ${Math.round(data.value * 100)} %`;
}

function onTerrain(data) {
  const key = terrainKey(data.dim, data.mode);
  const tiles = new Map();
  for (const t of data.tiles) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_CHUNKS * 16;
    c.getContext('2d').putImageData(new ImageData(t.data, TILE_CHUNKS * 16, TILE_CHUNKS * 16), 0, 0);
    tiles.set(t.tx + ',' + t.tz, c);
  }
  state.tiles.set(key, { tiles, chunks: data.chunks });
  if (data.req === state.terrainReq) {
    $('map-loading').hidden = !!data.chunks;
    if (!data.chunks) $('map-loading').textContent = 'No hay terreno guardado en esta dimensión';
  }
  drawMap();
}

function onTerrainError(data) {
  if (data.req !== state.terrainReq) return;
  $('map-loading').hidden = false;
  $('map-loading').textContent = 'No se pudo cargar la vista satélite: ' + data.message;
}

$('view-mode').addEventListener('change', (e) => {
  state.viewMode[state.dim] = e.target.value;
  syncViewControls();
  requestTerrain();
  drawMap();
});

$('slice-y').addEventListener('input', (e) => {
  $('slice-y-label').textContent = `Y ${e.target.value}`;
});
$('slice-y').addEventListener('change', (e) => {
  state.sliceY[state.dim] = Number(e.target.value);
  requestTerrain();
});

// ---------------------------------------------------------------- mapa

const canvas = $('map');
const ctx = canvas.getContext('2d');

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    bg: v('--map-bg'), chunk: v('--map-chunk'), chest: v('--map-chest'), del: v('--map-del'),
    zone: v('--map-zone'), player: v('--map-player'), sel: v('--map-sel'),
  };
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h: hgt };
}

function fitView() {
  const arr = state.dims[state.dim] || new Int32Array(0);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < arr.length; i += 4) {
    minX = Math.min(minX, arr[i]);
    maxX = Math.max(maxX, arr[i]);
    minZ = Math.min(minZ, arr[i + 1]);
    maxZ = Math.max(maxZ, arr[i + 1]);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minZ = maxZ = 0;
  }
  const { w, h: hgt } = sizeCanvas();
  const scale = Math.min(w / (maxX - minX + 3), hgt / (maxZ - minZ + 3));
  state.view = { cx: (minX + maxX + 1) / 2, cz: (minZ + maxZ + 1) / 2, scale: Math.max(0.02, Math.min(scale, 40)) };
}

function toScreen(cx, cz, w, hgt) {
  const v = state.view;
  return [(cx - v.cx) * v.scale + w / 2, (cz - v.cz) * v.scale + hgt / 2];
}

function toChunk(px, py) {
  const { w, h: hgt } = { w: canvas.clientWidth, h: canvas.clientHeight };
  const v = state.view;
  return [(px - w / 2) / v.scale + v.cx, (py - hgt / 2) / v.scale + v.cz];
}

let drawQueued = false;
function drawMap() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    paint();
  });
}

function paint() {
  if ($('screen-edit').hidden || !state.view) return;
  const { w, h: hgt } = sizeCanvas();
  const c = colors();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  const arr = state.dims[state.dim] || new Int32Array(0);
  const zones = state.zones[state.dim];
  const s = state.view.scale;
  const size = Math.max(s, 1);
  const sat = state.viewMode[state.dim] !== 'grid' ? state.tiles.get(state.terrainKey) : null;
  const anySel = hasSelection();

  if (sat) {
    // base tenue para los chunks sin terreno guardado y, encima, las teselas
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = c.chunk;
    for (let i = 0; i < arr.length; i += 4) {
      const [x, y] = toScreen(arr[i], arr[i + 1], w, hgt);
      if (x + size < 0 || y + size < 0 || x > w || y > hgt) continue;
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = s < 16;
    const tsz = TILE_CHUNKS * s;
    for (const [k, tile] of sat.tiles) {
      const comma = k.indexOf(',');
      const [x, y] = toScreen(Number(k.slice(0, comma)) * TILE_CHUNKS, Number(k.slice(comma + 1)) * TILE_CHUNKS, w, hgt);
      if (x + tsz < 0 || y + tsz < 0 || x > w || y > hgt) continue;
      ctx.drawImage(tile, x, y, tsz, tsz);
    }
    // marcas encima del terreno
    for (let i = 0; i < arr.length; i += 4) {
      const [x, y] = toScreen(arr[i], arr[i + 1], w, hgt);
      if (x + size < 0 || y + size < 0 || x > w || y > hgt) continue;
      const del = anySel && (state.mode === 'inside') === isMarked(arr[i], arr[i + 1]);
      if (del) {
        ctx.fillStyle = c.sel;
        ctx.fillRect(x, y, size, size);
      }
      if (arr[i + 2] && s >= 3) {
        ctx.strokeStyle = c.chest;
        ctx.lineWidth = Math.min(3, s / 6);
        ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
      }
    }
    // cuadrícula de chunks cuando se ve de cerca
    if (s >= 20) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      const [x0, z0] = toChunk(0, 0);
      const [x1, z1] = toChunk(w, hgt);
      ctx.beginPath();
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const [sx] = toScreen(x, 0, w, hgt);
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, hgt);
      }
      for (let z = Math.floor(z0); z <= Math.ceil(z1); z++) {
        const [, sy] = toScreen(0, z, w, hgt);
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(w, Math.round(sy) + 0.5);
      }
      ctx.stroke();
    }
  } else {
    const gap = s >= 6 ? 1 : 0;
    for (let i = 0; i < arr.length; i += 4) {
      const [x, y] = toScreen(arr[i], arr[i + 1], w, hgt);
      if (x + size < 0 || y + size < 0 || x > w || y > hgt) continue;
      const del = anySel && (state.mode === 'inside') === isMarked(arr[i], arr[i + 1]);
      ctx.fillStyle = del ? c.del : arr[i + 2] ? c.chest : c.chunk;
      ctx.fillRect(x, y, size - gap, size - gap);
    }
  }

  ctx.strokeStyle = c.zone;
  ctx.lineWidth = 2;
  for (const [x1, z1, x2, z2] of zones) {
    const [ax, ay] = toScreen(x1, z1, w, hgt);
    const [bx, by] = toScreen(x2 + 1, z2 + 1, w, hgt);
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
  }
  for (const p of state.players) {
    if (p.dim !== state.dim) continue;
    const [x, y] = toScreen(p.x / 16, p.z / 16, w, hgt);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = c.player;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
  if (state.firstCorner) {
    const [x, y] = toScreen(state.firstCorner[0] / 16, state.firstCorner[1] / 16, w, hgt);
    ctx.strokeStyle = c.zone;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
  }
  // origen (0,0) como referencia
  const [ox, oy] = toScreen(0, 0, w, hgt);
  ctx.fillStyle = c.zone;
  ctx.font = '11px system-ui, sans-serif';
  if (ox > -20 && ox < w && oy > -20 && oy < hgt) ctx.fillText('0,0', ox + 3, oy - 3);
}

function zoom(factor, px = canvas.clientWidth / 2, py = canvas.clientHeight / 2) {
  const [bx, bz] = toChunk(px, py);
  const v = state.view;
  v.scale = Math.max(0.02, Math.min(160, v.scale * factor));
  // mantener el punto bajo el dedo/cursor
  const [ax, az] = toChunk(px, py);
  v.cx += bx - ax;
  v.cz += bz - az;
  drawMap();
}

$('zoom-in').addEventListener('click', () => zoom(1.6));
$('zoom-out').addEventListener('click', () => zoom(1 / 1.6));
$('zoom-fit').addEventListener('click', () => {
  fitView();
  drawMap();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// Un dedo: mover, pintar o marcar esquinas según la herramienta. Dos dedos: zoom y mover.
const pointers = new Map();
let gesture = null;

function endStroke() {
  if (gesture?.type === 'stroke' && gesture.stroke.changes.size) {
    state.history.push({ type: 'paint', dim: state.dim, changes: gesture.stroke.changes });
    $('result').hidden = true;
    renderZones();
    updateSummary();
  }
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
  if (pointers.size === 1) {
    const p = pointers.get(e.pointerId);
    if (state.tool === 'paint' || state.tool === 'erase') {
      const [cx, cz] = toChunk(p.x, p.y).map(Math.floor);
      gesture = { type: 'stroke', stroke: { add: state.tool === 'paint', changes: new Map() }, last: [cx, cz] };
      brushAt(gesture.stroke, cx, cz);
      drawMap();
    } else {
      gesture = { type: 'pan', startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false };
    }
  } else if (pointers.size === 2) {
    endStroke();
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const r = canvas.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  pointers.set(e.pointerId, p);
  if (gesture.type === 'stroke' && pointers.size === 1) {
    const [cx, cz] = toChunk(p.x, p.y).map(Math.floor);
    if (cx !== gesture.last[0] || cz !== gesture.last[1]) {
      brushLine(gesture.stroke, gesture.last[0], gesture.last[1], cx, cz);
      gesture.last = [cx, cz];
      drawMap();
    }
  } else if (gesture.type === 'pan' && pointers.size === 1) {
    if (Math.hypot(p.x - gesture.startX, p.y - gesture.startY) > 6) gesture.moved = true;
    if (gesture.moved) {
      state.view.cx -= (p.x - gesture.lastX) / state.view.scale;
      state.view.cz -= (p.y - gesture.lastY) / state.view.scale;
      drawMap();
    }
    gesture.lastX = p.x;
    gesture.lastY = p.y;
  } else if (gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    state.view.cx -= (mx - gesture.mx) / state.view.scale;
    state.view.cz -= (my - gesture.my) / state.view.scale;
    if (gesture.dist > 0) zoom(dist / gesture.dist, mx, my);
    Object.assign(gesture, { dist, mx, my });
    drawMap();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (gesture?.type === 'stroke') {
    endStroke();
    gesture = null;
  } else if (gesture?.type === 'pan' && !gesture.moved && e.type === 'pointerup') {
    tap(p.x, p.y);
  }
  if (!pointers.size) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function tap(px, py) {
  const [cx, cz] = toChunk(px, py);
  const bx = Math.floor(cx * 16);
  const bz = Math.floor(cz * 16);
  if (state.tool !== 'rect') {
    $('map-hint').textContent = `Punto tocado: X ${bx} · Z ${bz} (chunk ${Math.floor(cx)}, ${Math.floor(cz)}).`;
    return;
  }
  if (!state.firstCorner) {
    state.firstCorner = [bx, bz];
    $('map-hint').textContent = `Primera esquina: X ${bx} · Z ${bz}. Toca la otra esquina (o el mismo chunk para uno solo).`;
    drawMap();
  } else {
    const [ax, az] = state.firstCorner;
    state.firstCorner = null;
    const z = blocksToChunkZone(ax, az, bx, bz);
    $('map-hint').textContent = `Rectángulo añadido: ${zoneText(z)}. Toca de nuevo para otro.`;
    addZone(z);
  }
}

window.addEventListener('resize', drawMap);
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawMap);

setTool('move');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
