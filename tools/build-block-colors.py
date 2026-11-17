"""Genera data/block_colors.json: el color de cada bloque visto desde arriba.

El color es la media de la textura de la cara superior del bloque en el
resource pack oficial de Bedrock (github.com/Mojang/bedrock-samples). Las
texturas en gris que el juego tiñe según el bioma (hierba, hojas, agua...) se
tiñen con los colores de la llanura.

    git clone --filter=blob:none --sparse https://github.com/Mojang/bedrock-samples
    cd bedrock-samples && git sparse-checkout set --no-cone /resource_pack/blocks.json \\
        /resource_pack/textures/terrain_texture.json '/resource_pack/textures/blocks/'
    python3 tools/build-block-colors.py /ruta/a/bedrock-samples /ruta/a/mojang-blocks.json

mojang-blocks.json (opcional) es metadata/vanilladata_modules/mojang-blocks.json del
mismo repositorio; sirve para comprobar que no falta ningún bloque.
"""

import colorsys
import json
import os
import re
import sys

from PIL import Image

ROOT = sys.argv[1]
RP = os.path.join(ROOT, "resource_pack")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "block_colors.json")


def load(path):
    text = open(path, encoding="utf-8-sig").read()
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return json.loads(text)


blocks = load(os.path.join(RP, "blocks.json"))
terrain = load(os.path.join(RP, "textures", "terrain_texture.json"))["texture_data"]

GRASS = (0x91, 0xBD, 0x59)
FOLIAGE = (0x77, 0xAB, 0x2F)
BIRCH = (0x80, 0xA7, 0x55)
SPRUCE = (0x61, 0x99, 0x61)
WATER = (0x3A, 0x7B, 0xD5)

cache = {}


def mean_color(path):
    if path in cache:
        return cache[path]
    for ext in (".png", ".tga"):
        p = os.path.join(RP, path + ext)
        if os.path.exists(p):
            break
    else:
        cache[path] = None
        return None
    im = Image.open(p).convert("RGBA")
    w, h = im.size
    im = im.crop((0, 0, w, min(h, w)))  # texturas animadas: solo el primer fotograma
    r = g = b = n = 0
    for pr, pg, pb, pa in list(im.getdata()):
        if pa < 128:
            continue
        r += pr
        g += pg
        b += pb
        n += 1
    cache[path] = (r / n, g / n, b / n, n / (im.size[0] * im.size[1])) if n else None
    return cache[path]


def texture_path(key):
    t = terrain.get(key)
    if not t:
        return None
    tex = t.get("textures")
    while isinstance(tex, list):
        tex = tex[0]
    if isinstance(tex, dict):
        tex = tex.get("path")
    return tex


def top_key(textures):
    if isinstance(textures, str):
        return textures
    if isinstance(textures, dict):
        for k in ("up", "side", "north", "east", "down"):
            if k in textures:
                return textures[k]
        return next(iter(textures.values()))
    return None


def tint_for(name):
    if "water" in name or name in ("bubble_column",):
        return WATER
    if "birch_leaves" in name:
        return BIRCH
    if "spruce_leaves" in name:
        return SPRUCE
    if any(k in name for k in ("leaves", "vine", "waterlily", "lily_pad")):
        return FOLIAGE
    if any(k in name for k in ("grass", "fern", "tallgrass", "double_plant", "bush", "stem", "reeds")):
        return GRASS
    return None


colors = {}
for name, data in blocks.items():
    if name == "format_version" or not isinstance(data, dict):
        continue
    key = top_key(data.get("textures"))
    path = texture_path(key) if key else None
    c = mean_color(path) if path else None
    if not c:
        continue
    r, g, b, cover = c
    _, s, _ = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    tint = tint_for(name)
    if tint and s < 0.2:
        # se aclara un poco: en el mapa, la media de la textura teñida queda demasiado oscura
        r, g, b = (min(255, 1.25 * r * tint[0] / 255), min(255, 1.25 * g * tint[1] / 255), min(255, 1.25 * b * tint[2] / 255))
    colors["minecraft:" + name] = "%02x%02x%02x" % (round(r), round(g), round(b))

# Nombres modernos que el resource pack todavía guarda con el nombre antiguo.
ALIASES = {
    "grass_block": "grass",
    "short_grass": "tallgrass",
    "sea_lantern": "seaLantern",
    "iron_chain": "chain",
    "underwater_torch": "torch",
    "underwater_tnt": "tnt",
    "colored_torch_red": "torch",
    "colored_torch_green": "torch",
    "colored_torch_blue": "torch",
    "colored_torch_purple": "torch",
}
for n in list(blocks):
    if n.startswith("hard_"):
        ALIASES[n] = n[5:]
for new, old in ALIASES.items():
    if "minecraft:" + new not in colors and "minecraft:" + old in colors:
        colors["minecraft:" + new] = colors["minecraft:" + old]

# El agua se ve de un azul fijo (el color medio del agua teñida es demasiado claro en un mapa).
for n in ("water", "flowing_water"):
    colors["minecraft:" + n] = "%02x%02x%02x" % WATER

if len(sys.argv) > 2:
    names = [d["name"] for d in json.load(open(sys.argv[2]))["data_items"]]
    missing = [n for n in names if n not in colors]
    print("bloques sin color:", len(missing), "de", len(names), file=sys.stderr)
    print(missing[:80], file=sys.stderr)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(dict(sorted(colors.items())), f, separators=(",", ":"))
print("escrito", OUT, len(colors), "colores", file=sys.stderr)
