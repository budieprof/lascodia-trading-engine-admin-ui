import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  EAObservabilityDto,
  EngineObservabilityDto,
  FleetObservabilityDto,
  ResponseData,
} from '@core/api/api.types';

/**
 * Phase-16: read-only observability service.  Powers the Fleet Health
 * page on the admin UI.  Three endpoints, each cheap (~3-5 SELECTs):
 *
 *   * fleet()   — counts of EAs/daemons/sessions by state.
 *   * ea(id)    — distilled state-envelope highlights for one EA.
 *   * engine()  — DB latency, working-order/position counts, outbox depth.
 *
 * For raw Prometheus metrics, hit ``/metrics`` directly — that's still
 * the system-of-record for time-series data and what Grafana scrapes.
 * This service exists so the admin UI can render a one-glance health
 * dashboard without each panel scraping Prometheus separately.
 */
@Injectable({ providedIn: 'root' })
export class ObservabilityService {
  private readonly api = inject(ApiService);
  private readonly base = '/admin/observability';

  fleet(): Observable<ResponseData<FleetObservabilityDto>> {
    return this.api.get<ResponseData<FleetObservabilityDto>>(`${this.base}/fleet`);
  }

  ea(instanceId: string): Observable<ResponseData<EAObservabilityDto>> {
    return this.api.get<ResponseData<EAObservabilityDto>>(
      `${this.base}/ea/${encodeURIComponent(instanceId)}`,
    );
  }

  engine(): Observable<ResponseData<EngineObservabilityDto>> {
    return this.api.get<ResponseData<EngineObservabilityDto>>(`${this.base}/engine`);
  }
}
