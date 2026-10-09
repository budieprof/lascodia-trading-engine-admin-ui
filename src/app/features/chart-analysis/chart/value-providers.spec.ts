import { describe, expect, it } from 'vitest';
import { ValueProviders, type DataWindowContext } from './value-providers';

const ctx: DataWindowContext = {
  index: 3,
  bar: { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  utcTime: 0,
  precision: 5,
};
const section = (id: string) => [{ id, title: id, rows: [{ label: 'v', value: id }] }];

describe('ValueProviders — the data window’s sources (CC-I6)', () => {
  it('lists every provider’s sections in registration order', () => {
    const p = new ValueProviders();
    p.register('bar', () => section('bar'));
    p.register('studies', () => section('studies'));
    p.register('pine:a', (c) => section(`pine@${c.index}`));
    expect(p.collect(ctx).map((s) => s.id)).toEqual(['bar', 'studies', 'pine@3']);
  });

  it('replaces a provider registered again under its id, in place', () => {
    const p = new ValueProviders();
    p.register('bar', () => section('bar'));
    p.register('pine:a', () => section('old'));
    p.register('pine:a', () => section('new'));
    expect(p.collect(ctx).map((s) => s.id)).toEqual(['bar', 'new']);
  });

  it('unregisters; a stale unregister leaves the newer provider alone', () => {
    const p = new ValueProviders();
    const off = p.register('pine:a', () => section('first'));
    p.register('pine:a', () => section('second'));
    off();
    expect(p.collect(ctx).map((s) => s.id)).toEqual(['second']);
    p.register('x', () => section('x'))();
    expect(p.collect(ctx).map((s) => s.id)).toEqual(['second']);
  });

  it('leaves out a provider that throws or has nothing, keeps the others', () => {
    const p = new ValueProviders();
    p.register('broken', () => {
      throw new Error('no run');
    });
    p.register('none', () => null);
    p.register('bar', () => section('bar'));
    expect(p.collect(ctx).map((s) => s.id)).toEqual(['bar']);
  });
});
