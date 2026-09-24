import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
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
 * The scripting endpoints the Pine chart drives: §3 run/preview and §5 Bar Replay sessions
 * (`docs/api/scripting-api.md`). Payloads are normalised on the way in (`normalize.ts`), so a field
 * the engine has not shipped yet reads as its Pine default instead of crashing a render.
 */
@Injectable({ providedIn: 'root' })
export class ScriptingRunApiService {
  private readonly api = inject(ApiService);

  /**
   * `POST scripting/run`. A script that does not compile still resolves — with `compile.success`
   * false and its diagnostics — whether the engine answers 200 or -11 with the compile result in
   * `data`; transport and other engine errors reject.
   */
  run(request: PineRunRequest): Observable<PineRunResult> {
    return this.api.post<ResponseData<unknown>>('/scripting/run', request, SILENT).pipe(
      map((res) => {
        if (res?.status && res.data) {
          const run = normalizeRunResult(res.data);
          if (run) return run;
        }
        if (res?.data && typeof res.data === 'object') {
          const d = res.data as Record<string, unknown>;
          const run = normalizeRunResult('compile' in d ? d : { compile: d });
          if (run?.compile) return run;
        }
        throw new ApiError(
          res?.responseCode ?? 'UNKNOWN',
          res?.message ?? 'The engine could not run the script.',
          res as ResponseData<unknown>,
        );
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
