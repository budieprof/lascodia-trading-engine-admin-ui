import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { RecTimelineEventDto } from '../../trade-recommendations.types';

/** The card's life as one oldest-first list: chat, plan, monitors, signal, orders, positions. */
@Component({
  selector: 'app-rec-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  styleUrls: ['../../rec-shared.scss'],
  template: `
    @if (events().length === 0) {
      <p class="empty-line">Nothing has happened to this card yet.</p>
    } @else {
      <ol class="tl">
        @for (e of events(); track $index) {
          <li class="ev" [attr.data-tone]="e.tone">
            <span class="dot" aria-hidden="true"></span>
            <div class="body">
              <div class="row">
                <span class="title">{{ e.title }}</span>
                @if (link(e); as l) {
                  <a class="ref" [routerLink]="l.path" [queryParams]="l.query">{{ l.label }} ↗</a>
                }
              </div>
              <div class="when mono muted">
                {{ e.atUtc | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC · {{ e.kind }}
              </div>
              @if (e.detail) {
                <p class="detail">{{ plain(e.detail) }}</p>
              }
            </div>
          </li>
        }
      </ol>
    }
  `,
  styles: [
    `
      .tl {
        list-style: none;
        margin: 0;
        padding: 0;
        position: relative;
      }
      .tl::before {
        content: '';
        position: absolute;
        left: 5px;
        top: 6px;
        bottom: 6px;
        width: 2px;
        background: var(--border);
      }
      .ev {
        position: relative;
        display: flex;
        gap: 12px;
        padding: 0 0 14px;
      }
      .dot {
        flex: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        margin-top: 3px;
        background: var(--bg-secondary);
        border: 2px solid var(--text-secondary);
        box-sizing: border-box;
        z-index: 1;
      }
      .ev[data-tone='good'] .dot {
        border-color: var(--profit);
        background: var(--profit);
      }
      .ev[data-tone='bad'] .dot {
        border-color: var(--loss);
        background: var(--loss);
      }
      .ev[data-tone='warn'] .dot {
        border-color: var(--warning);
      }
      .body {
        min-width: 0;
        flex: 1;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .title {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .ref {
        font-size: 12px;
        color: var(--accent);
        text-decoration: none;
      }
      .ref:hover {
        text-decoration: underline;
      }
      .when {
        font-size: 11.5px;
      }
      .detail {
        margin: 4px 0 0;
        font-size: 12.5px;
        line-height: 1.45;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class RecTimelineComponent {
  readonly events = input<RecTimelineEventDto[]>([]);

  /** Timeline snippets are cut from chat markdown; drop the markup so a cut table or ** reads as prose. */
  plain(s: string): string {
    return s
      .replace(/\|?\s*-{3,}\s*(\|\s*-{3,}\s*)*\|?/g, ' ')
      .replace(/[*`#]+/g, '')
      .replace(/\s*\|\s*/g, ' · ')
      .replace(/(\s·\s)+/g, ' · ')
      .replace(/\s+/g, ' ')
      .replace(/^\s*·\s*|\s*·\s*$/g, '')
      .trim();
  }

  link(
    e: RecTimelineEventDto,
  ): { path: unknown[]; query: Record<string, unknown> | null; label: string } | null {
    if (e.refId == null) return null;
    switch (e.refKind) {
      case 'monitor':
        return {
          path: ['/analysis-monitors'],
          query: { focus: e.refId },
          label: `monitor #${e.refId}`,
        };
      case 'signal':
        return { path: ['/trade-signals', e.refId], query: null, label: `signal #${e.refId}` };
      case 'order':
        return { path: ['/orders', e.refId], query: null, label: `order #${e.refId}` };
      case 'position':
        return { path: ['/positions', e.refId], query: null, label: `position #${e.refId}` };
      case 'analysis':
        return {
          path: ['/conversations'],
          query: { conversation: e.refId },
          label: `conversation #${e.refId}`,
        };
      case 'plan':
        return { path: ['/patient-trader'], query: null, label: `plan #${e.refId}` };
      case 'pending':
        return { path: ['/pending-signal-recs'], query: null, label: `parked rec #${e.refId}` };
      default:
        return null;
    }
  }
}
