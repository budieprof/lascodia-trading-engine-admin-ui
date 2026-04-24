import { Component, ChangeDetectionStrategy, output, signal, input } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import type { CreateOrderRequest } from '@core/api/api.types';

@Component({
  selector: 'app-order-form',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="overlay"
        role="presentation"
        tabindex="-1"
        (click)="onCancel()"
        (keydown.escape)="onCancel()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="dialog-header">
            <h3 class="dialog-title">Create Order</h3>
            <button type="button" class="close-btn" aria-label="Close" (click)="onCancel()">
              &times;
            </button>
          </div>

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="dialog-body">
            <div class="form-grid">
              <div class="form-field">
                <label class="form-label">Symbol *</label>
                <input class="form-input" formControlName="symbol" placeholder="e.g. EURUSD" />
                @if (form.get('symbol')?.touched && form.get('symbol')?.errors?.['required']) {
                  <span class="form-error">Symbol is required</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Order Type *</label>
                <select class="form-select" formControlName="orderType">
                  <option value="" disabled>Select type</option>
                  <option value="Buy">Buy</option>
                  <option value="Sell">Sell</option>
                </select>
                @if (
                  form.get('orderType')?.touched && form.get('orderType')?.errors?.['required']
                ) {
                  <span class="form-error">Order type is required</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Execution Type *</label>
                <select class="form-select" formControlName="executionType">
                  <option value="" disabled>Select execution</option>
                  <option value="Market">Market</option>
                  <option value="Limit">Limit</option>
                  <option value="Stop">Stop</option>
                  <option value="StopLimit">Stop Limit</option>
                </select>
                @if (
                  form.get('executionType')?.touched &&
                  form.get('executionType')?.errors?.['required']
                ) {
                  <span class="form-error">Execution type is required</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Quantity *</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="quantity"
                  placeholder="0.00"
                  step="0.01"
                />
                @if (form.get('quantity')?.touched && form.get('quantity')?.errors?.['required']) {
                  <span class="form-error">Quantity is required</span>
                }
                @if (form.get('quantity')?.touched && form.get('quantity')?.errors?.['min']) {
                  <span class="form-error">Must be greater than 0</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Price *</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="price"
                  placeholder="0.00000"
                  step="0.00001"
                />
                @if (form.get('price')?.touched && form.get('price')?.errors?.['required']) {
                  <span class="form-error">Price is required</span>
                }
                @if (form.get('price')?.touched && form.get('price')?.errors?.['min']) {
                  <span class="form-error">Must be greater than 0</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Stop Loss</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="stopLoss"
                  placeholder="Optional"
                  step="0.00001"
                />
              </div>

              <div class="form-field">
                <label class="form-label">Take Profit</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="takeProfit"
                  placeholder="Optional"
                  step="0.00001"
                />
              </div>

              <div class="form-field">
                <label class="form-label">Strategy ID *</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="strategyId"
                  placeholder="Strategy ID"
                />
                @if (
                  form.get('strategyId')?.touched && form.get('strategyId')?.errors?.['required']
                ) {
                  <span class="form-error">Strategy ID is required</span>
                }
              </div>

              <div class="form-field">
                <label class="form-label">Trading Account ID *</label>
                <input
                  class="form-input"
                  type="number"
                  formControlName="tradingAccountId"
                  placeholder="Account ID"
                />
                @if (
                  form.get('tradingAccountId')?.touched &&
                  form.get('tradingAccountId')?.errors?.['required']
                ) {
                  <span class="form-error">Trading Account ID is required</span>
                }
              </div>

              <div class="form-field form-field-full">
                <label class="form-label">Notes</label>
                <textarea
                  class="form-textarea"
                  formControlName="notes"
                  rows="3"
                  placeholder="Optional notes..."
                ></textarea>
              </div>

              <div class="form-field form-field-full">
                <label class="form-checkbox-label">
                  <input type="checkbox" formControlName="isPaper" />
                  <span>Paper Trade</span>
                </label>
              </div>
            </div>

            <div class="dialog-actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="onCancel()"
                [disabled]="loading()"
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="form.invalid || loading()">
                @if (loading()) {
                  <span class="spinner"></span>
                } @else {
                  Create Order
                }
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }

      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 600px;
        max-height: 90vh;
        overflow-y: auto;
        animation: scaleIn 0.2s ease-out;
      }

      .dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-5) var(--space-6);
        border-bottom: 1px solid var(--border);
      }

      .dialog-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--text-secondary);
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }
      .close-btn:hover {
        background: var(--bg-tertiary);
      }

      .dialog-body {
        padding: var(--space-5) var(--space-6);
      }

      .form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }

      .form-field {
        display: flex;
        flex-direction: column;
      }

      .form-field-full {
        grid-column: 1 / -1;
      }

      .form-label {
        display: block;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .form-input,
      .form-select,
      .form-textarea {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s ease;
        box-sizing: border-box;
      }

      .form-textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
      }

      .form-input:focus,
      .form-select:focus,
      .form-textarea:focus {
        border-color: var(--accent);
      }

      .form-error {
        display: block;
        font-size: var(--text-xs);
        color: var(--loss);
        margin-top: 2px;
      }

      .form-checkbox-label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-primary);
        cursor: pointer;
      }

      .form-checkbox-label input[type='checkbox'] {
        width: 16px;
        height: 16px;
        accent-color: var(--accent);
        cursor: pointer;
      }

      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding-top: var(--space-5);
        border-top: 1px solid var(--border);
        margin-top: var(--space-5);
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }
      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
        opacity: 0.8;
      }

      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class OrderFormComponent {
  open = input(false);
  loading = input(false);

  submitOrder = output<CreateOrderRequest>();
  cancelled = output<void>();

  private readonly fb = new FormBuilder();

  form: FormGroup = this.fb.nonNullable.group({
    symbol: ['', Validators.required],
    orderType: ['', Validators.required],
    executionType: ['', Validators.required],
    quantity: [null as number | null, [Validators.required, Validators.min(0.001)]],
    price: [null as number | null, [Validators.required, Validators.min(0)]],
    stopLoss: [null as number | null],
    takeProfit: [null as number | null],
    strategyId: [null as number | null, Validators.required],
    tradingAccountId: [null as number | null, Validators.required],
    notes: [''],
    isPaper: [false],
  });

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const request: CreateOrderRequest = {
      symbol: v.symbol,
      orderType: v.orderType,
      executionType: v.executionType,
      quantity: v.quantity!,
      price: v.price!,
      stopLoss: v.stopLoss || null,
      takeProfit: v.takeProfit || null,
      strategyId: v.strategyId!,
      tradingAccountId: v.tradingAccountId!,
      notes: v.notes || null,
      isPaper: v.isPaper,
    };
    this.submitOrder.emit(request);
  }

  onCancel(): void {
    this.cancelled.emit();
  }

  reset(): void {
    this.form.reset({
      symbol: '',
      orderType: '',
      executionType: '',
      quantity: null,
      price: null,
      stopLoss: null,
      takeProfit: null,
      strategyId: null,
      tradingAccountId: null,
      notes: '',
      isPaper: false,
    });
  }
}
