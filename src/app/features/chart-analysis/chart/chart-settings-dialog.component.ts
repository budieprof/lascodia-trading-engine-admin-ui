import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  type OnInit,
  afterNextRender,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { ChartAppearance } from './appearance';

/** Everything the chart settings dialog edits — the chart's own settings, as the page holds them. */
export interface ChartSettings {
  appearance: ChartAppearance | null;
  /** Each symbol opens on the timeframe and zoom it was left on (layout memory per symbol). */
  rememberPerSymbol: boolean;
  showVolume: boolean;
  countdown: boolean;
  scaleMode: 'normal' | 'log' | 'percent' | 'indexed';
  invertScale: boolean;
  scaleSide: 'right' | 'left';
  timezone: string;
  sessionBreaks: boolean;
  showEvents: boolean;
  minEventImpact: 'High' | 'Medium' | 'Low';
  showBlackout: boolean;
  showPositions: boolean;
  showOrders: boolean;
  showOverlays: boolean;
  showClosedTrades: boolean;
  fitTradeLines: boolean;
}

type Tab = 'symbol' | 'scales' | 'canvas' | 'trading' | 'events';

/** The theme's candle colours (chart-host's palette): what "Reset" goes back to. */
const THEME_UP = '#089981';
const THEME_DOWN = '#F23645';

/**
 * The chart's Settings (CC-I11), TradingView's tabs: Symbol (candle colours, volume, countdown), Scales (mode,
 * direction, side, time zone), Canvas (background, grid lines), Trading (positions, orders, signals, closed trades)
 * and Events (economic events, blackout shading, session breaks). Every edit applies at once (`changed` carries the
 * whole settings); Ok keeps them, Cancel (Esc, ×) puts back what the chart had when the dialog opened.
 */
