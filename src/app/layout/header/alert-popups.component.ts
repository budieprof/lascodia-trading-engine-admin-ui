import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';

import { AlertPopupsService, type AlertPopup } from '@core/alerts/alert-popups.service';

/**
 * The alert pop-ups (contract C2): a stack in the bottom-right corner, newest on top, each with the alert's title,
 * message and time, "Open" (the chart at that symbol and timeframe, or the script strategy) and dismiss. Hosted by the
 * notification bell, which is on every page.
 */
@Component({
  selector: 'app-alert-popups',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    @if (service.popups().length) {
      <div class="ap-stack" role="region" aria-label="Fired alerts" aria-live="polite">
        @for (p of service.popups(); track p.key) {
          <div
            class="ap"
            [class]="'ap sev-' + p.payload.severity.toLowerCase()"
            data-testid="alert-popup"
          >
            <div class="ap-head">
              <span class="ap-kind">{{ kindLabel(p) }}</span>
              <span class="ap-time">{{ p.payload.firedAtUtc | date: 'HH:mm:ss' }}</span>
              <button type="button" class="ap-x" title="Dismiss" (click)="service.dismiss(p.key)">
                ✕
              </button>
            </div>
            <div class="ap-title">{{ p.payload.title }}</div>
            <div class="ap-msg">{{ p.payload.message }}</div>
            @if (p.link) {
              <button type="button" class="ap-open" (click)="open(p)">Open</button>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .ap-stack {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1200;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(360px, calc(100vw - 32px));
      }
      .ap {
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--border, #e6e9ef);
        border-left: 4px solid var(--accent, #2962ff);
        background: var(--bg-primary, #fff);
        color: var(--text-primary, #1d2433);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
        font-size: 13px;
      }
      .ap.sev-info {
        border-left-color: #607d8b;
      }
      .ap.sev-medium {
        border-left-color: #2962ff;
      }
      .ap.sev-high {
        border-left-color: #fb8c00;
      }
      .ap.sev-critical {
        border-left-color: #e53935;
      }
      .ap-head {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: var(--text-tertiary, #6b7280);
      }
      .ap-kind {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ap-time {
        margin-left: auto;
      }
      .ap-x,
      .ap-open {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      .ap-title {
        margin-top: 2px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .ap-msg {
        margin-top: 2px;
        overflow-wrap: anywhere;
      }
      .ap-open {
        margin-top: 6px;
        padding: 0;
        color: var(--accent, #2962ff);
        font-weight: 600;
      }
    `,
  ],
})
export class AlertPopupsComponent {
  protected readonly service = inject(AlertPopupsService);
  private readonly router = inject(Router);

  protected kindLabel(p: AlertPopup): string {
    switch (p.payload.source) {
      case 'script':
        return 'Script alert';
      case 'screen':
        return 'Screen alert';
      case 'test':
        return 'Test alert';
      case 'drawing':
        return 'Drawing alert';
      default:
        return 'Price alert';
    }
  }

  protected open(p: AlertPopup): void {
    if (!p.link) return;
    void this.router.navigate(p.link.route, { queryParams: p.link.params });
    this.service.dismiss(p.key);
  }
}
