import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';

import { ThemeService } from '@core/theme/theme.service';

import { toEchartsOption, type VisualSpec } from './visual-spec';

/**
 * Renders one analyst-authored `chart` turn.
 *
 * <p>Everything here is presentation of a spec the engine already validated. The header carries the
 * title (so it wraps and stays selectable rather than being baked into the canvas), the chart body
 * is either an ECharts option or — for a calendar runway — a hand-laid HTML strip, and the caption
 * carries the claim the chart is evidence for.</p>
 *
 * <p>Two affordances are not decoration. The ESTIMATED badge sits ON the artwork, because an
 * OHLCV-derived delta series drawn as a clean line reads as a measurement unless the picture itself
 * says otherwise. And the data disclosure exists so every chart has a table view — the numbers stay
 * reachable for a reader who cannot separate two of the hues, or who wants to copy one.</p>
 */
@Component({
  selector: 'app-analysis-visual',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgxEchartsDirective],
  template: `
    @if (spec(); as s) {
      <figure class="viz" [attr.data-type]="s.type">
        <figcaption class="viz-head">
          <span class="viz-title">{{ s.title }}</span>
          @if (s.subtitle) {
            <span class="viz-sub">{{ s.subtitle }}</span>
          }
          @if (s.estimated) {
            <span class="viz-est" [title]="s.estimatedNote || 'Inferred, not measured.'">
              ESTIMATED
            </span>
          }
        </figcaption>

        @if (s.type === 'timeline') {
          <!-- A runway is a band with shaded windows and labelled ticks; no cartesian series
               expresses that without being fought. -->
          <div class="strip">
            <div class="strip-track">
              @for (w of windows(); track w.label + w.from) {
                <div
                  class="strip-window"
                  [attr.data-kind]="w.kind || 'neutral'"
                  [style.left.%]="w.leftPct"
                  [style.width.%]="w.widthPct"
                  [title]="w.label"
                >
                  <span class="strip-window-label">{{ w.label }}</span>
                </div>
              }
              @for (e of events(); track e.label + e.at) {
                <div
                  class="strip-event"
                  [attr.data-impact]="e.impact || 'low'"
                  [style.left.%]="e.leftPct"
                  [title]="e.note || e.label"
                >
                  <span class="strip-tick"></span>
                  <span class="strip-event-label">{{ e.label }}</span>
                </div>
              }
            </div>
            <div class="strip-axis">
              <span>{{ rangeFrom() }}</span>
              <span>{{ rangeTo() }}</span>
            </div>
          </div>
        } @else if (options(); as opts) {
          <div
            echarts
            [options]="opts"
            [theme]="echartsTheme()"
            [autoResize]="true"
            class="viz-canvas"
            [style.height.px]="height()"
          ></div>
        } @else {
          <div class="viz-empty">This chart type could not be drawn.</div>
        }

        @if (s.caption) {
          <p class="viz-caption">{{ s.caption }}</p>
        }
        @if (s.estimated && s.estimatedNote) {
          <p class="viz-estnote">{{ s.estimatedNote }}</p>
        }

        @if (table(); as t) {
          <details class="viz-data">
            <summary>Data</summary>
            <div class="viz-data-scroll">
              <table>
                <thead>
                  <tr>
                    @for (h of t.head; track h) {
                      <th>{{ h }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of t.rows; track $index) {
                    <tr>
                      @for (cell of row; track $index) {
                        <td>{{ cell }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
        }
      </figure>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .viz {
        margin: 0;
        padding: 0.7rem 0.8rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 8px);
        background: var(--bg-primary);
      }
      .viz-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 0.35rem;
      }
      .viz-title {
        font-size: 0.86rem;
        font-weight: 650;
        color: var(--text-primary);
      }
      .viz-sub {
        font-size: 0.76rem;
        color: var(--text-secondary);
      }
      .viz-est {
        margin-left: auto;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 2px 6px;
        border-radius: 3px;
        color: var(--warning, #b45309);
        border: 1px solid currentColor;
        cursor: help;
      }
      .viz-canvas {
        width: 100%;
      }
      .viz-caption {
        margin: 0.45rem 0 0;
        font-size: 0.76rem;
        line-height: 1.45;
        color: var(--text-secondary);
      }
      .viz-estnote {
        margin: 0.25rem 0 0;
        font-size: 0.72rem;
        color: var(--warning, #b45309);
      }
      .viz-empty {
        padding: 1.2rem;
        text-align: center;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }

      /* ── Data disclosure (the table view every chart is required to have) ── */
      .viz-data {
        margin-top: 0.5rem;
      }
      .viz-data > summary {
        cursor: pointer;
        font-size: 0.72rem;
        color: var(--text-secondary);
        list-style: none;
      }
      .viz-data > summary::-webkit-details-marker {
        display: none;
      }
      .viz-data > summary::before {
        content: '▸ ';
      }
      .viz-data[open] > summary::before {
        content: '▾ ';
      }
      .viz-data-scroll {
        max-height: 220px;
        overflow: auto;
        margin-top: 0.35rem;
      }
      .viz-data table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.72rem;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .viz-data th,
      .viz-data td {
        border-bottom: 1px solid var(--border);
        padding: 2px 8px 2px 0;
        text-align: right;
        white-space: nowrap;
      }
      .viz-data th:first-child,
      .viz-data td:first-child {
        text-align: left;
      }
      .viz-data th {
        color: var(--text-secondary);
        font-weight: 600;
        position: sticky;
        top: 0;
        background: var(--bg-primary);
      }

      /* ── Timeline strip ───────────────────────────────────────────────── */
      .strip {
        padding: 0.4rem 0 0;
      }
      .strip-track {
        position: relative;
        height: 86px;
        border-radius: 4px;
        background: var(--bg-secondary, rgba(0, 0, 0, 0.03));
      }
      .strip-window {
        position: absolute;
        top: 0;
        bottom: 34px;
        border-radius: 3px;
        overflow: hidden;
      }
      .strip-window[data-kind='quiet'] {
        background: rgba(31, 138, 61, 0.14);
      }
      .strip-window[data-kind='risk'] {
        background: rgba(196, 41, 10, 0.14);
      }
      .strip-window[data-kind='session'] {
        background: rgba(0, 113, 227, 0.12);
      }
      .strip-window[data-kind='neutral'] {
        background: rgba(110, 110, 115, 0.14);
      }
      .strip-window-label {
        position: absolute;
        left: 5px;
        top: 3px;
        font-size: 0.68rem;
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .strip-event {
        position: absolute;
        bottom: 0;
        height: 100%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
      }
      .strip-tick {
        width: 2px;
        height: 52px;
        background: var(--text-secondary);
      }
      .strip-event[data-impact='high'] .strip-tick {
        background: #c4290a;
        width: 3px;
      }
      .strip-event[data-impact='medium'] .strip-tick {
        background: #b45309;
      }
      .strip-event-label {
        margin-top: 3px;
        font-size: 0.66rem;
        line-height: 1.2;
        max-width: 92px;
        text-align: center;
        color: var(--text-primary);
      }
      .strip-axis {
        display: flex;
        justify-content: space-between;
        margin-top: 0.3rem;
        font-size: 0.68rem;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AnalysisVisualComponent {
  private readonly theme = inject(ThemeService);

  readonly spec = input.required<VisualSpec>();

  protected readonly echartsTheme = computed(() =>
    this.theme.theme() === 'dark' ? 'dark' : 'default',
  );

  protected readonly options = computed(() =>
    toEchartsOption(this.spec(), this.theme.theme() === 'dark' ? 'dark' : 'light'),
  );

  /** A tree needs vertical room per branch; everything else reads at a fixed chat-panel height. */
  protected readonly height = computed(() => {
    const s = this.spec();
    if (s.type === 'tree') return Math.min(520, 120 + 52 * countLeaves(s.root));
    if (s.type === 'heatmap') return Math.min(520, 140 + 34 * (s.yCategories?.length ?? 4));
    return 300;
  });

  // ── Timeline layout ────────────────────────────────────────────────────────
  // Positions are percentages of the strip's own span, so the strip stays fluid at any chat width.

  private readonly span = computed(() => {
    const s = this.spec();
    const stamps = [
      ...(s.events ?? []).map((e) => Date.parse(e.at)),
      ...(s.windows ?? []).flatMap((w) => [Date.parse(w.from), Date.parse(w.to)]),
      ...(s.from ? [Date.parse(s.from)] : []),
      ...(s.to ? [Date.parse(s.to)] : []),
    ].filter((n) => Number.isFinite(n));
    if (stamps.length === 0) return { from: 0, to: 1 };
    const from = Math.min(...stamps);
    const to = Math.max(...stamps);
    // A single-instant timeline would divide by zero; give it an hour of air either side.
    return to > from ? { from, to } : { from: from - 3.6e6, to: to + 3.6e6 };
  });

  protected readonly events = computed(() => {
    const { from, to } = this.span();
    return (this.spec().events ?? []).map((e) => ({
      ...e,
      leftPct: pct(Date.parse(e.at), from, to),
    }));
  });

  protected readonly windows = computed(() => {
    const { from, to } = this.span();
    return (this.spec().windows ?? []).map((w) => {
      const l = pct(Date.parse(w.from), from, to);
      const r = pct(Date.parse(w.to), from, to);
      return { ...w, leftPct: l, widthPct: Math.max(0.5, r - l) };
    });
  });

  protected readonly rangeFrom = computed(() => stamp(this.span().from));
  protected readonly rangeTo = computed(() => stamp(this.span().to));

  // ── Table view ─────────────────────────────────────────────────────────────

  protected readonly table = computed<{ head: string[]; rows: string[][] } | null>(() => {
    const s = this.spec();
    switch (s.type) {
      case 'line':
      case 'bar':
      case 'stackedbar': {
        const axis = s.x ?? s.categories ?? [];
        const series = s.series ?? [];
        return {
          head: ['', ...series.map((q) => q.name)],
          rows: axis.map((label, i) => [label, ...series.map((q) => cell(q.data[i]))]),
        };
      }
      case 'histogram':
        return {
          head: ['from', 'to', 'count'],
          rows: (s.bins ?? []).map((b) => [cell(b.from), cell(b.to), cell(b.count)]),
        };
      case 'scatter':
        return {
          head: [s.xLabel || 'x', s.yLabel || 'y', 'label'],
          rows: (s.points ?? []).map((p) => [cell(p.x), cell(p.y), p.label ?? '']),
        };
      case 'heatmap': {
        const xs = s.xCategories ?? [];
        const ys = s.yCategories ?? [];
        const by = new Map((s.cells ?? []).map((c) => [`${c.x}:${c.y}`, c.value]));
        return {
          head: ['', ...xs],
          rows: ys.map((y, yi) => [y, ...xs.map((_, xi) => cell(by.get(`${xi}:${yi}`)))]),
        };
      }
      case 'waterfall':
        return {
          head: ['step', 'value', 'note'],
          rows: (s.steps ?? []).map((st) => [st.label, cell(st.value), st.note ?? '']),
        };
      case 'timeline':
        return {
          head: ['when', 'what', 'impact'],
          rows: [
            ...(s.windows ?? []).map((w) => [
              `${stamp(Date.parse(w.from))} → ${stamp(Date.parse(w.to))}`,
              w.label,
              w.kind ?? '',
            ]),
            ...(s.events ?? []).map((e) => [stamp(Date.parse(e.at)), e.label, e.impact ?? '']),
          ],
        };
      default:
        // A tree's content is its labels, which are already fully on screen.
        return null;
    }
  });
}

const pct = (at: number, from: number, to: number): number =>
  Number.isFinite(at) ? Math.max(0, Math.min(100, ((at - from) / (to - from)) * 100)) : 0;

const stamp = (ms: number): string => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};

const cell = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : String(v);

function countLeaves(node: { children?: unknown[] } | undefined): number {
  if (!node) return 1;
  const kids = (node.children ?? []) as { children?: unknown[] }[];
  return kids.length === 0 ? 1 : kids.reduce((n, k) => n + countLeaves(k), 0);
}
