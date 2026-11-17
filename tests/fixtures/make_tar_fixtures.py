"""Crea copias del mundo de prueba en .tar.gz y .tar, como las de un hosting.

    python3 tests/fixtures/make_tar_fixtures.py

- test_world.tar.gz: formato PAX, el mundo en «worlds/Hardlands/» y un
  server.properties fuera, más un fichero con una ruta de más de 100 letras.
- test_world_gnu.tar: formato GNU (nombres largos con «././@LongLink»), sin comprimir.
"""
import io
import os
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
LONG = "behavior_packs/" + "Pack con un nombre larguísimo para probar rutas de más de cien letras " * 2 + "/manifest.json"


def build(path, fmt, compress, prefix):
    src = zipfile.ZipFile(os.path.join(HERE, "test_world.mcworld"))
    mode = "w:gz" if compress else "w"
    with tarfile.open(path, mode, format=fmt) as tar:
        def add(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 1767225600
            tar.addfile(info, io.BytesIO(data))
        # carpetas (como hace tar), que el lector debe ignorar
        for d in sorted({prefix + n.rsplit("/", 1)[0] + "/" for n in src.namelist() if "/" in n}):
            info = tarfile.TarInfo(d.rstrip("/"))
            info.type = tarfile.DIRTYPE
            tar.addfile(info)
        for n in src.namelist():
            add(prefix + n, src.read(n))
        add(prefix + LONG, b'{"format_version": 2}')
        add("server.properties", b"level-name=Hardlands\n")


build(os.path.join(HERE, "test_world.tar.gz"), tarfile.PAX_FORMAT, True, "./worlds/Hardlands/")
build(os.path.join(HERE, "test_world_gnu.tar"), tarfile.GNU_FORMAT, False, "Hardlands/")
for f in ("test_world.tar.gz", "test_world_gnu.tar"):
    print(f, os.path.getsize(os.path.join(HERE, f)))
