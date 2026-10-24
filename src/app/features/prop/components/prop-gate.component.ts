import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';

import { errorText } from '@features/iam/iam.logic';
import { PropApiService } from '../prop-api.service';
import type { PropModuleStatus } from '../prop.types';

/** Overlay and dialog look shared by the prop pages (scoped per component through `styles`). */
export const PROP_DIALOG_STYLES = `
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: min(760px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
  }
  .dialog h3 {
    margin: 0;
    font-size: var(--text-base);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pos { color: var(--profit, #1f9d55); }
  .neg { color: var(--loss); }
`;

/**
 * The prop module is a plan add-on: this asks the engine once (`GET prop/status`) and shows the
 * upgrade notice in place of the page when the organisation's plan does not include it — never an
 * error. `ready` fires once when the module is available, so the page loads its data only then.
 */
@Component({
  selector: 'app-prop-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    @switch (state()) {
      @case ('loading') {
        <p class="pad muted">Loading…</p>
      }
      @case ('unavailable') {
        <section class="card">
          <header class="card-head">
            <h3>Prop-firm module</h3>
            <span class="chip info">Not in your plan</span>
          </header>
          <div class="card-body">
            <p>
              Challenge programs, rule evaluation with automatic account halts, trader dashboards and
              payout statements are a separate module.
            </p>
            <p class="note">
              {{
                status()?.message ??
                  "Your organisation's plan does not include the prop-firm module. Ask platform staff to move the organisation to a plan that does."
              }}
            </p>
          </div>
        </section>
      }
      @case ('error') {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ error() }}</p>
        </section>
      }
      @default {
        <ng-content />
      }
    }
  `,
})
export class PropGateComponent {
  private readonly api = inject(PropApiService);

  readonly ready = output<void>();
  readonly status = signal<PropModuleStatus | null>(null);
  readonly state = signal<'loading' | 'available' | 'unavailable' | 'error'>('loading');
  readonly error = signal<string | null>(null);

  constructor() {
    this.api.status().subscribe({
      next: (s) => {
        this.status.set(s);
        this.state.set(s.available ? 'available' : 'unavailable');
        // After the parent has bound (ready) even when the answer arrives synchronously.
        if (s.available) queueMicrotask(() => this.ready.emit());
      },
      error: (e) => {
        this.error.set(errorText(e, 'Could not check whether the prop-firm module is available.'));
        this.state.set('error');
      },
    });
  }
}
