import './version.js';
import { STRUCTURES, BIOME_NAMES, parseSeed, planTasks, mergeResults } from './seedfinder.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });
const dec = (n) => String(n).replace('.', ',');

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

const state = { mode: 'multi', pool: [], run: 0, data: null, opts: null, list: [], shown: 0 };
const PAGE = 30;
const STORE = 'hardlands-seed';

// ---------------------------------------------------------------- formulario

$('multi-type').append(h('option', { value: '' }, 'Todas las estructuras'));
$('type-b').append(h('option', { value: '' }, '(nada: solo listar la primera)'));
for (const [id, cfg] of Object.entries(STRUCTURES)) {
  $('multi-type').append(h('option', { value: id }, cfg.name));
  $('type-a').append(h('option', { value: id }, cfg.name));
  $('type-b').append(h('option', { value: id }, cfg.name));
}
$('type-a').value = 'monument';
$('type-b').value = 'outpost';

const chunksText = (n) => `${n} ${n === 1 ? 'chunk' : 'chunks'} (${n * 16} bloques)`;

function updateForm() {
  $('multi-dist-label').textContent = chunksText(Number($('multi-dist').value));
  $('dist-label').textContent = chunksText(Number($('dist').value));
  $('dist-field').hidden = !$('type-b').value;
  $('mode-multi').hidden = state.mode !== 'multi';
  $('mode-pairs').hidden = state.mode !== 'pairs';
  for (const t of document.querySelectorAll('.mode-tabs .tab')) {
    const active = t.dataset.mode === state.mode;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  }
  const radius = Number($('radius').value);
  const heavy = state.mode === 'multi' ? radius >= ($('multi-type').value ? 500000 : 250000) : radius >= 1000000;
  $('slow-note').hidden = !heavy;
}

for (const t of document.querySelectorAll('.mode-tabs .tab')) {
  t.addEventListener('click', () => {
    state.mode = t.dataset.mode;
    updateForm();
  });
}
for (const id of ['multi-dist', 'dist']) $(id).addEventListener('input', updateForm);
for (const id of ['type-b', 'radius', 'multi-type']) $(id).addEventListener('change', updateForm);

function remember() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      seed: $('seed').value, mode: state.mode, multi: $('multi-type').value, multiDist: $('multi-dist').value,
      a: $('type-a').value, b: $('type-b').value, dist: $('dist').value,
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
    if (s.mode === 'multi' || s.mode === 'pairs') state.mode = s.mode;
    if (s.multi === '' || STRUCTURES[s.multi]) $('multi-type').value = s.multi;
    if (s.multiDist) $('multi-dist').value = s.multiDist;
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
updateForm();

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

function setBusy(busy, text = 'Buscando…') {
  $('progress').hidden = !busy;
  $('progress-status').textContent = text;
  if (busy) $('progress-bar').style.width = '0%';
  $('btn-search').disabled = busy;
}

// ---------------------------------------------------------------- hilos de trabajo

const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

function newWorker() {
  return new Worker(new URL('./seed-worker.js', import.meta.url), { type: 'module' });
}

function stopPool() {
  state.run++;
  for (const w of state.pool) w.terminate();
  state.pool = [];
}

/** Reparte las tareas entre varios hilos y devuelve los resultados. */
function runTasks(plan, onProgress) {
  stopPool();
  const run = state.run;
  const { tasks, options } = plan;
  const n = Math.min(THREADS, tasks.length);
  return new Promise((resolve, reject) => {
    const parts = [];
    let next = 0;
    let done = 0;
    const fail = (message) => {
      if (run !== state.run) return;
      stopPool();
      reject(new Error(message));
    };
    const give = (w) => {
      if (next < tasks.length) w.postMessage({ type: 'task', id: next, options, task: tasks[next++] });
    };
    for (let i = 0; i < n; i++) {
      const w = newWorker();
      state.pool.push(w);
      w.onmessage = ({ data }) => {
        if (run !== state.run) return;
        if (data.type === 'error') {
          fail(data.message);
          return;
        }
        parts.push(data.result);
        onProgress(++done / tasks.length);
        if (done === tasks.length) {
          stopPool();
          resolve(parts);
        } else {
          give(w);
        }
      };
      w.onerror = (e) => fail('Error interno: ' + (e.message || 'el navegador no pudo ejecutar el buscador.'));
      give(w);
    }
  });
}

