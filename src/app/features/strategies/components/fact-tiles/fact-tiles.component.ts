import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One summary figure. `value` is already formatted (units included); `caption` says what it means. */
export interface FactTile {
  label: string;
  value: string;
  caption?: string | null;
  tone?: 'good' | 'bad' | 'warn' | 'muted' | null;
  /** Tooltip with the exact definition of the figure. */
  title?: string | null;
  route?: string | null;
  query?: Record<string, string> | null;
}

/**
 * A row of 3–6 summary tiles with a caption under each figure ("0 · none due until …"). The shared
 * metric card has no caption, and the pages of this group explain their zeros, so they use this.
 */
@Component({
  selector: 'app-fact-tiles',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="tiles" role="list">
      @for (t of tiles(); track t.label) {
        <div class="tile" role="listitem" [attr.data-tone]="t.tone ?? null" [title]="t.title ?? ''">
          <span class="label">{{ t.label }}</span>
          @if (t.route) {
            <a class="value link" [routerLink]="t.route" [queryParams]="t.query ?? undefined">{{
              t.value
            }}</a>
          } @else {
            <span class="value">{{ t.value }}</span>
          }
          @if (t.caption) {
            <span class="caption">{{ t.caption }}</span>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-3);
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .value {
        font-size: var(--text-xl, 1.25rem);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .value.link {
        color: var(--accent);
        text-decoration: none;
      }
      .value.link:hover {
        text-decoration: underline;
      }
      .caption {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.35;
      }
      .tile[data-tone='good'] .value {
        color: var(--profit);
      }
      .tile[data-tone='bad'] .value {
        color: var(--loss);
      }
      .tile[data-tone='warn'] .value {
        color: var(--warning);
      }
      .tile[data-tone='muted'] .value {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class FactTilesComponent {
  readonly tiles = input.required<FactTile[]>();
}
