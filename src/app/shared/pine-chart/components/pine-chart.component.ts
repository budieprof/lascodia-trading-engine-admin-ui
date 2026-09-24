import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ThemeService } from '@core/theme/theme.service';
import { formatValue, zoneOffsetMinutes } from '../core/format';
import {
  PINE_CHART_DARK,
  PINE_CHART_LIGHT,
  PineChartRenderer,
  type CrosshairEvent,
  type PaneRect,
} from '../lwc/pine-chart-renderer';
import { toPineChartData, type PineChartData } from '../model/chart-data';
import { buildRenderModel } from '../render/build-render-model';
import { dataWindowAt, legendLogical, statusLines, type LegendValue } from '../render/legend';
import type { PaneKey, PineRenderModel, TableLayout } from '../render/render-model';
import { PineDataWindowComponent } from './pine-data-window.component';
import { PineTableOverlayComponent } from './pine-table-overlay.component';

/** A bar the chart points at. */
export interface PineBarRef {
  barIndex: number;
  /** Chart logical index (0 = first bar the chart holds). */
  logical: number;
  /** Bar open time (ms), extrapolated past the data. */
  time: number;
}

interface PaneOverlay {
  key: PaneKey;
  rect: PaneRect;
  tables: readonly TableLayout[];
  /** Script status-line values drawn in this pane (null = no script row here). */
  script: LegendValue[] | null;
}

/**
 * The Pine chart: renders a §3 run result (or an accumulated Bar Replay) on Lightweight Charts —
 * price bars, every output kind of the script, strategy trades — with a status line per pane, a data
 * window, tables over their pane and tooltips.
 *
 * Host it in a sized container (it fills its host). `result` takes the run response `data`, the
 * whole envelope, UI-IDE's `ScriptRunResult` or a `PineChartData`. Give a replay's growing data to the
 * same input: a result that extends the previous one keeps the view and follows the newest bar.
 */
