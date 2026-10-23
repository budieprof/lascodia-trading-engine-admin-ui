import {
  MarketDataStreamCore,
  MD_FRAME_EVENT,
  type MdConnection,
  type MdProtocol,
  type MdStreamDeps,
} from './marketdata-stream';
import type { MdFrame, MdHistory, MdHistoryRequest } from './marketdata.types';
import { loadMdFixture } from './testing/md-fixture';

const fixture = loadMdFixture();

class FakeConnection implements MdConnection {
  handlers = new Map<string, (...args: unknown[]) => void>();
  calls: { method: string; args: unknown[] }[] = [];
  closeCb: ((e?: Error) => void) | null = null;
  stopped = false;
  constructor(readonly protocol: MdProtocol) {}
  on(event: string, h: (...args: unknown[]) => void): void {
    this.handlers.set(event, h);
  }
  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    this.calls.push({ method, args });
    if (method === 'Subscribe') {
      const [, sources, kinds] = args as [string, string[] | null, string[]];
      return {
        ok: true,
        denied: [],
        subscribed: (sources ?? ['src']).flatMap((s) => kinds.map((k) => `${s}:${k}`)),
      } as T;
    }
    return undefined as T;
  }
  onclose(cb: (e?: Error) => void): void {
    this.closeCb = cb;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  push(frame: MdFrame): void {
    this.handlers.get(MD_FRAME_EVENT)!(frame);
  }
}

