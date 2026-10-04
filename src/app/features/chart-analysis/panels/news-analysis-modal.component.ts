import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NewsIntelService } from '@core/services/news-intel.service';
import type { NewsArticleAnalysis, NewsArticleView } from '@features/news-intel/news-intel.types';

/**
 * Long-press on a chart news item: the article, the classifier's per-currency
 * labels, and an AI read — summary, analysis, and the implication for each
 * affected pair (the chart's symbol first). Explanatory only; the engine feeds
 * this into no score and no decision.
 */
@Component({
  selector: 'app-news-analysis-modal',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="na-backdrop" (click)="closed.emit()"></div>
    <section
      class="na-modal"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="'AI analysis: ' + article().title"
    >
      <header class="na-head">
        <div>
          <div class="na-meta">
            {{ article().sourceName }} · {{ article().publishedAtUtc | date: 'EEE d MMM, HH:mm' }}
          </div>
          <h2 class="na-title">{{ article().title }}</h2>
        </div>
        <button type="button" class="na-x" (click)="closed.emit()" aria-label="Close">×</button>
      </header>

      @if (article().labels.length) {
        <div class="na-labels">
          @for (l of article().labels; track l.currency) {
            <span class="chip" [class]="tone(l.direction)" [title]="l.rationale ?? ''">
              <b>{{ l.currency }}</b> {{ l.direction }} · {{ l.category }} · {{ l.certainty }}
            </span>
          }
        </div>
      }

      @if (loading()) {
        <div class="na-loading"><span class="spin"></span> Reading the article…</div>
      } @else if (error()) {
        <div class="na-error">
          {{ error() }} <button type="button" class="link" (click)="load(true)">Retry</button>
        </div>
      } @else if (result(); as r) {
        <h3>Summary</h3>
        <p>{{ r.summary }}</p>
        <h3>Analysis</h3>
        <p>{{ r.analysis }}</p>

        <h3>Implications</h3>
        @if (r.pairs.length) {
          <table class="na-pairs">
            <tbody>
              @for (p of r.pairs; track p.symbol) {
                <tr [class.focus]="p.symbol === symbol()">
                  <td class="sym">{{ p.symbol }}</td>
                  <td class="bias" [class]="tone(p.bias)">{{ p.bias }}</td>
                  <td class="conf">
                    <span class="bar"
                      ><i [style.width.%]="p.confidence * 100" [class]="tone(p.bias)"></i
                    ></span>
                    {{ p.confidence * 100 | number: '1.0-0' }}%
                  </td>
                  <td class="hz">{{ p.horizon }}</td>
                  <td class="why">{{ p.rationale }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted">The model found no pair this article bears on.</p>
        }

        @if (r.risks.length) {
          <h3>What would change the read</h3>
          <ul class="na-risks">
            @for (k of r.risks; track k) {
              <li>{{ k }}</li>
            }
          </ul>
        }

        <footer class="na-foot">
          <span
            >{{ r.model }} · {{ r.generatedAtUtc | date: 'd MMM HH:mm'
            }}{{ r.cached ? ' · cached' : '' }}</span
          >
          @if (r.llmInvocationId) {
            <a [routerLink]="['/conversations']" [queryParams]="{ conversation: r.llmInvocationId }"
              >#{{ r.llmInvocationId }}</a
            >
          }
          @if (article().url) {
            <a [href]="article().url" target="_blank" rel="noopener noreferrer">Open article ↗</a>
          }
          <button type="button" class="link" (click)="load(true)">Regenerate</button>
        </footer>
        <p class="na-disclaimer">
          AI reading for context only — not a signal; the engine does not trade on it.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
      }
      .na-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
      }
      .na-modal {
        position: relative;
        width: min(720px, calc(100vw - 32px));
        max-height: calc(100vh - 64px);
        overflow-y: auto;
        padding: 18px 22px 16px;
        border-radius: 10px;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, #131722);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        font-size: 13px;
        line-height: 1.5;
      }
      .na-head {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .na-head > div {
        flex: 1;
      }
      .na-meta,
      .muted,
      .na-foot,
      .na-disclaimer {
        color: var(--tv-muted, #787b86);
        font-size: 12px;
      }
      .na-title {
        margin: 2px 0 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.35;
      }
      .na-x {
        border: 0;
        background: none;
        color: inherit;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }
      .na-labels {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 10px 0 2px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        background: var(--tv-hover, #f0f3fa);
      }
      h3 {
        margin: 16px 0 4px;
        font-size: 13px;
        font-weight: 600;
      }
      p {
        margin: 0;
      }
      .bullish {
        color: #089981;
      }
      .bearish {
        color: #f23645;
      }
      .neutral {
        color: var(--tv-muted, #787b86);
      }
      .na-pairs {
        width: 100%;
        border-collapse: collapse;
      }
      .na-pairs td {
        padding: 6px 8px 6px 0;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
        vertical-align: top;
      }
      .na-pairs tr.focus .sym {
        font-weight: 700;
      }
      .sym,
      .bias,
      .hz,
      .conf {
        white-space: nowrap;
      }
      .bias {
        font-weight: 600;
      }
      .conf {
        font-variant-numeric: tabular-nums;
      }
      .bar {
        display: inline-block;
        width: 48px;
        height: 4px;
        margin-right: 6px;
        border-radius: 2px;
        background: var(--tv-line, #e0e3eb);
        vertical-align: middle;
        overflow: hidden;
      }
      .bar i {
        display: block;
        height: 100%;
        background: currentColor;
      }
      .bar i.neutral {
        background: var(--tv-muted, #787b86);
      }
      .bar i.bullish {
        background: #089981;
      }
      .bar i.bearish {
        background: #f23645;
      }
      .why {
        color: var(--tv-ink, #131722);
      }
      .na-risks {
        margin: 0;
        padding-left: 18px;
        list-style: disc;
      }
      .na-foot {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin-top: 16px;
      }
      .na-foot a,
      .link {
        color: var(--tv-blue, #2962ff);
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
      }
      .na-disclaimer {
        margin-top: 6px;
        font-size: 11px;
      }
      .na-loading,
      .na-error {
        padding: 28px 0;
        text-align: center;
        color: var(--tv-muted, #787b86);
      }
      .na-error {
        color: #f23645;
      }
      .spin {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 6px;
        vertical-align: -1px;
        border: 2px solid var(--tv-line, #e0e3eb);
        border-top-color: var(--tv-blue, #2962ff);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class NewsAnalysisModalComponent {
  readonly article = input.required<NewsArticleView>();
  /** The chart's symbol — always read against, listed first. */
  readonly symbol = input<string | null>(null);
  readonly closed = output<void>();

  private readonly news = inject(NewsIntelService);
  private readonly destroyRef = inject(DestroyRef);

  readonly result = signal<NewsArticleAnalysis | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private seq = 0;

  readonly id = computed(() => this.article().id);

  constructor() {
    effect(() => {
      this.id();
      untracked(() => this.load(false));
    });
  }

  load(refresh: boolean): void {
    const n = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const sub = this.news.analyseArticle(this.id(), this.symbol(), refresh).subscribe({
      next: (r) => {
        if (n !== this.seq) return;
        this.result.set(r);
        this.loading.set(false);
      },
      error: (e: unknown) => {
        if (n !== this.seq) return;
        this.error.set(e instanceof Error ? e.message : 'Analysis unavailable.');
        this.loading.set(false);
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected tone(direction: string): string {
    const d = direction.toLowerCase();
    return d === 'bullish' ? 'bullish' : d === 'bearish' ? 'bearish' : 'neutral';
  }
}
