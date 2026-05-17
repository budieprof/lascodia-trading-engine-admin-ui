import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { LlmService } from '@core/services/llm.service';
import { LifecycleRationaleDto } from '@core/api/api.types';

/**
 * Inline card that fetches the LLM-authored rationale(s) for a single
 * lifecycle event and renders them next to the entity that owns the
 * event. Drop into a strategy / position / optimisation detail page
 * with the (eventType, eventId) the page already has in hand.
 *
 * Hides itself when the event has no rationale attached — the narrative
 * layer doesn't write a row for every lifecycle event (e.g. low-traffic
 * accounts) so a missing card just means "no commentary on this one".
 */
@Component({
  selector: 'app-rationale-inline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, DecimalPipe],
  template: `
    @if (rationales().length > 0) {
      <section class="rationale-card">
        @for (r of rationales(); track r.id) {
          <article class="rationale" [class.low-conf]="r.confidence < 0.4">
            <header class="rh">
              <span class="rationale-icon" aria-hidden="true">💬</span>
              <span class="muted small">LLM rationale ·</span>
              <span class="muted small">{{ r.createdAt | date: 'MMM d, HH:mm' }}</span>
              <span class="spacer"></span>
              @if (r.llmProvider) {
                <span class="provider-tag mono">{{ r.llmProvider }} / {{ r.llmModel }}</span>
              }
              <span class="conf" [class.low]="r.confidence < 0.4">
                conf {{ r.confidence | number: '1.2-2' }}
              </span>
            </header>
            <p class="text">{{ r.rationaleText }}</p>
            @if (r.keyMetricReferenced) {
              <footer class="rf">
                <span class="ml">Key metric</span>
                <span class="mv mono">{{ r.keyMetricReferenced }}</span>
              </footer>
            }
          </article>
        }
      </section>
    }
  `,
  styles: [
    `
      .rationale-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .rationale {
        background: rgba(0, 113, 227, 0.04);
        border: 1px solid rgba(0, 113, 227, 0.2);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .rationale.low-conf {
        background: rgba(255, 149, 0, 0.04);
        border-color: rgba(255, 149, 0, 0.3);
      }
      .rh {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
        font-size: var(--text-xs);
      }
      .rationale-icon {
        font-size: 14px;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .spacer {
        flex: 1;
      }
      .conf {
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(52, 199, 89, 0.12);
        color: #34c759;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .conf.low {
        background: rgba(255, 149, 0, 0.14);
        color: #ff9500;
      }
      .provider-tag {
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .text {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .rf {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .ml {
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mv {
        color: var(--text-primary);
      }
    `,
  ],
})
export class RationaleInlineComponent {
  private readonly llm = inject(LlmService);

  readonly eventType = input.required<string>();
  readonly eventId = input.required<number>();
  readonly rationales = signal<LifecycleRationaleDto[]>([]);

  constructor() {
    // Re-fetch whenever the event identity changes; common case is a
    // single page mounting the component with a stable (type, id) but
    // the inputs are reactive so a list page swapping rows for the same
    // entity still works.
    effect(() => {
      const type = this.eventType();
      const id = this.eventId();
      if (!type || !id) {
        this.rationales.set([]);
        return;
      }
      this.llm
        .rationalesByEvent(type, id)
        .pipe(catchError(() => of(null)))
        .subscribe((res) => {
          this.rationales.set(res?.data ?? []);
        });
    });
  }
}