function harness(
  opts: { refuseMsgpack?: boolean; history?: (r: MdHistoryRequest) => Promise<MdHistory> } = {},
) {
  let now = fixture.book[fixture.book.length - 1].t + 1_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const conns: FakeConnection[] = [];
  const historyCalls: MdHistoryRequest[] = [];
  const changed: string[] = [];
  const deps: MdStreamDeps = {
    connect: async (p) => {
      if (p === 'messagepack' && opts.refuseMsgpack) throw new Error('handshake refused');
      const c = new FakeConnection(p);
      conns.push(c);
      return c;
    },
    history: (r) => {
      historyCalls.push(r);
      return opts.history
        ? opts.history(r)
        : Promise.resolve({ sources: [], truncated: false, message: null });
    },
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    backoffMs: () => 1000,
    changed: (k) => changed.push(k),
    stateChanged: () => undefined,
  };
  const core = new MarketDataStreamCore(deps);
  return {
    core,
    conns,
    timers,
    historyCalls,
    changed,
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MarketDataStreamCore', () => {
  it('connects with MessagePack and subscribes the union of the watchers', async () => {
    const h = harness();
    h.core.watch({ symbol: 'eurusd', sources: ['a'], kinds: ['book'] });
    await flush();
    h.core.watch({ symbol: 'EURUSD', sources: ['b'], kinds: ['ticks'] });
    await flush();
    expect(h.conns).toHaveLength(1);
    expect(h.conns[0].protocol).toBe('messagepack');
    const subs = h.conns[0].calls.filter((c) => c.method === 'Subscribe');
    expect(subs[0].args).toEqual(['EURUSD', ['a'], ['book']]);
    expect(subs.at(-1)!.args).toEqual(['EURUSD', ['a', 'b'], ['book', 'ticks']]);
    expect(h.core.state).toBe('connected');
  });

  it('falls back to JSON when the MessagePack handshake is refused', async () => {
    const h = harness({ refuseMsgpack: true });
    h.core.watch({ symbol: 'EURUSD', kinds: ['book'] });
    await flush();
    expect(h.conns[0].protocol).toBe('json');
    expect(h.core.currentProtocol).toBe('json');
  });

  it('rebuilds the book from recorded frames and fans out to listeners', async () => {
    const h = harness();
    h.core.watch({ symbol: 'EURUSD', kinds: ['book', 'ticks'] });
    await flush();
    const seen: number[] = [];
    h.core.onBook('EURUSD', (_s, evs) => seen.push(evs.length));
    const c = h.conns[0];
    // As the hub coalesces: ~100 ms frames.
    for (let i = 0; i < fixture.book.length; i += 10)
      c.push({ symbol: 'EURUSD', sourceId: fixture.sourceId, book: fixture.book.slice(i, i + 10) });
    c.push({ symbol: 'EURUSD', sourceId: fixture.sourceId, ticks: fixture.ticks });
    const s = h.core.stream('EURUSD', fixture.sourceId)!;
    expect(s.book.known).toBe(true);
    expect(s.bookEvents).toBe(fixture.book.length);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(fixture.book.length);
    expect(s.ticks.size).toBe(fixture.ticks.t.length);
    expect(s.book.bestBid()!).toBeLessThan(s.book.bestAsk()!);
    expect(h.changed).toContain('EURUSD');
  });

  it('asks md/history for a keyframe when a delta arrives with no book under it', async () => {
    const kfBook = fixture.book[0];
    const h = harness({
      history: async (r) => ({
        sources: [
          {
            sourceId: r.sourceIds![0],
            keyframe: { t: r.from, b: kfBook.b, a: kfBook.a },
            book: [],
          },
        ],
        truncated: false,
        message: null,
      }),
    });
    h.core.watch({ symbol: 'EURUSD', kinds: ['book'] });
    await flush();
    const resets: boolean[] = [];
    h.core.onBook('EURUSD', (_s, _e, reset) => resets.push(reset));
    h.conns[0].push({ symbol: 'EURUSD', sourceId: 'src', book: [fixture.book[1]] }); // a D first
    expect(h.historyCalls).toHaveLength(1);
    expect(h.historyCalls[0]).toMatchObject({
      symbol: 'EURUSD',
      sourceIds: ['src'],
      kinds: ['book'],
    });
    // A second orphan within the retry window does not ask again.
    h.conns[0].push({ symbol: 'EURUSD', sourceId: 'src', book: [fixture.book[2]] });
    expect(h.historyCalls).toHaveLength(1);
    await flush();
    const s = h.core.stream('EURUSD', 'src')!;
    expect(s.book.known).toBe(true);
    expect(s.bookGaps).toBe(1);
    expect(resets).toEqual([true]);
  });

  it('after a dropped connection, holds live frames while the missed span is read, then applies both in order', async () => {
    let release: (v: MdHistory) => void = () => undefined;
    const h = harness({ history: () => new Promise<MdHistory>((r) => (release = r)) });
    h.core.watch({ symbol: 'EURUSD', kinds: ['book', 'ticks'] });
    await flush();
    const c1 = h.conns[0];
    c1.push({
      symbol: 'EURUSD',
      sourceId: 'src',
      book: fixture.book.slice(0, 20),
      ticks: { t: [fixture.book[19].t], b: [1.1], a: [1.2] },
    });
    // Drop.
    c1.closeCb!();
    expect(h.core.state).toBe('reconnecting');
    h.advance(3000);
    h.timers.at(-1)!.fn();
    await flush();
    const c2 = h.conns[1];
    expect(c2.calls.some((c) => c.method === 'Subscribe')).toBe(true);
    expect(h.historyCalls).toHaveLength(1);
    expect(h.historyCalls[0].from).toBe(fixture.book[19].t);
    // A live frame arrives during the read: held.
    c2.push({ symbol: 'EURUSD', sourceId: 'src', book: fixture.book.slice(40, 50) });
    const s = h.core.stream('EURUSD', 'src')!;
    expect(s.bookEvents).toBe(20);
    release({
      sources: [{ sourceId: 'src', book: fixture.book.slice(15, 40) }],
      truncated: false,
      message: null,
    });
    await flush();
    await flush();
    // 19..39 from history (15..18 are older than the book and skipped; 19 shares the book's time and is applied again —
    // harmless, sizes are absolute), then the held 40..49.
    expect(s.bookEvents).toBe(51);
    expect(s.book.t).toBe(fixture.book[49].t);
  });

  it('closes the connection when the last watcher leaves', async () => {
    const h = harness();
    const id = h.core.watch({ symbol: 'EURUSD', kinds: ['book'] });
    await flush();
    h.core.unwatch('EURUSD', id);
    await flush();
    expect(h.conns[0].calls.some((c) => c.method === 'Unsubscribe')).toBe(true);
    expect(h.conns[0].stopped).toBe(true);
    expect(h.core.state).toBe('idle');
  });
});
