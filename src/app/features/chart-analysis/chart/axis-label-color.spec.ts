import { describe, expect, it } from 'vitest';

import { labelTextColor, lastValueLabelColor, opaqueOver } from './axis-label-color';

// The chart's canvas backgrounds (ChartHostComponent.palette).
const DARK = '#0F0F0F';
const LIGHT = '#FFFFFF';

describe('opaqueOver', () => {
  it('lays a translucent bar colour over the chart background', () => {
    // Smart Algo v2's faded down-close: #FB7185 at 0x73 (45%).
    expect(opaqueOver('#FB718573', DARK)).toBe('rgb(121, 59, 68)');
    expect(opaqueOver('#FB718573', LIGHT)).toBe('rgb(253, 191, 200)');
    // As the chart receives script colours: CSS rgba() (pine-chart's cssColor).
    expect(opaqueOver('rgba(242, 54, 69, 0.451)', DARK)).toBe('rgb(117, 33, 39)');
  });

  it('passes an opaque colour through untouched, whatever its notation', () => {
    for (const c of [
      '#089981',
      '#F23645',
      '#2962FF',
      '#FDD835FF',
      'rgb(34, 211, 238)',
      'rgba(1, 2, 3, 1)',
    ])
      expect(opaqueOver(c, DARK)).toBe(c);
  });

  it('leaves what it cannot read as it was', () => {
    expect(opaqueOver('transparent', DARK)).toBe('transparent');
    expect(opaqueOver('#FB718573', 'not-a-colour')).toBe('#FB718573');
  });
});

describe('labelTextColor', () => {
  it('reads on the label in both themes: white on a dark box, black on a light one', () => {
    expect(labelTextColor(opaqueOver('#FB718573', DARK))).toBe('#ffffff');
    expect(labelTextColor(opaqueOver('#FB718573', LIGHT))).toBe('#000000');
    expect(labelTextColor(opaqueOver('#22D3EE73', DARK))).toBe('#ffffff');
    expect(labelTextColor(opaqueOver('#22D3EE73', LIGHT))).toBe('#000000');
  });

  it('keeps white on the chart’s own up, down and line colours (unchanged labels)', () => {
    for (const c of ['#089981', '#F23645', '#2962FF']) expect(labelTextColor(c)).toBe('#ffffff');
  });

  it('takes black on a light opaque bar colour, as the library does for the price label above it', () => {
    expect(labelTextColor('#FDD835')).toBe('#000000'); // yellow
    expect(labelTextColor('#22D3EE')).toBe('#000000'); // v2's cyan up-close
    expect(labelTextColor('#FB7185')).toBe('#ffffff'); // v2's pink down-close stays white
  });
});

describe('lastValueLabelColor', () => {
  it('composites a translucent bar colour; the library labels the bar otherwise', () => {
    expect(lastValueLabelColor('#FB718573', DARK)).toBe('rgb(121, 59, 68)');
    expect(lastValueLabelColor('rgba(34, 211, 238, 0.451)', LIGHT)).toBe('rgb(155, 235, 247)');
    // Opaque, or no script colour on the bar (a hollow candle's border colour never reaches the
    // row's `color`): '' = the series' own colouring, exactly as before.
    expect(lastValueLabelColor('#FB7185FF', DARK)).toBe('');
    expect(lastValueLabelColor('rgb(34, 211, 238)', DARK)).toBe('');
    expect(lastValueLabelColor(undefined, DARK)).toBe('');
    expect(lastValueLabelColor(null, DARK)).toBe('');
  });
});
