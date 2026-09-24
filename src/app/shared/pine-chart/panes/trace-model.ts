import type { PineTraceBar, PineTraceItem } from '../model/pine-outputs.types';

/**
 * "Why didn't it fire?" — navigation over a run's trace: the engine evaluates every traced
 * expression on each bar of the trace window and reports its source span and value.
 */

export type TraceValueKind = 'true' | 'false' | 'na' | 'number' | 'text';

export function traceValueKind(value: string): TraceValueKind {
  const v = value.trim();
  if (v === 'true') return 'true';
  if (v === 'false') return 'false';
  if (v === 'na' || v === 'NaN' || v === '') return 'na';
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return 'number';
  return 'text';
}

export interface TraceRow extends PineTraceItem {
  kind: TraceValueKind;
  /** The value on the previous traced bar, when it differs (what changed this bar). */
  previous: string | null;
}

export class TraceNavigator {
  private readonly byBar = new Map<number, PineTraceBar>();
  /** Traced bar indices, ascending. */
  readonly bars: number[];

  constructor(trace: readonly PineTraceBar[]) {
    for (const t of trace) this.byBar.set(t.bar, t);
    this.bars = [...this.byBar.keys()].sort((a, b) => a - b);
  }

  get empty(): boolean {
    return this.bars.length === 0;
  }

  get first(): number | null {
    return this.bars.length ? this.bars[0] : null;
  }

  get last(): number | null {
    return this.bars.length ? this.bars[this.bars.length - 1] : null;
  }

  has(bar: number): boolean {
    return this.byBar.has(bar);
  }

  covers(bar: number): boolean {
    return this.bars.length > 0 && bar >= this.bars[0] && bar <= this.bars[this.bars.length - 1];
  }

  timeOf(bar: number): number | null {
    return this.byBar.get(bar)?.timeMs ?? null;
  }

  /** The traced bar closest to `bar` (ties go to the earlier bar). */
  nearest(bar: number): number | null {
    const b = this.bars;
    if (!b.length) return null;
    let lo = 0;
    let hi = b.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (b[mid] < bar) lo = mid + 1;
      else hi = mid;
    }
    const after = b[lo];
    const before = lo > 0 ? b[lo - 1] : after;
    return Math.abs(bar - before) <= Math.abs(after - bar) ? before : after;
  }

  /** The traced bar `delta` steps from `bar` (clamped to the window), or null when empty. */
  step(bar: number, delta: number): number | null {
    const b = this.bars;
    if (!b.length) return null;
    let i = b.indexOf(bar);
    if (i < 0) {
      const n = this.nearest(bar);
      i = n === null ? 0 : b.indexOf(n);
    }
    return b[Math.max(0, Math.min(b.length - 1, i + delta))];
  }

  /** Items at a bar in source order, with the previous traced bar's value where it changed. */
  rowsAt(bar: number): TraceRow[] | null {
    const t = this.byBar.get(bar);
    if (!t) return null;
    const i = this.bars.indexOf(bar);
    const prev = i > 0 ? this.byBar.get(this.bars[i - 1]) : undefined;
    const prevByKey = new Map<string, string>();
    for (const it of prev?.items ?? []) prevByKey.set(spanKey(it), it.value);
    return [...t.items]
      .sort((a, b) => a.line - b.line || a.column - b.column || a.endLine - b.endLine || a.endColumn - b.endColumn)
      .map((it) => {
        const before = prevByKey.get(spanKey(it));
        return {
          ...it,
          kind: traceValueKind(it.value),
          previous: before !== undefined && before !== it.value ? before : null,
        };
      });
  }
}

function spanKey(i: PineTraceItem): string {
  return `${i.line}:${i.column}:${i.endLine}:${i.endColumn}`;
}

/** A trace window of `size` bars centred on `bar`, clamped at 0. */
export function traceWindowAround(bar: number, size = 100): { fromBar: number; toBar: number } {
  const half = Math.floor(size / 2);
  const from = Math.max(0, bar - half);
  return { fromBar: from, toBar: from + size - 1 };
}
