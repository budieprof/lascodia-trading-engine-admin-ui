import { MessageType, NullLogger } from '@microsoft/signalr';

import { MsgPackReader, msgpackDecode, msgpackEncode } from './msgpack';
import { MessagePackHubProtocol, binaryFrames, frame } from './msgpack-hub-protocol';

describe('msgpack codec', () => {
  it('round-trips every value shape the hub uses', () => {
    const value = {
      symbol: 'EURUSD',
      sourceId: 'mt5-metaquotes-demo',
      ticks: {
        t: [1792771523554, 1792771523600],
        b: [1.11996, 1.11997],
        a: [1.11997, 1.11998],
        f: [6, 2],
        v: [0, 0],
      },
      book: [{ t: 1792771523554, k: 'S', b: [[1.11996, 2200000]], a: [[1.11997, 2000000]] }],
      neg: [-1, -31, -32, -33, -128, -129, -40000, -3000000000],
      big: [127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER],
      flags: [true, false, null],
      long: 'x'.repeat(40),
      longer: 'é'.repeat(300),
      many: Array.from({ length: 20 }, (_, i) => i / 3),
    };
    expect(msgpackDecode(msgpackEncode(value))).toEqual(value);
  });

  it('reads the encodings MessagePack-CSharp writes (uint64 epoch ms, float64, str8, array16, int types)', () => {
    // { "t": uint64 1792771523554, "p": float64 1.11996, "s": str8 "B" … } hand-built as the server writes it.
    const bytes: number[] = [0x83, 0xa1, 0x74, 0xcf];
    const ms = 1792771523554;
    const hi = Math.floor(ms / 2 ** 32);
    const lo = ms >>> 0;
    bytes.push(
      (hi >>> 24) & 255,
      (hi >>> 16) & 255,
      (hi >>> 8) & 255,
      hi & 255,
      (lo >>> 24) & 255,
      (lo >>> 16) & 255,
      (lo >>> 8) & 255,
      lo & 255,
    );
    bytes.push(0xa1, 0x70, 0xcb);
    const f = new DataView(new ArrayBuffer(8));
    f.setFloat64(0, 1.11996);
    for (let i = 0; i < 8; i++) bytes.push(f.getUint8(i));
    bytes.push(0xa1, 0x73, 0xd9, 1, 0x42);
    expect(msgpackDecode(Uint8Array.from(bytes))).toEqual({ t: ms, p: 1.11996, s: 'B' });
    // int8 / int16 / int32 / int64 / float32 / array16 / map16
    expect(msgpackDecode(Uint8Array.from([0xd0, 0x80]))).toBe(-128);
    expect(msgpackDecode(Uint8Array.from([0xd1, 0x80, 0x00]))).toBe(-32768);
    expect(msgpackDecode(Uint8Array.from([0xd2, 0xff, 0xff, 0xff, 0xfe]))).toBe(-2);
    expect(
      msgpackDecode(Uint8Array.from([0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfd])),
    ).toBe(-3);
    expect(msgpackDecode(Uint8Array.from([0xca, 0x3f, 0xc0, 0x00, 0x00]))).toBe(1.5);
    expect(msgpackDecode(Uint8Array.from([0xdc, 0x00, 0x02, 0x01, 0x02]))).toEqual([1, 2]);
    expect(msgpackDecode(Uint8Array.from([0xde, 0x00, 0x01, 0xa1, 0x61, 0x07]))).toEqual({ a: 7 });
  });

  it('decodes the timestamp extension as a Date and other extensions raw', () => {
    expect(msgpackDecode(Uint8Array.from([0xd6, 0xff, 0x00, 0x00, 0x00, 0x3c]))).toEqual(
      new Date(60_000),
    );
    expect(msgpackDecode(Uint8Array.from([0xd4, 0x05, 0x09]))).toEqual({
      type: 5,
      data: Uint8Array.from([9]),
    });
  });

  it('refuses truncated data', () => {
    expect(() => new MsgPackReader(Uint8Array.from([0xcd, 0x01])).read()).toThrow(/unexpected end/);
  });
});

describe('MessagePackHubProtocol', () => {
  const protocol = new MessagePackHubProtocol();

  it('names itself as ASP.NET Core expects', () => {
    expect(protocol.name).toBe('messagepack');
    expect(protocol.version).toBe(2);
  });

  it('frames with a VarInt length prefix and splits several messages', () => {
    const big = new Uint8Array(300).fill(1);
    const a = new Uint8Array(frame(big));
    expect([a[0], a[1]]).toEqual([0xac, 0x02]); // 300 = 0b10_0101100
    const b = new Uint8Array(frame(Uint8Array.from([0x90])));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    expect(binaryFrames(joined)).toEqual([
      [2, 302],
      [303, 304],
    ]);
  });

  it('parses an md invocation, a completion with a result, a void completion, a ping and a close', () => {
    const md = {
      symbol: 'EURUSD',
      sourceId: 'mt5-x',
      book: [{ t: 1, k: 'D', b: [[1.1, 0]], a: [] }],
    };
    const parts = [
      msgpackEncode([MessageType.Invocation, {}, null, 'md', [md]]),
      msgpackEncode([MessageType.Completion, {}, '1', 3, { ok: true, denied: [] }]),
      msgpackEncode([MessageType.Completion, {}, '2', 2]),
      msgpackEncode([MessageType.Completion, {}, '3', 1, 'boom']),
      msgpackEncode([MessageType.Ping]),
      msgpackEncode([MessageType.Close, null, true]),
    ].map((p) => new Uint8Array(frame(p)));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const msgs = protocol.parseMessages(all.buffer, NullLogger.instance);
    expect(msgs).toHaveLength(6);
    expect(msgs[0]).toMatchObject({ type: MessageType.Invocation, target: 'md', arguments: [md] });
    expect((msgs[0] as { invocationId?: string }).invocationId).toBeUndefined();
    expect(msgs[1]).toMatchObject({
      type: MessageType.Completion,
      invocationId: '1',
      result: { ok: true, denied: [] },
    });
    expect(msgs[2]).toEqual({ type: MessageType.Completion, headers: {}, invocationId: '2' });
    expect(msgs[3]).toMatchObject({ error: 'boom' });
    expect(msgs[4]).toEqual({ type: MessageType.Ping });
    expect(msgs[5]).toEqual({ type: MessageType.Close, error: undefined, allowReconnect: true });
  });

  it('writes invocations and pings the way the server reads them', () => {
    const out = new Uint8Array(
      protocol.writeMessage({
        type: MessageType.Invocation,
        invocationId: '7',
        target: 'Subscribe',
        arguments: ['EURUSD', null, ['book', 'ticks']],
        streamIds: [],
      }),
    );
    const [[s, e]] = binaryFrames(out);
    expect(new MsgPackReader(out, s, e).read()).toEqual([
      1,
      {},
      '7',
      'Subscribe',
      ['EURUSD', null, ['book', 'ticks']],
      [],
    ]);
    const ping = new Uint8Array(protocol.writeMessage({ type: MessageType.Ping }));
    expect([...ping]).toEqual([2, 0x91, 6]);
  });
});
