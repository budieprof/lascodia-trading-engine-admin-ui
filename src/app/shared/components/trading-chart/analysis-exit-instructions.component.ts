import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MarketAnalysisExitInstructionDto } from '@core/api/api.types';

/**
 * Friendly label for an exit-instruction outcome — the wire codes are PascalCase compact identifiers;
 * the UI shows a hyphenated form.
 */
export function exitOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'Executed':
      return 'EXECUTED';
    case 'RateLimited':
      return 'RATE-LIMITED';
    case 'BelowConfidence':
      return 'LOW CONFIDENCE';
    case 'PositionClosed':
      return 'POSITION CLOSED';
    case 'Failed':
      return 'FAILED';
    default:
      return outcome.toUpperCase();
  }
}

/**
 * The model's position-management instructions, including server-rejected ones so the operator sees its
 * full intent. The outcome chip is the source of truth (green = acted, amber = rate-limited /
 * below-confidence, grey = position already closed, red = dispatch failure).
 */
@Component({
  selector: 'app-analysis-exit-instructions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './analysis-exit-instructions.component.scss',
  template: `
    <section class="exit-card">
      <header class="exit-head">
        <span class="exit-title">Position management</span>
        <span class="exit-meta">
          {{ instructions().length }} instruction(s) · {{ executedCount() }} executed
        </span>
      </header>
      <ul class="exit-list">
        @for (e of instructions(); track e.positionId + '|' + e.action) {
          <li class="exit-row" [class.exit-row-rejected]="e.outcome !== 'Executed'">
            <span
              class="exit-outcome"
              [class.exit-outcome-ok]="e.outcome === 'Executed'"
              [class.exit-outcome-warn]="
                e.outcome === 'RateLimited' || e.outcome === 'BelowConfidence'
              "
              [class.exit-outcome-muted]="e.outcome === 'PositionClosed'"
              [class.exit-outcome-bad]="e.outcome === 'Failed'"
            >
              {{ outcomeLabel(e.outcome) }}
            </span>
            <span class="exit-action">
              @if (e.action === 'close') {
                Close
                {{
                  e.executedCloseLots !== null
                    ? e.executedCloseLots + ' lots'
                    : e.closeFractionPct + '%'
                }}
                of #{{ e.positionId }}
              } @else {
                Move stop on #{{ e.positionId }} to {{ e.newStopLoss }}
              }
            </span>
            <span class="exit-confidence"> {{ (e.confidence * 100).toFixed(0) }}% confidence </span>
            <p class="exit-reason">{{ e.reason }}</p>
            @if (e.failureMessage; as fm) {
              <p class="exit-failure">{{ fm }}</p>
            }
          </li>
        }
      </ul>
    </section>
  `,
})
export class AnalysisExitInstructionsComponent {
  readonly instructions = input.required<readonly MarketAnalysisExitInstructionDto[]>();

  /** How many instructions actually executed — the header shows executed-to-emitted at a glance. */
  protected readonly executedCount = computed(
    () => this.instructions().filter((e) => e.outcome === 'Executed').length,
  );
  protected readonly outcomeLabel = exitOutcomeLabel;
}
