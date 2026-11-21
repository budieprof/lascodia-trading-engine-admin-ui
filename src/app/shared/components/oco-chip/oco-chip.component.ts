import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { OcoChipPartner, ocoHue, ocoShortCode } from '../../utils/oco';

/**
 * The one-cancels-other badge: "⛓ OCO AD37 ↔ #11 #12". Every leg of a group carries the same
 * colour and code, so linked cards and watches pair up by eye; hovering one reports the group (the
 * page highlights its partners) and clicking narrows the page to the group.
 *
 * Safe inside a link or a clickable row: a click never reaches the parent.
 */
@Component({
  selector: 'app-oco-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="oco"
      [class.oco--lit]="highlighted()"
      [class.oco--static]="!selectable()"
      [style.--oco-h]="hue()"
      [attr.role]="selectable() ? 'button' : null"
      [attr.tabindex]="selectable() ? 0 : null"
      [attr.title]="title()"
      [attr.aria-label]="title()"
      (click)="select($event)"
      (keydown.enter)="select($event)"
      (keydown.space)="select($event)"
      (mouseenter)="hover.emit(groupId())"
      (mouseleave)="hover.emit(null)"
      (focus)="hover.emit(groupId())"
      (blur)="hover.emit(null)"
    >
      <span class="dot" aria-hidden="true"></span>
      <b>OCO</b>
      <span class="code">{{ code() }}</span>
      @if (shown().length > 0) {
        <span class="sep" aria-hidden="true">↔</span>
        @for (p of shown(); track p.id) {
          <span class="leg" [class.leg--ended]="p.ended">#{{ p.id }}</span>
        }
        @if (more() > 0) {
          <span class="leg">+{{ more() }}</span>
        }
      } @else if (showLonely()) {
        <span class="sep muted" aria-hidden="true">· no partner found</span>
      }
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        min-width: 0;
      }
      .oco {
        --oco-fg: hsl(var(--oco-h) 62% 38%);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        font-size: 11px;
        line-height: 18px;
        padding: 0 7px;
        border-radius: 999px;
        border: 1px solid hsl(var(--oco-h) 62% 45% / 0.55);
        background: hsl(var(--oco-h) 70% 50% / 0.1);
        color: var(--oco-fg);
        white-space: nowrap;
        overflow: hidden;
        cursor: pointer;
        transition:
          background 0.12s ease,
          box-shadow 0.12s ease;
      }
      :host-context([data-theme='dark']) .oco {
        --oco-fg: hsl(var(--oco-h) 75% 72%);
        background: hsl(var(--oco-h) 70% 55% / 0.16);
      }
      .oco--static {
        cursor: default;
      }
      .oco:not(.oco--static):hover,
      .oco:focus-visible,
      .oco--lit {
        background: hsl(var(--oco-h) 70% 50% / 0.2);
        box-shadow: 0 0 0 2px hsl(var(--oco-h) 70% 50% / 0.3);
        outline: none;
      }
      .dot {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: 50%;
        background: hsl(var(--oco-h) 65% 50%);
      }
      b {
        font-size: 10px;
        letter-spacing: 0.05em;
        font-weight: var(--font-semibold, 600);
      }
      .code,
      .leg {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 10.5px;
      }
      .sep {
        opacity: 0.7;
      }
      .leg--ended {
        text-decoration: line-through;
        opacity: 0.6;
      }
    `,
  ],
})
export class OcoChipComponent {
  readonly groupId = input.required<string>();
  readonly partners = input<OcoChipPartner[]>([]);
  /** The page is pointing at this group (a partner is hovered). */
  readonly highlighted = input(false);
  /** Clicking emits `select`; off for a read-only mention. */
  readonly selectable = input(true);
  /** Say so when the group names no other leg (it was never paired, or the partner was deleted). */
  readonly showLonely = input(false);
  readonly maxLegs = input(3);

  readonly hover = output<string | null>();
  readonly selected = output<string>();

  readonly hue = computed(() => ocoHue(this.groupId()));
  readonly code = computed(() => ocoShortCode(this.groupId()));
  readonly shown = computed(() => this.partners().slice(0, this.maxLegs()));
  readonly more = computed(() => Math.max(0, this.partners().length - this.maxLegs()));

  readonly title = computed(() => {
    const legs = this.partners()
      .map((p) => `#${p.id}${p.label ? ' ' + p.label : ''}${p.ended ? ' (ended)' : ''}`)
      .join(', ');
    const base = `One-cancels-other group ${this.groupId()}: when one leg fires or fills, the others are cancelled.`;
    const linked = legs ? ` Linked to ${legs}.` : '';
    return base + linked + (this.selectable() ? ' Click to show every leg.' : '');
  });

  protected select(e: Event): void {
    if (!this.selectable()) return;
    e.preventDefault();
    e.stopPropagation();
    this.selected.emit(this.groupId());
  }
}
