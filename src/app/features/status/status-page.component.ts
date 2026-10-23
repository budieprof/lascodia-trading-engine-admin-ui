import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import type { Subscription } from 'rxjs';

import { ThemeService } from '@core/theme/theme.service';
import { LogoComponent } from '@shared/components/logo/logo.component';
import { StatusApiService } from './status-api.service';
import {
  STATUS_POLL_MS,
  headline,
  levelLabel,
  levelTone,
  orderComponents,
  updatedText,
  type PageView,
} from './status.logic';
import type { PublicStatusDocument } from './status.types';

/**
 * Public status page (`/status`, no sign-in; engine resilience program). Shows the engine's own public status
 * document — one line per component, worst first — and refreshes every 30 s. It carries no detail beyond the engine's
 * fixed words: no counts, identifiers or host names. When the engine cannot be reached the page says so and keeps the
 * last answer it had, marked as stale.
 */
@Component({
  selector: 'app-status-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LogoComponent],
  template: `
    <div class="st-page">
      <header class="st-header">
        <app-logo [size]="28" />
        <span class="st-brand">Lascodia</span>
        <span class="st-sep" aria-hidden="true">·</span>
        <h1 class="st-title">System status</h1>
      </header>

      <main class="st-main">
        <section
          class="st-banner"
          [attr.data-tone]="banner().tone"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="st-dot" aria-hidden="true"></span>
          <span class="st-banner__text">{{ banner().text }}</span>
        </section>

        @if (doc(); as d) {
          <ul class="st-list" aria-label="Components">
            @for (c of components(); track c.id) {
              <li class="st-row">
                <div class="st-row__name">
                  <span class="st-row__title">{{ c.name }}</span>
                  <span class="st-row__msg">{{ c.message }}</span>
                </div>
                <span class="st-pill" [attr.data-tone]="tone(c.status)">{{ label(c.status) }}</span>
              </li>
            }
          </ul>
          <p class="st-foot">
            {{ updated() }}
            @if (view().kind === 'unreachable') {
              <span class="st-stale">— last known status, the service is not answering now.</span>
            }
          </p>
        }
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .st-page {
        max-width: 760px;
        margin: 0 auto;
        padding: 32px 16px 48px;
      }
      .st-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 28px;
      }
      .st-brand {
        font-weight: 600;
        font-size: 17px;
      }
      .st-sep {
        color: var(--text-tertiary);
      }
      .st-title {
        margin: 0;
        font-size: 17px;
        font-weight: 500;
        color: var(--text-secondary);
      }
      .st-banner {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 18px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        font-size: 16px;
        font-weight: 500;
      }
      .st-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex: none;
        background: var(--text-tertiary);
      }
      [data-tone='success'] .st-dot {
        background: var(--profit);
      }
      [data-tone='warning'] .st-dot {
        background: var(--warning);
      }
      [data-tone='danger'] .st-dot {
        background: var(--loss);
      }
      .st-list {
        list-style: none;
        margin: 20px 0 0;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
      }
      .st-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 18px;
        background: var(--bg-secondary);
      }
      .st-row + .st-row {
        border-top: 1px solid var(--border);
      }
      .st-row__name {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .st-row__title {
        font-weight: 500;
      }
      .st-row__msg {
        font-size: 13px;
        color: var(--text-secondary);
      }
      .st-pill {
        flex: none;
        font-size: 12px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 999px;
        border: 1px solid currentColor;
        color: var(--text-secondary);
      }
      .st-pill[data-tone='success'] {
        color: var(--profit);
      }
      .st-pill[data-tone='warning'] {
        color: var(--warning);
      }
      .st-pill[data-tone='danger'] {
        color: var(--loss);
      }
      .st-foot {
        margin: 14px 2px 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }
      .st-stale {
        color: var(--warning);
      }
    `,
  ],
})
export class StatusPageComponent implements OnInit {
  private readonly api = inject(StatusApiService);
  private readonly destroyRef = inject(DestroyRef);
  private inFlight: Subscription | null = null;

  readonly view = signal<PageView>({ kind: 'loading' });
  private readonly now = signal(Date.now());

  readonly doc = computed<PublicStatusDocument | null>(() => {
    const v = this.view();
    return v.kind === 'ready' ? v.doc : v.kind === 'unreachable' ? v.lastGood : null;
  });
  readonly banner = computed(() => headline(this.view()));
  readonly components = computed(() => orderComponents(this.doc()?.components ?? []));
  readonly updated = computed(() => updatedText(this.doc()?.generatedAtUtc, this.now()));

  protected readonly label = levelLabel;
  protected readonly tone = levelTone;

  constructor() {
    // The page is outside the console, which is what normally starts the theme.
    inject(ThemeService);
  }

  ngOnInit(): void {
    this.refresh();
    const poll = setInterval(() => this.refresh(), STATUS_POLL_MS);
    const clock = setInterval(() => this.now.set(Date.now()), 5_000);
    this.destroyRef.onDestroy(() => {
      clearInterval(poll);
      clearInterval(clock);
      this.inFlight?.unsubscribe();
    });
  }

  private refresh(): void {
    this.inFlight?.unsubscribe();
    this.inFlight = this.api.status().subscribe({
      next: (doc) => {
        this.view.set({ kind: 'ready', doc });
        this.now.set(Date.now());
      },
      error: () => this.view.set({ kind: 'unreachable', lastGood: this.doc() }),
    });
  }
}
