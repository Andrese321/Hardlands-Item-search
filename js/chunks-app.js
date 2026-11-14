import { inZones, blocksToChunkZone } from './chunks.js';
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
  zones: { 0: [], 1: [], 2: [] }, // en chunks: [x1, z1, x2, z2]
  mode: 'inside',
  view: null, // { cx, cz, scale }
  firstCorner: null, // [bx, bz] en bloques
  downloadUrl: null,
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
  renderZones();
  updateSummary();
}

// ---------------------------------------------------------------- selección

function selection() {
  const arr = state.dims[state.dim] || new Int32Array(0);
  const zones = state.zones[state.dim];
  let chunks = 0;
  let containers = 0;
  let items = 0;
  if (zones.length) {
    for (let i = 0; i < arr.length; i += 4) {
      if ((state.mode === 'inside') === inZones(arr[i], arr[i + 1], zones)) {
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
  const zones = state.zones[state.dim];
  const box = $('summary');
  if (!zones.length) {
    box.replaceChildren('Añade al menos una zona para ver qué se borrará.');
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
      (state.mode === 'inside') === inZones(Math.floor(p.x / 16), Math.floor(p.z / 16), zones));
    if (playersIn.length) {
      parts.push(h('div', {}, `${playersIn.length === 1 ? 'Hay 1 jugador' : `Hay ${playersIn.length} jugadores`} desconectados en esa zona: ` +
        'al entrar aparecerán en el terreno nuevo (podrían quedar dentro de un bloque).'));
    }
    box.replaceChildren(...parts);
  }
  $('btn-build').disabled = !(s.chunks && $('confirm').checked);
  drawMap();
}

function addZone(zone) {
  state.zones[state.dim].push(zone);
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
  list.replaceChildren(
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
  renderZones();
  updateSummary();
});

for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', () => {
    state.mode = document.querySelector('input[name=mode]:checked').value;
    $('result').hidden = true;
    updateSummary();
  });
}
$('confirm').addEventListener('change', updateSummary);

// ---------------------------------------------------------------- crear

$('btn-build').addEventListener('click', () => {
  const s = selection();
  const what = state.mode === 'inside' ? 'dentro de las zonas' : 'fuera de las zonas';
  const msg = `Se borrarán ${fmt.format(s.chunks)} chunks ${what} en el ${DIMENSIONS[state.dim]}` +
    (s.containers ? `, con ${fmt.format(s.containers)} contenedores y ${fmt.format(s.items)} objetos` : '') +
    '.\n\nSe creará un archivo nuevo; el original no se toca. ¿Continuar?';
  if (!window.confirm(msg)) return;
  state.building = true;
  progressScreen();
  state.worker.postMessage({
    type: 'build',
    selection: { dim: state.dim, zones: state.zones[state.dim], mode: state.mode },
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

// ---------------------------------------------------------------- mapa

const canvas = $('map');
const ctx = canvas.getContext('2d');

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { bg: v('--map-bg'), chunk: v('--map-chunk'), chest: v('--map-chest'), del: v('--map-del'), zone: v('--map-zone'), player: v('--map-player') };
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
  const gap = s >= 6 ? 1 : 0;
  for (let i = 0; i < arr.length; i += 4) {
    const [x, y] = toScreen(arr[i], arr[i + 1], w, hgt);
    if (x + size < 0 || y + size < 0 || x > w || y > hgt) continue;
    const del = zones.length && (state.mode === 'inside') === inZones(arr[i], arr[i + 1], zones);
    ctx.fillStyle = del ? c.del : arr[i + 2] ? c.chest : c.chunk;
    ctx.fillRect(x, y, size - gap, size - gap);
  }
  ctx.strokeStyle = c.zone;
  ctx.lineWidth = 2;
  for (const [x1, z1, x2, z2] of zones) {
    const [ax, ay] = toScreen(x1, z1, w, hgt);
    const [bx, by] = toScreen(x2 + 1, z2 + 1, w, hgt);
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
  }
  ctx.fillStyle = c.player;
  for (const p of state.players) {
    if (p.dim !== state.dim) continue;
    const [x, y] = toScreen(p.x / 16, p.z / 16, w, hgt);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.firstCorner) {
    const [x, y] = toScreen(state.firstCorner[0] / 16, state.firstCorner[1] / 16, w, hgt);
    ctx.strokeStyle = c.zone;
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
  v.scale = Math.max(0.02, Math.min(64, v.scale * factor));
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

// Arrastrar para mover, pellizcar para zoom, tocar para marcar esquinas.
const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
  if (pointers.size === 1) {
    const p = pointers.get(e.pointerId);
    gesture = { type: 'pan', startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), moved: true };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const r = canvas.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  pointers.set(e.pointerId, p);
  if (gesture.type === 'pan' && pointers.size === 1) {
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
    if (gesture.dist > 0) zoom(dist / gesture.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    gesture.dist = dist;
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (gesture?.type === 'pan' && !gesture.moved && e.type === 'pointerup') tap(p.x, p.y);
  if (!pointers.size) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function tap(px, py) {
  const [cx, cz] = toChunk(px, py);
  const bx = Math.floor(cx * 16);
  const bz = Math.floor(cz * 16);
  if (!state.firstCorner) {
    state.firstCorner = [bx, bz];
    $('map-hint').textContent = `Primera esquina: X ${bx} · Z ${bz}. Toca la otra esquina (o el mismo chunk para uno solo).`;
    drawMap();
  } else {
    const [ax, az] = state.firstCorner;
    state.firstCorner = null;
    const z = blocksToChunkZone(ax, az, bx, bz);
    $('map-hint').textContent = `Zona añadida: ${zoneText(z)}. Toca de nuevo para otra zona.`;
    addZone(z);
  }
}

window.addEventListener('resize', drawMap);
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawMap);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
