import { Component, input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-page-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div class="header-left">
        <div class="title-row">
          <h1 class="title">{{ title() }}</h1>
          <ng-content select="[slot=title-after]" />
        </div>
        @if (subtitle()) {
          <p class="subtitle">{{ subtitle() }}</p>
        }
      </div>
      <div class="header-actions">
        <ng-content />
      </div>
    </div>
  `,
  styles: [
    `
      /*
       * No accent underline here on purpose: the former 48×3px gradient bar
       * under the subtitle read as a stalled progress indicator on every
       * detail page. The title weight and the breadcrumb above carry the
       * hierarchy on their own.
       */
      .page-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        margin-bottom: var(--space-6);
        position: relative;
        padding-bottom: var(--space-2);
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }

      .title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
        letter-spacing: var(--tracking-tight);
        /* Gradient text on the title — a premium touch without shouting. */
        background: linear-gradient(180deg, var(--text-primary) 0%, var(--text-secondary) 140%);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
        -webkit-text-fill-color: transparent;
      }

      .subtitle {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: var(--space-1) 0 0;
        letter-spacing: var(--tracking-normal);
      }

      /* The title keeps a readable minimum; the actions take the rest and WRAP. With
         flex-shrink: 0 and no wrap, eight actions on a strategy detail page pushed it to 1608px
         in a 1440px window. Few actions still sit on one line, right-aligned. */
      .header-left {
        flex: 1 1 320px;
        min-width: 0;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex: 0 1 auto;
        flex-wrap: wrap;
        justify-content: flex-end;
        min-width: 0;
      }

      /* On a phone the actions cannot sit beside the title: a no-shrink row of two or three
         buttons pushed the recommendation detail page to 502px wide at 390. Stack and wrap. */
      @media (max-width: 640px) {
        .page-header {
          flex-direction: column;
          align-items: stretch;
        }
        .header-actions {
          flex-shrink: 1;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
      }
    `,
  ],
})
export class PageHeaderComponent {
  title = input.required<string>();
  subtitle = input<string>();
}
