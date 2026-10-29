import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { ScriptingService } from '@core/services/scripting.service';
import type { StrategyDto } from '@core/api/api.types';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';
import { isScriptStrategy } from '@features/scripting/shared/script-strategy';

/** The two evaluator types a template can hold (Pine strategies reuse code through libraries instead). */
const TEMPLATE_TYPES = ['CompositeML', 'Custom'];

/**
 * Why the template library is empty and what to use instead: templates hold CompositeML / Custom
 * configurations, while Pine strategies — almost every strategy today — are reused through Pine libraries
 * and Clone. Every count is read from the engine.
 */
@Component({
  selector: 'app-templates-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FeatureStateComponent],
  template: `
    <app-feature-state
      kind="waiting"
      title="No template saved yet"
      summary="A template is a saved strategy configuration — type, parameters, risk, sizing, session and regime settings and a risk profile — that Apply turns into one Paused strategy per symbol you pick, in a single round trip. Templates hold CompositeML and Custom strategies; a Pine script is reused through Pine libraries or Clone instead."
      detail="Save one with “Save as template…” in the New strategy form when its type is CompositeML or Custom."
      [requirements]="requirements()"
      [links]="[
        { label: 'Strategies (New strategy)', route: '/strategies' },
        { label: 'Pine libraries', route: '/strategies/libraries' },
      ]"
    />

    <div class="grid">
      <section class="card">
        <h3>Strategies a template could hold <span class="muted">CompositeML · Custom</span></h3>
        @if (candidates() === null) {
          <p class="muted">Loading…</p>
        } @else if (candidates()!.length === 0) {
          <p class="muted">No CompositeML or Custom strategy exists.</p>
        } @else {
          <ul>
            @for (s of candidates(); track s.id) {
              <li>
                <a [routerLink]="['/strategies', s.id]">{{ s.name }}</a>
                <span class="muted"
                  >#{{ s.id }} · {{ s.strategyType }} · {{ s.symbol }} {{ s.timeframe }} ·
                  {{ s.status }}</span
                >
              </li>
            }
          </ul>
        }
      </section>
      <section class="card">
        <h3>Reuse for Pine strategies</h3>
        <p class="muted">
          {{ scriptCount() ?? '—' }} of {{ total() ?? '—' }} strategies are Pine scripts. Share
          logic between them with a library ({{ libraryCount() ?? '—' }} available, e.g.
          {{ libraryNames() }}) or copy one onto another market with <strong>Clone…</strong> on its
          detail page.
        </p>
        <a routerLink="/strategies/libraries" class="small">Browse the libraries →</a>
      </section>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--text-sm);
      }
      li {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: baseline;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-weight: normal;
        margin: 0;
        line-height: 1.5;
      }
      .small {
        font-size: var(--text-xs);
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class TemplatesContextComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly scripting = inject(ScriptingService);

  private readonly all = signal<StrategyDto[] | null>(null);
  private readonly libraries = signal<string[] | null>(null);

  constructor() {
    this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(
        map((r) => r?.data?.data ?? []),
        catchError(() => of(null)),
      )
      .subscribe((rows) => this.all.set(rows));
    this.scripting
      .listLibraries()
      .pipe(
        map((rows) => rows.map((l) => `${l.publisher}/${l.name}/${l.version}`)),
        catchError(() => of(null)),
      )
      .subscribe((names) => this.libraries.set(names));
  }

  protected readonly candidates = computed(
    () => this.all()?.filter((s) => TEMPLATE_TYPES.includes(s.strategyType)) ?? null,
  );
  protected readonly total = computed(() => this.all()?.length ?? null);
  protected readonly scriptCount = computed(
    () => this.all()?.filter((s) => isScriptStrategy(s)).length ?? null,
  );
  protected readonly libraryCount = computed(() => this.libraries()?.length ?? null);
  protected readonly libraryNames = computed(
    () => (this.libraries() ?? []).slice(0, 3).join(', ') || '—',
  );

  protected readonly requirements = computed<FeatureRequirement[]>(() => {
    const c = this.candidates();
    return [
      {
        label: 'A CompositeML or Custom strategy configuration to save',
        ok: c === null ? null : c.length > 0,
        detail:
          c === null
            ? 'could not list strategies'
            : `${c.length} exist (${c.filter((s) => s.strategyType === 'CompositeML').length} CompositeML, ${
                c.filter((s) => s.strategyType === 'Custom').length
              } Custom)`,
        route: '/strategies',
      },
      {
        label: 'A template saved',
        ok: false,
        detail: 'none in the library — the engine has no template row',
      },
    ];
  });
}
