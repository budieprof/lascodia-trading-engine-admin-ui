import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { ScriptStrategyService } from './script-strategy.service';

function make() {
  const api = { get: vi.fn(() => of(null)), post: vi.fn(() => of(null)) };
  const injector = Injector.create({
    providers: [
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine' } },
      { provide: ApiService, useValue: api },
      { provide: HttpClient, useValue: {} },
      { provide: ScriptStrategyService, useClass: ScriptStrategyService },
    ],
  });
  const service = runInInjectionContext(injector, () => injector.get(ScriptStrategyService));
  return { service, api };
}

describe('ScriptStrategyService — §8f parity (BT-I3 / PE-I2 / BX-1)', () => {
  it('reads the summary for a window, and the sessions', () => {
    const { service, api } = make();
    service.getParitySummary(41, 90);
    service.getParitySummary(41);
    service.getParitySessions(41);
    expect(api.get.mock.calls).toEqual([
      ['/strategy/41/parity/summary?days=90', { silent: true }],
      ['/strategy/41/parity/summary', { silent: true }],
      ['/strategy/41/parity/sessions', { silent: true }],
    ]);
  });

  it('queues a reconcile of a session (or the newest one) and reads it back', () => {
    const { service, api } = make();
    service.queueParityReconcile(41, 9);
    service.queueParityReconcile(41, null);
    service.getParityReconcile(41, 7001);
    expect(api.post.mock.calls).toEqual([
      ['/strategy/41/parity/reconcile', { sessionId: 9 }, { silent: true }],
      ['/strategy/41/parity/reconcile', {}, { silent: true }],
    ]);
    expect(api.get.mock.calls).toEqual([['/strategy/41/parity/reconcile/7001', { silent: true }]]);
  });

  it('reads the trade timeline over a window, against a chosen backtest', () => {
    const { service, api } = make();
    service.getParityTimeline(41);
    service.getParityTimeline(41, {
      fromUtc: '2026-10-01T00:00:00Z',
      toUtc: '2026-10-08T00:00:00Z',
      backtestRunId: 7001,
    });
    expect(api.get.mock.calls).toEqual([
      ['/strategy/41/parity/timeline', { silent: true }],
      [
        '/strategy/41/parity/timeline?fromUtc=2026-10-01T00%3A00%3A00Z&toUtc=2026-10-08T00%3A00%3A00Z&backtestRunId=7001',
        { silent: true },
      ],
    ]);
  });
});
