import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { exposureKindOf } from '@features/news-intel/news-intel.logic';
import { ExposureKindName, ScheduledMarketEventRow } from '@features/news-intel/news-intel.types';
import { KIND_ORDER, kindColor, kindVar, shortKey } from './ni-viz';

/**
 * Widgets for the Calendar / Stories / Risk-use tabs of the dense News Intel cockpit (DESIGN.md).
 * Colours are the inherited --ni-* variables; identity is never colour alone (every mark has a label or
 * a tooltip naming it).
 */

// ═════════════════════════════════════════════════════════════════════════════
// Horizontal bar list — label · bar · value. One measure, one axis (0..max).
// ═════════════════════════════════════════════════════════════════════════════

export interface HBarItem {
  label: string;
  value: number;
  /** Bar colour (identity); default accent. */
  color?: string | null;
  /** Mono key chip instead of plain text (kind-coloured dot). */
  key?: string | null;
  hint?: string | null;
}

@Component({
  selector: 'app-ni-hbars',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hb">
      @for (i of rows(); track i.label) {
        <button type="button" class="row" [class.static]="!clickable()" (click)="clickable() && pick.emit(i.label)" [title]="i.hint ?? i.label + ': ' + i.value">
          <span class="lab">
            @if (i.key) {
              <i [style.background]="kc(i.key)"></i><span class="mono">{{ short(i.key) }}</span>
            } @else {
              @if (i.color) {
                <i [style.background]="i.color"></i>
              }
              <span>{{ i.label }}</span>
            }
          </span>
          <span class="track"><b [style.width.%]="(i.value / max()) * 100" [style.background]="i.color ?? (i.key ? kc(i.key) : 'var(--accent)')"></b></span>
          <span class="v">{{ i.value }}</span>
        </button>
      } @empty {
        <span class="empty">{{ emptyText() }}</span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .hb {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, var(--lab-w, 120px)) minmax(0, 1fr) 38px;
        align-items: center;
        gap: 8px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        padding: 2px 4px;
        border-radius: 5px;
        cursor: pointer;
        text-align: left;
      }
      .row.static {
        cursor: default;
      }
      .row:not(.static):hover {
        background: var(--ni-sunken);
      }
      .lab {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lab i {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        flex: none;
      }
      .mono {
        font-family: var(--ni-mono, monospace);
        font-size: 11px;
      }
      .track {
        height: 7px;
        border-radius: 4px;
        background: var(--ni-sunken);
        overflow: hidden;
      }
      .track b {
        display: block;
        height: 100%;
        border-radius: 4px;
        min-width: 2px;
      }
      .v {
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        text-align: right;
        font-weight: 600;
      }
      .empty {
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 6px 0;
      }
    `,
  ],
})
export class NiHBarsComponent {
  readonly items = input<readonly HBarItem[]>([]);
  readonly limit = input(12);
  readonly clickable = input(false);
  readonly emptyText = input('Nothing yet.');
  readonly pick = output<string>();
  readonly rows = computed(() => this.items().slice(0, this.limit()));
  readonly max = computed(() => Math.max(1, ...this.rows().map((i) => i.value)));
  kc(k: string): string {
    return kindVar(k);
  }
  short(k: string): string {
    return shortKey(k);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Event timeline — UTC day columns × exposure-kind rows. Each event is a dot in its kind's colour,
// sized by impact (High solid, Medium smaller, Low hollow). Hover a cell for its events; click a day
// header to pick that day.
// ═════════════════════════════════════════════════════════════════════════════

interface TlCell {
  day: string;
  events: ScheduledMarketEventRow[];
}
interface TlRow {
  kind: ExposureKindName;
  label: string;
  color: string;
  cells: TlCell[];
  total: number;
}

@Component({
  selector: 'app-ni-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="tl" [style.--cols]="days().length">
      <div class="corner"></div>
      @for (d of days(); track d) {
        <button
          type="button"
          class="dh"
          [class.today]="d === today"
          [class.wk]="isWeekend(d)"
          [class.on]="d === selected()"
          (click)="pickDay.emit(d === selected() ? null : d)"
          [title]="'Show ' + (d + 'T00:00:00Z' | date: 'EEE d MMM' : 'UTC')"
        >
          <span>{{ d + 'T00:00:00Z' | date: 'EEE' : 'UTC' }}</span>
          <b>{{ d + 'T00:00:00Z' | date: 'd' : 'UTC' }}</b>
          @if (dayHigh(d) > 0) {
            <em>{{ dayHigh(d) }}</em>
          }
        </button>
      }
      @for (r of rows(); track r.kind) {
        <div class="rh"><i [style.background]="r.color"></i>{{ r.label }}<span>{{ r.total }}</span></div>
        @for (c of r.cells; track c.day) {
          <div class="cell" [class.today]="c.day === today" [class.wk]="isWeekend(c.day)" [class.on]="c.day === selected()" tabindex="-1">
            @for (e of c.events.slice(0, 6); track e.id) {
              <span class="dot" [class]="'dot ' + impact(e.impact)" [style.--dc]="r.color"></span>
            }
            @if (c.events.length > 6) {
              <span class="more">+{{ c.events.length - 6 }}</span>
            }
            @if (c.events.length) {
              <span class="tip" role="tooltip">
                <span class="tt">{{ c.day + 'T00:00:00Z' | date: 'EEE d MMM' : 'UTC' }} · {{ r.label }}</span>
                @for (e of c.events.slice(0, 10); track e.id) {
                  <span class="tr">
                    <span class="tm">{{ e.scheduledAtUtc | date: 'HH:mm' : 'UTC' }}</span>
                    <span class="ik" [class]="'ik ' + impact(e.impact)"></span>
                    <span class="k">{{ short(e.exposureKey) }}</span>
                    <span class="t">{{ e.title }}</span>
                  </span>
                }
                @if (c.events.length > 10) {
                  <span class="tm">+{{ c.events.length - 10 }} more</span>
                }
              </span>
            }
          </div>
        }
      } @empty {
        <div class="none">No events in the window.</div>
      }
    </div>
    <div class="legend">
      <span><span class="dot high" style="--dc: var(--text-secondary)"></span>High</span>
      <span><span class="dot medium" style="--dc: var(--text-secondary)"></span>Medium</span>
      <span><span class="dot low" style="--dc: var(--text-secondary)"></span>Low</span>
      <span class="faint">· UTC days · amber count = High events · click a day to filter the agenda</span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .tl {
        display: grid;
        grid-template-columns: 108px repeat(var(--cols), minmax(0, 1fr));
        gap: 2px;
        overflow-x: auto;
      }
      .corner {
        min-height: 30px;
      }
      .dh {
        position: relative;
        border: 0;
        background: transparent;
        color: var(--text-tertiary);
        font: inherit;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 2px 0 4px;
        border-radius: 6px;
        cursor: pointer;
        line-height: 1.15;
      }
      .dh span {
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dh b {
        font-size: 12px;
        color: var(--text-primary);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .dh em {
        position: absolute;
        top: 0;
        right: 2px;
        font-style: normal;
        font-size: 9px;
        font-weight: 700;
        color: var(--ni-warn);
      }
      .dh.today b {
        color: var(--accent);
      }
      .dh.on,
      .dh:hover {
        background: var(--ni-sunken);
      }
      .dh.wk b {
        color: var(--text-tertiary);
      }
      .rh {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .rh i {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .rh span {
        margin-left: auto;
        padding-right: 6px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .cell {
        position: relative;
        min-height: 36px;
        border-radius: 6px;
        background: var(--ni-sunken);
        display: flex;
        flex-wrap: wrap;
        align-content: center;
        justify-content: center;
        gap: 3px;
        padding: 4px 3px;
        outline: none;
      }
      .cell.wk {
        background: color-mix(in oklab, var(--ni-sunken) 55%, transparent);
      }
      .cell.today {
        background: color-mix(in oklab, var(--accent) 9%, var(--ni-sunken));
      }
      .cell.on {
        box-shadow: inset 0 0 0 1.5px var(--text-secondary);
      }
      .dot {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--dc);
      }
      .dot.medium {
        width: 7px;
        height: 7px;
        opacity: 0.85;
      }
      .dot.low {
        width: 6px;
        height: 6px;
        background: transparent;
        box-shadow: inset 0 0 0 1.5px var(--dc);
      }
      .more {
        font-size: 9.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .tip {
        position: absolute;
        left: 50%;
        bottom: calc(100% + 6px);
        transform: translateX(-50%) translateY(3px);
        z-index: 40;
        width: 300px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 8px 10px;
        border-radius: 9px;
        background: var(--ni-panel, #fff);
        border: 1px solid var(--border);
        box-shadow: var(--shadow-lg);
        font-size: 11px;
        opacity: 0;
        pointer-events: none;
        transition:
          opacity 0.1s ease,
          transform 0.1s ease;
      }
      .cell:hover .tip {
        opacity: 1;
        transform: translateX(-50%);
      }
      .tt {
        color: var(--text-tertiary);
        margin-bottom: 2px;
      }
      .tr {
        display: grid;
        grid-template-columns: 36px 7px auto minmax(0, 1fr);
        gap: 6px;
        align-items: center;
      }
      .tm {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
      }
      .ik {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .ik.high {
        background: var(--ni-warn);
      }
      .k {
        font-family: var(--ni-mono, monospace);
        font-weight: 600;
      }
      .t {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .none {
        grid-column: 1 / -1;
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 10px 0;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        align-items: center;
        font-size: 10.5px;
        color: var(--text-secondary);
        margin-top: 6px;
      }
      .legend > span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .faint {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class NiTimelineComponent {
  readonly events = input<readonly ScheduledMarketEventRow[]>([]);
  /** First UTC day (YYYY-MM-DD) and number of day columns. */
  readonly start = input.required<string>();
  readonly span = input(14);
  readonly selected = input<string | null>(null);
  readonly pickDay = output<string | null>();

  readonly today = new Date().toISOString().slice(0, 10);

  readonly days = computed(() => {
    const t0 = Date.parse(this.start() + 'T00:00:00Z');
    return Array.from({ length: this.span() }, (_, i) => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
  });

  private readonly byDay = computed(() => {
    const m = new Map<string, ScheduledMarketEventRow[]>();
    for (const e of this.events()) {
      const d = e.scheduledAtUtc.slice(0, 10);
      (m.get(d) ?? m.set(d, []).get(d)!).push(e);
    }
    for (const l of m.values()) l.sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc));
    return m;
  });

  readonly rows = computed<TlRow[]>(() => {
    const days = this.days();
    const inWindow = new Set(days);
    const kinds = new Set<ExposureKindName>();
    for (const e of this.events()) {
      const k = exposureKindOf(e.exposureKey);
      if (k && inWindow.has(e.scheduledAtUtc.slice(0, 10))) kinds.add(k);
    }
    return KIND_ORDER.filter((k) => kinds.has(k)).map((kind) => {
      const cells = days.map((day) => ({
        day,
        events: (this.byDay().get(day) ?? []).filter((e) => exposureKindOf(e.exposureKey) === kind),
      }));
      return {
        kind,
        label: kindRowLabel(kind),
        color: kindColor(kind),
        cells,
        total: cells.reduce((s, c) => s + c.events.length, 0),
      };
    });
  });

  dayHigh(d: string): number {
    return (this.byDay().get(d) ?? []).filter((e) => e.impact.toLowerCase() === 'high').length;
  }
  isWeekend(d: string): boolean {
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    return w === 0 || w === 6;
  }
  impact(i: string): string {
    const v = (i ?? '').toLowerCase();
    return v === 'high' ? 'high' : v === 'medium' ? 'medium' : 'low';
  }
  short(k: string): string {
    return shortKey(k);
  }
}

export function kindRowLabel(k: ExposureKindName): string {
  switch (k) {
    case 'Currency':
      return 'Currencies';
    case 'Commodity':
      return 'Commodities';
    case 'EquityIndex':
      return 'Indices';
    case 'Equity':
      return 'Stocks';
    case 'Crypto':
      return 'Crypto';
    case 'Factor':
      return 'Factors';
  }
}
