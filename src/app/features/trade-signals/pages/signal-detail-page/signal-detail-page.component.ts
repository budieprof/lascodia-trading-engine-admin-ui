import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { AccountAttemptsComponent } from '../../components/account-attempts/account-attempts.component';

/**
 * Per-signal detail surface.  Currently scoped to the "Account attempts"
 * panel introduced in v8.47.172/.173 — answers "what happened to signal
 * X across every EA / account / broker?" without operator triangulation.
 *
 * The fuller detail view (signal pricing, ML score, lifecycle timeline,
 * order linkage) is queued behind this minimal scaffold so the rejection
 * log's [signal #N] click-through has somewhere meaningful to land
 * today.  Future panels mount alongside the attempts component below.
 */
@Component({
  selector: 'app-signal-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AccountAttemptsComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <h1 class="page-title">Signal #{{ signalId() ?? '—' }}</h1>
        <p class="page-subtitle">
          Cross-account attempts for this signal — every EA that polled it, every rejection it hit,
          and every engine / broker outcome that followed.
        </p>
      </header>

      @if (signalId() !== null) {
        <app-account-attempts [signalId]="signalId()" />
      } @else {
        <p class="empty muted">Invalid signal id — route is missing the numeric segment.</p>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .page-head {
        margin-bottom: var(--space-3);
      }
      .page-title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-1);
        letter-spacing: var(--tracking-tight);
      }
      .page-subtitle {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }
      .empty {
        font-size: var(--text-sm);
        padding: var(--space-3) 0;
      }
    `,
  ],
})
export class SignalDetailPageComponent {
  private readonly route = inject(ActivatedRoute);

  /**
   * Parses :id from the route param into a number.  Null when the
   * route is missing the segment or the value is non-numeric — the
   * template renders an invalid-id message in that case rather than
   * silently submitting a bogus query to the engine.
   */
  readonly signalId = toSignal(
    this.route.paramMap.pipe(
      map((params) => {
        const raw = params.get('id');
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      }),
    ),
    { initialValue: null as number | null },
  );
}
