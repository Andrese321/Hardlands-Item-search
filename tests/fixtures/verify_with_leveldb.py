"""Verifica con la LevelDB real de Mojang (amulet-leveldb) un mundo editado por
la herramienta de borrar chunks. Uso:

    .venv/bin/python tests/fixtures/verify_with_leveldb.py original.mcworld editado.mcworld
"""
import os, shutil, struct, sys, tempfile, zipfile
import leveldb


def open_world(path, tmp):
    d = os.path.join(tmp, os.path.basename(path))
    with zipfile.ZipFile(path) as z:
        z.extractall(d)
    return d


def chunk_of(k):
    if len(k) in (9, 10, 13, 14) and (len(k) < 13 or struct.unpack_from("<i", k, 8)[0] in (1, 2)):
        tag = k[12] if len(k) >= 13 else k[8]
        if 43 <= tag <= 65 or tag == 118:
            dim = struct.unpack_from("<i", k, 8)[0] if len(k) >= 13 else 0
            return (dim,) + struct.unpack_from("<ii", k, 0)
    return None


def main(orig, edited, *expect):
    tmp = tempfile.mkdtemp()
    try:
        a = leveldb.LevelDB(os.path.join(open_world(orig, tmp), "db"))
        before = dict(a.iterate())
        a.close()
        db = leveldb.LevelDB(os.path.join(open_world(edited, tmp), "db"))
        after = dict(db.iterate())
        db.close(compact=True)  # como haría el juego: aplica y compacta
        db = leveldb.LevelDB(os.path.join(tmp, os.path.basename(edited), "db"))
        after2 = dict(db.iterate())
        db.close()
        assert after == after2, "los datos cambian tras compactar"
        removed = set(before) - set(after)
        assert not (set(after) - set(before)), "aparecieron claves nuevas"
        for k in after:
            assert after[k] == before[k], "valor modificado: %r" % k
        chunks = sorted({chunk_of(k) for k in removed if chunk_of(k)})
        others = sorted(k[:11].decode() if k.startswith(b"actorprefix") else k[:4].decode() for k in removed if not chunk_of(k))
        print("claves borradas:", len(removed), "| chunks:", len(chunks), chunks[:5], "| otras:", others)
        left = [k for k in after if chunk_of(k) in set(chunks)]
        assert not left, "quedan restos de chunks borrados"
        print("OK: la LevelDB de Mojang abre el mundo, aplica los borrados y el resto queda intacto")
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    main(*sys.argv[1:])
