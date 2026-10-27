import { Injectable, signal } from '@angular/core';

import type { VenueOrderType } from '@features/venues/venues.types';
import type { VenueSide } from './venue-ticket-model';

/** A request to open the exchange-traded ticket at a price (from the DOM ladder or the chart). */
export interface VenueTicketRequest {
  symbol: string;
  side: VenueSide;
  orderType: VenueOrderType;
  price: number | null;
  /** Increments on every request so the same click twice still opens the ticket. */
  seq: number;
}

/**
 * Hands a ladder click on an EXCHANGE-TRADED instrument to the chart's venue ticket (multi-asset WS7 7.6): the ladder
 * never places a venue order itself — it opens the ticket prefilled, where the engine's dry run shows margin and risk.
 * FX / CFD ladders never use it (they keep today's manual-signal path).
 */
@Injectable({ providedIn: 'root' })
export class VenueTicketBus {
  private seq = 0;
  readonly request = signal<VenueTicketRequest | null>(null);

  open(r: Omit<VenueTicketRequest, 'seq'>): void {
    this.request.set({ ...r, seq: ++this.seq });
  }

  clear(): void {
    this.request.set(null);
  }
}
