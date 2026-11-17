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

## Borrar chunks (`chunks.html`)

Segunda herramienta, en la pestaña **Borrar chunks**: elimina zonas del mundo para que
Minecraft las **vuelva a generar** desde la semilla (terreno, estructuras y minerales nuevos).

- Hay un mapa de los chunks generados donde los que tienen cofres con objetos salen en otro color y también aparecen los jugadores. Se mueve con el dedo, se hace zoom con dos dedos y se marca una zona tocando dos esquinas.
- Las zonas también se pueden escribir: rectángulo (X1 Z1 X2 Z2) o punto y radio.
- Hay dos modos: **borrar lo de dentro** de las zonas, o **borrar todo lo de fuera** (para reiniciar el mapa conservando las bases).
- Antes de crear el archivo avisa de cuántos chunks, contenedores y objetos se perderán.
- Borra todo lo del chunk: terreno, cofres, entidades (animales, objetos tirados…) y datos auxiliares.
- **Nunca modifica el archivo original.** Crea uno nuevo (`<nombre>-chunks-borrados.mcworld/.zip`) con los mismos ficheros más un registro de borrado de LevelDB (`db/NNNNNN.log`). Al abrir el mundo, Minecraft aplica los borrados.

Uso con un servidor: **apágalo** (los chunks cargados en un servidor encendido se volverían
a guardar), descarga el mundo, edítalo aquí y súbelo como copia de seguridad a restaurar.
En un Realm: abre el .mcworld con Minecraft y usa *Reemplazar mundo* en los ajustes del Realm.

## Archivos y estructuras (`files.html`)

Tercera herramienta, en la pestaña **Archivos**:

- **Estructuras:** saca como archivos `.mcstructure` las estructuras guardadas con un bloque de
  estructuras (modo «Guardar») o con `/structure save`. Minecraft las guarda dentro de la base
  de datos del mundo y en el móvil no se pueden exportar. Para cada una muestra el tamaño, los
  bloques principales y desde dónde se guardó. Se descargan una a una o todas en un .zip.
  También lista los `.mcstructure` que haya dentro de los packs del mundo.
- **Borrar estructuras:** marca una, varias o todas y crea una **copia del mundo** sin ellas
  (el original no se toca). Las guardadas en el mundo se borran con un registro de borrado de
  LevelDB, igual que «Borrar chunks»; las de los packs se quitan de la copia. Las construcciones
  ya puestas en el mapa no cambian: solo se borra la plantilla guardada.
- **Todos los archivos:** explorador de carpetas del mundo (o de cualquier .zip/.mcpack/.mcaddon)
  para descargar cualquier archivo suelto.

El mundo original nunca se modifica.

## Estructuras por semilla (`seed.html`)

Cuarta herramienta, en la pestaña **Semilla**: dada una semilla, busca **dos estructuras que estén
a pocos chunks una de otra** (de 1 a 10), por ejemplo un monumento oceánico junto a un puesto de
saqueadores, o un monumento doble. También puede listar un solo tipo de estructura.

- No necesita el archivo del mundo. La semilla se escribe, o se lee de un mundo (`level.dat`),
  y el punto de aparición se puede usar como centro de la búsqueda.
- Estructuras: monumento oceánico, puesto de saqueadores, aldea, mansión, templo del desierto,
  templo de la jungla, cabaña de bruja e iglú.
- Radio de búsqueda de 5 000 a 1 000 000 de bloques. Hay combinaciones muy raras: un monumento
  a menos de 10 chunks de un puesto de saqueadores suele estar a cientos de miles de bloques.
- Cada resultado da las coordenadas, el bioma y botones para copiar coordenadas o `/tp`.

Cómo se calcula:

- **Posiciones:** con el algoritmo de Bedrock (regiones + Mersenne Twister), en `js/seedfinder.js`.
  Referencias: [bedrockified](https://github.com/Earthcomputer/bedrockified) y
  [MCBEStructureFinder](https://github.com/hhhxiao/MCBEStructureFinder).
- **Biomas:** con [cubiomes](https://github.com/Cubitect/cubiomes) (MIT) compilado a WebAssembly
  (`vendor/cubiomes.wasm`; se regenera con `tools/build-cubiomes.sh`). Desde 1.18 los biomas
  son iguales en Bedrock y Java.
- **Comprobado** con posiciones publicadas de semillas de Bedrock 1.21 (monumentos, puestos de
  saqueadores, una aldea y una cabaña de bruja): están en `tests/seedfinder.test.js`. Las mansiones
  no están comprobadas con datos reales.
- Vale para terreno generado en 1.18 o posterior, y es una predicción: el juego puede no generar
  alguna estructura por el terreno.

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
chunks.html             herramienta de borrar chunks
js/chunks.js            análisis de chunks y creación del registro de borrado
js/chunks-app.js        interfaz y mapa de la herramienta de chunks
js/chunks-worker.js     trabajo pesado de la herramienta de chunks
files.html              explorador de archivos y estructuras
js/files.js             extracción de estructuras (.mcstructure) y árbol de archivos
js/files-app.js         interfaz del explorador
js/files-worker.js      trabajo pesado del explorador
js/edit.js              copia del mundo con borrados (lo usan chunks y estructuras)
seed.html               buscador de estructuras por semilla
js/seedfinder.js        posiciones de estructuras de Bedrock y búsqueda de parejas
js/seed-app.js          interfaz del buscador por semilla
js/seed-worker.js       trabajo pesado del buscador por semilla y lectura de level.dat
vendor/cubiomes.wasm    generador de biomas (cubiomes, MIT)
tools/                  envoltorio en C y script para recompilar cubiomes.wasm
data/names_es.json      nombres en español (sacados de los textos oficiales de Bedrock)
vendor/fflate.js        descompresión (fflate 0.8.3, MIT)
```

Pruebas: `npm test` (necesita Node 18+). Usan `tests/fixtures/test_world.mcworld`, un mundo
generado con la LevelDB real de Mojang mediante `tests/fixtures/generate_world.py`.
Las pruebas de chunks dejan los mundos editados en `.test-output/`; para comprobarlos con la
LevelDB real de Mojang:

```
uv venv -p 3.14 .venv && uv pip install -p .venv/bin/python amulet-leveldb
.venv/bin/python tests/fixtures/verify_with_leveldb.py tests/fixtures/test_world.mcworld .test-output/edited.mcworld
```
