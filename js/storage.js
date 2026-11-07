// Guarda el último mundo escaneado (IndexedDB) y los nombres que el usuario
// pone a los jugadores (localStorage). Todo queda en este dispositivo.

const DB_NAME = 'hardlands-item-search';
const STORE = 'worlds';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export function saveIndex(index) {
  return tx('readwrite', (s) => s.put(index, 'last'));
}

export async function loadIndex() {
  const index = await tx('readonly', (s) => s.get('last'));
  return index && index.version === 1 ? index : null;
}

const ALIAS_KEY = 'hardlands-aliases';

function readAliases() {
  try {
    return JSON.parse(localStorage.getItem(ALIAS_KEY)) || {};
  } catch {
    return {};
  }
}

export function getAliases(world) {
  return { ...(readAliases()[world] || {}) };
}

export function setAlias(world, playerId, name) {
  const all = readAliases();
  const w = { ...(all[world] || {}) };
  if (name) w[playerId] = name;
  else delete w[playerId];
  all[world] = w;
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(all));
  } catch {
    /* almacenamiento no disponible: el nombre dura hasta cerrar */
  }
  return w;
}
