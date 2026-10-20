import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * A credential or link the engine shows exactly once (a personal access token, a SCIM token, an
 * invitation link). Copy button, a plain warning that it will not be shown again, and a "Done"
 * that drops it from the page.
 */
@Component({
  selector: 'app-secret-once',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="secret" role="status">
      <p class="title">{{ title() }}</p>
      <div class="value-row">
        <code class="value">{{ value() }}</code>
        <button type="button" class="btn" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
      </div>
      <p class="warn">{{ warning() }}</p>
      <div class="done-row">
        <button type="button" class="btn" (click)="dismissed.emit()">Done</button>
      </div>
    </div>
  `,
  styles: [
    `
      .secret {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid rgba(52, 199, 89, 0.4);
        background: rgba(52, 199, 89, 0.08);
        border-radius: var(--radius-sm);
      }
      .title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .value-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .value {
        flex: 1;
        min-width: 0;
        font-size: var(--text-xs);
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        word-break: break-all;
        user-select: all;
      }
      .warn {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .done-row {
        display: flex;
        justify-content: flex-end;
      }
      .btn {
        padding: 5px 12px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
      }
    `,
  ],
})
export class SecretOnceComponent {
  readonly title = input.required<string>();
  readonly value = input.required<string>();
  readonly warning = input('Copy it now: it will not be shown again.');
  readonly dismissed = output<void>();
  readonly copied = signal(false);

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.value());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard refused (permissions, insecure context): the value is selectable by hand.
      this.copied.set(false);
    }
  }
}
