import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@core/api/api.types';
import { Permission } from '@core/auth/permissions.generated';
import { RealtimeService } from '@core/realtime/realtime.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { SpotSweepService } from '@core/services/spot-sweep.service';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { DEFAULT_SWEEP_CONFIG, type SpotSweepConfig } from '@features/spot-sweep/spot-sweep.types';

import { SpotSweepPageComponent } from './spot-sweep-page.component';

ensureTestBed();

const AT_LOAD: SpotSweepConfig = {
  ...DEFAULT_SWEEP_CONFIG,
  enabled: false,
  pairs: [{ symbol: 'EURUSD', timeframe: 'H1' }],
};
/** What the engine holds by the time Start is pressed: another operator added a pair. */
const NOW: SpotSweepConfig = {
  ...AT_LOAD,
  pairs: [
    { symbol: 'EURUSD', timeframe: 'H1' },
    { symbol: 'GBPUSD', timeframe: 'H1' },
  ],
};

function setup(
  reads: SpotSweepConfig[],
  save = vi.fn((c: SpotSweepConfig) => of({ config: c, message: 'Saved' })),
) {
  const queue = [...reads];
  const svc = {
    getConfig: vi.fn(() => of(structuredClone(queue.length > 1 ? queue.shift()! : queue[0]))),
    saveConfig: save,
    getStatus: vi.fn(() => of(null)),
    getHistory: vi.fn(() => of([])),
    getScoreboard: vi.fn(() => of(null)),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: SpotSweepService, useValue: svc },
      { provide: RealtimeService, useValue: null },
      {
        provide: CurrencyPairsService,
        useValue: { list: () => of({ status: true, data: { data: [] } }) },
      },
      provideAuthWithPermissions(Permission.PlatformEngineManage, Permission.AccessOperator),
    ],
  });
  const page = TestBed.runInInjectionContext(() => new SpotSweepPageComponent());
  return { page, svc, save };
}

describe('Spot Sweep Start/Stop (full-replace PUT)', () => {
  it('reads the config fresh right before the toggle and flips enabled on THAT copy', () => {
    const { page, svc, save } = setup([AT_LOAD, NOW]);
    expect(svc.getConfig).toHaveBeenCalledTimes(1); // page load

    page.applyToggle();

    expect(svc.getConfig).toHaveBeenCalledTimes(2); // the fresh read
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0][0] as SpotSweepConfig;
    expect(sent.enabled).toBe(true);
    // The other operator's pair survives; the stale page-load copy would have reverted it.
    expect(sent.pairs.map((p) => p.symbol)).toEqual(['EURUSD', 'GBPUSD']);
  });

  it('writes nothing when the engine is already in the requested state', () => {
    const { page, save } = setup([AT_LOAD, { ...NOW, enabled: true }]);
    page.applyToggle();
    expect(save).not.toHaveBeenCalled();
  });

  it('adopts the persisted config a refused (partial) save echoes back', () => {
    const echoed = { ...NOW, enabled: false };
    const refusal = new ApiError('-11', 'Configuration partially saved — 1 field(s) refused', {
      status: false,
      data: echoed,
      message: 'Configuration partially saved',
      responseCode: '-11',
    });
    const save = vi.fn(() => throwError(() => refusal));
    const { page } = setup([AT_LOAD, NOW], save);
    page.applyToggle();
    expect(page.error()).toContain('partially saved');
    // The form shows what the engine now holds, not the page-load copy.
    expect(page.config()?.pairs.map((p) => p.symbol)).toEqual(['EURUSD', 'GBPUSD']);
  });
});
