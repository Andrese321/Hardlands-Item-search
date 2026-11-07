import {
  prepare, search, groupByPlace, itemLabel, entityLabel, enchantLabel,
  DIMENSIONS, CONTAINERS, PLAYER_SECTIONS, EXACT,
} from './search.js';
import { saveIndex, loadIndex, getAliases, setAlias } from './storage.js';

const $ = (id) => document.getElementById(id);

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

const fmt = new Intl.NumberFormat('es-ES');

const state = {
  names: { items: {}, entities: {} },
  index: null,
  prepared: null,
  aliases: {},
  kind: 'all',
  dim: 'all',
  player: null,
  worker: null,
};

// ---------------------------------------------------------------- pantallas

function show(screen) {
  for (const id of ['screen-load', 'screen-progress', 'screen-choose', 'screen-app']) $(id).hidden = id !== screen;
  $('error').hidden = true;
}

function showError(message) {
  for (const id of ['screen-progress', 'screen-choose']) $(id).hidden = true;
  $('screen-load').hidden = false;
  $('error-text').textContent = message;
  $('error').hidden = false;
  $('error').scrollIntoView({ behavior: 'smooth' });
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------------------------------------------------------------- escaneo

function startWorker() {
  state.worker?.terminate();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      $('progress-bar').style.width = `${Math.round(data.value * 100)}%`;
    } else if (data.type === 'status') {
      $('progress-status').textContent = data.text;
    } else if (data.type === 'choose') {
      chooseWorld(data.worlds);
    } else if (data.type === 'done') {
      worker.terminate();
      state.worker = null;
      onIndex(data.index, true);
    } else if (data.type === 'error') {
      worker.terminate();
      state.worker = null;
      showError(data.message);
    }
  };
  worker.onerror = (e) => {
    showError('Error interno: ' + (e.message || 'el navegador no pudo ejecutar el lector.') +
      ' Prueba con una versión reciente de Chrome, Safari o Firefox.');
  };
  state.worker = worker;
  return worker;
}

function beginScan(message) {
  show('screen-progress');
  $('progress-bar').style.width = '0%';
  $('progress-status').textContent = 'Preparando…';
  startWorker().postMessage(message);
}

function chooseWorld(worlds) {
  show('screen-choose');
  const list = $('world-list');
  list.replaceChildren(
    ...worlds.map((prefix) =>
      h('button', {
        class: 'btn',
        onclick: () => {
          show('screen-progress');
          state.worker.postMessage({ type: 'scan', prefix });
        },
      }, prefix.replace(/\/$/, '') || '(carpeta principal)'),
    ),
  );
}

$('input-zip').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) beginScan({ type: 'open', zip: file });
});

$('input-folder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) beginScan({ type: 'open', files });
});

$('btn-error').addEventListener('click', () => {
  $('error').hidden = true;
});

$('btn-change').addEventListener('click', () => {
  show('screen-load');
  refreshCached();
});

// ---------------------------------------------------------------- índice cargado

async function onIndex(index, fresh) {
  state.index = index;
  state.prepared = prepare(index, state.names);
  state.aliases = getAliases(index.worldName);
  state.player = null;
  if (fresh) saveIndex(index).catch(() => {});

  $('world-name').textContent = index.worldName;
  const s = index.stats;
  $('world-stats').textContent =
    `${fmt.format(s.total)} objetos · ${fmt.format(s.containers)} contenedores · ` +
    `${fmt.format(s.players)} jugadores · escaneado ${new Date(index.scannedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`;

  const notes = [...index.warnings];
  if (s.lootChests) {
    notes.push(s.lootChests === 1
      ? 'Hay 1 cofre de botín (aldea, templo…) que nunca se ha abierto: su contenido aún no existe en el mundo.'
      : `Hay ${fmt.format(s.lootChests)} cofres de botín (aldeas, templos…) que nunca se han abierto: su contenido aún no existe en el mundo.`);
  }
  const warn = $('warnings');
  warn.hidden = !notes.length;
  warn.replaceChildren(h('strong', {}, 'Avisos'), h('ul', {}, notes.map((n) => h('li', {}, n))));

  show('screen-app');
  selectTab('search');
  renderPlayers();
  runSearch();
  $('query').focus({ preventScroll: true });
}

