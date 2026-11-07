// Lector de NBT "little-endian", el formato que usa Minecraft Bedrock
// para guardar cofres, entidades y jugadores dentro de la base de datos.
//
// Devuelve objetos JS normales:
//   compound -> objeto, list -> array, long -> BigInt, arrays -> arrays numéricos.

const decoder = new TextDecoder('utf-8');

export class NbtReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  get remaining() {
    return this.bytes.length - this.pos;
  }

  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  string() {
    const len = this.u16();
    if (this.pos + len > this.bytes.length) throw new Error('NBT: cadena fuera de rango');
    const s = decoder.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  count() {
    const n = this.i32();
    if (n < 0) return 0;
    if (n > this.remaining) throw new Error('NBT: tamaño de lista no válido');
    return n;
  }

  payload(type, depth) {
    if (depth > 512) throw new Error('NBT: anidamiento demasiado profundo');
    switch (type) {
      case 1: return this.i8();
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: return this.i64();
      case 5: return this.f32();
      case 6: return this.f64();
      case 7: {
        const n = this.count();
        const out = this.bytes.slice(this.pos, this.pos + n);
        this.pos += n;
        return Array.from(out, (b) => (b << 24) >> 24);
      }
      case 8: return this.string();
      case 9: {
        const itemType = this.u8();
        const n = this.count();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.payload(itemType, depth + 1);
        return out;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = this.u8();
          if (t === 0) break;
          const name = this.string();
          obj[name] = this.payload(t, depth + 1);
        }
        return obj;
      }
      case 11: {
        const n = this.count();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i32();
        return out;
      }
      case 12: {
        const n = this.count();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i64();
        return out;
      }
      default:
        throw new Error('NBT: tipo de etiqueta desconocido ' + type);
    }
  }

  // Lee una etiqueta raíz con nombre (normalmente un compound con nombre vacío).
  root() {
    const type = this.u8();
    if (type === 0) return null;
    this.string();
    return this.payload(type, 0);
  }
}

// Lee un único NBT raíz.
export function readNbt(bytes) {
  return new NbtReader(bytes).root();
}

// Lee varios NBT raíz seguidos (así guarda Bedrock los cofres de un chunk).
export function readNbtList(bytes) {
  const r = new NbtReader(bytes);
  const out = [];
  while (r.remaining > 0) {
    const v = r.root();
    if (v === null) break;
    out.push(v);
  }
  return out;
}