@Component({
  selector: 'app-pine-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PineTableOverlayComponent, PineDataWindowComponent],
  template: `
    <div class="surface" #surface></div>

    @for (o of overlays(); track o.key) {
      <div
        class="pane-overlay"
        [style.top.px]="o.rect.top"
        [style.left.px]="o.rect.left"
        [style.width.px]="o.rect.width"
        [style.height.px]="o.rect.height"
      >
        <app-pine-table-overlay [tables]="o.tables" [paneWidth]="o.rect.width" [paneHeight]="o.rect.height" />
        <div class="status">
          @if (o.key === 'main' && ohlc(); as b) {
            <div class="status-row">
              @if (symbol()) {
                <span class="symbol">{{ symbol() }}</span>
              }
              @if (timeframe()) {
                <span class="muted">{{ timeframe() }}</span>
              }
              <span class="ohlc" [class.up]="b.up" [class.down]="!b.up">
                O<b>{{ b.o }}</b> H<b>{{ b.h }}</b> L<b>{{ b.l }}</b> C<b>{{ b.c }}</b>
                @if (b.change) {
                  <b>{{ b.change }}</b>
                }
              </span>
            </div>
          }
          @if (o.script; as values) {
            <div class="status-row script">
              <span class="title">{{ title() }}</span>
              @for (v of values; track v.key) {
                <span class="val" [style.color]="v.color" [attr.title]="v.title">{{ v.text }}</span>
              }
            </div>
          }
        </div>
      </div>
    }

    <!-- Bottom-right of the last pane, shown on hover: tables own the pane corners at rest. -->
    <div class="toolbar" [class.pinned]="dataWindow()" [style.bottom.px]="toolbarBottom()" [style.right.px]="toolbarRight()">
      @if (hasTrades()) {
        <button type="button" [class.on]="tradesOn()" (click)="tradesOn.set(!tradesOn())" title="Show strategy trades on the chart">
          Trades
        </button>
      }
      <button type="button" [class.on]="dataWindow()" (click)="dataWindow.set(!dataWindow())" title="Data window">
        Data
      </button>
      <button type="button" (click)="resetView()" title="Reset the view to the newest bars">Reset</button>
    </div>

    @if (dataWindow() && !empty()) {
      <app-pine-data-window
        class="data-window"
        [style.top.px]="dataWindowTop()"
        [style.right.px]="toolbarRight()"
        [sections]="dataSections()"
        (closed)="dataWindow.set(false)"
      />
    }

    @if (tooltip(); as t) {
      <div class="tooltip" role="tooltip" [style.left.px]="t.left" [style.top.px]="t.top">{{ t.text }}</div>
    }

    @if (empty()) {
      <div class="empty">{{ emptyText() }}</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        min-height: 240px;
        overflow: hidden;
        background: var(--pine-chart-bg, transparent);
      }
      .surface {
        position: absolute;
        inset: 0;
        /* The library z-indexes its canvases: contain them so the overlays stay on top. */
        z-index: 0;
      }
      .pane-overlay {
        position: absolute;
        z-index: 1;
        pointer-events: none;
        overflow: hidden;
      }
      .status {
        position: absolute;
        top: 4px;
        left: 8px;
        right: 8px;
        font-size: 12px;
        line-height: 1.55;
        pointer-events: none;
        color: var(--pine-chart-text, #131722);
        text-shadow: 0 0 3px var(--pine-chart-halo, rgba(255, 255, 255, 0.9));
      }
      .status-row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 10px;
        font-variant-numeric: tabular-nums;
      }
      .symbol {
        font-weight: 600;
      }
      .muted {
        opacity: 0.7;
      }
      .ohlc b {
        font-weight: 500;
        margin: 0 2px;
      }
      .ohlc.up b {
        color: #089981;
      }
      .ohlc.down b {
        color: #f23645;
      }
      .script .title {
        font-weight: 500;
      }
      .toolbar {
        position: absolute;
        display: flex;
        gap: 4px;
        z-index: 3;
        opacity: 0;
        transition: opacity var(--dur-fast, 0.15s);
      }
      :host(:hover) .toolbar,
      .toolbar:focus-within,
      .toolbar.pinned {
        opacity: 1;
      }
      .toolbar button {
        font: inherit;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        border: 1px solid var(--pine-chart-border, rgba(0, 0, 0, 0.12));
        background: var(--pine-chart-button, rgba(255, 255, 255, 0.85));
        color: var(--pine-chart-text, #131722);
        cursor: pointer;
      }
      .toolbar button.on {
        border-color: var(--accent, #0071e3);
        color: var(--accent, #0071e3);
      }
      .data-window {
        position: absolute;
        z-index: 3;
        max-height: calc(100% - 48px);
      }
      .tooltip {
        position: absolute;
        z-index: 4;
        max-width: 320px;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(19, 23, 34, 0.92);
        color: #fff;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
        pointer-events: none;
      }
      .empty {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: grid;
        place-items: center;
        color: var(--text-tertiary, #86868b);
        font-size: 13px;
        pointer-events: none;
      }
      :host-context([data-theme='dark']) {
        --pine-chart-text: #d1d4dc;
        --pine-chart-halo: rgba(19, 23, 34, 0.9);
        --pine-chart-border: rgba(255, 255, 255, 0.14);
        --pine-chart-button: rgba(30, 34, 45, 0.9);
      }
    `,
  ],
})
export class PineChartComponent implements OnDestroy {
  private readonly theme = inject(ThemeService);
  private readonly zone = inject(NgZone);
  private readonly surface = viewChild.required<ElementRef<HTMLDivElement>>('surface');