$('btn-cancel').addEventListener('click', () => {
  stopPool();
  setBusy(false);
});

// ---------------------------------------------------------------- semilla desde un mundo

$('input-world').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('error').hidden = true;
  stopPool();
  setBusy(true, 'Leyendo la semilla del mundo…');
  const w = newWorker();
  state.pool.push(w);
  const finish = () => {
    stopPool();
    setBusy(false);
  };
  w.onmessage = ({ data }) => {
    finish();
    if (data.type === 'seed') onSeed(data);
    else showError(data.message);
  };
  w.onerror = (err) => {
    finish();
    showError('Error interno: ' + (err.message || 'no se pudo leer el archivo.'));
  };
  w.postMessage({ type: 'readSeed', zip: f });
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

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;
  let plan;
  try {
    const common = {
      seed: parseSeed($('seed').value),
      centerX: Math.trunc(Number($('center-x').value) || 0),
      centerZ: Math.trunc(Number($('center-z').value) || 0),
      radius: Number($('radius').value),
    };
    plan = planTasks(state.mode === 'multi'
      ? { ...common, mode: 'multi', types: $('multi-type').value ? [$('multi-type').value] : null, maxChunks: Number($('multi-dist').value) }
      : { ...common, mode: 'pairs', a: $('type-a').value, b: $('type-b').value || null, maxChunks: Number($('dist').value) });
  } catch (err) {
    showError(err.message);
    return;
  }
  remember();
  for (const id of ['report', 'controls']) $(id).hidden = true;
  $('results').replaceChildren();
  $('summary').textContent = '';
  const threads = Math.min(THREADS, plan.tasks.length);
  setBusy(true, threads > 1 ? `Buscando con ${threads} núcleos…` : 'Buscando…');
  const t0 = performance.now();
  try {
    const parts = await runTasks(plan, (p) => ($('progress-bar').style.width = `${Math.round(p * 100)}%`));
    state.opts = plan.options;
    state.data = mergeResults(plan.options, parts);
    state.data.seconds = (performance.now() - t0) / 1000;
    setBusy(false);
    render();
  } catch (err) {
    setBusy(false);
    showError(err.message);
  }
});

// ---------------------------------------------------------------- resultados

const biomeName = (id) => BIOME_NAMES[id] ?? 'Bioma ' + id;
const where = (o) => `en ${fmt.format(o.radius)} bloques alrededor de (${o.centerX}, ${o.centerZ})`;

function tpButtons(x, z) {
  return h('div', { class: 'place-actions' },
    h('button', { class: 'btn small', onclick: () => copy(`${x} ~ ${z}`) }, 'Copiar coordenadas'),
    h('button', { class: 'btn small', onclick: () => copy(`/tp @s ${x} ~ ${z}`) }, 'Copiar /tp'));
}

function place(p) {
  return h('div', { class: 'seed-place' },
    h('div', { class: 'place-title' }, p.name),
    h('div', { class: 'place-detail' }, h('span', { class: 'coords' }, `X ${p.x} · Z ${p.z}`), ` · ${biomeName(p.biome)}`),
    tpButtons(p.x, p.z));
}

const groupTitle = (g) => `${g.size} ${STRUCTURES[g.type].plural}`;

