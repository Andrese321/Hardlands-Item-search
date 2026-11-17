"""Genera un mundo Bedrock de prueba (tests/fixtures/test_world.mcworld).

Usa la LevelDB real de Mojang (paquete `amulet-leveldb`, que comprime con
zlib igual que el juego) para que el lector de la app se pruebe contra
ficheros auténticos (.ldb comprimidos, .log, MANIFEST, borrados...).

    uv venv -p 3.14 .venv && uv pip install -p .venv/bin/python amulet-leveldb
    .venv/bin/python tests/fixtures/generate_world.py

El NBT se escribe aquí con una implementación propia en Python,
independiente de la de JavaScript.
"""

import os
import random
import shutil
import struct
import sys
import tempfile
import zipfile

import leveldb

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "test_world.mcworld")

# --------------------------------------------------------------- NBT (LE)


class Byte(int): pass
class Short(int): pass
class Int(int): pass
class Long(int): pass
class Float(float): pass


def _name(s):
    b = s.encode("utf-8")
    return struct.pack("<H", len(b)) + b


def _type(v):
    if isinstance(v, Byte): return 1
    if isinstance(v, Short): return 2
    if isinstance(v, Long): return 4
    if isinstance(v, Float): return 5
    if isinstance(v, bool): return 1
    if isinstance(v, Int) or isinstance(v, int): return 3
    if isinstance(v, float): return 6
    if isinstance(v, str): return 8
    if isinstance(v, list): return 9
    if isinstance(v, dict): return 10
    raise TypeError(v)


def _payload(v):
    t = _type(v)
    if t == 1: return struct.pack("<b", int(v))
    if t == 2: return struct.pack("<h", v)
    if t == 3: return struct.pack("<i", v)
    if t == 4: return struct.pack("<q", v)
    if t == 5: return struct.pack("<f", v)
    if t == 6: return struct.pack("<d", v)
    if t == 8: return _name(v)
    if t == 9:
        it = _type(v[0]) if v else 0
        return bytes([it]) + struct.pack("<i", len(v)) + b"".join(_payload(x) for x in v)
    if t == 10:
        out = b""
        for k, x in v.items():
            out += bytes([_type(x)]) + _name(k) + _payload(x)
        return out + b"\x00"


def nbt(v):
    return b"\x0a" + _name("") + _payload(v)


def item(name, count=1, slot=0, damage=0, tag=None):
    d = {"Name": "minecraft:" + name, "Count": Byte(count), "Damage": Short(damage), "Slot": Byte(slot), "WasPickedUp": Byte(0)}
    if tag is not None:
        d["tag"] = tag
    return d


# --------------------------------------------------------------- claves


def chunk_key(cx, cz, dim, tag):
    k = struct.pack("<ii", cx, cz)
    if dim:
        k += struct.pack("<i", dim)
    return k + bytes([tag])


def block_entity(eid, x, y, z, items=None, **extra):
    d = {"id": eid, "x": Int(x), "y": Int(y), "z": Int(z), "isMovable": Byte(1)}
    if items is not None:
        d["Items"] = items
    d.update(extra)
    return d



# --------------------------------------------------------------- subchunks (terreno)
#
# Formato de Bedrock: [versión] [nº de capas] ([índice Y] en v9) capas...
# Cada capa: [bits << 1] palabras uint32 · [tamaño paleta] · paleta NBT.
# Orden de los bloques: XZY, índice = (x << 8) | (z << 4) | y.