@Component({
  selector: 'app-chart-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="cs" aria-labelledby="cs-title" (cancel)="$event.preventDefault(); cancel()">
      <header class="cs-head">
        <h2 id="cs-title">Chart settings</h2>
        <button type="button" class="cs-x" (click)="cancel()" aria-label="Close">×</button>
      </header>
      <div class="cs-body">
        <nav class="cs-tabs" role="tablist">
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="tab() === t.id"
              [class.on]="tab() === t.id"
              (click)="tab.set(t.id)"
            >
              {{ t.label }}
            </button>
          }
        </nav>
        @let s = draft();
        <section class="cs-pane" role="tabpanel">
          @switch (tab()) {
            @case ('symbol') {
              <label class="cs-row">
                <span>Rising bars</span>
                <input type="color" [value]="s.appearance?.up ?? themeUp" (input)="setAppearance('up', $any($event.target).value)" />
              </label>
              <label class="cs-row">
                <span>Falling bars</span>
                <input type="color" [value]="s.appearance?.down ?? themeDown" (input)="setAppearance('down', $any($event.target).value)" />
              </label>
              <button type="button" class="cs-link" (click)="resetColours()">Theme colours</button>
              <label class="cs-check"><input type="checkbox" [checked]="s.showVolume" (change)="set('showVolume', $any($event.target).checked)" /> Volume</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.countdown" (change)="set('countdown', $any($event.target).checked)" /> Countdown to bar close</label>
              <label class="cs-check" title="In this layout: switching to a symbol opens it on the timeframe and zoom you left it on">
                <input type="checkbox" [checked]="s.rememberPerSymbol" (change)="set('rememberPerSymbol', $any($event.target).checked)" />
                Remember each symbol’s timeframe and zoom
              </label>
            }
            @case ('scales') {
              <label class="cs-row">
                <span>Scale</span>
                <select [value]="s.scaleMode" (change)="set('scaleMode', $any($event.target).value)">
                  <option value="normal">Regular</option>
                  <option value="log">Logarithmic</option>
                  <option value="percent">Percent</option>
                  <option value="indexed">Indexed to 100</option>
                </select>
              </label>
              <label class="cs-row">
                <span>Placement</span>
                <select [value]="s.scaleSide" (change)="set('scaleSide', $any($event.target).value)">
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                </select>
              </label>
              <label class="cs-check"><input type="checkbox" [checked]="s.invertScale" (change)="set('invertScale', $any($event.target).checked)" /> Invert scale</label>
              <label class="cs-row">
                <span>Time zone</span>
                <select [value]="s.timezone" (change)="set('timezone', $any($event.target).value)">
                  @for (z of timezones(); track z.id) {
                    <option [value]="z.id">{{ z.label }}</option>
                  }
                </select>
              </label>
            }
            @case ('canvas') {
              <label class="cs-check">
                <input type="checkbox" [checked]="!!s.appearance?.background" (change)="toggleBackground($any($event.target).checked)" />
                Own background colour
              </label>
              @if (s.appearance?.background; as bg) {
                <label class="cs-row">
                  <span>Background</span>
                  <input type="color" [value]="bg" (input)="setAppearance('background', $any($event.target).value)" />
                </label>
              } @else {
                <p class="cs-note">The background follows the console's light or dark theme.</p>
              }
              <label class="cs-row">
                <span>Grid lines</span>
                <select [value]="s.appearance?.grid ?? 'both'" (change)="setGrid($any($event.target).value)">
                  <option value="both">Vertical and horizontal</option>
                  <option value="vertical">Vertical only</option>
                  <option value="horizontal">Horizontal only</option>
                  <option value="none">None</option>
                </select>
              </label>
            }
            @case ('trading') {
              <label class="cs-check"><input type="checkbox" [checked]="s.showPositions" (change)="set('showPositions', $any($event.target).checked)" /> Open positions</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.showOrders" (change)="set('showOrders', $any($event.target).checked)" /> Pending orders</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.showOverlays" (change)="set('showOverlays', $any($event.target).checked)" /> Signals and martingale rungs</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.showClosedTrades" (change)="set('showClosedTrades', $any($event.target).checked)" /> Closed trades</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.fitTradeLines" (change)="set('fitTradeLines', $any($event.target).checked)" /> Fit the price scale to trade lines</label>
            }
            @case ('events') {
              <label class="cs-check"><input type="checkbox" [checked]="s.showEvents" (change)="set('showEvents', $any($event.target).checked)" /> Economic events</label>
              <label class="cs-row">
                <span>Least importance</span>
                <select [value]="s.minEventImpact" (change)="set('minEventImpact', $any($event.target).value)" [disabled]="!s.showEvents">
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </label>
              <label class="cs-check"><input type="checkbox" [checked]="s.showBlackout" (change)="set('showBlackout', $any($event.target).checked)" /> Shade the news blackout</label>
              <label class="cs-check"><input type="checkbox" [checked]="s.sessionBreaks" (change)="set('sessionBreaks', $any($event.target).checked)" /> Session breaks</label>
            }
          }
        </section>
      </div>
      <footer class="cs-foot">
        <button type="button" class="cs-btn" (click)="cancel()">Cancel</button>
        <button type="button" class="cs-btn primary" (click)="ok()">Ok</button>
      </footer>
    </dialog>
  `,
  styles: `
    .cs {
      width: min(560px, calc(100vw - 32px));
      padding: 0;
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 8px;
      background: var(--surface, #fff);
      color: var(--text, #131722);
      font-size: 13px;
    }
    .cs::backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    .cs-head,
    .cs-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
    }
    .cs-head h2 {
      flex: 1;
      margin: 0;
      font-size: 16px;
    }
    .cs-foot {
      justify-content: flex-end;
      border-top: 1px solid var(--border, #e0e3eb);
    }
    .cs-x {
      border: none;
      background: none;
      color: inherit;
      font-size: 20px;
      cursor: pointer;
    }
    .cs-body {
      display: flex;
      min-height: 260px;
      border-top: 1px solid var(--border, #e0e3eb);
    }
    .cs-tabs {
      display: flex;
      flex-direction: column;
      min-width: 120px;
      padding: 8px 0;
      border-right: 1px solid var(--border, #e0e3eb);
    }
    .cs-tabs button {
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      padding: 8px 16px;
      cursor: pointer;
    }
    .cs-tabs button.on {
      background: var(--surface-hover, rgba(41, 98, 255, 0.08));
      color: var(--tv-blue, #2962ff);
    }
    .cs-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 16px;
    }
    .cs-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .cs-check {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cs-note {
      margin: 0;
      color: var(--text-muted, #787b86);
    }
    .cs-link {
      align-self: flex-start;
      border: none;
      background: none;
      padding: 0;
      color: var(--tv-blue, #2962ff);
      font: inherit;
      cursor: pointer;
    }
    select {
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 3px 6px;
    }
    .cs-btn {
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 5px 14px;
      cursor: pointer;
    }
    .cs-btn.primary {
      border-color: var(--tv-blue, #2962ff);
      background: var(--tv-blue, #2962ff);
      color: #fff;
    }
    @media (max-width: 520px) {
      .cs-body {
        flex-direction: column;
      }
      .cs-tabs {
        flex-direction: row;
        overflow-x: auto;
        border-right: none;
        border-bottom: 1px solid var(--border, #e0e3eb);
      }
    }
  `,
})
export class ChartSettingsDialogComponent implements OnInit {
  /** The chart's settings as the dialog opens. */
  readonly settings = input.required<ChartSettings>();
  readonly timezones = input.required<ReadonlyArray<{ id: string; label: string }>>();
  /** Every edit, with the whole settings: the page applies them at once. */
  readonly changed = output<ChartSettings>();
  /** Closed: `kept` — Ok; else Cancel, and `changed` has already put the opening settings back. */
  readonly closed = output<{ kept: boolean }>();

  readonly tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'symbol', label: 'Symbol' },
    { id: 'scales', label: 'Scales' },
    { id: 'canvas', label: 'Canvas' },
    { id: 'trading', label: 'Trading' },
    { id: 'events', label: 'Events' },
  ];
  readonly themeUp = THEME_UP;
  readonly themeDown = THEME_DOWN;
  readonly tab = signal<Tab>('symbol');
  readonly draft = signal<ChartSettings>(null as unknown as ChartSettings);
  private opening: ChartSettings | null = null;
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    afterNextRender(() => {
      const el = this.dlg()?.nativeElement;
      if (el && !el.open) el.showModal?.();
    });
  }

  ngOnInit(): void {
    this.opening = cloneSettings(this.settings());
    this.draft.set(cloneSettings(this.settings()));
  }

  set<K extends keyof ChartSettings>(key: K, value: ChartSettings[K]): void {
    this.update({ ...this.draft(), [key]: value });
  }

  setAppearance(key: 'up' | 'down' | 'background', colour: string): void {
    this.update({ ...this.draft(), appearance: { ...(this.draft().appearance ?? {}), [key]: colour } });
  }

  setGrid(grid: NonNullable<ChartAppearance['grid']>): void {
    const a = { ...(this.draft().appearance ?? {}) };
    if (grid === 'both') delete a.grid;
    else a.grid = grid;
    this.update({ ...this.draft(), appearance: Object.keys(a).length ? a : null });
  }

  toggleBackground(own: boolean): void {
    const a = { ...(this.draft().appearance ?? {}) };
    if (own) a.background = a.background ?? '#FFFFFF';
    else delete a.background;
    this.update({ ...this.draft(), appearance: Object.keys(a).length ? a : null });
  }

  resetColours(): void {
    const a = { ...(this.draft().appearance ?? {}) };
    delete a.up;
    delete a.down;
    this.update({ ...this.draft(), appearance: Object.keys(a).length ? a : null });
  }

  ok(): void {
    this.close(true);
  }

  cancel(): void {
    if (this.opening) this.changed.emit(cloneSettings(this.opening));
    this.close(false);
  }

  private update(next: ChartSettings): void {
    this.draft.set(next);
    this.changed.emit(cloneSettings(next));
  }

  private close(kept: boolean): void {
    const el = this.dlg()?.nativeElement;
    if (el?.open) el.close?.();
    this.closed.emit({ kept });
  }
}

function cloneSettings(s: ChartSettings): ChartSettings {
  return { ...s, appearance: s.appearance ? { ...s.appearance } : null };
}
