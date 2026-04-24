import { Component, input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-page-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div class="header-left">
        <h1 class="title">{{ title() }}</h1>
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
       * A thin gradient accent sits beneath the title. Picks up the accent
       * colour without being loud — PRD §3.1 "depth: layered surfaces with
       * subtle shadows and colour". The bar scales in on mount courtesy of
       * the global page-entry stagger animation in styles.scss.
       */
      .page-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        margin-bottom: var(--space-6);
        position: relative;
        padding-bottom: var(--space-4);
      }

      .page-header::after {
        content: '';
        position: absolute;
        left: 0;
        bottom: 0;
        width: 48px;
        height: 3px;
        border-radius: 2px;
        background: linear-gradient(90deg, var(--accent), rgba(10, 132, 255, 0));
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
