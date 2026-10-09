import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { STRATEGY_EXAMPLES, type StrategyExample } from './strategy-examples';

/**
 * PE-I9: the example gallery in the strategy editor — complete strategies to start from, each with
 * an ATR stop and every parameter an input. Picking one hands it to the host, which puts it in the
 * editor as an undoable edit.
 */
@Component({
  selector: 'app-example-gallery',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="gallery" aria-label="Example strategies" data-testid="example-gallery">
      <header class="head">
        <h4 class="title">Start from an example</h4>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="closed.emit()">Close</button>
      </header>
      <ul class="cards">
        @for (ex of examples(); track ex.id) {
          <li class="card" [attr.data-example]="ex.id">
            <div class="card-head">
              <span class="card-title">{{ ex.title }}</span>
              <span class="chip">{{ ex.style }}</span>
              @if (ex.usesClassic) {
                <span
                  class="chip chip-accent"
                  title="Imports the built-in lascodia/classic/1 library"
                  >lascodia/classic</span
                >
              }
            </div>
            <p class="summary">{{ ex.summary }}</p>
            <button type="button" class="btn btn-sm" (click)="picked.emit(ex)">
              Use this example
            </button>
          </li>
        }
      </ul>
      <p class="note">
        Examples show the shape of a strategy; none is a proven edge. Backtest one, and read its R
        analysis, before trusting it.
      </p>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .gallery {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 12px;
        background: var(--bg-secondary);
        margin-bottom: 8px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .spacer {
        flex: 1;
      }
      .cards {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
        gap: 8px;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-primary);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .card-title {
        font-weight: 600;
        font-size: 13px;
      }
      .chip {
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        font-size: 11px;
        color: var(--text-secondary);
      }
      .chip-accent {
        border-color: var(--accent);
        color: var(--accent);
      }
      .summary {
        margin: 0;
        flex: 1;
        font-size: 12px;
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .card .btn {
        align-self: flex-start;
      }
      .note {
        margin: 8px 0 0;
        font-size: 11px;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class ExampleGalleryComponent {
  readonly examples = input<readonly StrategyExample[]>(STRATEGY_EXAMPLES);
  readonly picked = output<StrategyExample>();
  readonly closed = output<void>();
}