function groupCard(g) {
  return h('div', { class: 'card seed-result' + (g.size >= 3 ? ' big-group' : '') },
    h('div', { class: 'seed-head' },
      h('span', { class: 'seed-dist' }, groupTitle(g)),
      g.size >= 3 ? h('span', { class: 'badge exact' }, `★ grupo de ${g.size}`) : null,
      h('span', { class: 'muted small' },
        `Separación máxima ${dec(g.span)} chunks (${fmt.format(g.blocks)} bloques) · a ${fmt.format(g.fromCenter)} bloques del centro`)),
    h('div', { class: 'seed-place' },
      h('div', { class: 'place-title' }, 'Punto medio'),
      h('div', { class: 'place-detail' }, h('span', { class: 'coords' }, `X ${g.x} · Z ${g.z}`)),
      tpButtons(g.x, g.z)),
    h('ol', { class: 'members' }, g.members.map((m) =>
      h('li', {},
        h('span', {}, h('span', { class: 'coords' }, `X ${m.x} · Z ${m.z}`), h('span', { class: 'muted' }, ` · ${biomeName(m.biome)}`)),
        h('button', { class: 'btn small', onclick: () => copy(`/tp @s ${m.x} ~ ${m.z}`) }, '/tp')))));
}

function pairCard(r) {
  if (!r.b) {
    return h('div', { class: 'card seed-result' },
      h('div', { class: 'seed-head' }, h('span', { class: 'seed-dist' }, `A ${fmt.format(r.fromCenter)} bloques del centro`)),
      place(r.a));
  }
  return h('div', { class: 'card seed-result' },
    h('div', { class: 'seed-head' },
      h('span', { class: 'seed-dist' }, `${dec(r.chunks)} ${r.chunks === 1 ? 'chunk' : 'chunks'}`),
      h('span', { class: 'muted small' }, `${fmt.format(r.blocks)} bloques entre las dos · a ${fmt.format(r.fromCenter)} del centro`)),
    place(r.a),
    place(r.b));
}

function renderMore() {
  const card = state.data.mode === 'multi' ? groupCard : pairCard;
  const next = state.list.slice(state.shown, state.shown + PAGE);
  $('results').querySelector('.more')?.remove();
  $('results').append(...next.map(card));
  state.shown += next.length;
  if (state.shown < state.list.length) {
    $('results').append(h('button', { class: 'btn more', onclick: renderMore },
      `Ver más (${fmt.format(state.list.length - state.shown)} restantes)`));
  }
}

// Texto como «1 grupo de 4, 2 grupos de 3 y 57 parejas».
function countsText(sizes) {
  const parts = Object.keys(sizes).map(Number).sort((a, b) => b - a).map((size) => {
    const n = sizes[size];
    if (size === 2) return `${fmt.format(n)} ${n === 1 ? 'pareja' : 'parejas'}`;
    return `${fmt.format(n)} ${n === 1 ? 'grupo' : 'grupos'} de ${size}`;
  });
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1] : parts[0];
}

// Número de grupos encontrados (todos, o solo los de 3 o más).
function countGroups(counts, min = 2) {
  let n = 0;
  for (const sizes of Object.values(counts)) {
    for (const [size, c] of Object.entries(sizes)) if (Number(size) >= min) n += c;
  }
  return n;
}

