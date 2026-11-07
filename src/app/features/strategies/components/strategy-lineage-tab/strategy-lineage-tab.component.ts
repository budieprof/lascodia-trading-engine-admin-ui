import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { StrategyLineageDto } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { StrategiesService } from '@core/services/strategies.service';

import { layoutLineage, lineageCounts } from './lineage-layout';

/**
 * Strategy detail → Lineage tab (U13: split out of the strategy detail page, behaviour unchanged): the parent/child
 * tree centred on the strategy, read once per strategy when the tab opens.
 */
@Component({
  selector: 'app-strategy-lineage-tab',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="lineage-panel">
      @if (loadingLineage()) {
        <p class="muted">Loading lineage…</p>
      } @else if (lineage(); as l) {
        @if (l.nodes.length <= 1) {
          <p class="muted">No ancestors or descendants — this strategy was created standalone.</p>
        } @else {
          <div class="lineage-legend">
            <span class="muted small"
              >{{ ancestorCount() }} ancestor(s) · 1 focus ·
              {{ descendantCount() }} descendant(s)</span
            >
          </div>
          @if (lineageLayout(); as layout) {
            <div class="lineage-tree" [style.height.px]="layout.height">
              <svg
                class="lineage-svg"
                [attr.width]="layout.width"
                [attr.height]="layout.height"
                [attr.viewBox]="'0 0 ' + layout.width + ' ' + layout.height"
              >
                @for (e of layout.edges; track e.id) {
                  <path [attr.d]="e.path" fill="none" [attr.stroke]="e.color" stroke-width="1.4" />
                }
              </svg>
              @for (n of layout.nodes; track n.id) {
                <a
                  class="lineage-tree-node"
                  [class.is-focus]="n.depthOffset === 0"
                  [class.is-ancestor]="n.depthOffset < 0"
                  [class.is-descendant]="n.depthOffset > 0"
                  [routerLink]="n.depthOffset === 0 ? null : ['/strategies', n.id]"
                  [style.left.px]="n.x - n.width / 2"
                  [style.top.px]="n.y - 14"
                  [style.width.px]="n.width"
                  [title]="n.tooltip"
                >
                  <span class="lineage-tree-name">{{ n.name }}</span>
                  <span class="muted small">#{{ n.id }} · {{ n.symbol }}/{{ n.timeframe }}</span>
                </a>
              }
            </div>
          }
        }
      } @else {
        <p class="muted">Lineage unavailable.</p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
      }
      .lineage-panel {
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
        padding: 12px 16px;
      }
      .lineage-legend {
        margin-bottom: 8px;
      }
      .lineage-tree {
        position: relative;
        margin: 8px 0;
        overflow-x: auto;
      }
      .lineage-svg {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
      }
      .lineage-tree-node {
        position: absolute;
        height: 36px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 2px 8px;
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.2;
        text-decoration: none;
        color: var(--text-primary, #1d1d1f);
        box-sizing: border-box;
        text-align: center;
        overflow: hidden;
      }
      .lineage-tree-node.is-focus {
        background: rgba(0, 113, 227, 0.08);
        border-color: #0071e3;
        cursor: default;
        font-weight: 500;
      }
      .lineage-tree-node.is-ancestor {
        border-color: #c5b3e6;
      }
      .lineage-tree-node.is-descendant {
        border-color: #9ec5fe;
      }
      .lineage-tree-node:hover:not(.is-focus) {
        background: rgba(0, 113, 227, 0.04);
      }
      .lineage-tree-name {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
    `,
  ],
})
export class StrategyLineageTabComponent {
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  readonly strategyId = input.required<number>();

  readonly loadingLineage = signal(false);
  readonly lineage = signal<StrategyLineageDto | null>(null);

  private readonly counts = computed(() => lineageCounts(this.lineage()));
  readonly ancestorCount = computed(() => this.counts().ancestors);
  readonly descendantCount = computed(() => this.counts().descendants);
  readonly lineageLayout = computed(() => layoutLineage(this.lineage()));

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => this.fetchLineage(id));
    });
  }

  private fetchLineage(id: number): void {
    if (!id) return;
    this.lineage.set(null);
    this.loadingLineage.set(true);
    this.strategiesService.getLineage(id).subscribe({
      next: (res) => {
        if (id !== this.strategyId()) return;
        this.loadingLineage.set(false);
        this.lineage.set(res?.data ?? null);
      },
      error: () => {
        if (id !== this.strategyId()) return;
        this.loadingLineage.set(false);
        this.lineage.set(null);
        this.notifications.error('Failed to load lineage');
      },
    });
  }
}
