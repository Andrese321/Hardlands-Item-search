// Permite usar la app sin conexión una vez abierta (y que se pueda instalar).
const CACHE = 'hardlands-v6';
const FILES = [
  './', 'index.html', 'chunks.html', 'files.html', 'seed.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/worker.js', 'js/chunks.js', 'js/chunks-app.js', 'js/chunks-worker.js', 'js/files.js', 'js/files-app.js', 'js/files-worker.js', 'js/edit.js', 'js/version.js', 'js/seedfinder.js', 'js/seed-app.js', 'js/seed-worker.js', 'js/world.js', 'js/leveldb.js', 'js/nbt.js', 'js/zip.js', 'js/search.js', 'js/storage.js',
  'vendor/fflate.js', 'vendor/cubiomes.wasm', 'data/names_es.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero la red (para recibir actualizaciones). Si no hay conexión o la web
// responde con error (p. ej. 404), se usa la copia guardada.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: pregunta siempre al servidor si hay versión nueva (sin esperar a la caché del navegador)
    fetch(e.request, { cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) return (await caches.match(e.request, { ignoreSearch: true })) || res;
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(async (err) => {
        const cached = await caches.match(e.request, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }),
  );
});
