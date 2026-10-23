import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService } from '@core/realtime/marketdata-stream.service';
import { MdSourceStream, type MdFrameListener, type MdWatchSpec, type MdWatchStatus } from '@core/realtime/marketdata-stream';
import type { MdConsolidatedWire } from '@core/realtime/marketdata.types';
import { MultibookPanelComponent } from './multibook-panel.component';

declareSignalIo(MultibookPanelComponent, { inputs: ['symbol', 'digits'] });

/** Sources named test-* are synthetic TEST sources (specs only). */
function consolidated(): MdConsolidatedWire {
  const s = (sourceId: string, name: string, mode: string, bid: number, ask: number, state = 'live') => ({
    sourceId, name, kind: 'Mt5Broker', state, mode, bid, ask, mid: (bid + ask) / 2, topT: 1, ageMs: 120, lagMs: 35,
    bidLevels: 2, askLevels: 2, sizeUnit: 'Units', sizeKnown: true, dev: 0, basis: null,
  });
  return {
    t: 1_000, point: 0.00001, sizeUnit: 'base',
    b: [{ p: 1.1, s: 1_300_000, partial: false, src: ['mt5-a', 'test-venue'], sz: [1_000_000, 300_000] }],
    a: [{ p: 1.10002, s: 2_000_000, partial: false, src: ['mt5-a'], sz: [2_000_000] }],
    bestBid: 1.1, bestAsk: 1.10002, bestBidSources: ['mt5-a', 'test-venue'], bestAskSources: ['mt5-a'],
    crossed: false, locked: false, crosses: [], medianMid: 1.10001, midRange: 0.00001,
    sources: [s('mt5-a', 'MetaQuotes-Demo (MT5 broker)', 'book', 1.1, 1.10002), s('test-venue', 'TEST venue', 'book', 1.1, 1.10004),
      s('test-old', 'TEST stale', 'quote', 1.2, 1.3, 'stale')],
  };
}

describe('MultibookPanelComponent', () => {
  let fixture: ComponentFixture<MultibookPanelComponent>;
  let el: HTMLElement;
  let stream: MdSourceStream;
  const version = signal(0);
  const status = signal<MdWatchStatus>({
    state: 'connected', protocol: 'messagepack', subscribed: ['consolidated:book'], denied: [], deniedReasons: {},
    notEntitled: null, revoked: null, unknown: [], error: null,
  });
  const listeners: MdFrameListener[] = [];
  const specs: MdWatchSpec[] = [];
  const released = vi.fn();
  const dispersion = vi.fn(async () => ({
    symbol: 'EURUSD', denied: [],
    minutes: [{ t: 0, samples: 120, sampleIntervalMs: 500, meanLiveSources: 2, midRangeMean: 0.00001, midRangeMax: 0.00002,
      rangeSamples: 120, crossedSamples: 0, lockedSamples: 0, point: 0.00001,
      sources: [{ sourceId: 'mt5-a', samples: 120, liveSamples: 120, staleSamples: 0, meanAbsDev: 0.000004, maxAgeMs: 300, maxLagMs: 80, meanLagMs: 40 }] }],
  }));
  const mdStream = {
    watch: (spec: MdWatchSpec) => {
      specs.push(spec);
      return {
        symbol: 'EURUSD',
        version: version.asReadonly(),
        status: status.asReadonly(),
        streams: () => [stream],
        stream: (id: string) => (id === 'consolidated' ? stream : null),
        onFrame: (l: MdFrameListener) => {
          listeners.push(l);
          return () => undefined;
        },
        onBook: () => () => undefined,
        release: released,
      };
    },
  };

  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
  };

  beforeEach(() => {
    stream = new MdSourceStream('EURUSD', 'consolidated');
    stream.consolidated = consolidated();
    specs.length = 0;
    listeners.length = 0;
    released.mockClear();
    TestBed.configureTestingModule({
      imports: [MultibookPanelComponent],
      providers: [
        { provide: MarketDataStreamService, useValue: mdStream },
        { provide: MarketDataApiService, useValue: { dispersion } },
      ],
    });
    fixture = TestBed.createComponent(MultibookPanelComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('digits', 5);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => fixture?.destroy());

  it('subscribes the consolidated source only and draws its levels with per-source segments', async () => {
    await settle();
    expect(specs).toEqual([{ symbol: 'EURUSD', sources: ['consolidated'], kinds: ['book'] }]);
    const rows = el.querySelectorAll('.mb-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('.mb-px')!.textContent).toContain('1.10000');
    expect(rows[1].querySelector('.mb-tot')!.textContent).toContain('1.3M');
    expect(rows[1].querySelectorAll('.mb-seg')).toHaveLength(2);
    expect(el.textContent).toContain('sizes in base-currency units');
    expect(el.textContent).toContain('2 of 3 sources live');
  });

  it('a source toggle filters the ladder client-side, without a new subscription', async () => {
    await settle();
    const boxes = el.querySelectorAll<HTMLInputElement>('.mb-legend input[type=checkbox]');
    boxes[0].click(); // mt5-a off
    await settle();
    const bid = el.querySelectorAll('.mb-row')[0];
    expect(el.querySelectorAll('.mb-row')).toHaveLength(1); // the ask was mt5-a's only
    expect(bid.querySelector('.mb-tot')!.textContent).toContain('300K');
    expect(specs).toHaveLength(1);
  });

  it('shows health per source (stale sources listed and marked) and the last hour from md/dispersion', async () => {
    await settle();
    const rows = el.querySelectorAll('.mb-health tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[2].textContent).toContain('stale — left out');
    expect(dispersion).toHaveBeenCalled();
    expect(rows[0].textContent).toContain('0.40'); // 1 h |dev| of mt5-a in points
  });

  it('says why when the hub refuses the feeds', async () => {
    status.update((s) => ({ ...s, notEntitled: 'Your organisation is not entitled to the venue feed.' }));
    version.update((v) => v + 1);
    await settle();
    expect(el.textContent).toContain('not entitled to the venue feed');
    status.update((s) => ({ ...s, notEntitled: null }));
  });
});
