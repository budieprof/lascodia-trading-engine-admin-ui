import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { NgClass } from '@angular/common';

@Component({
  selector: 'ui-button',
  standalone: true,
  imports: [NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      [type]="type()"
      [disabled]="disabled() || loading()"
      [ngClass]="['btn', 'btn--' + variant(), 'btn--' + size()]"
      [class.btn--loading]="loading()"
    >
      @if (loading()) {
        <span class="btn__spinner"></span>
      }
      <span class="btn__content" [class.btn__content--hidden]="loading()">
        <ng-content />
      </span>
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-block;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        border: none;
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
        letter-spacing: -0.01em;
        transition: all 0.15s ease;
        position: relative;
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
      }

      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }

      .btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Variants */
      .btn--primary {
        background: var(--accent);
        background-image: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.12) 0%,
          rgba(255, 255, 255, 0) 100%
        );
        color: #ffffff;
        border-radius: var(--radius-full);
      }

      .btn--primary:hover:not(:disabled) {
        background-color: var(--accent-hover);
      }

      .btn--secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
      }

      .btn--secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }

      .btn--ghost {
        background: transparent;
        color: var(--text-primary);
        border-radius: var(--radius-full);
      }

      .btn--ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }

      .btn--destructive {
        background: #ff3b30;
        background-image: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.12) 0%,
          rgba(255, 255, 255, 0) 100%
        );
        color: #ffffff;
        border-radius: var(--radius-full);
      }

      .btn--destructive:hover:not(:disabled) {
        background-color: #e6352b;
      }

      .btn--icon {
        background: transparent;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        padding: 0;
      }

      .btn--icon:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      /* Sizes */
      .btn--sm {
        height: 32px;
        padding: 0 var(--space-4);
        font-size: 13px;
      }

      .btn--md {
        height: 40px;
        padding: 0 var(--space-5);
        font-size: 14px;
      }

      .btn--lg {
        height: 48px;
        padding: 0 var(--space-7);
        font-size: 15px;
      }

      .btn--icon.btn--sm {
        width: 32px;
        height: 32px;
      }

      .btn--icon.btn--md {
        width: 40px;
        height: 40px;
      }

      .btn--icon.btn--lg {
        width: 48px;
        height: 48px;
      }

      /* Spinner */
      .btn__spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: btn-spin 0.6s linear infinite;
        position: absolute;
      }

      .btn--secondary .btn__spinner,
      .btn--ghost .btn__spinner {
        border-color: rgba(0, 0, 0, 0.15);
        border-top-color: var(--text-primary);
      }

      .btn__content {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        transition: opacity 0.15s ease;
      }

      .btn__content--hidden {
        opacity: 0;
        visibility: hidden;
      }

      @keyframes btn-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class ButtonComponent {
  readonly variant = input<'primary' | 'secondary' | 'ghost' | 'destructive' | 'icon'>('primary');
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly loading = input(false);
  readonly disabled = input(false);
  readonly type = input<'button' | 'submit'>('button');
}
