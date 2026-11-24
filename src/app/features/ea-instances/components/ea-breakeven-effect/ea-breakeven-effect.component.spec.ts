import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import {
  PositionsService,
  type BreakevenCounterfactualDto,
} from '@core/services/positions.service';
import { EaBreakevenEffectComponent } from './ea-breakeven-effect.component';

const trade = (effectR: number, withoutRule: string) => ({
  positionId: Math.random(),
  tradeSignalId: 1,
  source: 'PatientTrader',
  symbol: 'EURUSD',
  direction: 'Short',
  accounts: 1,
  movedAtUtc: '2026-11-17T13:20:00Z',
  entry: 1.102,
  initialStop: 1.1055,
  takeProfit: 1.095,
  plannedR: 2,
  status: 'Closed',
  realisedR: 0,
  withoutRule,
  withoutRuleR: withoutRule === 'HitTP' ? 2 : -1,
  effectR,
});

function report(net: number, trades = 2): BreakevenCounterfactualDto {
  return {
    days: 90,
    summary: {
      trades,
      resolved: trades,
      cutWinners: 1,
      savedLosers: 1,
      realisedR: 0,
      withoutRuleR: -net,
      netEffectR: net,
    },
    bySource: [
      {
        key: 'PatientTrader',
        trades,
        cutWinners: 1,
        savedLosers: 1,
        realisedR: 0,
        withoutRuleR: -net,
        netEffectR: net,
      },
    ],
    byPlannedR: [],
    trades: trades ? [trade(-2, 'HitTP'), trade(1, 'HitSL')] : [],
    basis: 'basis text',
  };
}

function render(dto: BreakevenCounterfactualDto) {
  const calls: [number, number | null | undefined][] = [];
  TestBed.configureTestingModule({
    imports: [EaBreakevenEffectComponent],
    providers: [
      {
        provide: PositionsService,
        useValue: {
          getBreakevenCounterfactual: (days: number, account?: number | null) => {
            calls.push([days, account]);
            return of({ data: dto, status: true, message: 'ok', responseCode: '00' });
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(EaBreakevenEffectComponent);
  (fixture.componentInstance as unknown as { tradingAccountId: unknown }).tradingAccountId =
    signal(17);
  fixture.detectChanges();
  TestBed.flushEffects();
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, calls };
}

describe('EaBreakevenEffectComponent', () => {
  it('asks for this account over 90 days and says in plain words that the rule cost R', () => {
    const { host, calls } = render(report(-1));
    expect(calls).toEqual([[90, 17]]);
    expect(host.querySelector('.bee-verdict')?.textContent).toContain(
      'Break-even cost 1.00R over the last 90 days',
    );
    expect(host.textContent).toContain('1 would have reached their target without the rule');
  });

  it('says when the rule earned R', () => {
    const { host } = render(report(0.5));
    expect(host.querySelector('.bee-verdict')?.textContent).toContain('Break-even earned 0.50R');
  });

  it('says so when the rule moved nothing', () => {
    const { host } = render(report(0, 0));
    expect(host.textContent).toContain(
      'The rule moved no trades on this account in the last 90 days',
    );
  });
});
