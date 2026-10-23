/**
 * A small, dependency-free MessagePack codec (https://github.com/msgpack/msgpack/blob/master/spec.md) — just what the
 * SignalR MessagePack hub protocol needs (`msgpack-hub-protocol.ts`).
 *
 * Why in-repo: the console cannot add `@microsoft/signalr-protocol-msgpack` without a lockfile change, and the hub's
 * frames are plain maps / arrays / numbers / strings (the engine's `MdFrameDto` uses string keys). Decoding:
 * - integers of every width (uint64 / int64 become JS numbers — exact up to 2^53, which covers epoch ms);
 * - float32 / float64, str, bin (as Uint8Array), array, map (as a plain object; non-string keys are stringified);
 * - ext −1 (timestamp) as a `Date`; any other ext as `{ type, data }`.
 * Encoding writes the smallest representation of what JS gives it (numbers: an integer type when the value is a safe
 * integer, else float64).
 */

export class MsgPackError extends Error {}

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  if (textDecoder) return textDecoder.decode(bytes.subarray(start, end));
  // jsdom without TextDecoder (never in practice) — a plain UTF-8 walk.
  let out = '';
  let i = start;
  while (i < end) {
    const c = bytes[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0)
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp =
        ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

function utf8Encode(s: string): Uint8Array {
  if (textEncoder) return textEncoder.encode(s);
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

/** An ext value other than the timestamp. */
export interface MsgPackExt {
  type: number;
  data: Uint8Array;
}

/** Decodes MessagePack values one after another from a byte range. */
export class MsgPackReader {
  private readonly view: DataView;
  pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new MsgPackError('MessagePack: unexpected end of data.');
  }

  private u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  private u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  private u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  private u64(): number {
    this.need(8);
    const hi = this.view.getUint32(this.pos);
    const lo = this.view.getUint32(this.pos + 4);
    this.pos += 8;
    return hi * 4294967296 + lo;
  }
  private i64(): number {
    this.need(8);
    const hi = this.view.getInt32(this.pos);
    const lo = this.view.getUint32(this.pos + 4);
    this.pos += 8;
    return hi * 4294967296 + lo;
  }

  private str(n: number): string {
    this.need(n);
    const s = utf8Decode(this.bytes, this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  private bin(n: number): Uint8Array {
    this.need(n);
    const b = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  private array(n: number): unknown[] {
    const out = new Array<unknown>(n);
    for (let i = 0; i < n; i++) out[i] = this.read();
    return out;
  }

  private map(n: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const k = this.read();
      out[typeof k === 'string' ? k : String(k)] = this.read();
    }
    return out;
  }

  private ext(n: number): unknown {
    const type = (this.u8() << 24) >> 24;
    const data = this.bin(n);
    if (type === -1) return timestampOf(data);
    return { type, data } satisfies MsgPackExt;
  }

  /** The next value. */
  read(): unknown {
    const b = this.u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return this.map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return this.array(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return this.str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bin(this.u8());
      case 0xc5:
        return this.bin(this.u16());
      case 0xc6:
        return this.bin(this.u32());
      case 0xc7:
        return this.ext(this.u8());
      case 0xc8:
        return this.ext(this.u16());
      case 0xc9:
        return this.ext(this.u32());
      case 0xca: {
        this.need(4);
        const v = this.view.getFloat32(this.pos);
        this.pos += 4;
        return v;
      }
      case 0xcb: {
        this.need(8);
        const v = this.view.getFloat64(this.pos);
        this.pos += 8;
        return v;
      }
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return this.u64();
      case 0xd0:
        return (this.u8() << 24) >> 24;
      case 0xd1:
        return (this.u16() << 16) >> 16;
      case 0xd2:
        return this.u32() | 0;
      case 0xd3:
        return this.i64();
      case 0xd4:
        return this.ext(1);
      case 0xd5:
        return this.ext(2);
      case 0xd6:
        return this.ext(4);
      case 0xd7:
        return this.ext(8);
      case 0xd8:
        return this.ext(16);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
      default:
        throw new MsgPackError(`MessagePack: unknown type byte 0x${b.toString(16)}.`);
    }
  }
}

/** The MessagePack timestamp extension (−1): 32-, 64- or 96-bit. */
function timestampOf(d: Uint8Array): Date {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length === 4) return new Date(v.getUint32(0) * 1000);
  if (d.length === 8) {
    const hi = v.getUint32(0);
    const lo = v.getUint32(4);
    const nanos = hi >>> 2;
    const seconds = (hi & 0x3) * 4294967296 + lo;
    return new Date(seconds * 1000 + nanos / 1e6);
  }
  if (d.length === 12) {
    const nanos = v.getUint32(0);
    const seconds = v.getInt32(4) * 4294967296 + v.getUint32(8);
    return new Date(seconds * 1000 + nanos / 1e6);
  }
  throw new MsgPackError('MessagePack: bad timestamp length.');
}

/** One value from a whole buffer. */
export function msgpackDecode(bytes: Uint8Array): unknown {
  return new MsgPackReader(bytes).read();
}

/** A growable byte sink. */
class Sink {
  buf = new Uint8Array(256);
  view = new DataView(this.buf.buffer);
  len = 0;

  ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.len, v);
    this.len += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, v);
    this.len += 4;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

function writeValue(s: Sink, v: unknown): void {
  if (v === null || v === undefined) return s.u8(0xc0);
  if (v === false) return s.u8(0xc2);
  if (v === true) return s.u8(0xc3);
  if (typeof v === 'number') return writeNumber(s, v);
  if (typeof v === 'string') {
    const b = utf8Encode(v);
    if (b.length < 32) s.u8(0xa0 | b.length);
    else if (b.length < 0x100) {
      s.u8(0xd9);
      s.u8(b.length);
    } else if (b.length < 0x10000) {
      s.u8(0xda);
      s.u16(b.length);
    } else {
      s.u8(0xdb);
      s.u32(b.length);
    }
    return s.bytes(b);
  }
  if (v instanceof Uint8Array) {
    if (v.length < 0x100) {
      s.u8(0xc4);
      s.u8(v.length);
    } else if (v.length < 0x10000) {
      s.u8(0xc5);
      s.u16(v.length);
    } else {
      s.u8(0xc6);
      s.u32(v.length);
    }
    return s.bytes(v);
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const arr = v as ArrayLike<unknown>;
    const n = arr.length;
    if (n < 16) s.u8(0x90 | n);
    else if (n < 0x10000) {
      s.u8(0xdc);
      s.u16(n);
    } else {
      s.u8(0xdd);
      s.u32(n);
    }
    for (let i = 0; i < n; i++) writeValue(s, arr[i]);
    return;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    const n = entries.length;
    if (n < 16) s.u8(0x80 | n);
    else if (n < 0x10000) {
      s.u8(0xde);
      s.u16(n);
    } else {
      s.u8(0xdf);
      s.u32(n);
    }
    for (const [k, x] of entries) {
      writeValue(s, k);
      writeValue(s, x);
    }
    return;
  }
  throw new MsgPackError(`MessagePack: cannot encode a ${typeof v}.`);
}

function writeNumber(s: Sink, v: number): void {
  if (Number.isSafeInteger(v)) {
    if (v >= 0) {
      if (v < 0x80) return s.u8(v);
      if (v < 0x100) {
        s.u8(0xcc);
        return s.u8(v);
      }
      if (v < 0x10000) {
        s.u8(0xcd);
        return s.u16(v);
      }
      if (v < 0x100000000) {
        s.u8(0xce);
        return s.u32(v);
      }
      s.u8(0xcf);
      s.u32(Math.floor(v / 4294967296));
      return s.u32(v >>> 0);
    }
    if (v >= -32) return s.u8(v & 0xff);
    if (v >= -128) {
      s.u8(0xd0);
      return s.u8(v & 0xff);
    }
    if (v >= -32768) {
      s.u8(0xd1);
      return s.u16(v & 0xffff);
    }
    if (v >= -2147483648) {
      s.u8(0xd2);
      return s.u32(v >>> 0);
    }
    s.u8(0xd3);
    const hi = Math.floor(v / 4294967296);
    s.u32(hi >>> 0);
    return s.u32((v - hi * 4294967296) >>> 0);
  }
  s.u8(0xcb);
  s.ensure(8);
  s.view.setFloat64(s.len, v);
  s.len += 8;
}

/** One value as MessagePack bytes. */
export function msgpackEncode(v: unknown): Uint8Array {
  const s = new Sink();
  writeValue(s, v);
  return s.buf.slice(0, s.len);
}
