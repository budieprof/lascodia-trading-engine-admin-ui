import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { formatAge, type PendingApproval } from './agent-ops';

/**
 * Every approval card the fleet is blocked on, oldest first.
 *
 * This is the row the page exists for. An approval nobody notices does not fail — it waits, and the
 * work order waits with it, which is indistinguishable from the agent being slow until someone opens
 * the conversation. Each card says the same four things the card in the thread says (verb, target,
 * live effect, age) so the operator can decide whether to go and look, and links straight to the
 * thread where the buttons are: approving happens in the conversation, with the agent's reasoning
 * above it, never from a list.
 *
 * A child component so its styles bill to their own budget.
 */
@Component({
  selector: 'app-ops-approvals',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <ul class="list">
      @for (a of approvals(); track a.turnId) {
        <li class="card" [attr.data-urgency]="a.urgency" [class.live]="a.live">
          <div class="top">
            <code class="verb">{{ a.verb }}</code>
            @if (a.live) {
              <span class="chip live" title="Approving this changes something in production"
                >Goes live</span
              >
            }
            <span
              class="age"
              [attr.data-urgency]="a.urgency"
              [title]="a.requestedAtUtc | date: 'medium'"
            >
              waiting {{ age(a.ageMs) }}
            </span>
          </div>
          @if (a.targets.length > 0) {
            <div class="targets">
              @for (t of a.targets; track $index) {
                <code>{{ t }}</code>
              }
            </div>
          }
          @if (a.sideEffect) {
            <p class="effect">{{ a.sideEffect }}</p>
          }
          <div class="foot">
            <span class="order" [title]="a.workOrder">{{ a.workOrder }}</span>
            <a
              class="open"
              [routerLink]="['/conversations']"
              [queryParams]="{ conversation: a.sessionId }"
              >Open and decide →</a
            >
          </div>
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: var(--space-2);
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-left: 3px solid var(--text-tertiary);
        border-radius: var(--radius-lg);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
        min-width: 0;
      }
      /* The left edge carries the wait: quiet while it is fresh, loud once it has been ignored. */
      .card[data-urgency='waiting'] {
        border-left-color: var(--warning);
      }
      .card[data-urgency='stalled'] {
        border-left-color: var(--loss);
        background: color-mix(in srgb, var(--loss) 5%, var(--bg-secondary));
      }
      .top {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      .verb {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .chip {
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .chip.live {
        color: #fff;
        background: var(--loss);
      }
      .age {
        margin-left: auto;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .age[data-urgency='waiting'] {
        color: var(--warning);
      }
      .age[data-urgency='stalled'] {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .targets {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .targets code {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .effect {
        margin: 0;
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .foot {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        margin-top: 2px;
      }
      .order {
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .open {
        margin-left: auto;
        flex: none;
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium);
      }
      .open:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class OpsApprovalsComponent {
  readonly approvals = input.required<readonly PendingApproval[]>();

  protected readonly age = formatAge;
}
