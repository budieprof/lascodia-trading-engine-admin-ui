import { describe, expect, it } from 'vitest';

import { inlineSafeType } from './download';

describe('inlineSafeType (review A11)', () => {
  it('opens only raster images, with the bare type', () => {
    expect(inlineSafeType('image/png')).toBe('image/png');
    expect(inlineSafeType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg');
    expect(inlineSafeType('image/gif')).toBe('image/gif');
    expect(inlineSafeType('image/webp')).toBe('image/webp');
  });

  it('never opens SVG, HTML, PDF or an unknown type', () => {
    for (const t of ['image/svg+xml', 'text/html', 'application/pdf', 'application/xml', '', null, undefined]) {
      expect(inlineSafeType(t)).toBeNull();
    }
  });
});
