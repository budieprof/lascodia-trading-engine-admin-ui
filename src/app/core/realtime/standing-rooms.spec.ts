import { describe, expect, it } from 'vitest';

/**
 * The rule behind `RealtimeService.join` / `leave`, isolated from SignalR.
 *
 * <p>`priceUpdated` only reaches a connection that called `SubscribePrice`, and the old code sent
 * that through `invoke`, which resolves with `undefined` while the hub is still connecting. On
 * localhost the hub is up within milliseconds and the join always landed. Through the Cloudflare
 * tunnel the negotiate, upgrade and auth take long enough that the chart subscribed FIRST and the
 * call did nothing — so the page looked live and received no prices for the rest of its life.</p>
 *
 * <p>The same gap reopens on every reconnect: the hub drops a connection's groups with the
 * connection, and nothing re-joined them. Cloudflare closes an idle socket at ~100s, so on the
 * public origin that is not an edge case.</p>
 */

/** The behaviour under test, mirroring the service's bookkeeping. */
class StandingRooms {
  private readonly standing = new Map<string, { method: string; args: unknown[] }>();
  readonly sent: string[] = [];
  connected = false;

  private invoke(method: string, ...args: unknown[]): void {
    // Exactly the guard `RealtimeService.invoke` applies.
    if (!this.connected) return;
    this.sent.push(`${method}(${args.join(',')})`);
  }

  join(room: string, method: string, ...args: unknown[]): void {
    this.standing.set(room, { method, args });
    this.invoke(method, ...args);
  }

  leave(room: string, method: string, ...args: unknown[]): void {
    this.standing.delete(room);
    this.invoke(method, ...args);
  }

  /** Called when the connection comes up, and again after every reconnect. */
  onConnected(): void {
    this.connected = true;
    for (const { method, args } of [...this.standing.values()]) this.invoke(method, ...args);
  }

  onDropped(): void {
    this.connected = false;
  }
}

describe('standing hub rooms', () => {
  it('applies a join that was issued before the connection came up', () => {
    const r = new StandingRooms();
    // The chart subscribes immediately on load — this is the tunnel's timing.
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    expect(r.sent).toEqual([]); // nothing could be sent yet

    r.onConnected();
    expect(r.sent).toEqual(['SubscribePrice(EURUSD)']);
  });

  it('re-joins after a reconnect, because the hub dropped the group with the connection', () => {
    const r = new StandingRooms();
    r.onConnected();
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    expect(r.sent).toEqual(['SubscribePrice(EURUSD)']);

    r.onDropped();
    r.onConnected();
    expect(r.sent).toEqual(['SubscribePrice(EURUSD)', 'SubscribePrice(EURUSD)']);
  });

  it('stops re-joining a room that was left', () => {
    const r = new StandingRooms();
    r.onConnected();
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    r.leave('price:EURUSD', 'UnsubscribePrice', 'EURUSD');
    r.onDropped();
    r.onConnected();

    expect(r.sent).toEqual(['SubscribePrice(EURUSD)', 'UnsubscribePrice(EURUSD)']);
  });

  it('keeps one entry per room, so a repeated join does not stack', () => {
    const r = new StandingRooms();
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    r.onConnected();

    expect(r.sent).toEqual(['SubscribePrice(EURUSD)']);
  });

  it('re-joins every room it is holding', () => {
    const r = new StandingRooms();
    r.join('price:EURUSD', 'SubscribePrice', 'EURUSD');
    r.join('price:GBPUSD', 'SubscribePrice', 'GBPUSD');
    r.onConnected();

    expect(r.sent).toEqual(['SubscribePrice(EURUSD)', 'SubscribePrice(GBPUSD)']);
  });
});
