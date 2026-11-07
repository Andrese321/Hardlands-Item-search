# Hardlands · Buscador de objetos

Aplicación web (funciona en **móvil y PC**, se puede instalar como app) para
encontrar objetos en un mundo de **Minecraft Bedrock**: escribes el nombre del
objeto y te dice **dónde está** (coordenadas y dimensión) o **qué jugador lo tiene**.

- Busca en español o en inglés, con nombre exacto **o parecido** (tolera tildes y faltas: «netherita» → *Lingote de inframundita*).
- También encuentra objetos por **nombre personalizado** (yunque) y por **encantamiento** («filo», «reparación»…).
- Mira dentro de **todos los contenedores**: cofres, barriles, cajas de shulker, tolvas, hornos, dispensadores, soltadores, soportes de pociones, marcos, atriles, vasijas, librerías…
- Mira dentro de los **objetos que contienen objetos**: una caja de shulker dentro de un cofre, por ejemplo.
- **Jugadores:** inventario, armadura, mano secundaria y cofre de Ender, también de jugadores desconectados.
- **Entidades:** objetos tirados en el suelo, vagonetas con cofre, burros/llamas con cofre, soportes de armadura, mobs con objetos…
- Tiene botones para copiar las coordenadas o el comando `/tp`, incluido el del Nether y el End.
- Filtros por tipo (contenedores / jugadores / entidades), por dimensión y por jugador.

## Privacidad y seguridad

El mundo se lee **solo en tu dispositivo** (en el navegador). No se sube a ningún servidor
y el archivo **nunca se modifica**. El último mundo escaneado se guarda en el propio
dispositivo para no tener que volver a abrirlo.

## Cómo se usa

1. Consigue el archivo del mundo:
   - **Servidor dedicado (BDS):** la carpeta `worlds/<mundo>`, comprimida en .zip.
   - **Hosting:** descarga una copia de seguridad del mundo (el .zip sirve tal cual).
   - **Realm:** *Descargar mundo* en los ajustes del Realm y luego *Exportar mundo* (.mcworld).
   - **Mundo local:** *Editar mundo → Exportar mundo* (.mcworld).
2. Abre la app y pulsa **Abrir archivo .mcworld o .zip** (en PC también puedes abrir la carpeta).
3. Escribe el nombre del objeto.

> Haz la copia con el servidor apagado, o después de `save hold` / `save query`
> (y luego `save resume`), para que los datos estén al día.

## Limitaciones

- **Nombres de jugadores:** Bedrock no guarda el gamertag dentro del mundo, solo un
  identificador. En la pestaña *Jugadores* puedes ponerle nombre a cada uno (se recuerda
  en tu dispositivo). Su última posición ayuda a reconocerlo.
- **Cofres de botín sin abrir** (aldeas, templos…): su contenido no existe hasta que alguien
  los abre, así que no se puede encontrar. La app indica cuántos hay.
- Es una **foto del momento** en que se hizo la copia del mundo.

## Publicarla (para usarla desde el móvil)

Es una web estática, sin servidor ni compilación. La forma más sencilla:

1. En GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**,
   elige la rama y la carpeta `/ (root)`.
2. Abre la URL que te da GitHub (`https://<usuario>.github.io/<repo>/`) en el móvil.
3. Para instalarla, en Chrome usa *Menú → Añadir a pantalla de inicio*; en Safari, *Compartir → Añadir a inicio*.

GitHub Pages en repositorios privados requiere un plan de pago. Si el tuyo es privado,
puedes hacerlo público o usar otro hosting estático (Netlify, Cloudflare Pages…).

Para probarla en el ordenador: `npm start` y abre <http://localhost:8080>.

## Desarrollo

```
index.html, css/        interfaz
js/app.js               lógica de la interfaz
js/worker.js            lectura del mundo en segundo plano
js/zip.js               lector de .zip/.mcworld (bajo demanda, sin cargarlo entero)
js/leveldb.js           lector de la LevelDB de Mojang (zlib/raw, .ldb, .log, MANIFEST)
js/nbt.js               lector de NBT little-endian
js/world.js             extracción de objetos (contenedores, entidades, jugadores)
js/search.js            búsqueda exacta/parecida, nombres y encantamientos
data/names_es.json      nombres en español (sacados de los textos oficiales de Bedrock)
vendor/fflate.js        descompresión (fflate 0.8.3, MIT)
```

Pruebas: `npm test` (necesita Node 18+). Usan `tests/fixtures/test_world.mcworld`, un mundo
generado con la LevelDB real de Mojang mediante `tests/fixtures/generate_world.py`.