  /** The run result (§3 `data`, envelope, `ScriptRunResult`) or `PineChartData`. */
  readonly result = input<PineChartData | null, unknown>(null, { transform: toPineChartData });
  readonly symbol = input('');
  readonly timeframe = input('');
  /** Symbol price decimals; inferred from the bars when null. */
  readonly pricePrecision = input<number | null>(null);
  readonly showTrades = input(true);
  /** IANA zone for the time axis, the data window and bar times (data stays UTC). */
  readonly timezone = input('UTC');
  /** bar_index to highlight (selected log line, trace bar, replay start). */
  readonly highlightBar = input<number | null>(null);
  readonly emptyText = input('Run the script to see its outputs on the chart.');
  /** Data window open (two-way bindable). */
  readonly dataWindow = model(false);

  /** A bar was clicked (trace bar selection, replay start picking). */
  readonly barClick = output<PineBarRef>();
  /** The crosshair moved to another bar (null when it left the chart). */
  readonly crosshairBar = output<PineBarRef | null>();

  readonly renderModel = computed<PineRenderModel | null>(() => {
    const data = this.result();
    return data ? buildRenderModel(data, { pricePrecision: this.pricePrecision() }) : null;
  });

  readonly tradesOn = linkedSignal(() => this.showTrades());
  readonly tooltip = signal<{ text: string; left: number; top: number } | null>(null);
  private readonly hovered = signal<number | null>(null);
  private readonly rects = signal<PaneRect[]>([]);
  private readonly ready = signal(false);
  private renderer: PineChartRenderer | null = null;
  private layoutFrame = 0;

  readonly empty = computed(() => {
    const m = this.renderModel();
    return !m || m.bars.time.length === 0;
  });
  readonly title = computed(() => this.renderModel()?.title ?? '');
  readonly hasTrades = computed(() => (this.renderModel()?.panes.main.trades.length ?? 0) > 0);
  private readonly legendBar = computed(() => {
    const m = this.renderModel();
    return m ? legendLogical(m, this.hovered()) : 0;
  });

  readonly ohlc = computed(() => {
    const m = this.renderModel();
    if (!m || m.bars.time.length === 0) return null;
    const n = m.bars.time.length;
    const i = Math.max(0, Math.min(n - 1, this.legendBar()));
    const fmt = { format: 'price' as const, precision: m.pricePrecision };
    const b = m.bars;
    const prev = i > 0 ? b.close[i - 1] : NaN;
    const change = prev === prev && prev !== 0 ? ((b.close[i] - prev) / prev) * 100 : NaN;
    return {
      o: formatValue(b.open[i], fmt),
      h: formatValue(b.high[i], fmt),
      l: formatValue(b.low[i], fmt),
      c: formatValue(b.close[i], fmt),
      change: change === change ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '',
      up: b.close[i] >= b.open[i],
    };
  });

  readonly overlays = computed<PaneOverlay[]>(() => {
    const m = this.renderModel();
    if (!m) return [];
    const lines = statusLines(m, this.legendBar());
    return this.rects().map((rect) => {
      const pane = rect.key === 'main' ? m.panes.main : m.panes.script;
      const values = lines.find((l) => l.pane === rect.key)?.values ?? [];
      const home = m.overlay ? 'main' : 'script';
      const script = values.length || rect.key === home ? values : null;
      return { key: rect.key, rect, tables: pane?.tables ?? [], script };
    });
  });

  readonly dataSections = computed(() => {
    const m = this.renderModel();
    return this.dataWindow() && m ? dataWindowAt(m, this.legendBar(), this.timezone()) : [];
  });

  readonly dataWindowTop = computed(() => (this.rects()[0]?.top ?? 0) + 6);
  readonly toolbarBottom = computed(() => {
    const rects = this.rects();
    const last = rects[rects.length - 1];
    const el = this.surface().nativeElement;
    return last ? Math.max(4, el.clientHeight - (last.top + last.height) + 6) : 34;
  });
  readonly toolbarRight = computed(() => {
    const r = this.rects()[0];
    const el = this.surface().nativeElement;
    return r ? Math.max(4, el.clientWidth - (r.left + r.width) + 8) : 64;
  });

