import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import {
  DEFAULT_LAYER_GROUPS,
  LAYER_GROUPS,
  withGroupOpacity,
  withGroupVisible,
  type LayerGroupId,
  type LayerGroupsState,
} from './layer-groups';

/**
 * The layer menu's "Layer groups" section (PR-5): per group a show/hide switch and an opacity slider.
 * Emits the whole new state; the page keeps it (and saves it with the layout).
 */
@Component({
  selector: 'app-layer-groups-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lg-heading">Layer groups</div>
    @for (g of defs; track g.id) {
      <div class="lg-row" [title]="g.members">
        <button
          type="button"
          role="menuitemcheckbox"
          class="lg-toggle"
          [class.on]="groups()[g.id].visible"
          [attr.aria-checked]="groups()[g.id].visible"
          (click)="toggle(g.id)"
          [attr.data-testid]="'layer-group-' + g.id"
        >
          <span class="lg-check" aria-hidden="true">{{ groups()[g.id].visible ? '✓' : '' }}</span>
          {{ g.label }}
        </button>
        <input
          type="range"
          class="lg-slider"
          min="0.1"
          max="1"
          step="0.05"
          [value]="groups()[g.id].opacity"
          [disabled]="!groups()[g.id].visible"
          (input)="setOpacity(g.id, $any($event.target).valueAsNumber)"
          [attr.aria-label]="g.label + ' opacity'"
          [attr.data-testid]="'layer-opacity-' + g.id"
        />
        <span class="lg-value">{{ percent(g.id) }}</span>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .lg-heading {
        padding: 6px 12px 2px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--tv-muted, #787b86);
      }
      .lg-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px 0 0;
      }
      .lg-toggle {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 0 4px 0 12px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .lg-toggle:hover {
        background: var(--tv-hover, rgba(120, 123, 134, 0.12));
      }
      .lg-check {
        width: 14px;
        color: #2962ff;
      }
      .lg-toggle:not(.on) {
        color: var(--tv-muted, #787b86);
      }
      .lg-slider {
        width: 88px;
        accent-color: #2962ff;
      }
      .lg-value {
        width: 34px;
        text-align: right;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: var(--tv-muted, #787b86);
      }
    `,
  ],
})
export class LayerGroupsMenuComponent {
  readonly groups = input<LayerGroupsState>(DEFAULT_LAYER_GROUPS);
  readonly groupsChange = output<LayerGroupsState>();
  readonly defs = LAYER_GROUPS;

  toggle(id: LayerGroupId): void {
    this.groupsChange.emit(withGroupVisible(this.groups(), id, !this.groups()[id].visible));
  }

  setOpacity(id: LayerGroupId, value: number): void {
    const next = withGroupOpacity(this.groups(), id, value);
    if (next !== this.groups()) this.groupsChange.emit(next);
  }

  percent(id: LayerGroupId): string {
    return `${Math.round(this.groups()[id].opacity * 100)}%`;
  }
}
