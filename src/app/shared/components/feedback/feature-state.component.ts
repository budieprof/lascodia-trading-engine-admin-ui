import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One thing a feature needs before it produces anything, with its real current status. */
export interface FeatureRequirement {
  /** Plain-language name of the requirement ("Polygon API key", "A crypto market-data feed running"). */
  label: string;
  /** true = in place, false = missing, null = unknown / not checked. */
  ok: boolean | null;
  /** What was found, or what to do about it ("not set on the engine host — add POLYGON key to .env"). */
  detail?: string | null;
  /** In-app route that fixes it, e.g. '/engine-config'. */
  route?: string | null;
  /** Query params for `route` (e.g. { search: 'Execution:' }). */
  query?: Record<string, string> | null;
}

export interface FeatureLink {
  label: string;
  route?: string | null;
  query?: Record<string, string> | null;
  href?: string | null;
}

export type FeatureStateKind = 'on' | 'off' | 'partial' | 'waiting';

/**
 * Explains a feature instead of leaving a page blank: what it does, whether it is on (and the switch
 * that controls it), what it still needs — each with its real status — and where to go next.
 * Use it at the top of a page whose feature is off, not set up, or has produced nothing yet
 * (see `.pages-program/PROGRAM.md`, "the no empty page standard"). Never feed it made-up status.
 */
@Component({
  selector: 'app-feature-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="fs" [attr.data-kind]="kind()" role="status">
      <header class="head">
        <span class="pill">{{ pill() }}</span>
        <h3 class="title">{{ title() }}</h3>
        @if (switchKey()) {
          <code class="key" title="Engine setting that controls this feature">{{
            switchKey()
          }}</code>
        }
      </header>
      <p class="summary">{{ summary() }}</p>
      @if (detail()) {
        <p class="detail">{{ detail() }}</p>
      }
      @if (requirements().length) {
        <ul class="reqs" aria-label="What this feature needs">
          @for (r of requirements(); track r.label) {
            <li [attr.data-ok]="r.ok === null ? 'unknown' : r.ok">
              <span class="mark" aria-hidden="true">{{
                r.ok === true ? '✓' : r.ok === false ? '✕' : '?'
              }}</span>
              <span class="req-label">{{ r.label }}</span>
              @if (r.detail) {
                <span class="req-detail">{{ r.detail }}</span>
              }
              @if (r.route) {
                <a class="req-link" [routerLink]="r.route" [queryParams]="r.query ?? undefined"
                  >Open</a
                >
              }
            </li>
          }
        </ul>
      }
      @if (links().length) {
        <nav class="links" aria-label="Related">
          @for (l of links(); track l.label) {
            @if (l.route) {
              <a [routerLink]="l.route" [queryParams]="l.query ?? undefined">{{ l.label }}</a>
            } @else if (l.href) {
              <a [href]="l.href" target="_blank" rel="noopener">{{ l.label }}</a>
            }
          }
        </nav>
      }
    </section>
  `,
  styles: [
    `
      .fs {
        border: 1px solid var(--border);
        border-left: 4px solid var(--text-tertiary);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--space-4) var(--space-5);
        display: grid;
        gap: var(--space-3);
      }
      .fs[data-kind='on'] {
        border-left-color: var(--profit);
      }
      .fs[data-kind='off'] {
        border-left-color: var(--warning);
      }
      .fs[data-kind='partial'],
      .fs[data-kind='waiting'] {
        border-left-color: var(--accent);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
      }
      .pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary, var(--bg-primary));
        color: var(--text-secondary);
      }
      .title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }
      .key {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        overflow-wrap: anywhere;
      }
      .summary,
      .detail {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        max-width: 80ch;
      }
      .reqs {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--space-2);
      }
      .reqs li {
        display: grid;
        grid-template-columns: 1.25rem minmax(10rem, max-content) 1fr auto;
        gap: var(--space-2);
        align-items: baseline;
        font-size: var(--text-sm);
      }
      .mark {
        font-weight: var(--font-bold, 700);
        color: var(--text-tertiary);
      }
      li[data-ok='true'] .mark {
        color: var(--profit);
      }
      li[data-ok='false'] .mark {
        color: var(--loss);
      }
      .req-label {
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .req-detail {
        color: var(--text-secondary);
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .req-link,
      .links a {
        font-size: var(--text-sm);
        color: var(--accent);
      }
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
      }
      @media (max-width: 860px) {
        .reqs li {
          grid-template-columns: 1.25rem 1fr;
        }
        .req-detail,
        .req-link {
          grid-column: 2;
        }
      }
    `,
  ],
})
export class FeatureStateComponent {
  /** Feature name as the operator knows it ("Instrument candle builder"). */
  readonly title = input.required<string>();
  /** What it does, in one or two plain sentences. */
  readonly summary = input.required<string>();
  /** Current state: on (working), off (switched off), partial (on, something missing), waiting (on, no data yet). */
  readonly kind = input<FeatureStateKind>('on');
  /** Overrides the default pill text for `kind`. */
  readonly stateLabel = input<string | null>(null);
  /** The engine setting that switches it, shown so it can be found on Engine config. */
  readonly switchKey = input<string | null>(null);
  /** Extra sentence about the current state ("Waiting for the first exchange trade print"). */
  readonly detail = input<string | null>(null);
  readonly requirements = input<FeatureRequirement[]>([]);
  readonly links = input<FeatureLink[]>([]);

  protected readonly pill = computed(
    () =>
      this.stateLabel() ??
      { on: 'On', off: 'Off', partial: 'On · needs setup', waiting: 'On · no data yet' }[
        this.kind()
      ],
  );
}
