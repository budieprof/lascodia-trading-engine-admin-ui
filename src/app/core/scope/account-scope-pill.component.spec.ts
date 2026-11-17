import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { TradingAccountDto } from '@core/api/api.types';

import { AccountScopePillComponent, scopeOptions } from './account-scope-pill.component';
import { AccountScopeService } from './account-scope.service';

const acc = (id: number, extra: Partial<TradingAccountDto> = {}) =>
  ({
    id,
    accountId: String(9000 + id),
    accountName: `Acct ${id}`,
    currency: 'USD',
    isPaper: false,
    accountType: 'Real',
    brokerName: null,
    ...extra,
  }) as unknown as TradingAccountDto;

function render(live: TradingAccountDto[], selected = AccountScopeService.SCOPE_AGGREGATE_REAL) {
  const picks: (number | string)[] = [];
  const stub = {
    liveAccounts: signal(live),
    liveRealAccounts: signal(live.filter((a) => !a.isPaper)),
    effectiveSelected: signal(selected),
    select: (v: number | string) => picks.push(v),
  };
  TestBed.configureTestingModule({
    imports: [AccountScopePillComponent],
    providers: [{ provide: AccountScopeService, useValue: stub }],
  });
  const fixture = TestBed.createComponent(AccountScopePillComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, picks };
}

describe('scopeOptions', () => {
  it('never calls a mix of demo and real accounts "real"', () => {
    const opts = scopeOptions(
      [acc(1), acc(2, { accountType: 'Demo' as never })],
      [acc(1), acc(2, { accountType: 'Demo' as never })],
    );
    expect(opts[0].title).toBe('All accounts');
    expect(opts[0].meta).toBe('2 accounts · 1 real, 1 demo · aggregated');
    expect(opts.find((o) => o.value === '2')!.badges).toEqual([{ text: 'demo', tone: 'warn' }]);
    expect(opts.find((o) => o.value === '1')!.badges).toEqual([{ text: 'real', tone: 'real' }]);
  });

  it('offers the incl.-paper aggregate only when a paper account is live', () => {
    const paper = acc(3, { isPaper: true, accountType: 'Demo' as never });
    expect(scopeOptions([acc(1), acc(2)], [acc(1), acc(2)]).map((o) => o.value)).not.toContain(
      AccountScopeService.SCOPE_AGGREGATE_ALL,
    );
    expect(scopeOptions([acc(1), paper], [acc(1)])[1].title).toBe('All live accounts');
  });
});

describe('AccountScopePillComponent', () => {
  it('opens a list, marks the current scope, and selects an account by click', () => {
    const { fixture, el, picks } = render([acc(1), acc(2)]);
    const pill = el.querySelector<HTMLButtonElement>('button.scope-pill')!;
    expect(pill.textContent).toContain('All real accounts');

    pill.click();
    fixture.detectChanges();
    const options = [...el.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

    options[2].click();
    fixture.detectChanges();
    expect(picks).toEqual([2]);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('walks the list with the arrow keys and picks with Enter', () => {
    const { fixture, el, picks } = render([acc(1), acc(2)]);
    el.querySelector<HTMLButtonElement>('button.scope-pill')!.click();
    fixture.detectChanges();
    const list = el.querySelector<HTMLElement>('[role="listbox"]')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picks).toEqual([1]);
  });

  it('closes when the operator clicks elsewhere on the page', () => {
    const { fixture, el } = render([acc(1), acc(2)]);
    el.querySelector<HTMLButtonElement>('button.scope-pill')!.click();
    fixture.detectChanges();
    document.body.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('shows a static pill, no menu, for a single live account', () => {
    const { el } = render([acc(1)]);
    expect(el.querySelector('button.scope-pill')).toBeNull();
    expect(el.textContent).toContain('Acct 1');
  });
});
