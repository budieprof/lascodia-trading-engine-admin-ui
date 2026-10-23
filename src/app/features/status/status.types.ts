/**
 * The engine's public status document — `GET /health/status` (engine resilience program, ADR-0034). Anonymous,
 * cached by the engine for 10 s, statuses and fixed words only: no counts, identifiers or host names.
 */
export type PublicStatusLevel = 'operational' | 'degraded' | 'outage' | 'idle';

export interface PublicStatusComponent {
  /** Stable id: `api`, `database`, `messaging`, `role:money-path`, `marketData`, `realtime`, `brokerConnectivity`, … */
  id: string;
  name: string;
  status: PublicStatusLevel;
  message: string;
}

export interface PublicStatusDocument {
  /** Overall: the worst component (`idle` never counts against it). */
  status: Exclude<PublicStatusLevel, 'idle'>;
  message: string;
  generatedAtUtc: string;
  components: PublicStatusComponent[];
}
