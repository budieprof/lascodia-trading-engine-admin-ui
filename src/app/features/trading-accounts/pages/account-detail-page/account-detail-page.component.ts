import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-account-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h1 class="page-title">Account Detail</h1>
      <p class="page-subtitle">Content coming soon</p>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .page-title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
        letter-spacing: var(--tracking-tight);
      }
      .page-subtitle {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }
    `,
  ],
})
export class AccountDetailPageComponent {}
