import { describe, expect, it } from 'vitest';

import { fileNameFromContentDisposition, fileStamp, toCsv } from './download';

describe('toCsv', () => {
  it('writes RFC 4180 CSV with a BOM and CRLF line ends', () => {
    const csv = toCsv(
      ['Symbol', 'RSI'],
      [
        ['EURUSD', 54.2],
        ['GBPUSD', null],
      ],
    );
    expect(csv).toBe('\uFEFFSymbol,RSI\r\nEURUSD,54.2\r\nGBPUSD,\r\n');
  });

  it('quotes cells with commas, quotes or newlines', () => {
    const csv = toCsv(['a'], [['x, "y"\nz']]);
    expect(csv).toContain('"x, ""y""\nz"');
  });

  it('defuses spreadsheet formulas in text cells but never alters numbers', () => {
    const csv = toCsv(['msg', 'v'], [['=HYPERLINK("x")', -1.5]]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")",-1.5`);
  });
});

describe('fileNameFromContentDisposition', () => {
  it('prefers the RFC 5987 name', () => {
    expect(
      fileNameFromContentDisposition(
        `attachment; filename="plain.csv"; filename*=UTF-8''backtest%20812.csv`,
      ),
    ).toBe('backtest 812.csv');
  });

  it('reads a plain quoted or bare name', () => {
    expect(fileNameFromContentDisposition('attachment; filename="run-9.xlsx"')).toBe('run-9.xlsx');
    expect(fileNameFromContentDisposition('attachment; filename=run-9.csv')).toBe('run-9.csv');
  });

  it('strips path separators and handles absence', () => {
    expect(fileNameFromContentDisposition('attachment; filename="../../x.csv"')).toBe(
      '.._.._x.csv',
    );
    expect(fileNameFromContentDisposition(null)).toBeNull();
    expect(fileNameFromContentDisposition('inline')).toBeNull();
  });
});

describe('fileStamp', () => {
  it('joins parts file-name safely', () => {
    expect(fileStamp('pine screener', 'EURUSD', null, '60')).toBe('pine-screener_EURUSD_60');
  });
});
