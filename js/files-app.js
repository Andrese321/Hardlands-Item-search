import { buildTree } from './files.js';
import { itemLabel } from './search.js';

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
  worker: null, files: [], structures: [], names: { items: {} }, archiveName: 'mundo', ext: '.zip', worldName: '',
  selected: new Set(), canEdit: false, deleting: false, downloadUrl: null,
};

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function show(screen) {
  for (const id of ['screen-load', 'screen-progress', 'screen-choose', 'screen-files']) $(id).hidden = id !== screen;
  $('error').hidden = true;
}

function showError(message) {
  if ($('screen-files').hidden) show('screen-load');
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

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Descargando ' + name);
}

function startWorker() {
  state.worker?.terminate();
  const w = new Worker(new URL('./files-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') $('progress-bar').style.width = `${Math.round(data.value * 100)}%`;
    else if (data.type === 'status') {
      if (!$('screen-progress').hidden) $('progress-status').textContent = data.text;
    } else if (data.type === 'files') state.files = data.files;
    else if (data.type === 'choose') chooseWorld(data.worlds);
    else if (data.type === 'scanned') onScanned(data);
    else if (data.type === 'download') saveBlob(data.blob, data.name);
    else if (data.type === 'deleted') onDeleted(data);
    else if (data.type === 'error') {
      if (state.deleting) deleteFailed(data.message);
      else showError(data.message);
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

$('input-zip').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  state.archiveName = f.name.replace(/\.[^.]+$/, '') || 'mundo';
  state.ext = /\.mcworld$/i.test(f.name) ? '.mcworld' : '.zip';
  progressScreen();
  startWorker().postMessage({ type: 'open', zip: f });
});

$('input-folder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  state.archiveName = (files[0].webkitRelativePath || '').split('/')[0] || 'mundo';
  state.ext = '.zip';
  progressScreen();
  startWorker().postMessage({ type: 'open', files });
});

function chooseWorld(worlds) {
  show('screen-choose');
  $('world-list').replaceChildren(
    ...worlds.map((prefix) =>
      h('button', {
        class: 'btn',
        onclick: () => {
          progressScreen();
          state.worker.postMessage({ type: 'scan', prefix });
        },
      }, prefix.replace(/\/$/, '') || '(carpeta principal)'),
    ),
  );
}

function onScanned(data) {
  state.structures = data.structures;
  state.canEdit = data.canEdit;
  state.selected = new Set();
  $('delete-result').hidden = true;
  $('delete-confirm').checked = false;
  state.worldName = data.worldName || state.archiveName;
  $('world-name').textContent = state.worldName;
  const total = state.files.reduce((s, f) => s + f.size, 0);
  $('world-stats').textContent = `${fmt.format(state.files.length)} archivos · ${size(total)} · ` +
    `${fmt.format(data.structures.length)} ${data.structures.length === 1 ? 'estructura' : 'estructuras'}`;
  const warn = $('warnings');
  warn.hidden = !data.warnings.length;
  warn.replaceChildren(h('strong', {}, 'Avisos'), h('ul', {}, data.warnings.map((w) => h('li', {}, w))));
  show('screen-files');
  renderStructures();
  renderTree();
  selectTab(data.structures.length || !state.files.length ? 'structures' : 'tree');
}

// ---------------------------------------------------------------- estructuras

function blockName(id) {
  return itemLabel(id, state.names);
}

