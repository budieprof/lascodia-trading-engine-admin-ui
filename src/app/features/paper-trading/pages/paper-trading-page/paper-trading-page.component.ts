import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

@Component({
  selector: 'app-paper-trading-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header title="Paper Trading" subtitle="Simulated trading mode configuration" />

      @if (enabled()) {
        <div class="warning-banner">
          <span class="warning-icon">&#9888;</span>
          <span>Simulated mode &mdash; no real trades will be executed</span>
        </div>
      }

      <!-- Status display -->
      <div class="status-card">
        <div class="status-header">
          <div class="status-text">
            <span class="status-label">Paper Trading is</span>
            <span class="status-value" [class.on]="enabled()" [class.off]="!enabled()">
              {{ enabled() ? 'ENABLED' : 'DISABLED' }}
            </span>
          </div>
          <button class="toggle-switch" [class.active]="enabled()" (click)="toggle()" type="button" role="switch" [attr.aria-checked]="enabled()">
            <span class="toggle-knob"></span>
          </button>
        </div>
      </div>

      <!-- Config card -->
      <div class="config-card">
        <h3 class="config-title">Simulation Settings</h3>
        <div class="config-grid">
          <div class="config-item">
            <span class="config-label">Simulated Balance</span>
            <span class="config-value">$100,000.00</span>
          </div>
          <div class="config-item">
            <span class="config-label">Simulated Slippage</span>
            <span class="config-value">0.5 pips</span>
          </div>
          <div class="config-item">
            <span class="config-label">Fill Delay</span>
            <span class="config-value">50 ms</span>
          </div>
          <div class="config-item">
            <span class="config-label">Commission Model</span>
            <span class="config-value">$7 / round turn</span>
          </div>
          <div class="config-item">
            <span class="config-label">Max Position Size</span>
            <span class="config-value">100,000 units</span>
          </div>
          <div class="config-item">
            <span class="config-label">Started</span>
            <span class="config-value">{{ enabled() ? 'Mar 18, 2026 09:00' : '--' }}</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    .warning-banner {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      background: rgba(255, 149, 0, 0.12);
      border: 1px solid rgba(255, 149, 0, 0.3);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-6);
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: #C93400;
    }
    .warning-icon {
      font-size: 18px;
    }

    .status-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-8);
      margin-bottom: var(--space-6);
      box-shadow: var(--shadow-sm);
    }
    .status-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .status-text {
      display: flex;
      align-items: baseline;
      gap: var(--space-3);
    }
    .status-label {
      font-size: var(--text-lg);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
    }
    .status-value {
      font-size: 32px;
      font-weight: var(--font-semibold);
      letter-spacing: var(--tracking-tight);
    }
    .status-value.on { color: #34C759; }
    .status-value.off { color: #8E8E93; }

    .toggle-switch {
      position: relative;
      width: 64px;
      height: 34px;
      border-radius: 17px;
      border: none;
      background: #E5E5EA;
      cursor: pointer;
      transition: background 0.25s ease;
      padding: 0;
      flex-shrink: 0;
    }
    .toggle-switch.active {
      background: #34C759;
    }
    .toggle-knob {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: transform 0.25s ease;
    }
    .toggle-switch.active .toggle-knob {
      transform: translateX(30px);
    }

    .config-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      box-shadow: var(--shadow-sm);
    }
    .config-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0 0 var(--space-4);
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-4);
    }
    .config-item {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .config-label {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .config-value {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }
  `],
})
export class PaperTradingPageComponent {
  enabled = signal(true);

  toggle(): void {
    this.enabled.update(v => !v);
  }
}
