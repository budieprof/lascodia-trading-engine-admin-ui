import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { ScriptingService } from '@core/services/scripting.service';
import { normalizeReplayFrame, normalizeReplayStart, normalizeRunResult } from '../model/normalize';
import type {
  PineReplayFrame,
  PineReplayStartRequest,
  PineReplayStartResponse,
  PineReplayStepRequest,
  PineRunRequest,
  PineRunResult,
} from '../model/pine-outputs.types';

/** The chart, logs, trace and profiler render their own errors: no interceptor toasts. */
const SILENT = { silent: true } as const;

/**
 * The Pine chart's run and Bar Replay port (`docs/api/scripting-api.md` §3 and §5), in the chart's
 * own model: payloads are normalised on the way in (`normalize.ts`), so a field the engine has not
 * shipped yet reads as its Pine default instead of crashing a render.
 *
 * `run` goes through {@link ScriptingService} — the console's one client for the scripting
 * endpoints — and only reshapes its result for the chart. The §5 replay endpoints serve the chart
 * alone and are called from here.
 */
@Injectable({ providedIn: 'root' })
export class ScriptingRunService {
  private readonly api = inject(ApiService);
  private readonly scripting = inject(ScriptingService);

  /**
   * `POST scripting/run`. A script that does not compile still resolves — with `compile.success`
   * false and its diagnostics — whether the engine answers 200 or -11 with the compile result in
   * `data`; transport and other engine failures reject with a `ScriptingApiError`.
   */
  run(request: PineRunRequest): Observable<PineRunResult> {
    return this.scripting.run(request).pipe(
      map((res) => {
        const run = normalizeRunResult(res);
        if (!run) throw new Error('The engine did not return a run result.');
        return run;
      }),
    );
  }

  /** `POST scripting/replay`: the §3 request plus `startBar`; the first frame carries every bar up to it. */
  startReplay(request: PineReplayStartRequest): Observable<PineReplayStartResponse> {
    return this.api.postEnvelope<unknown>('/scripting/replay', request, SILENT).pipe(
      map((data) => {
        const start = normalizeReplayStart(data);
        if (!start)
          throw new ApiError('UNKNOWN', 'The engine did not return a replay session.', {
            data,
            status: false,
            message: null,
            responseCode: null,
          });
        return start;
      }),
    );
  }

  /** `POST scripting/replay/{id}/step` with 1..500 bars. */
  stepReplay(sessionId: string, request: PineReplayStepRequest): Observable<PineReplayFrame> {
    const bars = Math.max(1, Math.min(500, Math.trunc(request.bars)));
    return this.api
      .postEnvelope<unknown>(
        `/scripting/replay/${encodeURIComponent(sessionId)}/step`,
        { ...request, bars },
        SILENT,
      )
      .pipe(map((data) => normalizeReplayFrame(data)));
  }

  /** `DELETE scripting/replay/{id}` (sessions also expire after 30 min idle). */
  stopReplay(sessionId: string): Observable<boolean> {
    return this.api
      .delete<ResponseData<unknown>>(`/scripting/replay/${encodeURIComponent(sessionId)}`, SILENT)
      .pipe(map((res) => res?.status !== false));
  }
}
