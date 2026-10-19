import { describe, it, expect } from 'vitest';

import { EnumLabelPipe } from './enum-label.pipe';

describe('EnumLabelPipe (fallback split)', () => {
  const pipe = new EnumLabelPipe();

  it('splits plain camel case', () => {
    expect(pipe.transform('RuleBased')).toBe('Rule Based');
    expect(pipe.transform('PaperTrading')).toBe('Paper Trading');
  });

  it('keeps acronyms together', () => {
    expect(pipe.transform('CompositeML')).toBe('Composite ML');
    expect(pipe.transform('MLModelRetired')).toBe('ML Model Retired');
    expect(pipe.transform('EA')).toBe('EA');
  });

  it('separates digits from a following capital', () => {
    expect(pipe.transform('Tier0Activation')).toBe('Tier0 Activation');
  });

  it('renders a dash for empty values', () => {
    expect(pipe.transform(null)).toBe('-');
    expect(pipe.transform('')).toBe('-');
  });
});
