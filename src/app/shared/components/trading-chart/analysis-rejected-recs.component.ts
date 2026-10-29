import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { MarketAnalysisRejectedRecommendationDto } from '@core/api/api.types';

/**
 * Recommendations the model proposed that the engine could not file, each with the reason — shown so a
 * proposal is never silently dropped.
 */
@Component({
  selector: 'app-analysis-rejected-recs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './analysis-rejected-recs.component.scss',
  template: `
    <section class="rejected-card">
      <div class="rejected-head">
        Proposed but not tradeable ({{ rejected().length }}) — surfaced so nothing is silently
        dropped:
      </div>
      @for (rej of rejected(); track $index) {
        <div class="rej" [attr.data-action]="rej.recommendation.action">
          <div class="rej-top">
            <span class="rec-action">{{ rej.recommendation.action }}</span>
            <span class="rej-conf mono"
              >{{ (rej.recommendation.confidence * 100).toFixed(0) }}%</span
            >
            <span class="rej-code mono" [title]="rej.reasonCode">{{ rej.reasonCode }}</span>
          </div>
          @if (
            rej.recommendation.action !== 'Hold' &&
            rej.recommendation.entryPrice !== null &&
            rej.recommendation.entryPrice !== undefined
          ) {
            <div class="rej-levels mono">
              Entry {{ rej.recommendation.entryPrice }} · SL {{ rej.recommendation.stopLoss }} · TP
              {{ rej.recommendation.takeProfit }}
            </div>
          }
          <p class="rej-reason">{{ rej.reasonDetail }}</p>
        </div>
      }
    </section>
  `,
})
export class AnalysisRejectedRecsComponent {
  readonly rejected = input.required<readonly MarketAnalysisRejectedRecommendationDto[]>();
}
