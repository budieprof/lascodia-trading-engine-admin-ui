import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { OcoChipComponent } from './oco-chip.component';

/**
 * "This page is showing one OCO group" — the group's chip, what that means, links to the same
 * group on the other pages (cards ↔ watches), and the way back.
 */
@Component({
  selector: 'app-oco-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, OcoChipComponent],
  template: `
    <section class="oco-banner" aria-label="OCO group filter">
      <app-oco-chip [groupId]="groupId()" [selectable]="false" />
      <span class="text">{{ text() }}</span>
      <a class="link" [routerLink]="otherPage()" [queryParams]="{ oco: groupId() }">{{
        otherLabel()
      }}</a>
      @if (secondPage(); as page) {
        <a class="link" [routerLink]="page" [queryParams]="{ oco: groupId() }">{{
          secondLabel()
        }}</a>
      }
      <button type="button" class="clear" (click)="cleared.emit()">{{ clearLabel() }}</button>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .oco-banner {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        padding: 8px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        font-size: 12.5px;
        color: var(--text-secondary);
      }
      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium, 500);
      }
      .link:hover {
        text-decoration: underline;
      }
      .clear {
        margin-left: auto;
        border: none;
        background: transparent;
        color: var(--accent);
        font: inherit;
        font-weight: var(--font-medium, 500);
        padding: 4px 8px;
        border-radius: var(--radius-full, 999px);
        cursor: pointer;
      }
      .clear:hover {
        background: rgba(0, 113, 227, 0.08);
      }
    `,
  ],
})
export class OcoBannerComponent {
  readonly groupId = input.required<string>();
  readonly text = input.required<string>();
  /** Route of the same group on the other page. */
  readonly otherPage = input.required<string>();
  readonly otherLabel = input.required<string>();
  /** Optional second destination (a page with both cards and watches links to each). */
  readonly secondPage = input<string | null>(null);
  readonly secondLabel = input('');
  readonly clearLabel = input('Show all ✕');

  readonly cleared = output<void>();
}
