import './version.js';
import { STRUCTURES, BIOME_NAMES, parseSeed } from './seedfinder.js';

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

const state = { worker: null, busy: false, all: [], results: [], shown: 0, last: null };
const PAGE = 30;
const STORE = 'hardlands-seed';

// ---------------------------------------------------------------- formulario

for (const [id, cfg] of Object.entries(STRUCTURES)) {
  $('type-a').append(h('option', { value: id }, cfg.name));
}
$('type-b').append(h('option', { value: '' }, '(nada: solo listar)'));
for (const [id, cfg] of Object.entries(STRUCTURES)) {
  $('type-b').append(h('option', { value: id }, cfg.name));
}
$('type-a').value = 'monument';
$('type-b').value = 'outpost';

function updateDist() {
  const n = Number($('dist').value);
  $('dist-label').textContent = `${n} ${n === 1 ? 'chunk' : 'chunks'} (${n * 16} bloques)`;
  $('dist-field').hidden = !$('type-b').value;
}
$('dist').addEventListener('input', updateDist);
$('type-b').addEventListener('change', updateDist);

function remember() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      seed: $('seed').value, a: $('type-a').value, b: $('type-b').value, dist: $('dist').value,
      x: $('center-x').value, z: $('center-z').value, radius: $('radius').value,
    }));
  } catch {
    /* sin almacenamiento */
  }
}

try {
  const s = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (s) {
    $('seed').value = s.seed ?? '';
    if (STRUCTURES[s.a]) $('type-a').value = s.a;
    if (s.b === '' || STRUCTURES[s.b]) $('type-b').value = s.b;
    if (s.dist) $('dist').value = s.dist;
    if (s.x != null) $('center-x').value = s.x;
    if (s.z != null) $('center-z').value = s.z;
    if (s.radius) $('radius').value = s.radius;
  }
} catch {
  /* sin almacenamiento */
}
updateDist();

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado: ' + text);
  } catch {
    window.prompt('Copia el texto:', text);
  }
}

function showError(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
}

// ---------------------------------------------------------------- worker

function worker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('./seed-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      $('progress-bar').style.width = `${Math.round(data.value * 100)}%`;
    } else if (data.type === 'done') {
      setBusy(false);
      onResults(data);
    } else if (data.type === 'seed') {
      setBusy(false);
      onSeed(data);
    } else if (data.type === 'error') {
      setBusy(false);
      showError(data.message);
    }
  };
  w.onerror = (e) => {
    setBusy(false);
    showError('Error interno: ' + (e.message || 'el navegador no pudo ejecutar el buscador.'));
  };
  state.worker = w;
  return w;
}

function setBusy(busy, text = 'Buscando…') {
  state.busy = busy;
  $('progress').hidden = !busy;
  $('progress-status').textContent = text;
  $('progress-bar').style.width = '0%';
  $('btn-search').disabled = busy;
}

$('btn-cancel').addEventListener('click', () => {
  state.worker?.terminate();
  state.worker = null;
  setBusy(false);
});

// ---------------------------------------------------------------- semilla desde un mundo

$('input-world').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('error').hidden = true;
  setBusy(true, 'Leyendo la semilla del mundo…');
  worker().postMessage({ type: 'readSeed', zip: f });
});

function onSeed(data) {
  $('seed').value = data.seed;
  const info = $('seed-info');
  info.hidden = false;
  const parts = [`Semilla de «${data.name || 'mundo'}»: ${data.seed}.`];
  if (data.spawnX != null && data.spawnZ != null) {
    parts.push(' ', h('button', {
      type: 'button',
      class: 'linklike',
      onclick: () => {
        $('center-x').value = data.spawnX;
        $('center-z').value = data.spawnZ;
        toast('Centro puesto en el punto de aparición');
      },
    }, `Usar el punto de aparición (${data.spawnX}, ${data.spawnZ}) como centro`));
  }
  info.replaceChildren(...parts);
  remember();
}

