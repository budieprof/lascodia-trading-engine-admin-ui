import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { KillSwitchStatusDto, ResponseData, ToggleKillSwitchRequest } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class KillSwitchService {
  private readonly api = inject(ApiService);

  private readonly _global = signal<KillSwitchStatusDto | null>(null);
  readonly global = this._global.asReadonly();
  /** True when the global kill switch is engaged (no new signals / orders). */
  readonly isGlobalEngaged = computed(() => this._global()?.enabled === true);

  getGlobal(): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api.get<ResponseData<KillSwitchStatusDto>>(`/admin/kill-switch/global`).pipe(
      tap((res) => {
        if (res.data) this._global.set(res.data);
      }),
    );
  }

  toggleGlobal(data: ToggleKillSwitchRequest): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api.put<ResponseData<KillSwitchStatusDto>>(`/admin/kill-switch/global`, data).pipe(
      tap((res) => {
        if (res.data) this._global.set(res.data);
      }),
    );
  }

  getStrategy(strategyId: number): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api.get(`/admin/kill-switch/strategy/${strategyId}`);
  }

  toggleStrategy(
    strategyId: number,
    data: ToggleKillSwitchRequest,
  ): Observable<ResponseData<KillSwitchStatusDto>> {
    return this.api.put(`/admin/kill-switch/strategy/${strategyId}`, data);
  }
}
