#!/usr/bin/env bash
# Compila cubiomes a WebAssembly (vendor/cubiomes.wasm).
#
# Necesita zig (p. ej. `pip install ziglang` y ZIG="python -m ziglang") y el
# código de cubiomes:  git clone https://github.com/Cubitect/cubiomes
#
#   tools/build-cubiomes.sh /ruta/a/cubiomes
set -euo pipefail
SRC="${1:?uso: tools/build-cubiomes.sh /ruta/a/cubiomes}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="${ZIG:-zig}"
$ZIG cc -target wasm32-wasi -O2 -flto -mexec-model=reactor \
  -fno-math-errno -I"$SRC" \
  "$HERE/cubiomes_wrapper.c" "$SRC/generator.c" "$SRC/biomenoise.c" "$SRC/biomes.c" "$SRC/layers.c" "$SRC/noise.c" \
  -Wl,--strip-all -o "$HERE/../vendor/cubiomes.wasm"
cp "$SRC/LICENSE" "$HERE/../vendor/cubiomes.LICENSE"
ls -la "$HERE/../vendor/cubiomes.wasm"
