import { describe, expect, it } from 'vitest';

import { RecordingContext } from '../testing/recording-context';
import { Lru, TEXT_WIDTH_CACHE, textWidth } from './canvas-kit';

describe('Lru (PC-I13)', () => {
  it('drops the least recently used entry, not everything', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1); // a is now the most recent
    lru.set('d', 4); // b goes
    expect(lru.size).toBe(3);
    expect(lru.get('b')).toBeUndefined();
    expect([lru.get('a'), lru.get('c'), lru.get('d')]).toEqual([1, 3, 4]);
    lru.set('c', 30); // an update is no new entry
    expect(lru.size).toBe(3);
    expect(lru.get('c')).toBe(30);
  });
});

describe('textWidth (PC-I13)', () => {
  it('keeps the widths a frame keeps using when the cache fills — it used to empty it whole', () => {
    const ctx = new RecordingContext();
    ctx.font = '11px PC-I13-test';
    let measured = 0;
    const measure = ctx.measureText.bind(ctx);
    ctx.measureText = (text: string) => {
      measured++;
      return measure(text);
    };
    const c = ctx.asCtx();
    textWidth(c, 'label every frame');
    for (let i = 0; i < TEXT_WIDTH_CACHE; i++) {
      textWidth(c, `other ${i}`);
      // The label is drawn every frame: it stays the most recently used.
      if (i % 1000 === 0) textWidth(c, 'label every frame');
    }
    const before = measured;
    expect(textWidth(c, 'label every frame')).toBe(17 * 11 * 0.6);
    expect(measured).toBe(before);
    // The oldest of the others went to make room.
    textWidth(c, 'other 0');
    expect(measured).toBe(before + 1);
  });
});
