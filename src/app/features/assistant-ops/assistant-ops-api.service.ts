import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { PagedData } from '@core/api/api.types';

import type {
  AssistantEvalKind,
  AssistantEvalRun,
  AssistantEvalRunDetail,
  AssistantEvalRuns,
  AssistantHealthAlertRow,
  AssistantMetricsCompare,
  AssistantQuality,
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

  /**
   * `GET assistant/metrics/compare` — the same figures over two windows (before / after a change),
   * re-derived from the conversations so a window from before the telemetry compares like with like.
   */
  compare(
    baselineFrom: string,
    baselineTo: string,
    from: string,
    to: string,
  ): Observable<AssistantMetricsCompare> {
    const q = new URLSearchParams({ baselineFrom, baselineTo, from, to });
    return this.api.getEnvelope<AssistantMetricsCompare>(
      `/assistant/metrics/compare?${q.toString()}`,
      {
        silent: true,
      },
    );
  }

  /** `GET assistant/evals/runs?kind=&days=` — eval runs newest first, the live one and the settings. */
  evalRuns(kind: AssistantEvalKind, days: number): Observable<AssistantEvalRuns> {
    return this.api.getEnvelope<AssistantEvalRuns>(
      `/assistant/evals/runs?kind=${encodeURIComponent(kind)}&days=${Math.round(days)}`,
    );
  }

  /** `GET assistant/evals/runs/{id}` — one run with its cases and checks. */
  evalRun(id: number): Observable<AssistantEvalRunDetail> {
    return this.api.getEnvelope<AssistantEvalRunDetail>(`/assistant/evals/runs/${id}`, {
      silent: true,
    });
  }

  /**
   * `POST assistant/evals/run` (`llmbacktest.launch`) — queue a suite run on the real model now.
   * Refused with -16 while one is queued or running. Silent: the panel says why.
   */
  startEvalRun(): Observable<AssistantEvalRun> {
    return this.api.postEnvelope<AssistantEvalRun>('/assistant/evals/run', {}, { silent: true });
  }

  /** `POST assistant/lessons/{id}/evaluate` — replay the lesson's cases with and without it. */
  evaluateLesson(id: number): Observable<AssistantEvalRun> {
    return this.api.postEnvelope<AssistantEvalRun>(
      `/assistant/lessons/${id}/evaluate`,
      {},
      {
        silent: true,
      },
    );
  }

  /** `GET assistant/quality?days=&lowest=` — judge scores over time and the lowest-scored answers. */
  quality(days: number, lowest: number): Observable<AssistantQuality> {
    return this.api.getEnvelope<AssistantQuality>(
      `/assistant/quality?days=${Math.round(days)}&lowest=${Math.round(lowest)}`,
    );
  }
}
