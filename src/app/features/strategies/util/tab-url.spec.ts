import { describe, expect, it } from 'vitest';

import { readTabParam, tabQueryParam } from './tab-url';

describe('strategy detail ?tab= (U06)', () => {
  it('writes nothing for the default tab, the tab otherwise', () => {
    expect(tabQueryParam('config')).toBeNull();
    expect(tabQueryParam('')).toBeNull();
    expect(tabQueryParam('promotion')).toBe('promotion');
  });

  it('reads only tabs the page has', () => {
    const known = ['config', 'promotion', 'walkforward'];
    expect(readTabParam('promotion', known)).toBe('promotion');
    expect(readTabParam('WalkForward', known)).toBe('walkforward');
    expect(readTabParam('nope', known)).toBeNull();
    expect(readTabParam(null, known)).toBeNull();
  });
});
