import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';

import { EaOpsService, type TrackedAction } from './ea-ops.service';
import { formatDuration } from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

/**
 * "What happened to what I just did": every command / host job sent from the
 * page, live until the EA or the host answers. Hidden while empty.
 */
@Component({
  selector: 'app-ea-action-results',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length > 0) {
      <section class="panel" aria-label="Results of your actions" aria-live="polite">
        <header class="panel-head">
          <h3>Your actions</h3>
          @if (hasFinished()) {
            <button type="button" class="link-btn small" (click)="ops.clearFinished()">
              Clear finished
            </button>
          }
        </header>
        <ul class="list">
          @for (a of items(); track a.key) {
            <li [attr.data-tone]="a.tone" [class.child]="!!a.parentKey">
              <span class="dot" [attr.data-tone]="a.tone"></span>
              <div class="body">
                <div class="line">
                  <strong>{{ a.label }}</strong>
                  <span class="pill" [attr.data-tone]="a.tone">{{ statusWord(a) }}</span>
                  <span class="muted small">{{ elapsed(a) }}</span>
                </div>
                <div class="text">{{ a.text }}</div>
              </div>
              <button
                type="button"
                class="close"
                (click)="ops.dismiss(a.key)"
                [attr.aria-label]="'Dismiss ' + a.label"
                title="Dismiss"
              >
                ×
              </button>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      li {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      li.child {
        margin-left: 24px;
      }
      li[data-tone='bad'] {
        border-color: rgba(255, 59, 48, 0.4);
      }
      li[data-tone='ok'] {
        border-color: rgba(52, 199, 89, 0.35);
      }
      li .dot {
        margin-top: 6px;
      }
      li[data-tone='pending'] .dot {
        animation: pulse 1.2s ease-in-out infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.3;
        }
      }
      .body {
        flex: 1;
        min-width: 0;
      }
      .line {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        flex-wrap: wrap;
        font-size: var(--text-sm);
      }
      .text {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-top: 2px;
        overflow-wrap: anywhere;
      }
      .close {
        background: none;
        border: none;
        font-size: 18px;
        line-height: 1;
        color: var(--text-tertiary);
        cursor: pointer;
      }
    `,
  ],
})
export class EaActionResultsComponent {
  protected readonly ops = inject(EaOpsService);
  protected readonly items = this.ops.tracked;
  protected readonly hasFinished = computed(() => this.items().some((a) => a.final || a.gaveUp));
  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected statusWord(a: TrackedAction): string {
    if (a.gaveUp) return 'No answer yet';
    switch (a.status) {
      case 'Pending':
        return 'Waiting';
      case 'Delivered':
        return 'Delivered';
      case 'Claimed':
        return 'In progress';
      default:
        return a.status;
    }
  }

  protected elapsed(a: TrackedAction): string {
    const end = a.finishedAt ?? this.now();
    const s = (end - a.startedAt) / 1000;
    return a.finishedAt ? `took ${formatDuration(s)}` : `${formatDuration(s)} so far`;
  }
}