function renderReport() {
  const d = state.data;
  const o = state.opts;
  const report = $('report');
  report.hidden = false;
  const time = `Calculado en ${dec(d.seconds.toFixed(1))} s.`;

  if (d.mode !== 'multi') {
    const A = STRUCTURES[o.a].name;
    const B = o.b ? STRUCTURES[o.b].name : null;
    let text;
    if (d.total) {
      text = B
        ? `${fmt.format(d.total)} ${d.total === 1 ? 'pareja' : 'parejas'} de ${A} + ${B} a ${o.maxChunks} chunks o menos, ${where(o)}.`
        : `${fmt.format(d.total)} de ${A} ${where(o)}.`;
    } else if (B) {
      text = `Ninguna pareja de ${A} + ${B} a ${o.maxChunks} chunks o menos ${where(o)}. ` +
        (o.radius < 1000000 ? 'Prueba con un radio más grande' : 'Prueba con otro centro') +
        (o.maxChunks < 40 ? ' o con más distancia.' : '.');
    } else {
      text = `No hay: ${A} ${where(o)}. Prueba con un radio más grande.`;
    }
    report.replaceChildren(h('h2', {}, 'Lo que encontré'), h('p', {}, text), h('p', { class: 'small muted' }, time));
    return;
  }

  const count3 = countGroups(d.counts, 3);
  // Primero los tipos con grupos de 3 o más; después los que solo tienen parejas; al final los vacíos.
  const rank = (type) => (!d.counts[type] ? 2 : Object.keys(d.counts[type]).some((k) => Number(k) >= 3) ? 0 : 1);
  const lines = [...d.types].sort((p, q) => rank(p) - rank(q)).map((type) => {
    const sizes = d.counts[type];
    const g = d.best[type];
    return h('li', { class: rank(type) === 0 ? 'hit' : sizes ? '' : 'muted' },
      h('div', {}, h('strong', {}, STRUCTURES[type].name + ': '), sizes ? countsText(sizes) : 'nada'),
      g ? h('div', { class: 'best small' },
        `Lo mejor: ${g.size} a ${dec(g.span)} chunks como mucho entre sí, cerca de `,
        h('span', { class: 'coords' }, `X ${g.x} · Z ${g.z}`), ` (a ${fmt.format(g.fromCenter)} bloques del centro) `,
        h('button', { class: 'btn small', onclick: () => copy(`/tp @s ${g.x} ~ ${g.z}`) }, '/tp')) : null);
  });
  let headline;
  if (count3) {
    headline = h('div', { class: 'highlight' },
      h('strong', {}, `★ ${count3 === 1 ? 'Hay 1 grupo' : `Hay ${fmt.format(count3)} grupos`} de 3 o más estructuras del mismo tipo juntas`));
  } else {
    headline = h('p', {}, countGroups(d.counts)
      ? 'No hay grupos de 3 o más; solo parejas.'
      : 'No hay estructuras del mismo tipo tan cerca. Prueba con más separación o un radio más grande.');
  }
  report.replaceChildren(
    h('h2', {}, 'Lo que encontré'),
    h('p', { class: 'small muted' }, `Estructuras del mismo tipo a ${o.maxChunks} chunks o menos unas de otras, ${where(o)}.`),
    headline,
    h('ul', { class: 'report-list' }, lines),
    h('p', { class: 'small muted' }, time));
}

function applyView() {
  const d = state.data;
  let total;
  if (d.mode === 'multi') {
    const only3 = $('only3').checked;
    const bySize = $('sort').value !== 'center';
    state.list = bySize ? (only3 ? d.size.filter((g) => g.size >= 3) : d.size) : only3 ? d.center3 : d.center;
    total = countGroups(d.counts, only3 ? 3 : 2);
  } else {
    state.list = d.mode === 'pairs' && $('sort').value !== 'center' ? d.pair : d.center;
    total = d.total;
  }
  state.shown = 0;
  $('results').replaceChildren();
  $('summary').textContent = state.list.length && total > state.list.length
    ? `Se muestran ${fmt.format(state.list.length)} de ${fmt.format(total)} (los primeros según el orden elegido).`
    : '';
  renderMore();
}

function render() {
  const d = state.data;
  renderReport();
  const options = d.mode === 'multi'
    ? [['size', 'Los grupos más grandes primero'], ['center', 'Los más cercanos al centro primero']]
    : [['pair', 'Las más juntas primero'], ['center', 'Las más cercanas al centro primero']];
  $('sort').replaceChildren(...options.map(([v, t]) => h('option', { value: v }, t)));
  const count = d.mode === 'multi' ? d.size.length : d.center.length;
  $('controls').hidden = d.mode === 'single' || count < 2;
  const n3 = d.mode === 'multi' ? countGroups(d.counts, 3) : 0;
  $('only3-field').hidden = !n3 || n3 === countGroups(d.counts);
  $('only3').checked = false;
  applyView();
}

$('sort').addEventListener('change', applyView);
$('only3').addEventListener('change', applyView);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
