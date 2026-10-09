import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ThemeService } from '@core/theme/theme.service';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { reportPalette } from '../report/report-charts';
import { describeFailure } from '../shared/api-error';
import { heatmapGrid, plateauReadout, type PlateauGate } from './heatmap.model';
import { ResearchApiService } from './research-api.service';
import type { OptimizationHeatmapDto } from './research.types';

export const HEATMAP_BINS = [5, 8, 10, 15, 20] as const;

/**
 * BT-I7 — an optimization run's candidates as an ExpectancyR heatmap over two of its parameters (the engine bins them,
 * default the two most varied), with the peak cell and its neighbourhood marked and the engine's plateau scores read out
 * in words: does the edge survive near the best settings, or is it one lucky cell?
 */
@Component({
  selector: 'app-parameter-heatmap',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="hm-title" data-testid="parameter-heatmap">
      <header class="head">
        <h3 id="hm-title" class="title">Parameter stability — expectancy heatmap</h3>
      </header>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (loading() && !dto()) {
        <p class="muted">Binning the candidates…</p>
      } @else if (dto(); as d) {
        @if (d.parameters.length >= 2) {
          <div class="controls">
            <label>
              <span class="muted small">Across</span>
              <select
                class="field-input"
                (change)="pickX($any($event.target).value)"
                aria-label="Parameter across"
              >
                @for (p of d.parameters; track p.id) {
                  <option [value]="p.id" [selected]="p.id === grid()?.xId">{{ p.id }}</option>
                }
              </select>
            </label>
            <label>
              <span class="muted small">Up</span>
              <select
                class="field-input"
                (change)="pickY($any($event.target).value)"
                aria-label="Parameter up"
              >
                @for (p of d.parameters; track p.id) {
                  <option [value]="p.id" [selected]="p.id === grid()?.yId">{{ p.id }}</option>
                }
              </select>
            </label>
            <label>
              <span class="muted small">Bins per number axis</span>
              <select
                class="field-input"
                (change)="pickBins(+$any($event.target).value)"
                aria-label="Bins"
              >
                @for (b of bins; track b) {
                  <option [value]="b" [selected]="b === binCount()">{{ b }}</option>
                }
              </select>
            </label>
          </div>
        }
        @if (grid(); as g) {
          <div class="table-wrap">
            <table
              class="heat"
              [attr.aria-label]="'Mean expectancy in R by ' + g.xId + ' and ' + g.yId"
            >
              <tbody>
                @for (row of g.rows; track row.label) {
                  <tr>
                    <th scope="row" class="ylabel">{{ row.label }}</th>
                    @for (c of row.cells; track c.x) {
                      <td
                        [class.peak]="c.peak"
                        [class.neighbour]="c.neighbour"
                        [style.background]="c.background"
                        [style.color]="c.color"
                        [attr.title]="c.title"
                        [attr.aria-label]="c.title"
                      >
                        {{ c.text }}
                      </td>
                    }
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <th scope="col" class="corner">{{ g.yId }} ↑ / {{ g.xId }} →</th>
                  @for (label of g.xLabels; track $index) {
                    <th scope="col" class="xlabel">{{ label }}</th>
                  }
                </tr>
              </tfoot>
            </table>
          </div>
          <p class="muted small">
            Mean R per trade of the candidates in each cell ({{ d.candidates }} candidates with a
            stop). The outlined cell is the peak; the dotted ones are the neighbours its plateau
            score is measured over.
          </p>
        } @else {
          <p class="muted">{{ d.whyNot ?? 'No heatmap for this run.' }}</p>
        }
        @if (readout().lines.length > 0) {
          <div class="readout" [attr.data-level]="readout().level" data-testid="plateau-readout">
            @for (line of readout().lines; track line) {
              <p>{{ line }}</p>
            }
          </div>
        }
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .controls label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      .heat {
        border-collapse: separate;
        border-spacing: 2px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .heat td {
        min-width: 52px;
        height: 30px;
        text-align: center;
        border-radius: 4px;
        border: 1px solid var(--border);
      }
      .heat td.peak {
        outline: 2px solid var(--text-primary);
        outline-offset: -1px;
        font-weight: var(--font-semibold);
      }
      .heat td.neighbour {
        border-style: dotted;
        border-color: var(--text-secondary);
      }
      .ylabel,
      .xlabel,
      .corner {
        font-weight: normal;
        color: var(--text-secondary);
        font-size: 11px;
        padding: 2px 6px;
        white-space: nowrap;
      }
      .ylabel {
        text-align: right;
      }
      .readout {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        font-size: var(--text-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .readout[data-level='spike'],
      .readout[data-level='losing'] {
        background: rgba(255, 149, 0, 0.12);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class ParameterHeatmapComponent {
  private readonly api = inject(ResearchApiService);
  private readonly theme = inject(ThemeService);

  readonly runId = input.required<number>();
  /** The engine's plateau gate settings (from the run's candidates), when known. */
  readonly gate = input<PlateauGate | null>(null);

  readonly bins = HEATMAP_BINS;
  readonly dto = signal<OptimizationHeatmapDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly x = signal<string | null>(null);
  readonly y = signal<string | null>(null);
  readonly binCount = signal<number>(10);

  readonly grid = computed(() => {
    const d = this.dto();
    return d ? heatmapGrid(d, reportPalette(this.theme.theme())) : null;
  });
  readonly readout = computed(() => {
    const d = this.dto();
    return d ? plateauReadout(d, this.gate()) : { level: 'unknown' as const, lines: [] };
  });

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => {
        this.x.set(null);
        this.y.set(null);
        this.dto.set(null);
        void this.load(id);
      });
    });
  }

  pickX(id: string): void {
    this.x.set(id);
    if (id === (this.y() ?? this.grid()?.yId)) this.y.set(this.grid()?.xId ?? null);
    void this.load(this.runId());
  }

  pickY(id: string): void {
    this.y.set(id);
    if (id === (this.x() ?? this.grid()?.xId)) this.x.set(this.grid()?.yId ?? null);
    void this.load(this.runId());
  }

  pickBins(n: number): void {
    this.binCount.set(n);
    void this.load(this.runId());
  }

  async load(runId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(
        this.api.heatmap(runId, this.x(), this.y(), this.binCount()),
      );
      if (runId !== this.runId()) return;
      if (!res?.status || !res.data) throw res;
      this.dto.set(res.data);
    } catch (err) {
      this.error.set(describeFailure(err, 'The heatmap could not be built.'));
    } finally {
      this.loading.set(false);
    }
  }
}
