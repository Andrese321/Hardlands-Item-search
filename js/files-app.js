import './version.js';
import { buildTree } from './files.js';
import { splitArchiveName } from './archive.js';
import { checkBeforeOpen, looksLikeTar, markStart, markDone, checkPreviousCrash, explainError } from './sizewarn.js';
import { itemLabel } from './search.js';
import { checkStructureFile, structureName, uniqueNames, structureId, buildMcpack, loadCommand, LOADER_EVENT, shortName } from './inject.js';

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
  selected: new Set(), canEdit: false, editBlocked: '', deleting: false, downloadUrl: null,
  hasWorld: false, injectList: [], injecting: false,
};

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function show(screen) {
  for (const id of ['screen-load', 'screen-progress', 'screen-choose', 'screen-files']) $(id).hidden = id !== screen;
  $('inject').hidden = screen === 'screen-progress' || screen === 'screen-choose';
  $('error').hidden = true;
}

function showError(message) {
  markDone();
  if ($('screen-files').hidden) show('screen-load');
  $('error-text').textContent = explainError(message);
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
    else if (data.type === 'injected') onInjected(data);
    else if (data.type === 'error') {
      if (state.deleting) deleteFailed(data.message);
      else if (state.injecting) injectFailed(data.message);
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
  if (!f || !checkBeforeOpen(f.size, { tar: looksLikeTar(f.name), tool: 'files' })) return;
  ({ base: state.archiveName, ext: state.ext } = splitArchiveName(f.name));
  markStart(`«${f.name}»`, f.size);
  progressScreen();
  startWorker().postMessage({ type: 'open', zip: f });
});

$('input-folder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const size = files.reduce((s, f) => s + f.size, 0);
  if (!files.length || !checkBeforeOpen(size, { tool: 'files' })) return;
  state.archiveName = (files[0].webkitRelativePath || '').split('/')[0] || 'mundo';
  state.ext = '.zip';
  markStart('la carpeta del mundo', size);
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
  markDone();
  state.hasWorld = !!data.worldName;
  state.structures = data.structures;
  state.canEdit = data.canEdit;
  state.editBlocked = data.editBlocked || '';
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
  if (state.injecting) {
    show('screen-progress');
    $('progress-status').textContent = 'Metiendo las estructuras en el mundo…';
  }
  renderInject();
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
    const blocked = !state.canEdit && s.source === 'world';
    const check = !blocked
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
  panel.hidden = !state.structures.length;
  const reason = $('delete-blocked');
  reason.hidden = state.canEdit;
  reason.textContent = state.editBlocked || 'No se puede editar este mundo.';
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
  state.selected = on
    ? new Set(state.structures.map((s, i) => (state.canEdit || s.source === 'pack' ? i : -1)).filter((i) => i >= 0))
    : new Set();
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
  markDone();
  r.replaceChildren(h('strong', { class: 'danger' }, 'No se pudo crear la copia: '), explainError(message));
}

function onDeleted(data) {
  state.deleting = false;
  show('screen-files');
  const r = $('delete-result');
  r.hidden = false;
  r.replaceChildren(
    h('h2', {}, 'Copia del mundo lista'),
    h('p', {}, `Sin ${data.names.length === 1 ? 'la estructura' : `las ${data.names.length} estructuras`}: ${data.names.join(', ')}. ` +
      'Las construcciones que ya estén puestas en el mapa no se tocan: solo se borra la plantilla guardada.'),
    ...downloadLinks(data, `${state.archiveName}-sin-estructuras`, state.ext),
  );
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Copia del mundo lista para descargar');
}

