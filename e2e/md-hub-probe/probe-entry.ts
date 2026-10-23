/** Node side of the read-only hub probe: the console's own MessagePack protocol + SignalR client against a live hub. */
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '../../src/app/core/realtime/msgpack-hub-protocol';
import { BookState } from '../../src/app/core/realtime/md-book';

export async function probe(
  url: string,
  token: string,
  symbol: string,
  seconds: number,
  protocol: 'messagepack' | 'json',
) {
  let b = new HubConnectionBuilder().withUrl(url, {
    accessTokenFactory: () => token,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  });
  if (protocol === 'messagepack') b = b.withHubProtocol(new MessagePackHubProtocol());
  const c = b.configureLogging(LogLevel.Warning).build();
  const frames: { sourceId: string; ticks: number; book: number; kinds: string[] }[] = [];
  const books = new Map<string, BookState>();
  let firstBookKind: string | null = null;
  c.on(
    'md',
    (f: {
      sourceId: string;
      ticks?: { t: number[] };
      book?: { k: 'S' | 'D'; t: number; b: [number, number][]; a: [number, number][] }[];
    }) => {
      frames.push({
        sourceId: f.sourceId,
        ticks: f.ticks?.t.length ?? 0,
        book: f.book?.length ?? 0,
        kinds: Object.keys(f),
      });
      if (f.book?.length) {
        firstBookKind ??= f.book[0].k;
        const s = books.get(f.sourceId) ?? new BookState();
        for (const e of f.book) s.apply(e);
        books.set(f.sourceId, s);
      }
    },
  );
  const t0 = Date.now();
  await c.start();
  const connectMs = Date.now() - t0;
  const sub = await c.invoke('Subscribe', symbol, null, ['ticks', 'book']);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await c.invoke('Unsubscribe', symbol);
  await c.stop();
  return {
    protocol,
    connectMs,
    subscribe: sub,
    frames: frames.length,
    tickFrames: frames.filter((f) => f.ticks > 0).length,
    ticks: frames.reduce((n, f) => n + f.ticks, 0),
    bookFrames: frames.filter((f) => f.book > 0).length,
    bookEvents: frames.reduce((n, f) => n + f.book, 0),
    firstBookKind,
    sampleKeys: frames[0]?.kinds,
    books: [...books].map(([id, s]) => ({
      sourceId: id,
      known: s.known,
      bestBid: s.bestBid(),
      bestAsk: s.bestAsk(),
      levels: s.bids.size + s.asks.size,
      orphanDeltas: s.orphanDeltas,
    })),
  };
}
