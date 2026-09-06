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

      .header-actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-shrink: 0;
      }
    `,
  ],
})
export class PageHeaderComponent {
  title = input.required<string>();
  subtitle = input<string>();
}