def encode_layer(names):
    palette, index, ids = [], {}, []
    for n in names:
        if n not in index:
            index[n] = len(palette)
            palette.append(n)
        ids.append(index[n])
    bits = 0
    if len(palette) > 1:
        bits = next(b for b in (1, 2, 3, 4, 5, 6, 8, 16) if (1 << b) >= len(palette))
    out = bytes([bits << 1])
    if bits:
        per = 32 // bits
        words = [0] * ((4096 + per - 1) // per)
        for i, v in enumerate(ids):
            words[i // per] |= v << ((i % per) * bits)
        out += struct.pack("<%dI" % len(words), *words) + struct.pack("<i", len(palette))
    for n in palette:
        out += nbt({"name": "minecraft:" + n, "states": {}, "version": Int(18163713)})
    return out


def subchunk(block, version=8, yidx=0, water_layer=None):
    """block(x, y, z) -> nombre (sin «minecraft:»); y local 0..15."""
    layers = [encode_layer([block(x, y, z) for x in range(16) for z in range(16) for y in range(16)])]
    if water_layer:
        layers.append(encode_layer([water_layer(x, y, z) for x in range(16) for z in range(16) for y in range(16)]))
    head = bytes([version, len(layers)]) + (bytes([yidx & 0xFF]) if version == 9 else b"")
    return head + b"".join(layers)


def surface(wx, wz):
    """Altura del terreno de prueba en la zona con relieve (0 <= cx, cz < 4)."""
    return 66 + (wx * 3 + wz * 7) % 9 - (4 if wx < 16 and wz < 16 else 0)


def main():
    tmp = tempfile.mkdtemp()
    world = os.path.join(tmp, "world")
    os.makedirs(os.path.join(world, "db"))
    db = leveldb.LevelDB(os.path.join(world, "db"), create_if_missing=True)
    rnd = random.Random(1234)

    # Terreno del mundo normal: 40x40 chunks con un subchunk (y 64..79) de piedra
    # (paleta de un solo bloque) para que haya muchas claves y varios bloques comprimidos.
    stone_sub = subchunk(lambda x, y, z: "stone")
    for cx in range(-20, 20):
        for cz in range(-20, 20):
            if 0 <= cx < 4 and 0 <= cz < 4:
                continue
            db.put(chunk_key(cx, cz, 0, 0x2F) + b"\x04", stone_sub)

    # Zona con relieve (chunks 0..3): hierba sobre tierra, un lago en el chunk (0,0)
    # con kelp anegado, y un subchunk en versión 9 con índice negativo (y -64..-49).
    for cx in range(4):
        for cz in range(4):
            def block(x, y, z, cx=cx, cz=cz):
                wx, wz, wy = cx * 16 + x, cz * 16 + z, 64 + y
                h = surface(wx, wz)
                if cx == 0 and cz == 0 and 4 <= x < 12 and 4 <= z < 12:  # lago: fondo de arena a 66, agua hasta 74
                    if wy < 66:
                        return "dirt"
                    if wy == 66:
                        return "sand"
                    if wy <= 74:
                        return "kelp" if (x == 6 and z == 6 and wy <= 70) else "water"
                    return "air"
                if wy < h:
                    return "dirt"
                if wy == h:
                    return "grass_block"
                return "air"

            def water(x, y, z, cx=cx, cz=cz):
                return "water" if (cx == 0 and cz == 0 and x == 6 and z == 6 and 67 <= 64 + y <= 70) else "air"

            version = 9 if (cx + cz) % 2 else 8
            db.put(chunk_key(cx, cz, 0, 0x2F) + b"\x04", subchunk(block, version, 4, water if cx == 0 and cz == 0 else None))
            db.put(chunk_key(cx, cz, 0, 0x2F) + bytes([0xFC]), subchunk(lambda x, y, z: "bedrock" if y == 0 else "deepslate", 9, -4))
            db.put(chunk_key(cx, cz, 0, 0x2C), b"\x28")  # versión del chunk

    # Torre de lana roja en el chunk (1,1), que después se reemplaza por una versión más baja.
    db.put(chunk_key(1, 1, 0, 0x2F) + b"\x05", subchunk(lambda x, y, z: "red_wool" if (x == 8 and z == 8) else "air", 8, 5))

    # Nether: chunks (-8..-6, 11..13). Roca madre en y 0, lava hasta 31, suelo de
    # nylium carmesí a 40, aire hasta 99 y techo de netherrack de 100 a 127.
    def nether(cx, cz, idx):
        def block(x, y, z):
            wy = idx * 16 + y
            if wy == 0:
                return "bedrock"
            if wy <= 31:
                return "lava"
            if wy < 40:
                return "netherrack"
            if wy == 40:
                return "crimson_nylium"
            if x == 3 and z == 3 and wy <= 60:  # columna de basalto
                return "basalt"
            if wy < 100:
                return "air"
            return "netherrack"
        return subchunk(block, 8, idx)

    for cx in range(-8, -5):
        for cz in range(11, 14):
            for idx in range(8):
                db.put(chunk_key(cx, cz, 1, 0x2F) + bytes([idx]), nether(cx, cz, idx))
            db.put(chunk_key(cx, cz, 1, 0x2C), b"\x28")

    # Chunk (0,-1) en el mundo normal: un cofre y un barril en la misma clave.
    shulker_tag = {"Items": [item("netherite_ingot", 32, 0), item("diamond_block", 3, 1)]}
    sword_tag = {
        "ench": [{"id": Short(9), "lvl": Short(5)}, {"id": Short(26), "lvl": Short(1)}],
        "display": {"Name": "Excalibur"},
    }
    chest = block_entity("Chest", 10, 64, -5, [
        item("diamond", 5, 0),
        item("diamond_sword", 1, 1, tag=sword_tag),
        item("purple_shulker_box", 1, 2, tag=shulker_tag),
        item("diamond", 7, 3),
    ], CustomName="Cofre del tesoro")
    barrel = block_entity("Barrel", 12, 64, -3, [item("elytra", 1, 0)])
    loot = block_entity("Chest", 3, 50, -10, LootTable="loot_tables/chests/village/village_plains.json", LootTableSeed=Int(5))
    db.put(chunk_key(0, -1, 0, 0x31), nbt(chest) + nbt(barrel) + nbt(loot))

    # Nether: una tolva.
    db.put(chunk_key(-7, 12, 1, 0x31), nbt(block_entity("Hopper", -100, 40, 200, [item("gold_ingot", 10, 0)])))
    # End: un cofre.
    db.put(chunk_key(5, 5, 2, 0x31), nbt(block_entity("Chest", 88, 70, 90, [item("dragon_breath", 4, 0)])))

    # Cofre que se borra después (no debe aparecer) y otro que se sobrescribe.
    db.put(chunk_key(30, 30, 0, 0x31), nbt(block_entity("Chest", 480, 70, 480, [item("beacon", 1, 0)])))
    db.put(chunk_key(31, 31, 0, 0x31), nbt(block_entity("Chest", 496, 70, 496, [item("apple", 1, 0)])))

    # Entidades en formato antiguo (tag 0x32): vagoneta con cofre y aldeano con ofertas.
    minecart = {"identifier": "minecraft:chest_minecart", "Pos": [Float(1.5), Float(65.0), Float(-14.2)],
                "UniqueID": Long(-55), "ChestItems": [item("emerald", 3, 0)]}
    villager = {"identifier": "minecraft:villager_v2", "Pos": [Float(2.0), Float(65.0), Float(-14.0)], "UniqueID": Long(-56),
                "Offers": {"Recipes": [{"buyA": item("emerald", 1), "sell": item("diamond_pickaxe", 1)}]}}
    db.put(chunk_key(0, -1, 0, 0x32), nbt(minecart) + nbt(villager))

    # Primera compactación: lo anterior pasa a tablas .ldb.
    db.put(chunk_key(2, 2, 0, 0x2F) + b"\x05", subchunk(lambda x, y, z: "gold_block" if (x == 0 and z == 0) else "air", 8, 5))
    db.compact()

    # La torre del chunk (1,1) se reemplaza (versión más nueva): ahora llega a y 82.
    db.put(chunk_key(1, 1, 0, 0x2F) + b"\x05", subchunk(lambda x, y, z: "red_wool" if (x == 8 and z == 8 and y <= 2) else "air", 8, 5))

    # Borrado y sobrescritura (más recientes que la tabla).
    db.delete(chunk_key(30, 30, 0, 0x31))
    db.put(chunk_key(31, 31, 0, 0x31), nbt(block_entity("Chest", 496, 70, 496, [item("golden_apple", 2, 0)])))

    # Entidades modernas: actorprefix + digp.
    donkey_id = struct.pack("<q", 4294967297)
    drop_id = struct.pack("<q", 4294967298)
    donkey = {"identifier": "minecraft:donkey", "Pos": [Float(-95.5), Float(41.0), Float(205.5)], "UniqueID": Long(4294967297),
              "CustomName": "Burrito", "ChestItems": [item("diamond", 2, 0)]}
    dropped = {"identifier": "minecraft:item", "Pos": [Float(15.2), Float(63.0), Float(-7.9)], "UniqueID": Long(4294967298),
               "Item": item("totem_of_undying", 1)}
    db.put(b"actorprefix" + donkey_id, nbt(donkey))
    db.put(b"actorprefix" + drop_id, nbt(dropped))
    db.put(b"digp" + struct.pack("<iii", -6, 12, 1), donkey_id)
    db.put(b"digp" + struct.pack("<ii", 0, -1), drop_id)

    # Estructuras guardadas con un bloque de estructuras (mismo formato que .mcstructure).
    def structure(sx, sy, sz, palette, indices, origin, position_data=None):
        return {
            "format_version": Int(1),
            "size": [Int(sx), Int(sy), Int(sz)],
            "structure": {
                "block_indices": [[Int(i) for i in indices], [Int(-1)] * len(indices)],
                "entities": [],
                "palette": {"default": {
                    "block_palette": [{"name": n, "states": s, "version": Int(18163713)} for n, s in palette],
                    "block_position_data": position_data or {},
                }},
            },
            "structure_world_origin": [Int(origin[0]), Int(origin[1]), Int(origin[2])],
        }

    casa = structure(
        3, 2, 3,
        [("minecraft:stone", {}), ("minecraft:air", {}), ("minecraft:chest", {"minecraft:cardinal_direction": "north"})],
        [0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        (10, 64, -5),
        {"4": {"block_entity_data": block_entity("Chest", 11, 64, -4, [item("diamond", 9, 0)])}},
    )
    torre = structure(1, 4, 1, [("minecraft:oak_planks", {})], [0, 0, 0, 0], (0, 70, 0))
    db.put(b"structuretemplate_mystructure:casa", nbt(casa))
    db.put(b"structuretemplate_hardlands:torre", nbt(torre))

    # Jugadores.
    local = {
        "Pos": [Float(100.5), Float(65.62), Float(-40.5)], "DimensionId": Int(0),
        "Inventory": [item("diamond", 64, 0), item("torch", 30, 1)],
        "Armor": [item("diamond_chestplate", 1, 1)],
        "Offhand": [item("shield", 1, 0)],
        "EnderChestInventory": [item("light_blue_shulker_box", 1, 0, tag={"Items": [item("diamond", 20, 0)]})],
    }
    other = {
        "Pos": [Float(-50.5), Float(80.62), Float(300.5)], "DimensionId": Int(1),
        "Inventory": [item("elytra", 1, 0), item("netherite_sword", 1, 1, tag={"ench": [{"id": Short(9), "lvl": Short(4)}]})],
        "Armor": [], "EnderChestInventory": [],
    }
    db.put(b"~local_player", nbt(local))
    db.put(b"player_server_1b2c3d4e-0000-4000-8000-000000000001", nbt(other))
    db.put(b"player_9f8e7d6c", nbt({"MsaId": "9f8e7d6c", "SelfSignedId": "x", "ServerId": "player_server_1b2c3d4e-0000-4000-8000-000000000001"}))
    # Se cierra y se vuelve a abrir: lo anterior pasa a una tabla de nivel 0 y lo
    # siguiente queda en el registro (.log). Así hay tres fuentes con versiones distintas.
    db.close(compact=False)
    db = leveldb.LevelDB(os.path.join(world, "db"))
    db.delete(chunk_key(2, 2, 0, 0x2F) + b"\x05")  # el bloque de oro desaparece
    db.put(chunk_key(3, 3, 0, 0x2F) + b"\x05", subchunk(lambda x, y, z: "diamond_block" if (x == 15 and z == 15 and y == 0) else "air", 8, 5))
    db.close(compact=False)

    with open(os.path.join(world, "levelname.txt"), "w") as f:
        f.write("Mundo de prueba")
    # Un pack de comportamiento con una estructura dentro (como los que trae un mundo).
    pack = os.path.join(world, "behavior_packs", "Pack Hardlands", "structures")
    os.makedirs(pack)
    with open(os.path.join(pack, "puente.mcstructure"), "wb") as f:
        f.write(nbt(torre))
    with open(os.path.join(world, "behavior_packs", "Pack Hardlands", "manifest.json"), "w") as f:
        f.write('{"format_version": 2}')
    with open(os.path.join(world, "level.dat"), "wb") as f:
        body = nbt({"LevelName": "Mundo de prueba", "RandomSeed": Long(1722026622528246853),
                    "SpawnX": Int(-120), "SpawnY": Int(70), "SpawnZ": Int(48), "StorageVersion": Int(10)})
        f.write(struct.pack("<ii", 10, len(body)) + body)

    files = sorted(os.listdir(os.path.join(world, "db")))
    print("ficheros db:", files, file=sys.stderr)
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, names in os.walk(world):
            for n in names:
                p = os.path.join(root, n)
                z.write(p, os.path.relpath(p, world))
    shutil.rmtree(tmp)
    print("escrito", OUT, os.path.getsize(OUT), "bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
