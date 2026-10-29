import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One summary figure: its value as text (zero is a real figure), and what it means. */
export interface StatTile {
  label: string;
  /** Already formatted ("0", "3 of 4", "12 h ago", "Off"). */
  value: string;
  /** One line saying what the figure means right now. */
  caption?: string | null;
  tone?: 'good' | 'warn' | 'bad' | null;
  /** Where to go for the detail behind the figure. */
  route?: string | null;
  query?: Record<string, string> | null;
  /** Longer explanation on hover. */
  title?: string | null;
}

/**
 * The summary strip at the top of the organisation, platform and account screens: 3–6 tiles of real
 * figures, each with a caption saying what it means (".pages-program" no-empty-page standard, point 1).
 */
@Component({
  selector: 'app-stat-tiles',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <ul class="tiles" [attr.aria-label]="label()">
      @for (t of tiles(); track t.label) {
        <li class="tile" [attr.data-tone]="t.tone ?? null" [attr.title]="t.title ?? null">
          <span class="t-label">{{ t.label }}</span>
          @if (t.route) {
            <a class="t-value" [routerLink]="t.route" [queryParams]="t.query ?? undefined">{{
              t.value
            }}</a>
          } @else {
            <span class="t-value">{{ t.value }}</span>
          }
          @if (t.caption) {
            <span class="t-caption">{{ t.caption }}</span>
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      .tiles {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-3);
      }
      .tile {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-top: 3px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .tile[data-tone='good'] {
        border-top-color: var(--profit);
      }
      .tile[data-tone='warn'] {
        border-top-color: var(--warning);
      }
      .tile[data-tone='bad'] {
        border-top-color: var(--loss);
      }
      .t-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .t-value {
        font-size: var(--text-xl, 1.25rem);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
        text-decoration: none;
      }
      a.t-value:hover {
        color: var(--accent);
      }
      .t-caption {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
      }
    `,
  ],
})
export class StatTilesComponent {
  readonly tiles = input.required<StatTile[]>();
  readonly label = input('Summary');
}
