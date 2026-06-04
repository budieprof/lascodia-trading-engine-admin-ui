import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  ResponseData,
  NotificationFeedResult,
  MarkAllNotificationsReadRequest,
  MuteNotificationRequest,
  UnmuteNotificationRequest,
  MutedTypeDto,
} from '@core/api/api.types';

/**
 * Talks to the engine's `/admin/notifications` endpoints — the unified
 * feed that aggregates alert firings, EA error log entries, signal-rejection
 * events, and EA-state anomalies into one bell-friendly stream, plus the
 * per-operator read-state and mute persistence.
 *
 * Why a separate file from `notification.service.ts`:
 * the latter is the toast/in-app banner notifier — a pure-client utility.
 * This service is the engine-backed feed of operationally-significant
 * events.  Keeping them apart so an unrelated refactor of either doesn't
 * accidentally rewire the other.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsFeedService {
  private readonly api = inject(ApiService);
  private readonly base = '/admin/notifications';

  /**
   * Fetch the unified feed.  Filters are optional and additive — passing
   * none returns everything in the window.  Severities + sources arrays
   * are repeated query params (`?severity=Info&severity=Medium`) which
   * Angular's `HttpParams` already encodes correctly when given an array.
   */
  getFeed(params: {
    windowHours?: number;
    limit?: number;
    severities?: string[];
    sources?: string[];
  }): Observable<ResponseData<NotificationFeedResult>> {
    const qs = new URLSearchParams();
    if (params.windowHours != null) qs.set('windowHours', String(params.windowHours));
    if (params.limit != null) qs.set('limit', String(params.limit));
    for (const s of params.severities ?? []) qs.append('severity', s);
    for (const s of params.sources ?? []) qs.append('source', s);
    const suffix = qs.toString().length > 0 ? `?${qs.toString()}` : '';
    return this.api.get<ResponseData<NotificationFeedResult>>(`${this.base}/feed${suffix}`);
  }

  /**
   * Mark the operator's high-water mark — passing the timestamp visible in
   * the panel at click time protects against items that arrived after
   * fetch but before click.
   */
  markAllRead(body: MarkAllNotificationsReadRequest = {}): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(`${this.base}/mark-all-read`, body);
  }

  /** Mute a notification type-key for N hours. */
  mute(body: MuteNotificationRequest): Observable<ResponseData<MutedTypeDto>> {
    return this.api.post<ResponseData<MutedTypeDto>>(`${this.base}/mute`, body);
  }

  /** Clear an active mute for a specific type-key. */
  unmute(body: UnmuteNotificationRequest): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(`${this.base}/unmute`, body);
  }
}
