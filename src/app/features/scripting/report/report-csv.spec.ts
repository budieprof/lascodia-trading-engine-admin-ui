import { describe, expect, it } from 'vitest';

import { liveClosedTradesCsv, reportTradesCsv } from './report-csv';
import { normalizeStrategyReport } from './strategy-report.model';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import { liveClosedTradesFixture } from '../testing/live-status.fixture';
import type { ScriptLiveClosedTrade } from '../api/scripting-api.types';

const lines = (csv: string) => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

describe('report-csv — PE-I14 trade lists for a spreadsheet', () => {
  it('writes every listed trade with UTC times, units, R and the account currency in the header', () => {
    const report = normalizeStrategyReport(strategyReportFixture())!;
    const out = lines(reportTradesCsv(report));
    expect(out).toHaveLength(report.trades.length + 1);
    expect(out[0]).toContain('Trade #,Side,Status,Entry signal,Entry time (UTC)');
    expect(out[0]).toContain(`Profit (${report.meta.accountCurrency})`);
    expect(out[0]).toContain('Initial stop,R multiple');
    expect(out[0]).not.toContain('Origin');
    const first = report.trades[0];
    expect(
      out[1].startsWith(`${first.number},${first.direction.startsWith('s') ? 'Short' : 'Long'},`),
    ).toBe(true);
    expect(out[1]).toContain(new Date(first.entryTime!).toISOString());
  });

  it('adds the origin of each trade when the live panel gives one', () => {
    const report = normalizeStrategyReport(strategyReportFixture())!;
    const out = lines(reportTradesCsv(report, () => 'paper'));
    expect(out[0].endsWith(',Origin')).toBe(true);
    expect(out[1].endsWith(',Paper')).toBe(true);
  });

  it('writes the live closed trades with their origin', () => {
    const trades = liveClosedTradesFixture() as unknown as ScriptLiveClosedTrade[];
    const out = lines(liveClosedTradesCsv(trades));
    expect(out).toHaveLength(trades.length + 1);
    expect(out[1]).toContain('Warm-up replay');
    expect(out[6]).toContain(',Live,Short,');
  });
});
