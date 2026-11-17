// Envoltorio mínimo de cubiomes (https://github.com/Cubitect/cubiomes, MIT)
// para usarlo desde JavaScript como WebAssembly. Solo expone lo necesario
// para saber qué bioma hay en un punto del mundo normal (1.18+).
//
// Desde 1.18 los biomas de Bedrock y Java se generan igual con la misma
// semilla; lo que cambia entre ediciones es la posición de las estructuras,
// que se calcula en JavaScript (js/seedfinder.js).

#include "generator.h"

static Generator g;

__attribute__((export_name("seed_init")))
void seed_init(uint32_t lo, uint32_t hi)
{
    uint64_t seed = ((uint64_t)hi << 32) | (uint64_t)lo;
    setupGenerator(&g, MC_NEWEST, 0);
    applySeed(&g, DIM_OVERWORLD, seed);
}

// Bioma en coordenadas de bloque (x, z), muestreado como hace el juego para
// las estructuras: resolución de 4 bloques, a una altura por encima del
// terreno (así nunca devuelve biomas de cueva).
__attribute__((export_name("biome_at")))
int biome_at(int x, int z)
{
    return getBiomeAt(&g, 4, x >> 2, 319 >> 2, z >> 2);
}

// 1 si todos los puntos (cada 4 bloques) del cuadrado de radio r alrededor de
// (x, z) tienen un bioma permitido. `mask` es un mapa de 256 bytes (id -> 0/1).
static unsigned char mask[256];

__attribute__((export_name("mask_ptr")))
unsigned char *mask_ptr(void) { return mask; }

__attribute__((export_name("area_only")))
int area_only(int x, int z, int r)
{
    int x0 = (x - r) >> 2, x1 = (x + r) >> 2;
    int z0 = (z - r) >> 2, z1 = (z + r) >> 2;
    for (int j = z0; j <= z1; j++)
        for (int i = x0; i <= x1; i++) {
            int id = getBiomeAt(&g, 4, i, 319 >> 2, j);
            if (id < 0 || id > 255 || !mask[id]) return 0;
        }
    return 1;
}