function renderStructures() {
  const list = $('structures');
  const ss = state.structures;
  if (!ss.length) {
    list.replaceChildren(h('div', { class: 'card empty' },
      'Este mundo no tiene estructuras guardadas. Se guardan con un bloque de estructuras en modo «Guardar» ',
      '(botón «Guardar», no «Exportar»), o con /structure save.'));
    return;
  }
  const cards = ss.map((s, index) => {
    const i = s.info;
    const lines = [];
    if (i) {
      lines.push(h('div', {}, h('span', { class: 'coords' }, `${i.size[0]} × ${i.size[1]} × ${i.size[2]}`),
        ` · ${fmt.format(i.blocks)} bloques` +
        (i.blockEntities ? ` · ${fmt.format(i.blockEntities)} con datos (cofres, carteles…)` : '') +
        (i.entities ? ` · ${fmt.format(i.entities)} entidades` : '')));
      if (i.origin && s.source === 'world') lines.push(h('div', {}, `Guardada desde X ${i.origin[0]} · Y ${i.origin[1]} · Z ${i.origin[2]}`));
      if (i.top.length) lines.push(h('div', {}, i.top.map(([n, c]) => h('span', { class: 'tag' }, `${blockName(n)} ×${fmt.format(c)}`))));
    } else {
      lines.push(h('div', { class: 'danger' }, 'No se pudo leer: ' + s.error));
    }
    const check = state.canEdit
      ? h('input', {
        type: 'checkbox',
        class: 'pick',
        'aria-label': 'Marcar ' + s.id + ' para borrar',
        onchange: (e) => {
          if (e.target.checked) state.selected.add(index);
          else state.selected.delete(index);
          e.target.closest('.structure').classList.toggle('picked', e.target.checked);
          updateDelete();
        },
      })
      : null;
    if (check && state.selected.has(index)) check.checked = true;
    return h('div', { class: 'card structure' + (state.selected.has(index) ? ' picked' : '') },
      h('div', { class: 'structure-head' },
        check,
        h('div', { class: 'grow' },
          h('h3', {}, s.id),
          h('div', { class: 'small muted' }, s.source === 'world' ? 'Guardada en el mundo' : 'En un pack: ' + s.path)),
        h('button', {
          class: 'btn small primary',
          onclick: () => state.worker.postMessage({ type: 'structure', index }),
        }, 'Descargar')),
      h('div', { class: 'small muted structure-info' }, lines),
      h('div', { class: 'small muted' }, 'Archivo: ' + s.file));
  });
  const all = ss.length > 1
    ? h('button', {
      class: 'btn primary',
      onclick: () => state.worker.postMessage({ type: 'allStructures', name: `estructuras-${state.worldName}`.replace(/[\\/:*?"<>|]+/g, '_') }),
    }, `Descargar todas (${ss.length}) en un .zip`)
    : null;
  list.replaceChildren(...(all ? [all] : []), ...cards);
  updateDelete();
}

// ---------------------------------------------------------------- borrar estructuras

function updateDelete() {
  const panel = $('delete-panel');
  panel.hidden = !state.structures.length || !state.canEdit;
  const chosen = [...state.selected].map((i) => state.structures[i]);
  const packs = chosen.filter((s) => s.source === 'pack').length;
  const summary = $('delete-summary');
  if (!chosen.length) {
    summary.replaceChildren('Marca una o más estructuras en la lista de arriba.');
  } else {
    summary.replaceChildren(
      h('div', {}, 'Se borrarán ', h('strong', {}, String(chosen.length)), ` de ${state.structures.length} estructuras: ` + chosen.map((s) => s.id).join(', ') + '.'),
      packs ? h('div', { class: 'small' }, `${packs === 1 ? '1 está' : `${packs} están`} dentro de un pack: se quita el archivo .mcstructure del pack en la copia.`) : null,
    );
  }
  $('btn-delete').disabled = !(chosen.length && $('delete-confirm').checked);
}

function setAll(on) {
  state.selected = on ? new Set(state.structures.map((_, i) => i)) : new Set();
  renderStructures();
}

$('sel-all').addEventListener('click', () => setAll(true));
$('sel-none').addEventListener('click', () => setAll(false));
$('delete-confirm').addEventListener('change', updateDelete);

$('btn-delete').addEventListener('click', () => {
  const indices = [...state.selected].sort((a, b) => a - b);
  const names = indices.map((i) => state.structures[i].id);
  if (!window.confirm(`Se creará una copia del mundo sin ${names.length === 1 ? 'esta estructura' : `estas ${names.length} estructuras`}:\n\n` +
    names.join('\n') + '\n\nEl archivo original no se toca. ¿Continuar?')) return;
  state.deleting = true;
  progressScreen();
  state.worker.postMessage({ type: 'delete', indices });
});

function deleteFailed(message) {
  state.deleting = false;
  show('screen-files');
  const r = $('delete-result');
  r.hidden = false;
  r.replaceChildren(h('strong', { class: 'danger' }, 'No se pudo crear la copia: '), message);
}

function onDeleted(data) {
  state.deleting = false;
  show('screen-files');
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(data.blob);
  const name = `${state.archiveName}-sin-estructuras${state.ext}`;
  const r = $('delete-result');
  r.hidden = false;
  r.replaceChildren(
    h('h2', {}, 'Copia del mundo lista'),
    h('p', {}, `Sin ${data.names.length === 1 ? 'la estructura' : `las ${data.names.length} estructuras`}: ${data.names.join(', ')}. ` +
      `Archivo: ${size(data.blob.size)}.`),
    h('a', { class: 'btn primary', href: state.downloadUrl, download: name }, 'Descargar ' + name),
    h('ol', { class: 'result-steps' },
      h('li', {}, 'Con el servidor apagado, sube este archivo como copia de seguridad a restaurar (o reemplaza la carpeta del mundo).'),
      h('li', {}, 'Al abrir el mundo, Minecraft aplica el borrado: esas estructuras ya no aparecerán en el bloque de estructuras ni en /structure load.'),
      h('li', {}, 'Las construcciones que ya estén puestas en el mapa no se tocan: solo se borra la plantilla guardada.')),
  );
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Copia del mundo lista para descargar');
}

// ---------------------------------------------------------------- árbol de archivos

function fileRow(f) {
  const isStructure = /\.mcstructure$/i.test(f.name);
  return h('li', { class: 'file' },
    h('span', { class: 'file-name' }, f.name, isStructure ? h('span', { class: 'badge exact' }, 'estructura') : null),
    h('span', { class: 'file-size' }, size(f.size)),
    h('button', { class: 'btn small', onclick: () => state.worker.postMessage({ type: 'file', path: f.path }) }, 'Bajar'));
}

function dirNode(node, open = false) {
  const det = h('details', { class: 'dir', open },
    h('summary', {}, h('span', { class: 'file-name' }, '📁 ' + node.name + '/'),
      h('span', { class: 'file-size' }, `${fmt.format(node.count)} · ${size(node.size)}`)));
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    det.append(dirContents(node));
  };
  if (open) fill();
  det.addEventListener('toggle', () => det.open && fill());
  return det;
}

function dirContents(node) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return h('div', { class: 'dir-body' },
    dirs.map((d) => dirNode(d)),
    files.length ? h('ul', { class: 'files' }, files.map(fileRow)) : null);
}

function renderTree() {
  const tree = buildTree(state.files);
  $('tree').replaceChildren(dirContents(tree));
}

// ---------------------------------------------------------------- pestañas

function selectTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  }
  $('tab-structures').hidden = name !== 'structures';
  $('tab-tree').hidden = name !== 'tree';
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));

(async () => {
  try {
    const res = await fetch(new URL('../data/names_es.json', import.meta.url));
    if (res.ok) state.names = await res.json();
  } catch {
    /* nombres en inglés */
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
