import { describe, it, expect } from 'vitest';

import { DSL_EXAMPLES, exampleJsonFor } from './dsl-examples';
import { emitDsl, forEachCondition, parseDsl, validateDsl } from './dsl-model';

describe('DSL_EXAMPLES', () => {
  it('ships six examples with unique ids', () => {
    expect(DSL_EXAMPLES).toHaveLength(6);
    expect(new Set(DSL_EXAMPLES.map((e) => e.id)).size).toBe(DSL_EXAMPLES.length);
  });

  for (const example of DSL_EXAMPLES) {
    describe(example.id, () => {
      const parsed = parseDsl(example.json);

      it('parses', () => {
        expect(parsed.ok).toBe(true);
      });

      it('is a v2 (Pine-exact) rule in canonical camelCase', () => {
        if (!parsed.ok) throw new Error('did not parse');
        expect(parsed.doc.fields['dslVersion']).toBe(2);
        expect(emitDsl(parsed.doc)).toBe(example.json);
      });

      it('passes every client-side structural check and lint', () => {
        if (!parsed.ok) throw new Error('did not parse');
        const f = parsed.doc.fields;
        const issues = validateDsl(parsed.doc, {
          timeframe: f['timeframe'] as string,
          symbol: f['symbol'] as string,
        });
        expect(issues).toEqual([]);
      });

      it('keeps every condition a known, fully-specified type', () => {
        if (!parsed.ok) throw new Error('did not parse');
        let count = 0;
        forEachCondition(parsed.doc, (c) => {
          count++;
          expect(c.type).not.toBe('');
          expect(Object.keys(c.config).length).toBeGreaterThan(0);
          expect(c.extra).toBeUndefined();
        });
        expect(count).toBeGreaterThan(0);
      });
    });
  }

  it('stamps the strategy symbol and timeframe into a loaded example', () => {
    const json = exampleJsonFor(DSL_EXAMPLES[0], { symbol: 'GBPJPY', timeframe: 'M15' });
    const parsed = JSON.parse(json);
    expect(parsed.symbol).toBe('GBPJPY');
    expect(parsed.timeframe).toBe('M15');
    expect(exampleJsonFor(DSL_EXAMPLES[0], {})).toBe(DSL_EXAMPLES[0].json);
  });
});
