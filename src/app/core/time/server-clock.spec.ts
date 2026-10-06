import { describe, expect, it, vi } from 'vitest';

import { ServerClock, median } from './server-clock';

describe('ServerClock', () => {
  it('is the client clock until a Date header is sampled', () => {
    const c = new ServerClock();
    expect(c.skewMs()).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(c.now()).toBe(1_000_000);
    vi.restoreAllMocks();
  });

  it('corrects a client clock 30 s slow using the Date header against the request midpoint', () => {
    const c = new ServerClock();
    const client = Date.parse('2026-10-06T13:00:00.000Z');
    // Server said 13:00:30 (1 s resolution ⇒ +0.5 s), request took 200 ms.
    c.sample('Tue, 06 Oct 2026 13:00:30 GMT', client - 100, client + 100);
    expect(c.skewMs()).toBe(30_500);
  });

  it('takes the median of recent samples and ignores bad ones', () => {
    const c = new ServerClock();
    const t = Date.parse('2026-10-06T13:00:00.000Z');
    c.sample(new Date(t + 2_000).toUTCString(), t, t);
    c.sample(new Date(t + 2_000).toUTCString(), t, t);
    c.sample(new Date(t + 60_000).toUTCString(), t, t); // a jittery outlier
    expect(c.skewMs()).toBe(2_500);
    c.sample(null, t, t);
    c.sample('garbage', t, t);
    c.sample(new Date(t).toUTCString(), t, t + 20_000); // too slow to trust
    expect(c.skewMs()).toBe(2_500);
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
