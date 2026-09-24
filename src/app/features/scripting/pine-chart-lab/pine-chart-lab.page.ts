import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { PinePreviewComponent } from '../pine-preview/pine-preview.component';
import type { PineLineJump } from '@shared/pine-chart/panes/pine-logs-pane.component';
import type { PineRunRequest, PineRunResult } from '@shared/pine-chart/model/pine-outputs.types';
import { FixtureReplayApi } from '@shared/pine-chart/testing/fixture-replay-api';
import {
  OVERLAY_STRATEGY_SOURCE,
  PANE_INDICATOR_SOURCE,
  largeFixture,
  overlayStrategyFixture,
  paneIndicatorFixture,
} from '@shared/pine-chart/testing/pine-fixtures';

type FixtureKey = 'overlay' | 'pane' | 'large' | 'empty';

interface Fixture {
  label: string;
  result: () => PineRunResult;
  source: string | null;
}

const FIXTURES: Record<FixtureKey, Fixture> = {
  overlay: { label: 'Overlay strategy — every output kind', result: () => overlayStrategyFixture(), source: OVERLAY_STRATEGY_SOURCE },
  pane: { label: 'Indicator in its own pane', result: () => paneIndicatorFixture(), source: PANE_INDICATOR_SOURCE },
  large: { label: '20,000 bars × 40 plots', result: () => largeFixture(), source: null },
  empty: {
    label: 'Compile error',
    result: () => ({
      compile: {
        success: false,
        diagnostics: [{ code: 'PS2003', severity: 'error', message: 'Undeclared identifier "clsoe"', line: 4, column: 12 }],
        declaration: null,
      },
      bars: [],
      outputs: null,
      report: null,
      trace: [],
      profile: [],
      runtimeError: null,
      elapsedMs: null,
    }),
    source: null,
  },
};

/**
 * Pine chart lab: the preview (chart, logs, trace, profiler, Bar Replay) on built-in fixtures that
 * exercise every output kind — or live against the engine's `scripting/run` with a script of your
 * own. For checking the renderer without a script editor.
 */
@Component({
  selector: 'app-pine-chart-lab-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PinePreviewComponent],
  template: `
    <div class="lab">
      <header>
        <div>
          <h1>Pine chart lab</h1>
          <p class="sub">Renders a script run's outputs: plots, shapes, fills, drawings, tables, trades, logs, trace, profile and Bar Replay.</p>
        </div>
        <div class="controls">
          <label>
            Source
            <select [value]="mode()" (change)="setMode($any($event.target).value)">
              @for (k of keys; track k) {
                <option [value]="k">Fixture: {{ fixtures[k].label }}</option>
              }
              <option value="live">Live: run a script on the engine</option>
            </select>
          </label>
          @if (lastJump(); as j) {
            <span class="jump">Editor would jump to line {{ j.line }}{{ j.column ? ':' + j.column : '' }}</span>
          }
        </div>
      </header>

      @if (mode() === 'live') {
        <form class="live" (submit)="$event.preventDefault(); runLive()">
          <label>Symbol <input name="symbol" [value]="liveSymbol()" (input)="liveSymbol.set($any($event.target).value)" /></label>
          <label>Timeframe <input name="tf" [value]="liveTimeframe()" (input)="liveTimeframe.set($any($event.target).value)" /></label>
          <label>Bars <input name="bars" type="number" [value]="liveBars()" (input)="liveBars.set(+$any($event.target).value)" /></label>
          <textarea name="source" rows="6" spellcheck="false" [value]="liveSource()" (input)="liveSource.set($any($event.target).value)"></textarea>
          <button type="submit">Run</button>
        </form>
      }

      <app-pine-preview
        class="preview"
        [result]="mode() === 'live' ? undefined : fixtureResult()"
        [request]="mode() === 'live' ? liveRequest() : fixtureRequest()"
        [autoRun]="mode() === 'live'"
        [source]="mode() === 'live' ? liveSource() : fixture()?.source ?? null"
        [symbol]="mode() === 'live' ? '' : 'EURUSD'"
        [timeframe]="mode() === 'live' ? '' : '60'"
        [replayApi]="replayApi()"
        (jumpToLine)="lastJump.set($event)"
      />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .lab {
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: calc(100vh - 120px);
        min-height: 640px;
        padding: 16px 20px;
        box-sizing: border-box;
      }
      header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: flex-end;
        gap: 12px;
      }
      h1 {
        margin: 0;
        font-size: 20px;
      }
      .sub {
        margin: 2px 0 0;
        color: var(--text-secondary, #6e6e73);
        font-size: 13px;
      }
      .controls {
        display: flex;
        gap: 12px;
        align-items: center;
        font-size: 13px;
      }
      select,
      input,
      textarea,
      button {
        font: inherit;
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 8px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: var(--text-primary, #1d1d1f);
      }
      .jump {
        color: var(--accent, #0071e3);
      }
      .live {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-end;
        font-size: 12px;
      }
      .live textarea {
        flex: 1 1 100%;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .preview {
        flex: 1 1 auto;
        min-height: 0;
      }
    `,
  ],
})
export class PineChartLabPage {
  protected readonly fixtures = FIXTURES;
  protected readonly keys = Object.keys(FIXTURES) as FixtureKey[];

  readonly mode = signal<FixtureKey | 'live'>('overlay');
  readonly lastJump = signal<PineLineJump | null>(null);
  readonly liveSymbol = signal('EURUSD');
  readonly liveTimeframe = signal('60');
  readonly liveBars = signal(2000);
  readonly liveSource = signal(OVERLAY_STRATEGY_SOURCE);
  readonly liveRequest = signal<PineRunRequest | null>(null);

  readonly fixture = computed(() => {
    const m = this.mode();
    return m === 'live' ? null : FIXTURES[m];
  });
  readonly fixtureResult = computed(() => this.fixture()?.result() ?? null);
  /** Fixtures replay from themselves; a request is needed to arm the replay. */
  readonly fixtureRequest = computed<PineRunRequest | null>(() =>
    this.fixtureResult()?.bars.length ? { source: this.fixture()?.source ?? '', symbol: 'EURUSD', timeframe: '60' } : null,
  );
  readonly replayApi = computed(() => {
    const r = this.fixtureResult();
    return this.mode() !== 'live' && r ? new FixtureReplayApi(r, 40) : null;
  });

  setMode(value: string): void {
    this.mode.set(value === 'live' || value in FIXTURES ? (value as FixtureKey | 'live') : 'overlay');
  }

  runLive(): void {
    this.liveRequest.set({
      source: this.liveSource(),
      symbol: this.liveSymbol().trim(),
      timeframe: this.liveTimeframe().trim(),
      lastBars: Math.max(50, Math.min(20_000, this.liveBars() || 2000)),
      mode: 'preview',
      profile: true,
    });
  }
}
