import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { KillSwitchStatusDto, ResponseData, ToggleKillSwitchRequest } from '@core/api/api.types';

/**
 * The engine answers the kill-switch endpoints with a bare boolean (`{ data: true }`), not the
 * `KillSwitchStatusDto` the typings promise. Reading `.enabled` off `true` gave `undefined`, and
 * `if (res.data)` never stored a `false` — so the global banner could NEVER show an engaged
 * switch. Accept either shape and always hand consumers a status object.
 */
export function normaliseKillSwitch(data: unknown): KillSwitchStatusDto | null {
  if (typeof data === 'boolean') {
    return { enabled: data, reason: null, changedAt: null, changedBy: null };
  }
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as KillSwitchStatusDto).enabled === 'boolean'
  ) {
    return data as KillSwitchStatusDto;
  }
  return null;
}

function normaliseResponse(
  res: ResponseData<KillSwitchStatusDto | boolean>,
): ResponseData<KillSwitchStatusDto> {
  return { ...res, data: normaliseKillSwitch(res.data) } as ResponseData<KillSwitchStatusDto>;
}

@Injectable({ providedIn: 'root' })
export class KillSwitchService {
  private readonly api = inject(ApiService);

  private readonly _global = signal<KillSwitchStatusDto | null>(null);
  readonly global = this._global.asReadonly();
  /** True when the global kill switch is engaged (no new signals / orders). */
  readonly isGlobalEngaged = computed(() => this._global()?.enabled === true);

  getGlobal(): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api
      .get<ResponseData<KillSwitchStatusDto | boolean>>(`/admin/kill-switch/global`)
      .pipe(
        map(normaliseResponse),
        tap((res) => {
          if (res.status && res.data) this._global.set(res.data);
        }),
      );
  }

  toggleGlobal(data: ToggleKillSwitchRequest): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api
      .put<ResponseData<KillSwitchStatusDto | boolean>>(`/admin/kill-switch/global`, data)
      .pipe(
        map(normaliseResponse),
        tap((res) => {
          // A successful toggle may answer with no body; the requested state is then the truth.
          if (!res.status) return;
          this._global.set(
            res.data ?? { enabled: data.enabled, reason: null, changedAt: null, changedBy: null },
          );
        }),
      );
  }

  getStrategy(strategyId: number): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api
      .get<ResponseData<KillSwitchStatusDto | boolean>>(`/admin/kill-switch/strategy/${strategyId}`)
      .pipe(map(normaliseResponse));
  }

  toggleStrategy(
    strategyId: number,
    data: ToggleKillSwitchRequest,
  ): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api
      .put<
        ResponseData<KillSwitchStatusDto | boolean>
      >(`/admin/kill-switch/strategy/${strategyId}`, data)
      .pipe(map(normaliseResponse));
  }
}
