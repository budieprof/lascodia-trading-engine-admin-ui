import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import type { MLSignalAbTestResultDto } from '@core/api/api.types';

/** One signal A/B test: champion vs challenger P&L and win rate, and the SPRT statistics. */
@Component({
  selector: 'app-ml-ab-test-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  styleUrl: './ml-ab-test-detail.component.scss',
  template: `
    @let t = test();
    <div class="ab-detail mt-6">
      <header class="ab-head">
        <h4>Test #{{ t.id }} — {{ t.symbol }} / {{ t.timeframe }}</h4>
        <span class="pill" [attr.data-status]="t.status">{{ t.status }}</span>
      </header>
      <div class="ab-grid">
        <div class="ab-side champion">
          <h5>Champion (#{{ t.championModelId }})</h5>
          <dl>
            <div>
              <dt>P&L</dt>
              <dd class="mono" [class.profit]="t.championPnl > 0" [class.loss]="t.championPnl < 0">
                {{ t.championPnl | number: '1.2-2' }}
              </dd>
            </div>
            <div>
              <dt>Win Rate</dt>
              <dd class="mono">{{ t.championWinRate * 100 | number: '1.1-1' }}%</dd>
            </div>
          </dl>
        </div>
        <div class="ab-side challenger">
          <h5>Challenger (#{{ t.challengerModelId }})</h5>
          <dl>
            <div>
              <dt>P&L</dt>
              <dd
                class="mono"
                [class.profit]="t.challengerPnl > 0"
                [class.loss]="t.challengerPnl < 0"
              >
                {{ t.challengerPnl | number: '1.2-2' }}
              </dd>
            </div>
            <div>
              <dt>Win Rate</dt>
              <dd class="mono">{{ t.challengerWinRate * 100 | number: '1.1-1' }}%</dd>
            </div>
          </dl>
        </div>
      </div>
      <dl class="ab-stats">
        <div>
          <dt>Samples</dt>
          <dd class="mono">{{ t.sampleSize | number }}</dd>
        </div>
        <div>
          <dt>SPRT LLR</dt>
          <dd class="mono">
            {{
              t.sprtLogLikelihoodRatio !== null ? (t.sprtLogLikelihoodRatio | number: '1.3-3') : '—'
            }}
          </dd>
        </div>
        <div>
          <dt>p-value</dt>
          <dd class="mono">
            {{ t.pValue !== null ? (t.pValue | number: '1.4-4') : '—' }}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{{ t.startedAt | date: 'MMM d, HH:mm' }}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{{ t.completedAt ? (t.completedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
        </div>
        @if (t.decision) {
          <div class="full">
            <dt>Decision</dt>
            <dd>{{ t.decision }}</dd>
          </div>
        }
      </dl>
    </div>
  `,
})
export class MlAbTestDetailComponent {
  readonly test = input.required<MLSignalAbTestResultDto>();
}