// Botones de descarga del mundo modificado: .mcworld (para abrir con Minecraft
// en el móvil) y .zip con la misma estructura que el original (para servidores).
function sizeText(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function downloadLinks(data, base, ext) {
  for (const u of state.downloadUrls || []) URL.revokeObjectURL(u);
  state.downloadUrls = [];
  const link = (blob, name, label, cls) => {
    const url = URL.createObjectURL(blob);
    state.downloadUrls.push(url);
    return h('a', { class: 'btn ' + cls, href: url, download: name }, label);
  };
  const out = [];
  if (data.mcworld) {
    out.push(link(data.mcworld, base + '.mcworld', `Descargar .mcworld (${sizeText(data.mcworld.size)}) · para abrir con Minecraft`, 'primary'));
  }
  if (!data.mcworld || data.nested || ext !== '.mcworld') {
    out.push(link(data.blob, base + (ext === '.mcworld' && !data.nested ? '.mcworld' : '.zip'),
      `Descargar .zip · misma estructura que el original (servidores)`, data.mcworld ? '' : 'primary'));
  }
  const steps = [];
  if (data.mcworld) {
    steps.push(h('p', { class: 'steps-title' }, 'En el móvil (también PC y consola):'),
      h('ol', { class: 'result-steps' },
        h('li', {}, 'Descarga el .mcworld y ábrelo con Minecraft. En Android, toca la descarga y elige Minecraft; en iPhone, en la app Archivos: Compartir → Minecraft.'),
        h('li', {}, 'Se importa como un mundo nuevo en tu lista; el mundo original no se toca.'),
        h('li', {}, 'Para un Realm: en los ajustes del Realm, «Reemplazar mundo» y elige el mundo importado.')));
  }
  steps.push(h('p', { class: 'steps-title' }, 'En un servidor:'),
    h('ol', { class: 'result-steps' },
      h('li', {}, 'Con el servidor apagado, sube el .zip como copia de seguridad a restaurar (o reemplaza la carpeta del mundo con su contenido).'),
      h('li', {}, 'Enciende el servidor. Si algo no va bien, restaura tu copia original.')));
  return [...out, ...steps];
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

// ---------------------------------------------------------------- meter estructuras

async function addStructureFiles(fileList) {
  for (const f of fileList) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let info = null;
    let error = null;
    try {
      info = checkStructureFile(bytes);
    } catch (e) {
      error = e.message;
    }
    state.injectList.push({ file: f.name, bytes, info, error, name: structureName(f.name) });
  }
  fixNames();
  $('inject-result').hidden = true;
  renderInject();
}

// Nombres únicos (si dos archivos dan el mismo nombre, el segundo se llama _2...).
function fixNames() {
  const ok = state.injectList.filter((s) => !s.error);
  uniqueNames(ok.map((s) => s.name)).forEach((n, i) => (ok[i].name = n));
}

const validStructures = () => state.injectList.filter((s) => !s.error);

function renderInject() {
  const list = $('inject-list');
  list.replaceChildren(...state.injectList.map((s, i) =>
    h('li', { class: s.error ? 'bad' : '' },
      s.error
        ? h('div', {}, h('strong', {}, s.file), h('span', { class: 'file' }, s.error))
        : h('div', {},
          h('label', { class: 'namebox' },
            h('span', {}, 'mystructure:'),
            h('input', {
              type: 'text',
              value: s.name,
              'aria-label': 'Nombre de ' + s.file,
              onchange: (e) => {
                s.name = structureName(e.target.value);
                fixNames();
                renderInject();
              },
            })),
          h('span', { class: 'file' }, s.file),
          h('span', { class: 'name-hint' }, `En el juego se llamará «${s.name}».`,
            shortName(s.name) ? ' ' : null,
            shortName(s.name) ? h('button', {
              type: 'button',
              class: 'linklike',
              onclick: () => {
                s.name = shortName(s.name);
                fixNames();
                renderInject();
              },
            }, `Acortar a «${shortName(s.name)}»`) : null)),
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          state.injectList.splice(i, 1);
          renderInject();
        },
      }, 'Quitar'),
      s.info ? h('div', { class: 'meta' },
        `${s.info.size.join(' × ')} · ${fmt.format(s.info.blocks)} bloques` +
        (s.info.blockEntities ? ` · ${fmt.format(s.info.blockEntities)} con datos (cofres…)` : '') +
        (s.info.entities ? ` · ${fmt.format(s.info.entities)} entidades` : '')) : null)));

  const n = validStructures().length;
  $('inject-actions').hidden = !n;
  const target = $('inject-target');
  const btn = $('btn-inject');
  if (state.hasWorld && state.canEdit) {
    target.textContent = `Se meterán en el mundo abierto: «${state.worldName}». Para otro mundo, pulsa «Cambiar» arriba y ábrelo primero.`;
    btn.textContent = `Meter ${n === 1 ? 'la estructura' : `las ${n} estructuras`} en «${state.worldName}»`;
  } else if (state.hasWorld) {
    target.textContent = `El mundo abierto («${state.worldName}») no se puede editar: ${state.editBlocked}`;
    btn.textContent = 'Elegir otro mundo y meterlas';
  } else {
    target.textContent = 'Al pulsar el botón eliges el mundo (.mcworld, .zip o .tar.gz).';
    btn.textContent = 'Elegir el mundo y meterlas';
  }
  btn.disabled = !(n && $('inject-confirm').checked);
  renderCommandPreviews();
}