  constructor() {
    afterNextRender({
      write: () => {
        this.zone.runOutsideAngular(() => {
          this.renderer = new PineChartRenderer(
            this.surface().nativeElement,
            this.theme.theme() === 'dark' ? PINE_CHART_DARK : PINE_CHART_LIGHT,
            {
              crosshair: (e) => this.onCrosshair(e),
              click: (e) => this.onClick(e.logical),
              layout: () => this.scheduleLayout(),
            },
            (ms) => {
              const tz = untracked(this.timezone);
              return tz === 'UTC' ? 0 : zoneOffsetMinutes(ms, tz) * 60_000;
            },
          );
        });
        this.ready.set(true);
      },
    });

    effect(() => {
      const m = this.renderModel();
      this.timezone();
      if (!this.ready()) return;
      untracked(() => {
        if (m) this.renderer?.setModel(m);
        this.scheduleLayout();
      });
    });
    effect(() => {
      const dark = this.theme.theme() === 'dark';
      if (!this.ready()) return;
      untracked(() => this.renderer?.setColors(dark ? PINE_CHART_DARK : PINE_CHART_LIGHT));
    });
    effect(() => {
      const bar = this.highlightBar();
      const m = this.renderModel();
      if (!this.ready()) return;
      untracked(() =>
        this.renderer?.setHighlight(bar === null || !m ? null : m.timeline.logicalOfBarIndex(bar)),
      );
    });
    effect(() => {
      const on = this.tradesOn();
      if (!this.ready()) return;
      untracked(() => this.renderer?.setTradesVisible(on));
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.layoutFrame);
    this.renderer?.destroy();
    this.renderer = null;
  }

  /** Bring a bar into view (logs "scroll to bar", runtime error bar, trace step). */
  scrollToBar(barIndex: number): void {
    const m = this.renderModel();
    if (!m || !this.renderer) return;
    this.renderer.scrollToLogical(m.timeline.logicalOfBarIndex(barIndex));
  }

  resetView(): void {
    this.renderer?.showLatest();
  }

  fitContent(): void {
    this.renderer?.fitContent();
  }

  private ref(logical: number): PineBarRef | null {
    const m = this.renderModel();
    if (!m) return null;
    return { barIndex: m.timeline.barIndexOfLogical(logical), logical, time: m.timeline.timeOfLogical(logical) };
  }

  private onCrosshair(e: CrosshairEvent): void {
    if (e.logical !== untracked(this.hovered)) {
      this.hovered.set(e.logical);
      const ref = e.logical === null ? null : this.ref(e.logical);
      this.zone.run(() => this.crosshairBar.emit(ref));
    }
    let tip: { text: string; left: number; top: number } | null = null;
    if (e.point && e.paneIndex !== null && this.renderer) {
      const hit = this.renderer.hitAt(e.paneIndex, e.point.x, e.point.y);
      const rect = untracked(this.rects)[e.paneIndex];
      if (hit && rect) tip = { text: hit.tooltip, left: rect.left + e.point.x + 14, top: rect.top + e.point.y + 14 };
    }
    const cur = untracked(this.tooltip);
    if (cur?.text !== tip?.text || cur?.left !== tip?.left || cur?.top !== tip?.top) this.tooltip.set(tip);
  }

  private onClick(logical: number): void {
    const ref = this.ref(logical);
    if (ref) this.zone.run(() => this.barClick.emit(ref));
  }

  private scheduleLayout(): void {
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => {
      const next = this.renderer?.paneRects() ?? [];
      const cur = untracked(this.rects);
      const same =
        next.length === cur.length &&
        next.every(
          (r, i) =>
            r.top === cur[i].top && r.left === cur[i].left && r.width === cur[i].width && r.height === cur[i].height,
        );
      if (!same) this.rects.set(next);
    });
  }
}
