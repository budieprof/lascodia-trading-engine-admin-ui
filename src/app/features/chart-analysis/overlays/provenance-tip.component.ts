import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Provenance } from './provenance';

/** Where a provenance card is shown (container px) and what it says. */
export interface ProvenanceTip {
  x: number;
  y: number;
  card: Provenance;
}

/**
 * "How was this computed?" — the card shown while the pointer rests on a derived layer (PR-4): its
 * method and inputs, with an "Estimate" badge on layers placed by assumption (the stop pools).
 */
@Component({
  selector: 'app-provenance-tip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tip(); as t) {
      <div
        class="prov-tip"
        [style.left.px]="t.x"
        [style.top.px]="t.y"
        role="tooltip"
        aria-live="polite"
        data-testid="provenance-tip"
      >
        <div class="prov-head">
          @if (t.card.estimate) {
            <span class="prov-badge">Estimate</span>
          }
          <b>{{ t.card.title }}</b>
        </div>
        @for (line of t.card.lines; track $index) {
          <p>{{ line }}</p>
        }
      </div>
    }
  `,
  styles: [
    `
      .prov-tip {
        position: absolute;
        z-index: 30;
        width: 280px;
        padding: 8px 10px;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e6e9ef);
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
        font-size: 12px;
        line-height: 17px;
        pointer-events: none;
      }
      .prov-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 4px;
      }
      .prov-head b {
        font-weight: 600;
      }
      .prov-badge {
        flex: none;
        padding: 0 5px;
        border-radius: 3px;
        background: #ff7043;
        color: #fff;
        font-size: 11px;
      }
      p {
        margin: 0 0 3px;
        color: var(--text-muted, #5d606b);
      }
    `,
  ],
})
export class ProvenanceTipComponent {
  readonly tip = input<ProvenanceTip | null>(null);
}

/**
 * Where the card goes: beside the pointer, flipped left near the right edge and kept inside the pane
 * (`width` × `height` container px). The card is ~280 px wide; its height is estimated from its lines.
 */
export function placeProvenanceTip(
  point: { x: number; y: number },
  card: Provenance,
  width: number,
  height: number,
): { x: number; y: number } {
  const w = 280;
  const h = 30 + card.lines.reduce((s, l) => s + 17 * Math.max(1, Math.ceil(l.length / 46)), 0);
  const x = point.x + 16 + w > width ? Math.max(4, point.x - 16 - w) : point.x + 16;
  const y = Math.max(4, Math.min(point.y + 12, height - h - 4));
  return { x, y };
}