$('input-structs').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await addStructureFiles(files);
});
$('inject-confirm').addEventListener('change', renderInject);

// Comandos para pegar las estructuras, con botón de copiar y notas según su tamaño.
// items: Array<{ name, info }>; loader: si hay cargador automático
function commandsBlock(items, intro, loader) {
  const cmdRow = (cmd) => h('div', { class: 'cmd' }, h('code', {}, cmd),
    h('button', { type: 'button', class: 'btn small', onclick: () => copyText(cmd) }, 'Copiar'));
  const out = [h('p', { class: 'steps-title' }, intro)];
  for (const s of items) {
    const { cmd, notes } = loadCommand(s.name, s.info?.size);
    if (loader) {
      out.push(
        cmdRow(`/scriptevent ${LOADER_EVENT} ${s.name}`),
        h('ul', { class: 'cmd-notes small muted' },
          h('li', {}, 'Carga toda la zona (verás el progreso arriba de la barra de objetos) y coloca la estructura entera, centrada donde estás si es grande y a una altura que quepa.'),
          h('li', {}, `Para girarla añade 90, 180 o 270 al final: /scriptevent ${LOADER_EVENT} ${s.name} 90`),
          h('li', {}, 'Todo lo que haya en ese espacio se reemplaza (también por aire): ponla en una zona despejada.')),
        h('details', { class: 'cmd-alt small' }, h('summary', {}, 'Comando normal, sin el cargador'), cmdRow(cmd)),
      );
    } else {
      out.push(cmdRow(cmd), h('ul', { class: 'cmd-notes small muted' }, notes.map((n) => h('li', {}, n))));
    }
  }
  out.push(h('p', { class: 'small muted' }, 'Hacen falta los trucos activados (Editar mundo → Trucos).' +
    (loader ? ` Para ver la lista de estructuras: /scriptevent ${LOADER_EVENT.replace('cargar', 'lista')}` : ' Si quieres girarla, añade al final 90_degrees, 180_degrees o 270_degrees.')));
  return out;
}

function packName() {
  return $('pack-name').value.trim() || 'Estructuras';
}

function renderCommandPreviews() {
  const list = validStructures();
  $('pack-cmds').replaceChildren(...(list.length ? commandsBlock(list,
    `Después de abrir el .mcpack con Minecraft y activar el paquete «${packName()}» en tu mundo (Editar → Paquetes de comportamiento), entra y escribe:`,
    $('pack-loader').checked) : []));
  $('inject-cmds').replaceChildren(...(list.length ? commandsBlock(list,
    $('inject-loader').checked
      ? 'Después de importar el mundo modificado (ya trae el cargador activado), entra y escribe:'
      : 'Después de importar el mundo modificado, entra y escribe (no hace falta activar ningún paquete):',
    $('inject-loader').checked) : []));
}
$('pack-name').addEventListener('input', renderCommandPreviews);
$('pack-loader').addEventListener('change', renderCommandPreviews);
$('inject-loader').addEventListener('change', renderCommandPreviews);

async function packIcon() {
  try {
    const res = await fetch(new URL('../icons/icon-192.png', import.meta.url));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {
    /* sin icono */
  }
  return null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado: ' + text);
  } catch {
    window.prompt('Copia el texto:', text);
  }
}

