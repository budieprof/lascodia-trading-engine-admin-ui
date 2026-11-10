import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { PagedData } from '@core/api/api.types';

import type {
  AssistantHealthAlertRow,
  AssistantLesson,
  AssistantLessonReviewAction,
  AssistantLessonReviewBody,
  AssistantMetrics,
} from './assistant-ops.types';

/**
 * The assistant's operations surface (engine `AssistantOpsController`, every endpoint
 * `access.operator`). The lesson endpoints are on the assistant's own deny list — only an
 * operator, never the assistant, can approve guidance for it — so they are called from here only.
 */
@Injectable({ providedIn: 'root' })
export class AssistantOpsApiService {
  private readonly api = inject(ApiService);

  /** `GET assistant/metrics?hours=` — windowed health, 1..720 h (engine clamps). */
  metrics(hours: number): Observable<AssistantMetrics> {
    return this.api.getEnvelope<AssistantMetrics>(`/assistant/metrics?hours=${Math.round(hours)}`);
  }

  /**
   * `GET assistant/lessons?status=&source=&take=&skip=` — newest first; status null = every
   * status. An engine older than 3f04f4b1 ignores `skip` (the caller detects the repeat page).
   */
  lessons(
    status: string | null,
    source: string | null,
    take = 100,
    skip = 0,
  ): Observable<AssistantLesson[]> {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (source) q.set('source', source);
    q.set('take', String(take));
    if (skip > 0) q.set('skip', String(skip));
    return this.api
      .getEnvelope<AssistantLesson[]>(`/assistant/lessons?${q.toString()}`)
      .pipe(map((rows) => (Array.isArray(rows) ? rows : [])));
  }

  /**
   * `POST assistant/lessons/{id}/approve|reject|retire`. Silent: a refusal (e.g. "only a candidate
   * can be rejected") is shown in the dialog that asked, not as a toast.
   */
  review(
    id: number,
    action: AssistantLessonReviewAction,
    body: AssistantLessonReviewBody,
  ): Observable<AssistantLesson> {
    return this.api.postEnvelope<AssistantLesson>(`/assistant/lessons/${id}/${action}`, body, {
      silent: true,
    });
  }

  /**
   * The assistant health alerts the engine has open right now (`AssistantHealthAlertWorker` raises
   * them as `AlertType.AssistantHealth`). `POST alert/list` is a read; criteria go in `filter`.
   */
  activeHealthAlerts(): Observable<AssistantHealthAlertRow[]> {
    return this.api
      .postEnvelope<PagedData<AssistantHealthAlertRow>>(
        '/alert/list',
        {
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { alertType: 'AssistantHealth', isActive: true },
          sortBy: 'Id',
          sortDirection: 'desc',
        },
        { silent: true },
      )
      .pipe(map((page) => page?.data ?? []));
  }
}
