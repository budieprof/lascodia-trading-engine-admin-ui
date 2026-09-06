import { Injectable, inject } from '@angular/core';
import { Observable, timeout } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/** The anchor conversation behind one assistant chat. */
export interface AssistantSessionDto {
  sessionLlmInvocationId: number;
  title: string;
  createdAtUtc: string;
}

/**
 * A question can take several LLM round-trips with no streaming, so the client waits a
 * long time by design. Past this the answer may still land — the thread is refetched on
 * failure for exactly that reason.
 */
const ASK_TIMEOUT_MS = 180_000;

/**
 * Transport for the admin assistant.
 *
 * <p>Only session creation is new. Reading the thread and resolving a proposed action reuse
 * the follow-up endpoints the spot-analysis chat has used since it shipped, because an
 * assistant session is the same object: an anchor conversation with turns hanging off it.</p>
 */
@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly api = inject(ApiService);

  /** Open a new chat. Returns the anchor id, which is also its id on /conversations. */
  startSession(title = 'Assistant session'): Observable<ResponseData<AssistantSessionDto>> {
    return this.api.post('/market-data/assistant/session', { title }, { silent: true });
  }

  /**
   * Ask a question. `pageContext` is the serialised {@link PageContext} for wherever the
   * operator is standing at the moment they press send.
   */
  ask(
    llmInvocationId: number,
    question: string,
    pageContext: string | null,
  ): Observable<ResponseData<SpotAnalysisFollowUpTurnDto>> {
    return this.api
      .post<
        ResponseData<SpotAnalysisFollowUpTurnDto>
      >(`/market-data/analyze/${llmInvocationId}/follow-up`, { question, pageContext: pageContext ? JSON.parse(pageContext) : undefined }, { silent: true })
      .pipe(timeout(ASK_TIMEOUT_MS));
  }
}
