import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, EMPTY, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService } from '@core/realtime/realtime.service';

import { StrategyDetailPageComponent } from './strategy-detail-page.component';

// U06: the tab on show is kept in `?tab=` (read on open, written on change, followed when it changes).

describe('StrategyDetailPageComponent (?tab= URL sync)', () => {
  let cmp: StrategyDetailPageComponent;
  let query: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    query = new BehaviorSubject(convertToParamMap({ tab: 'promotion' }));
    const route = {
      paramMap: of(convertToParamMap({ id: '41' })),
      queryParamMap: query.asObservable(),
      snapshot: {
        paramMap: convertToParamMap({ id: '41' }),
        get queryParamMap() {
          return query.value;
        },
      },
    };
    TestBed.configureTestingModule({
      imports: [StrategyDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: route },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
        { provide: AuthService, useValue: { hasPermission: () => true } },
      ],
    });
    navigate = vi.fn(async (_cmds: unknown[], extras: { queryParams?: { tab: string | null } }) => {
      query.next(convertToParamMap(extras.queryParams?.tab ? { tab: extras.queryParams.tab } : {}));
      return true;
    });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate as never);
    cmp = TestBed.createComponent(StrategyDetailPageComponent).componentInstance;
    cmp.ngOnInit();
    TestBed.tick();
  });

  it('opens the tab named in the URL without rewriting it', () => {
    expect(cmp.activeTab()).toBe('promotion');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('writes the tab on show to ?tab= (replaceUrl), and the default tab as the bare URL', () => {
    cmp.requestTab('walkforward');
    TestBed.tick();
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        queryParams: { tab: 'walkforward' },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
    cmp.requestTab('config');
    TestBed.tick();
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({ queryParams: { tab: null } }),
    );
  });

  it('follows a later ?tab= change and ignores an unknown one', () => {
    query.next(convertToParamMap({ tab: 'orders' }));
    expect(cmp.activeTab()).toBe('orders');
    query.next(convertToParamMap({ tab: 'no-such-tab' }));
    expect(cmp.activeTab()).toBe('config');
  });
});
