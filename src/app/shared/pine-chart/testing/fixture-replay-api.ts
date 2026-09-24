import { HttpErrorResponse } from '@angular/common/http';
import { delay, of, throwError, type Observable } from 'rxjs';
import type {
  PineReplayFrame,
  PineReplayStartRequest,
  PineReplayStartResponse,
  PineReplayStepRequest,
  PineReportTrade,
  PineRunResult,
  PineScriptOutputs,
  PineStrategyReport,
} from '../model/pine-outputs.types';
import type { ReplayApi } from '../replay/replay-session';

/**
 * Cuts outputs to the bar window [fromBar, toBar] the way `OutputCollector.Export(fromBar, toBar)`
 * does: per-bar series are sliced to the window, markers keep the points inside it, and drawings,
 * tables, logs and alerts are exported whole — here "whole as of `toBar`" (created by then).
 */
export function sliceOutputs(o: PineScriptOutputs, fromBar: number, toBar: number): PineScriptOutputs {
  const first = o.bars.firstIndex;
  const n = o.bars.times.length;
  const a = Math.max(fromBar, first);
  const b = Math.min(toBar, first + n - 1);
  const s = a - first;
  const e = Math.max(s, b - first + 1);
  const cut = <T>(arr: readonly T[]): T[] => arr.slice(s, e);
  const cutOpt = <T>(arr: readonly T[] | null | undefined): T[] | null => (arr ? arr.slice(s, e) : null);
  const inWindow = (bar: number) => bar >= a && bar <= b;
  return {
    ...o,
    bars: { firstIndex: a, times: cut(o.bars.times), timeframe: o.bars.timeframe },
    plots: o.plots.map((p) => ({ ...p, values: cut(p.values), colors: cutOpt(p.colors) })),
    markers: o.markers.map((m) => ({ ...m, points: m.points.filter((pt) => inWindow(pt.barIndex)) })),
    candles: o.candles.map((c) => ({
      ...c,
      open: cut(c.open),
      high: cut(c.high),
      low: cut(c.low),
      close: cut(c.close),
      colors: cutOpt(c.colors),
      wickColors: cutOpt(c.wickColors),
      borderColors: cutOpt(c.borderColors),
    })),
    backgrounds: o.backgrounds.map((x) => ({ ...x, colors: cut(x.colors) })),
    barColors: o.barColors.map((x) => ({ ...x, colors: cut(x.colors) })),
    fills: o.fills.map((f) => ({
      ...f,
      colors: cutOpt(f.colors),
      topValues: cutOpt(f.topValues),
      bottomValues: cutOpt(f.bottomValues),
      topColors: cutOpt(f.topColors),
      bottomColors: cutOpt(f.bottomColors),
    })),
    labels: o.labels.filter((l) => l.createdBar <= toBar),
    lines: o.lines.filter((l) => l.createdBar <= toBar),
    boxes: o.boxes.filter((l) => l.createdBar <= toBar),
    polylines: o.polylines.filter((l) => l.createdBar <= toBar),
    linefills: o.linefills,
    alerts: o.alerts.filter((x) => x.barIndex <= toBar),
    logs: o.logs.filter((x) => x.barIndex <= toBar),
  };
}

/** The report as of `toBar`: later trades dropped, trades still running then reported open. */
export function sliceReport(r: PineStrategyReport | null, toBar: number): PineStrategyReport | null {
  if (!r) return null;
  const trades: PineReportTrade[] = [];
  for (const t of r.trades) {
    if (t.entryBarIndex > toBar) continue;
    const closedBy = t.exitBarIndex !== null && t.exitBarIndex !== undefined && t.exitBarIndex <= toBar;
    trades.push(
      closedBy && !t.isOpen
        ? t
        : { ...t, isOpen: true, exitId: null, exitSignal: null, exitTime: null, exitBarIndex: null, exitPrice: null },
    );
  }
  return { ...r, trades };
}

/**
 * A §5 replay served from a finished run — Bar Replay without an engine (the chart lab, tests).
 * Frames are the run's bars and outputs cut to each step's window.
 */
export class FixtureReplayApi implements ReplayApi {
  private readonly sessions = new Map<string, { pos: number }>();
  private counter = 0;

  constructor(
    private readonly run: PineRunResult,
    private readonly latencyMs = 0,
  ) {}

  private frame(fromBar: number, toBar: number): PineReplayFrame {
    const first = this.run.outputs?.bars.firstIndex ?? 0;
    const bars = this.run.bars.slice(Math.max(0, fromBar - first), Math.max(0, toBar - first + 1));
    return {
      barIndex: toBar,
      bars,
      outputsDelta: this.run.outputs ? sliceOutputs(this.run.outputs, fromBar, toBar) : null,
      report: sliceReport(this.run.report, toBar),
      position: null,
    };
  }

  private latency<T>(o: Observable<T>): Observable<T> {
    return this.latencyMs > 0 ? o.pipe(delay(this.latencyMs)) : o;
  }

  private get lastBar(): number {
    return (this.run.outputs?.bars.firstIndex ?? 0) + this.run.bars.length - 1;
  }

  startReplay(request: PineReplayStartRequest): Observable<PineReplayStartResponse> {
    const id = `fixture-${++this.counter}`;
    const first = this.run.outputs?.bars.firstIndex ?? 0;
    const pos = Math.max(first, Math.min(this.lastBar, Math.trunc(request.startBar)));
    this.sessions.set(id, { pos });
    return this.latency(of({ sessionId: id, frame: this.frame(first, pos) }));
  }

  stepReplay(sessionId: string, request: PineReplayStepRequest): Observable<PineReplayFrame> {
    const s = this.sessions.get(sessionId);
    if (!s) return throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));
    const from = s.pos + 1;
    const to = Math.min(this.lastBar, s.pos + Math.max(1, request.bars));
    if (from > this.lastBar) {
      return this.latency(of<PineReplayFrame>({ barIndex: s.pos, bars: [], outputsDelta: null, report: null, position: null }));
    }
    s.pos = to;
    return this.latency(of(this.frame(from, to)));
  }

  stopReplay(sessionId: string): Observable<boolean> {
    this.sessions.delete(sessionId);
    return of(true);
  }
}
