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
/**
 * Re-parse the serialised context, or send none.
 *
 * <p>A bare `JSON.parse` here used to throw on a malformed payload and take the whole
 * question down with it. The context is an optional enrichment — losing it should cost the
 * assistant some awareness, never the operator their message — so a payload that will not
 * parse is dropped and the question still goes.</p>
 */
function parseContext(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** One todo on an assistant task. */
export interface AssistantTodo {
  id: string;
  text: string;
  /** pending | in_progress | done | skipped | blocked */
  status: string;
  note?: string | null;
}

/** An admin-assistant long-running task (engine AssistantTaskDto). */
export interface AssistantTaskDto {
  id: number;
  sessionLlmInvocationId: number;
  goal: string;
  /** Active | Waiting | Done | Failed | Cancelled */
  status: string;
  currentActivity?: string | null;
  todos: AssistantTodo[];
  activity: { atUtc: string; kind: string; text: string }[];
  wakeCount: number;
  maxWakes: number;
  budgetUsd: number;
  spentUsd: number;
  waitingOnMonitorIds: number[];
  createdAtUtc: string;
  updatedAtUtc: string;
  endedAtUtc?: string | null;
  endReason?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly api = inject(ApiService);

  /** The conversation's long-running task (latest, live or ended); `data` is null when it has none. */
  getTask(sessionId: number): Observable<ResponseData<AssistantTaskDto | null>> {
    return this.api.get(`/market-data/assistant/session/${sessionId}/task`, { silent: true });
  }

  /** Stop the live task: it, every monitor it armed and every queued wake are cancelled. */
  cancelTask(
    sessionId: number,
    reason?: string,
  ): Observable<ResponseData<AssistantTaskDto | null>> {
    return this.api.post(`/market-data/assistant/session/${sessionId}/task/cancel`, { reason });
  }

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
    /** A JPEG of the operator's screen, bare base64. Only while they are sharing. */
    screenshot?: string | null,
  ): Observable<ResponseData<SpotAnalysisFollowUpTurnDto>> {
    return this.api
      .post<
        ResponseData<SpotAnalysisFollowUpTurnDto>
      >(`/market-data/analyze/${llmInvocationId}/follow-up`, { question, pageContext: parseContext(pageContext), screenshot: screenshot || undefined }, { silent: true })
      .pipe(timeout(ASK_TIMEOUT_MS));
  }
}
