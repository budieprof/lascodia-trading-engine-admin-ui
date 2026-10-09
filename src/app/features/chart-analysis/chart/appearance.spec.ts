import { describe, expect, it } from 'vitest';
import { appearanceKey, applyAppearance, gridVisibility, restoredAppearance, withAlpha } from './appearance';

const theme = { background: '#FFFFFF', up: '#089981', down: '#F23645', volumeUp: 'x', volumeDown: 'y', text: '#131722' };

describe('chart appearance (CC-I11)', () => {
  it('lays the chart’s colours over the theme’s, volume at half strength', () => {
    const p = applyAppearance(theme, { up: '#2962FF', background: '#000000' });
    expect(p).toMatchObject({ up: '#2962FF', volumeUp: 'rgba(41,98,255,0.5)', down: '#F23645', background: '#000000', text: '#131722' });
    expect(applyAppearance(theme, null)).toBe(theme);
  });

  it('ignores what the dialog could not have written', () => {
    expect(applyAppearance(theme, { up: 'red', down: 'url(x)' })).toMatchObject({ up: '#089981', down: '#F23645' });
    expect(restoredAppearance({ up: 'red', grid: 'diagonal', down: '#112233' })).toEqual({ down: '#112233' });
    expect(restoredAppearance({ up: 'nope' })).toBeNull();
    expect(restoredAppearance(undefined)).toBeNull();
  });

  it('says which grid lines show and what rebuilds the price series', () => {
    expect(gridVisibility(null)).toEqual({ vert: true, horz: true });
    expect(gridVisibility({ grid: 'horizontal' })).toEqual({ vert: false, horz: true });
    expect(gridVisibility({ grid: 'none' })).toEqual({ vert: false, horz: false });
    expect(appearanceKey({ grid: 'none' })).toBe(appearanceKey(null));
    expect(appearanceKey({ up: '#000000' })).not.toBe(appearanceKey(null));
    expect(withAlpha('#FF0000', 0.25)).toBe('rgba(255,0,0,0.25)');
  });
});
