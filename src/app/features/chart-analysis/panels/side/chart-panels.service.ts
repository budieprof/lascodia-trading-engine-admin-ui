import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  AccountStrip,
  ChartNote,
  CreateNoteBody,
  OrderBookSnapshot,
  PairSentiment,
  UpdateNoteBody,
} from './chart-panels.types';

const SILENT = { silent: true };

/** HTTP for the chart side panels (SP-I9). Every call is silent: each panel says what failed in place. */
@Injectable({ providedIn: 'root' })
export class ChartPanelsService {
  private readonly api = inject(ApiService);

  notes(symbol: string | null, take = 50): Observable<ChartNote[]> {
    const qs = new URLSearchParams({ take: String(take) });
    if (symbol) qs.set('symbol', symbol);
    return this.api.getEnvelope<ChartNote[]>(`/chart-note?${qs}`, SILENT);
  }

  note(id: number): Observable<ChartNote> {
    return this.api.getEnvelope<ChartNote>(`/chart-note/${id}`, SILENT);
  }

  createNote(body: CreateNoteBody): Observable<ChartNote> {
    return this.api.postEnvelope<ChartNote>('/chart-note', body, SILENT);
  }

  updateNote(id: number, body: UpdateNoteBody): Observable<ChartNote> {
    return this.api.putEnvelope<ChartNote>(`/chart-note/${id}`, body, SILENT);
  }

  deleteNote(id: number): Observable<boolean> {
    return this.api.deleteEnvelope<boolean>(`/chart-note/${id}`, SILENT);
  }

  sentiment(symbol: string): Observable<PairSentiment> {
    return this.api.getEnvelope<PairSentiment>(`/chart-panels/sentiment/${encodeURIComponent(symbol)}`, SILENT);
  }

  /** `accountIds` empty = every account. */
  accountStrip(symbol: string, accountIds: readonly number[]): Observable<AccountStrip> {
    const qs = new URLSearchParams({ symbol });
    if (accountIds.length) qs.set('tradingAccountIds', accountIds.join(','));
    return this.api.getEnvelope<AccountStrip>(`/chart-panels/account-strip?${qs}`, SILENT);
  }

  orderBook(symbol: string): Observable<OrderBookSnapshot> {
    return this.api.getEnvelope<OrderBookSnapshot>(
      `/market-data/order-book/latest/${encodeURIComponent(symbol)}`,
      SILENT,
    );
  }
}
