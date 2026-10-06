import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';

export type EconomicImpact = 'Low' | 'Medium' | 'High';

/** One calendar row (`GET economic-event/upcoming`). */
export interface UpcomingEconomicEvent {
  id: number;
  title: string;
  currency: string;
  impact: EconomicImpact | string;
  scheduledAt: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** When the forecast was captured: PreRelease is the only point-in-time safe value. */
  forecastProvenance: 'None' | 'Unknown' | 'PreRelease' | 'PostRelease' | string;
}

export interface EconomicEventPairReaction {
  symbol: string;
  reaction: 'Up' | 'Down' | 'Mixed' | 'Little change' | string;
}

export interface EconomicEventScenario {
  case: 'Beat' | 'Inline' | 'Miss' | string;
  whatItMeans: string;
  likelyReaction: string;
  pairs: EconomicEventPairReaction[];
}

/** `POST economic-event/{id}/analysis` — a scenario reading, never a trade call. */
export interface EconomicEventAnalysis {
  eventId: number;
  phase: 'PreRelease' | 'Released' | string;
  summary: string;
  whyItMatters: string;
  analysis: string;
  expectation: string;
  scenarios: EconomicEventScenario[];
  uncertainty: string;
  whatWouldChange: string[];
  releaseReading: string | null;
  /** Engine-written facts about the stored data (missing consensus, unsafe history). */
  dataNotes: string[];
  history: {
    scheduledAt: string;
    forecast: string | null;
    actual: string | null;
    forecastProvenance: string;
    pointInTimeSafe: boolean;
  }[];
  pairsConsidered: string[];
  model: string;
  llmInvocationId: number | null;
  generatedAtUtc: string;
  cached: boolean;
}

/** The engine's economic calendar for the chart (engine `docs/api/economic-calendar-api.md`). */
@Injectable({ providedIn: 'root' })
export class EconomicCalendarService {
  private readonly api = inject(ApiService);

  upcoming(opts: {
    currencies?: string[];
    minImpact?: EconomicImpact | null;
    from?: string;
    to?: string;
  }): Observable<UpcomingEconomicEvent[]> {
    const qs = new URLSearchParams();
    if (opts.currencies?.length) qs.set('currencies', opts.currencies.join(','));
    if (opts.minImpact) qs.set('minImpact', opts.minImpact);
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    return this.api.getEnvelope<UpcomingEconomicEvent[]>(`/economic-event/upcoming?${qs}`, {
      silent: true,
    });
  }

  analyse(id: number, symbol: string | null, refresh = false): Observable<EconomicEventAnalysis> {
    const qs = new URLSearchParams();
    if (symbol) qs.set('symbol', symbol);
    if (refresh) qs.set('refresh', 'true');
    return this.api.postEnvelope<EconomicEventAnalysis>(
      `/economic-event/${id}/analysis?${qs}`,
      {},
      {
        silent: true,
      },
    );
  }
}
