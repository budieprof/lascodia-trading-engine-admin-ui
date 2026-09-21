import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';

import { ThemeService } from '@core/theme/theme.service';

import { MARKER_GAP_PX, layoutTimeline } from './timeline-layout';
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
          <!-- A runway is a band with shaded windows and numbered markers; no cartesian series
               expresses that without being fought. The words live in the agenda below, where
               each gets a full line — see timeline-layout.ts for why. -->
          @if (timeline(); as tl) {
            <div class="strip">
              <div class="strip-track" [style.height.px]="trackHeight()">
                @for (w of tl.windows; track w.label + w.from) {
                  <div
                    class="strip-window"
                    [attr.data-kind]="w.kind || 'neutral'"
                    [style.left.%]="w.leftPct"
                    [style.width.%]="w.widthPct"
                    [title]="w.label + ' · ' + w.range"
                  >
                    <span class="strip-window-label">{{ w.label }}</span>
                  </div>
                }
                @for (m of tl.midnights; track m) {
                  <div class="strip-midnight" [style.left.%]="m"></div>
                }
                @for (e of tl.events; track e.n) {
                  <div
                    class="strip-event"
                    [attr.data-impact]="e.impact || 'low'"
                    [style.left.%]="e.leftPct"
                    [style.top.px]="laneTop(e.lane)"
                    [title]="e.n + '. ' + e.time + ' · ' + e.label + (e.note ? ' — ' + e.note : '')"
                  >
                    <span class="strip-badge">{{ e.n }}</span>
                    <span class="strip-stem"></span>
                  </div>
                }
              </div>
              <div class="strip-days">
                @for (d of tl.days; track d.leftPct) {
                  <span [style.left.%]="d.leftPct" [style.width.%]="d.widthPct">{{ d.label }}</span>
                }
              </div>

              @if (tl.windows.length) {
                <div class="strip-legend">
                  @for (w of tl.windows; track w.label + w.from) {
                    <span class="strip-legend-item">
                      <span class="strip-swatch" [attr.data-kind]="w.kind || 'neutral'"></span>
                      {{ w.label }} <span class="strip-muted">{{ w.range }}</span>
                    </span>
                  }
                </div>
              }

              @if (tl.agenda.length) {
                <div class="agenda">
                  @for (d of tl.agenda; track d.day) {
                    <div class="agenda-day">{{ d.day }}</div>
                    @for (e of d.events; track e.n) {
                      <div class="agenda-row" [attr.data-impact]="e.impact || 'low'">
                        <span class="strip-badge">{{ e.n }}</span>
                        <span class="agenda-time">{{ e.time }}</span>
                        <span class="agenda-what">
                          {{ e.label }}
                          @if (e.note) {
                            <span class="strip-muted"> · {{ e.note }}</span>
                          }
                        </span>
                        <span class="agenda-impact">{{ e.impact || 'low' }}</span>
                      </div>
                    }
                  }
                </div>
              }
            </div>
          }
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
        border-radius: 4px;
        background: var(--bg-secondary, rgba(0, 0, 0, 0.03));
      }
      .strip-window {
        position: absolute;
        top: 0;
        bottom: 0;
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
        right: 5px;
        top: 3px;
        font-size: 0.68rem;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .strip-midnight {
        position: absolute;
        top: 0;
        bottom: 0;
        border-left: 1px dashed var(--border);
      }
      .strip-event {
        position: absolute;
        bottom: 0;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        cursor: default;
        z-index: 1;
      }
      .strip-event:hover {
        z-index: 2;
      }
      .strip-stem {
        flex: 1;
        width: 2px;
        background: var(--impact-color);
        opacity: 0.7;
      }
      /* The marker. Colour carries impact; the number ties it to its agenda line. */
      .strip-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        font-size: 0.62rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #fff;
        background: var(--impact-color);
        box-shadow: 0 0 0 2px var(--bg-primary);
      }
      [data-impact] {
        --impact-color: #6e6e73;
      }
      [data-impact='medium'] {
        --impact-color: #b45309;
      }
      [data-impact='high'] {
        --impact-color: #c4290a;
      }
      .strip-days {
        position: relative;
        height: 1.1rem;
        margin-top: 0.2rem;
        font-size: 0.68rem;
        color: var(--text-secondary);
      }
      .strip-days > span {
        position: absolute;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
      }
      .strip-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 1rem;
        margin-top: 0.3rem;
        font-size: 0.72rem;
        color: var(--text-primary);
      }
      /* Inline flow, not flex: in a narrow pane the range wraps UNDER the label instead of
         splitting the item into three squeezed columns. */
      .strip-legend-item {
        display: inline;
      }
      .strip-swatch {
        display: inline-block;
        vertical-align: -1px;
        margin-right: 0.3rem;
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }
      .strip-swatch[data-kind='quiet'] {
        background: rgba(31, 138, 61, 0.45);
      }
      .strip-swatch[data-kind='risk'] {
        background: rgba(196, 41, 10, 0.45);
      }
      .strip-swatch[data-kind='session'] {
        background: rgba(0, 113, 227, 0.4);
      }
      .strip-swatch[data-kind='neutral'] {
        background: rgba(110, 110, 115, 0.45);
      }
      .strip-muted {
        color: var(--text-secondary);
      }

      /* ── Agenda: the event names, one full line each ── */
      .agenda {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        align-items: center;
        gap: 0.2rem 0.55rem;
        margin-top: 0.55rem;
        font-size: 0.76rem;
      }
      .agenda-day {
        grid-column: 1 / -1;
        margin-top: 0.3rem;
        padding-bottom: 0.1rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.7rem;
        font-weight: 650;
        letter-spacing: 0.02em;
        color: var(--text-secondary);
      }
      .agenda-row {
        display: contents;
      }
      .agenda-time {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.72rem;
        color: var(--text-secondary);
      }
      .agenda-what {
        color: var(--text-primary);
        min-width: 0;
      }
      .agenda-row[data-impact='high'] .agenda-what {
        font-weight: 650;
      }
      .agenda-impact {
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--impact-color);
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
  // Lane packing needs the width in px (a marker is a fixed size), hence the observer.

  private readonly widthPx = signal(640);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver((entries) => {
        const w = Math.round(entries[0]?.contentRect.width ?? 0);
        if (w > 0 && w !== this.widthPx()) this.widthPx.set(w);
      });
      ro.observe(host.nativeElement);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  protected readonly timeline = computed(() => {
    const s = this.spec();
    return s.type === 'timeline' ? layoutTimeline(s, this.widthPx()) : null;
  });

  /** Top row holds the window labels; one lane per marker row; the rest is stem. */
  protected laneTop(lane: number): number {
    return TIMELINE_LABEL_ROW_PX + lane * MARKER_GAP_PX;
  }

  protected readonly trackHeight = computed(
    () => this.laneTop(Math.max(1, this.timeline()?.lanes ?? 1)) + 14,
  );

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
      default:
        // A tree's content is its labels, which are already fully on screen — and so is a
        // timeline's: its agenda and window legend ARE the table.
        return null;
    }
  });
}

const TIMELINE_LABEL_ROW_PX = 22;

const cell = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : String(v);

function countLeaves(node: { children?: unknown[] } | undefined): number {
  if (!node) return 1;
  const kids = (node.children ?? []) as { children?: unknown[] }[];
  return kids.length === 0 ? 1 : kids.reduce((n, k) => n + countLeaves(k), 0);
}
