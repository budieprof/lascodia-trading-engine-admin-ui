import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { blobError, fundQuery, toDownloadedFile } from './fund-api.service';
import {
  day,
  defaultPeriod,
  isSha256,
  isUpgradeNotice,
  markoutCell,
  money,
  monthlyGrid,
  pct,
  periodQuery,
  shortHash,
  signedAmount,
  sparkline,
} from './fund.logic';

describe('fund logic', () => {
  it('formats percentages and numbers, unknown as a dash', () => {
    expect(pct(0.0123)).toBe('1.23 %');
    expect(pct(null)).toBe('—');
    expect(pct(Number.NaN)).toBe('—');
    expect(money(12345.6, 'USD')).toBe('12,345.60 USD');
    expect(day('2026-10-24T21:00:00Z')).toBe('2026-10-24');
  });

  it('defaults to the last 30 UTC days and validates a period', () => {
    expect(defaultPeriod(new Date('2026-10-24T15:00:00Z'))).toEqual({
      from: '2026-09-25',
      to: '2026-10-25',
    });
    expect(periodQuery('2026-10-01', '2026-10-24')).toEqual({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-24T00:00:00Z',
    });
    expect(periodQuery('2026-10-24', '2026-10-01')).toEqual({
      problem: 'The period must end after it starts.',
    });
    expect(periodQuery('2024-01-01', '2026-01-01')).toEqual({
      problem: 'A report covers at most 366 days.',
    });
    expect(periodQuery('', '2026-01-01')).toEqual({ problem: 'Choose the period.' });
  });

  it('builds the monthly grid with gaps and year totals', () => {
    const grid = monthlyGrid(
      [
        { year: 2026, month: 2, return: -0.01, days: 2 },
        { year: 2026, month: 3, return: 0.1, days: 1 },
      ],
      [{ year: 2026, return: 0.089, days: 3 }],
    );
    expect(grid).toHaveLength(1);
    expect(grid[0].months[0]).toBeNull();
    expect(grid[0].months[1]).toBe(-0.01);
    expect(grid[0].total).toBe(0.089);
  });

  it('signs a cash flow by its kind', () => {
    expect(signedAmount('Deposit', -100)).toBe(100);
    expect(signedAmount('Withdrawal', 100)).toBe(-100);
    expect(signedAmount('Fee', 5)).toBe(-5);
    expect(signedAmount('Adjustment', -3)).toBe(-3);
  });

  it('recognises the plan upgrade notice', () => {
    expect(
      isUpgradeNotice({ error: { responseCode: '-403-quota', message: 'x', data: null } }),
    ).toBe(true);
    expect(isUpgradeNotice({ error: { responseCode: '-14' } })).toBe(false);
  });

  it('draws a sparkline and shows hashes compactly', () => {
    expect(sparkline([1], 100, 20)).toBe('');
    expect(sparkline([0, 1], 100, 20)).toBe('2.0,18.0 98.0,2.0');
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
    expect(isSha256('A'.repeat(64))).toBe(true);
    expect(isSha256('xyz')).toBe(false);
    expect(markoutCell(0.4, 12)).toBe('0.40 (n=12)');
    expect(markoutCell(null, 0)).toBe('—');
  });

  it('builds query strings without empty values', () => {
    expect(fundQuery({ from: 'a', to: null, symbol: '', id: 4 })).toBe('?from=a&id=4');
    expect(fundQuery({})).toBe('');
  });

  it('reads a download and its integrity headers', () => {
    const res = new HttpResponse<Blob>({
      body: new Blob(['{}']),
      headers: new HttpHeaders({
        'Content-Disposition': 'attachment; filename="compliance-a-20261001-20261024.json"',
        'X-Content-SHA256': 'ab',
        'X-Lascodia-Signature': 'v1=cd',
        'X-Lascodia-Signing-Key-Id': '1234abcd',
      }),
    });
    const file = toDownloadedFile(res, 'fallback.json');
    expect(file.fileName).toBe('compliance-a-20261001-20261024.json');
    expect([file.sha256, file.signature, file.signingKeyId]).toEqual(['ab', 'v1=cd', '1234abcd']);
  });

  it('turns a failed download body back into the engine envelope', async () => {
    const err = new HttpErrorResponse({
      status: 403,
      error: new Blob([
        JSON.stringify({
          responseCode: '-403-quota',
          message: 'upgrade',
          status: false,
          data: null,
        }),
      ]),
    });
    await expect(firstValueFrom(blobError(err))).rejects.toMatchObject({
      code: '-403-quota',
      message: 'upgrade',
    });
  });
});