// ---------------------------------------------------------------- buscar

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('error').hidden = true;
  let seed;
  try {
    seed = parseSeed($('seed').value).text;
  } catch (err) {
    showError(err.message);
    return;
  }
  const opts = {
    seed,
    a: $('type-a').value,
    b: $('type-b').value || null,
    maxChunks: Number($('dist').value),
    centerX: Math.trunc(Number($('center-x').value) || 0),
    centerZ: Math.trunc(Number($('center-z').value) || 0),
    radius: Number($('radius').value),
    limit: 1000,
  };
  state.last = opts;
  remember();
  $('results').replaceChildren();
  $('summary').textContent = '';
  $('sort-field').hidden = true;
  setBusy(true);
  worker().postMessage({ type: 'search', opts });
});

function place(p) {
  return h('div', { class: 'seed-place' },
    h('div', { class: 'place-title' }, p.name),
    h('div', { class: 'place-detail' },
      h('span', { class: 'coords' }, `X ${p.x} · Z ${p.z}`), ` · ${BIOME_NAMES[p.biome] ?? 'Bioma ' + p.biome}`),
    h('div', { class: 'place-actions' },
      h('button', { class: 'btn small', onclick: () => copy(`${p.x} ~ ${p.z}`) }, 'Copiar coordenadas'),
      h('button', { class: 'btn small', onclick: () => copy(`/tp @s ${p.x} ~ ${p.z}`) }, 'Copiar /tp')));
}

function card(r) {
  if (!r.b) {
    return h('div', { class: 'card seed-result' },
      h('div', { class: 'seed-head' },
        h('span', { class: 'seed-dist' }, `A ${fmt.format(r.fromCenter)} bloques del centro`)),
      place(r.a));
  }
  const chunks = String(r.chunks).replace('.', ',');
  return h('div', { class: 'card seed-result' },
    h('div', { class: 'seed-head' },
      h('span', { class: 'seed-dist' }, `${chunks} ${r.chunks === 1 ? 'chunk' : 'chunks'}`),
      h('span', { class: 'muted small' }, `${fmt.format(r.blocks)} bloques entre las dos · a ${fmt.format(r.fromCenter)} del centro`)),
    place(r.a),
    place(r.b));
}

function renderMore() {
  const next = state.results.slice(state.shown, state.shown + PAGE);
  const more = $('results').querySelector('.more');
  more?.remove();
  $('results').append(...next.map(card));
  state.shown += next.length;
  if (state.shown < state.results.length) {
    $('results').append(h('button', { class: 'btn more', onclick: renderMore },
      `Ver más (${fmt.format(state.results.length - state.shown)} restantes)`));
  }
}

function applySort() {
  const byCenter = $('sort').value === 'center';
  state.results = byCenter ? [...state.all].sort((p, q) => p.fromCenter - q.fromCenter) : state.all;
  state.shown = 0;
  $('results').replaceChildren();
  renderMore();
}
$('sort').addEventListener('change', applySort);

function onResults(data) {
  state.all = data.results;
  state.results = data.results;
  state.shown = 0;
  $('sort-field').hidden = !(state.last.b && data.results.length > 1);
  const o = state.last;
  const A = STRUCTURES[o.a].name;
  const B = o.b ? STRUCTURES[o.b].name : null;
  const where = `en ${fmt.format(o.radius)} bloques alrededor de (${o.centerX}, ${o.centerZ})`;
  const results = $('results');
  results.replaceChildren();
  if (!data.results.length) {
    $('summary').textContent = '';
    results.append(h('div', { class: 'card empty' },
      B ? `No hay ninguna pareja de ${A} + ${B} a ${o.maxChunks} chunks o menos ${where}. ` +
        (o.radius < 1000000 ? 'Prueba con un radio más grande' : 'Prueba con otro centro') +
        (o.maxChunks < 10 ? ' o con más distancia.' : '.') +
        ' Algunas combinaciones son muy raras: un monumento pegado a un puesto de saqueadores puede estar a cientos de miles de bloques.'
        : `No se encontró: ${A} ${where}. Prueba con un radio más grande.`));
    return;
  }
  const n = data.results.length;
  $('summary').textContent = (B
    ? `${fmt.format(n)}${data.truncated ? '+' : ''} ${n === 1 ? 'pareja' : 'parejas'} de ${A} + ${B} ${where}.`
    : `${fmt.format(n)}${data.truncated ? '+' : ''} de ${A} ${where}, de más cerca a más lejos del centro.`) +
    ` Calculado en ${(data.ms / 1000).toFixed(1).replace('.', ',')} s.`;
  if (B) applySort();
  else renderMore();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