// Opción 1: .mcpack
$('btn-mcpack').addEventListener('click', async () => {
  const list = validStructures();
  if (!list.length) return;
  const icon = await packIcon();
  const packName = $('pack-name').value.trim() || 'Estructuras';
  const loader = $('pack-loader').checked;
  const { blob } = buildMcpack(list, { packName, icon, loader });
  const fileName = (packName.replace(/[\\/:*?"<>|]+/g, '_') || 'estructuras') + '.mcpack';
  for (const u of state.downloadUrls || []) URL.revokeObjectURL(u);
  const url = URL.createObjectURL(blob);
  state.downloadUrls = [url];
  const r = $('inject-result');
  r.hidden = false;
  r.replaceChildren(
    h('h3', {}, 'Paquete listo'),
    h('a', { class: 'btn primary', href: url, download: fileName }, `Descargar ${fileName} (${size(blob.size)})`),
    h('ol', { class: 'result-steps' },
      h('li', {}, 'Ábrelo con Minecraft (Android: toca la descarga y elige Minecraft; iPhone: Archivos → Compartir → Minecraft). Se importa solo.'),
      h('li', {}, `En tu mundo: Editar → Paquetes de comportamiento → Activar «${packName}». Activarlo desactiva los logros en ese mundo.` +
        (loader ? ' El cargador usa scripts estables: no hace falta activar ningún experimento.' : '')),
      h('li', {}, 'En un servidor: descomprime el .mcpack dentro de «behavior_packs/» y actívalo en world_behavior_packs.json. En un Realm: actívalo en el mundo antes de subirlo.')),
    ...commandsBlock(list, `Cuando el paquete «${packName}» esté activado en tu mundo, entra y escribe:`, loader),
  );
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Opción 2: dentro de un mundo
function injectStructures() {
  return validStructures().map((s) => ({ name: s.name, bytes: s.bytes, size: s.info?.size || [1, 1, 1] }));
}

$('btn-inject').addEventListener('click', async () => {
  if (!validStructures().length) return;
  if (state.hasWorld && state.canEdit && state.worker) {
    state.injecting = true;
    progressScreen();
    $('progress-status').textContent = 'Metiendo las estructuras en el mundo…';
    const loader = $('inject-loader').checked;
    state.worker.postMessage({ type: 'inject', structures: injectStructures(), loader, icon: loader ? await packIcon() : null });
  } else {
    $('input-inject-world').click();
  }
});

$('input-inject-world').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !checkBeforeOpen(f.size, { tar: looksLikeTar(f.name), tool: 'files' })) return;
  ({ base: state.archiveName, ext: state.ext } = splitArchiveName(f.name));
  markStart(`«${f.name}»`, f.size);
  state.injecting = true;
  progressScreen();
  const loader = $('inject-loader').checked;
  startWorker().postMessage({ type: 'open', zip: f, inject: { structures: injectStructures(), loader, icon: loader ? await packIcon() : null } });
});

function onInjected(data) {
  state.injecting = false;
  markDone();
  show('screen-files');
  const r = $('inject-result');
  r.hidden = false;
  r.replaceChildren(
    h('h3', {}, `Mundo listo con ${data.ids.length === 1 ? 'la estructura' : `las ${data.ids.length} estructuras`}`),
    h('p', {}, `Se han metido en «${data.worldName}»: ${data.ids.join(', ')}.`),
    ...(data.replaced.length
      ? [h('p', { class: 'danger small' }, `⚠ Ya había ${data.replaced.length === 1 ? 'una estructura' : 'estructuras'} con ese nombre en el mundo (${data.replaced.join(', ')}): se ${data.replaced.length === 1 ? 'reemplaza' : 'reemplazan'} por la nueva.`)]
      : []),
    ...(data.loader ? [h('p', { class: 'small muted' }, 'El mundo lleva el «Cargador de estructuras Hardlands» ya activado (paquete de comportamiento: los logros quedan desactivados en ese mundo).')] : []),
    ...downloadLinks(data, `${state.archiveName}-con-estructuras`, state.ext),
    ...commandsBlock(validStructures(), 'Al entrar en el mundo, escribe:', data.loader),
  );
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Mundo con las estructuras listo para descargar');
}

function injectFailed(message) {
  state.injecting = false;
  markDone();
  show(state.hasWorld ? 'screen-files' : 'screen-load');
  const r = $('inject-result');
  r.hidden = false;
  r.replaceChildren(h('strong', { class: 'danger' }, 'No se pudieron meter las estructuras: '), explainError(message));
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

renderInject();

(async () => {
  try {
    const res = await fetch(new URL('../data/names_es.json', import.meta.url));
    if (res.ok) state.names = await res.json();
  } catch {
    /* nombres en inglés */
  }
  checkPreviousCrash();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
