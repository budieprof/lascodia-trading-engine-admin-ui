import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { efficiencyView } from '../assistant-quality.logic';
import type { AssistantLoopEfficiency } from '../assistant-ops.types';

/**
 * How efficiently the assistant's loop ran over the Health window (`metrics.efficiency`): which
 * way the model asked for tools, how often the saved start of the prompt was reused (and what that
 * did to the prompt cache), and how many questions the quick model answered.
 */
@Component({
  selector: 'app-assistant-efficiency-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Loop efficiency">
      <header class="card-head">
        <h3>Efficiency</h3>
        <span class="sub">How the assistant’s working loop ran · all questions in the window</span>
      </header>
      @if (!view()) {
        <p class="pad muted">
          This engine does not report efficiency figures yet (they arrived with the cost and speed
          changes of 2026-11-10).
        </p>
      } @else if (view()!.quiet) {
        <p class="pad muted">No questions in this window, so there is nothing to measure.</p>
      } @else {
        @let v = view()!;
        <div class="grid">
          <div>
            <h4>How tools were requested</h4>
            <p class="hint">
              A “round” is one back-and-forth with the model. Native tool calls are cheaper and more
              reliable than the older text markers.
            </p>
            <dl>
              @for (p of v.protocol; track p.label) {
                <dt [title]="p.hint">{{ p.label }}</dt>
                <dd>
                  {{ p.share }} <span class="muted">({{ p.count }} rounds)</span>
                </dd>
              }
            </dl>
          </div>
          <div>
            <h4>Prompt reuse</h4>
            <p class="hint">
              The fixed start of the assistant’s prompt is saved and sent again unchanged, so the
              provider can serve it from its cache (cheaper and faster).
            </p>
            <dl>
              <dt>Questions that reused it</dt>
              <dd>{{ v.prefix.share }}</dd>
              <dt>Cache hits when reused</dt>
              <dd>{{ v.prefix.reused }}</dd>
              <dt>Cache hits when rebuilt</dt>
              <dd>{{ v.prefix.rendered }}</dd>
            </dl>
          </div>
          <div>
            <h4>Quick model</h4>
            <p class="hint">
              Simple questions go to a quicker, cheaper model; it hands the question to the main
              model when it needs to.
            </p>
            <dl>
              <dt>Sent to the quick model</dt>
              <dd>{{ v.routing.routedShare }}</dd>
              <dt>Handed back to the main model</dt>
              <dd>{{ v.routing.escalationRate }}</dd>
              <dt>Why it handed back</dt>
              <dd class="wrap">{{ v.routing.reasons }}</dd>
              <dt>Cost per question, quick model</dt>
              <dd>{{ v.routing.costRouted }}</dd>
              <dt>Cost per question, main model</dt>
              <dd>{{ v.routing.costMain }}</dd>
            </dl>
          </div>
          <div>
            <h4>Questions per model</h4>
            @if (v.models.length === 0) {
              <p class="muted">No model recorded.</p>
            } @else {
              <table>
                <tbody>
                  @for (m of v.models; track m.model) {
                    <tr>
                      <td>
                        <code>{{ m.model }}</code>
                      </td>
                      <td class="num">{{ m.count }}</td>
                      <td class="bar-cell">
                        <span class="bar" [style.width.%]="m.share * 100"></span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        align-items: baseline;
        padding: var(--space-3) var(--space-4);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: 0 0 2px;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .sub,
      .hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .hint {
        margin: 0 0 6px;
      }
      .pad {
        padding: 0 var(--space-4) var(--space-3);
        margin: 0;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-4);
        padding: 0 var(--space-4) var(--space-3);
      }
      @media (max-width: 1100px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      dl {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 3px var(--space-3);
        margin: 0;
        font-size: var(--text-sm);
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      dd.wrap {
        text-align: left;
        grid-column: 1 / -1;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      td {
        padding: 3px 4px;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .bar-cell {
        width: 40%;
      }
      .bar {
        display: block;
        height: 6px;
        border-radius: 3px;
        background: var(--accent);
        min-width: 2px;
      }
      .muted {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class AssistantEfficiencySectionComponent {
  readonly efficiency = input<AssistantLoopEfficiency | null | undefined>(null);
  protected readonly view = computed(() => efficiencyView(this.efficiency()));
}