async function refreshCached() {
  try {
    const cached = await loadIndex();
    if (!cached) return;
    $('cached').hidden = false;
    const b = $('btn-cached');
    b.textContent = `${cached.worldName} · ${new Date(cached.scannedAt).toLocaleDateString('es-ES')}`;
    b.onclick = () => onIndex(cached, false);
  } catch {
    /* sin caché */
  }
}

// ---------------------------------------------------------------- búsqueda

function playerName(id) {
  if (state.aliases[id]) return state.aliases[id];
  if (id === '~local_player') return 'Anfitrión (jugador local)';
  const short = id.replace(/^player_server_/, '').slice(0, 8);
  return `Jugador ${short}`;
}

function dimName(d) {
  return DIMENSIONS[d] ?? `Dimensión ${d}`;
}

function coords(loc) {
  if (loc.x == null) return null;
  return h('span', { class: 'coords' }, `X ${loc.x} · Y ${loc.y} · Z ${loc.z}`);
}

function tpCommand(loc) {
  const tp = `tp @s ${loc.x} ${loc.y} ${loc.z}`;
  const dim = { 1: 'nether', 2: 'the_end' }[loc.dim];
  return dim ? `/execute in ${dim} run ${tp}` : `/${tp}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado: ' + text);
  } catch {
    window.prompt('Copia el comando:', text);
  }
}

function placeTitle(loc) {
  if (loc.kind === 'player') {
    return `${playerName(loc.player)} · ${PLAYER_SECTIONS[loc.section] ?? loc.section}`;
  }
  const base = loc.kind === 'container'
    ? CONTAINERS[loc.type] ?? loc.type
    : entityLabel(loc.type, state.names);
  return loc.label ? `${base} «${loc.label}»` : base;
}

function itemTags(items) {
  const tags = [];
  for (const it of items) {
    if (it.name) tags.push(h('span', { class: 'tag' }, `«${it.name}»`));
    if (it.ench) tags.push(h('span', { class: 'tag' }, it.ench.map(([id, lvl]) => enchantLabel(id, lvl)).join(', ')));
  }
  return tags;
}

function renderPlace(place) {
  const { loc, via, count, items } = place;
  const detail = [];
  if (loc.kind === 'player') {
    detail.push('Última posición: ', coords(loc) ?? '—', ` · ${dimName(loc.dim)}`);
  } else {
    detail.push(coords(loc) ?? 'Posición desconocida', ` · ${dimName(loc.dim)}`);
  }
  if (via.length) {
    detail.push(h('br'), 'Dentro de: ' + via.map((id) => itemLabel(id, state.names)).join(' → '));
  }
  const tags = itemTags(items);
  return h('li', { class: 'place' },
    h('div', { class: 'place-title' }, placeTitle(loc)),
    h('div', { class: 'place-count' }, '×' + fmt.format(count)),
    h('div', { class: 'place-detail' }, ...detail, tags.length ? h('div', {}, tags) : null),
    loc.x != null
      ? h('div', { class: 'place-actions' },
        h('button', { class: 'btn small', onclick: () => copy(`${loc.x} ${loc.y} ${loc.z}`) }, 'Copiar coordenadas'),
        h('button', { class: 'btn small', onclick: () => copy(tpCommand(loc)) }, 'Copiar /tp'))
      : null,
  );
}

const PAGE = 50;

function renderGroup(g) {
  const places = groupByPlace(state.index, g.records);
  const reasons = [];
  if (g.reasons.has('name')) reasons.push('por nombre personalizado');
  if (g.reasons.has('ench')) reasons.push('por encantamiento');
  const details = h('details', { class: 'group' },
    h('summary', {},
      h('div', { class: 'group-title' }, g.label),
      h('div', { class: 'group-total' }, '×' + fmt.format(g.total)),
      h('div', { class: 'group-meta' },
        h('span', { class: 'badge ' + (g.exact ? 'exact' : 'similar') }, g.exact ? 'Coincide' : 'Parecido'),
        h('span', {}, g.id),
        reasons.length ? h('span', {}, reasons.join(', ')) : null),
      h('div', { class: 'group-places' }, places.length === 1 ? '1 lugar' : `${fmt.format(places.length)} lugares`),
    ),
  );
  let shown = 0;
  const list = h('ul', { class: 'places' });
  const more = h('button', { class: 'btn more' });
  const renderMore = () => {
    const next = places.slice(shown, shown + PAGE);
    list.append(...next.map(renderPlace));
    shown += next.length;
    more.hidden = shown >= places.length;
    more.textContent = `Ver más (${fmt.format(places.length - shown)} lugares restantes)`;
  };
  more.addEventListener('click', renderMore);
  details.addEventListener('toggle', () => {
    if (details.open && shown === 0) {
      details.append(list, more);
      renderMore();
    }
  });
  return details;
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
}

function runSearch() {
  if (!state.index) return;
  const query = $('query').value;
  const pf = $('player-filter');
  if (state.player) {
    pf.hidden = false;
    pf.replaceChildren(
      h('span', {}, 'Objetos de ', h('strong', {}, playerName(state.player))),
      h('button', { class: 'btn small', onclick: () => { state.player = null; runSearch(); } }, 'Quitar filtro'),
    );
  } else {
    pf.hidden = true;
  }

  const results = $('results');
  const summary = $('summary');
  if (!query.trim() && !state.player) {
    summary.textContent = '';
    results.replaceChildren(h('div', { class: 'empty' }, 'Escribe el nombre de un objeto en español o en inglés.'));
    return;
  }
  const groups = search(state.index, state.prepared, query, { kind: state.kind, dim: state.dim, player: state.player });
  if (!groups.length) {
    summary.textContent = '';
    results.replaceChildren(h('div', { class: 'empty' }, 'No se ha encontrado nada con ese nombre.'));
    return;
  }
  const exact = groups.filter((g) => g.score >= EXACT).length;
  summary.textContent = `${fmt.format(groups.length)} tipos de objeto` +
    (query.trim() ? ` · ${fmt.format(exact)} coinciden, ${fmt.format(groups.length - exact)} parecidos` : '');
  const shownGroups = groups.slice(0, 100);
  const nodes = shownGroups.map(renderGroup);
  if (groups.length > shownGroups.length) {
    nodes.push(h('div', { class: 'empty' }, `Y ${groups.length - shownGroups.length} más: escribe un nombre más concreto.`));
  }
  results.replaceChildren(...nodes);
  if (groups.length === 1 || groups[0].score === 1 || (groups[0].exact && !groups[1]?.exact)) nodes[0].open = true;
}

$('query').addEventListener('input', scheduleSearch);
$('query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
    runSearch();
  }
});

$('kind-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.kind = chip.dataset.kind;
  for (const c of $('kind-chips').children) c.classList.toggle('active', c === chip);
  runSearch();
});

$('dim').addEventListener('change', (e) => {
  state.dim = e.target.value;
  runSearch();
});

// ---------------------------------------------------------------- pestañas

function selectTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  }
  $('tab-search').hidden = name !== 'search';
  $('tab-players').hidden = name !== 'players';
}

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
}

// ---------------------------------------------------------------- jugadores

function renderPlayers() {
  const list = $('players');
  const players = state.index.players;
  if (!players.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'Este mundo no tiene datos de jugadores.'));
    return;
  }
  list.replaceChildren(
    ...players.map((p) =>
      h('div', { class: 'card player' },
        h('div', {},
          h('h3', {}, playerName(p.id)),
          h('div', { class: 'id' }, p.id)),
        h('div', { class: 'place-count' }, '×' + fmt.format(p.total)),
        h('div', { class: 'place-detail' },
          'Última posición: ', coords(p) ?? '—', ` · ${dimName(p.dim)}`),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn small',
            onclick: () => {
              state.player = p.id;
              $('query').value = '';
              selectTab('search');
              runSearch();
            },
          }, 'Ver sus objetos'),
          h('button', {
            class: 'btn small',
            onclick: () => {
              const name = window.prompt('Nombre para este jugador:', state.aliases[p.id] || '');
              if (name === null) return;
              state.aliases = setAlias(state.index.worldName, p.id, name.trim());
              renderPlayers();
              runSearch();
            },
          }, 'Poner nombre')),
      ),
    ),
  );
}

// ---------------------------------------------------------------- inicio

async function init() {
  try {
    const res = await fetch(new URL('../data/names_es.json', import.meta.url));
    if (res.ok) state.names = await res.json();
  } catch {
    /* sin traducciones: se usarán los nombres en inglés */
  }
  refreshCached();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
