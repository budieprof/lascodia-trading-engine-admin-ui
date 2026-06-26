import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import {
  DEFAULT_SPREAD_REACTIVE_CONFIG,
  SpreadReactiveConfig,
  SpreadStateEntry,
} from '@features/spread-reactive/spread-reactive.types';

/**
 * Data access for the spread-reactive subsystem — config CRUD plus the
 * live spread-state snapshot consumed by the monitor dashboard.
 * Engine endpoints under `/spread-reactive/*` (see SpreadReactiveController).
 */
@Injectable({ providedIn: 'root' })
export class SpreadReactiveService {
  private readonly api = inject(ApiService);

  getConfig(): Observable<SpreadReactiveConfig> {
    // Backfill missing slots so a config served by an older engine still
    // renders every form field — same pattern as SpotSweepService.
    return this.api
      .getEnvelope<SpreadReactiveConfig>('/spread-reactive/config')
      .pipe(map((c) => ({ ...DEFAULT_SPREAD_REACTIVE_CONFIG, ...c })));
  }

  saveConfig(config: SpreadReactiveConfig): Observable<SpreadReactiveConfig> {
    return this.api
      .putEnvelope<SpreadReactiveConfig>('/spread-reactive/config', config)
      .pipe(map((c) => ({ ...DEFAULT_SPREAD_REACTIVE_CONFIG, ...c })));
  }

  getState(): Observable<SpreadStateEntry[]> {
    return this.api.getEnvelope<SpreadStateEntry[]>('/spread-reactive/state');
  }
}
