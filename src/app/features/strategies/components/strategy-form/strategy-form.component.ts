import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import {
  StrategyDto,
  StrategyType,
  Timeframe,
  CreateStrategyRequest,
  UpdateStrategyRequest,
} from '@core/api/api.types';

const STRATEGY_TYPES: StrategyType[] = [
  'MovingAverageCrossover',
  'RSIReversion',
  'BreakoutScalper',
  'BollingerBandReversion',
  'MACDDivergence',
  'SessionBreakout',
  'MomentumTrend',
  'Custom',
];

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

const TIMEFRAME_LABELS: Record<string, string> = {
  M1: '1 Min',
  M5: '5 Min',
  M15: '15 Min',
  H1: '1 Hour',
  H4: '4 Hours',
  D1: 'Daily',
};

@Component({
  selector: 'app-strategy-form',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="overlay" (click)="onCancel()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <h3 class="dialog-title">{{ strategy() ? 'Edit Strategy' : 'Create Strategy' }}</h3>
          </div>
          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="dialog-body">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Name <span class="required">*</span></label>
                <input type="text" formControlName="name" class="form-input" placeholder="e.g. EURUSD MA Crossover" />
                @if (form.get('name')?.touched && form.get('name')?.hasError('required')) {
                  <span class="form-error">Name is required</span>
                }
              </div>
              <div class="form-group">
                <label class="form-label">Symbol <span class="required">*</span></label>
                <input type="text" formControlName="symbol" class="form-input" placeholder="e.g. EUR_USD" />
                @if (form.get('symbol')?.touched && form.get('symbol')?.hasError('required')) {
                  <span class="form-error">Symbol is required</span>
                }
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Timeframe</label>
                <select formControlName="timeframe" class="form-input">
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf">{{ timeframeLabels[tf] }}</option>
                  }
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Strategy Type</label>
                <select formControlName="strategyType" class="form-input">
                  @for (st of strategyTypes; track st) {
                    <option [value]="st">{{ formatType(st) }}</option>
                  }
                </select>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Risk Profile ID</label>
              <input type="number" formControlName="riskProfileId" class="form-input" placeholder="Optional" />
            </div>

            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea formControlName="description" class="form-input form-textarea" rows="2" placeholder="Strategy description..."></textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Parameters JSON</label>
              <textarea formControlName="parametersJson" class="form-input form-textarea form-mono" rows="5" placeholder='{"period": 14, "threshold": 0.5}'></textarea>
            </div>

            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" (click)="onCancel()" [disabled]="submitting()">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="form.invalid || submitting()">
                @if (submitting()) {
                  <span class="spinner"></span>
                } @else {
                  {{ strategy() ? 'Update' : 'Create' }}
                }
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: [`
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
      max-width: 560px;
      max-height: 90vh;
      overflow-y: auto;
      animation: scaleIn 0.2s ease-out;
    }

    .dialog-header {
      padding: var(--space-5) var(--space-6) 0;
    }

    .dialog-title {
      font-size: var(--text-lg);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0;
    }

    .dialog-body {
      padding: var(--space-4) var(--space-6) var(--space-5);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
    }

    .form-group {
      margin-bottom: var(--space-4);
    }

    .form-label {
      display: block;
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--text-secondary);
      margin-bottom: var(--space-1);
    }

    .required { color: var(--loss); }

    .form-input {
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
      box-sizing: border-box;
      transition: border-color 0.15s ease;
    }

    .form-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
    }

    .form-textarea {
      height: auto;
      padding: var(--space-2) var(--space-3);
      resize: vertical;
      line-height: 1.5;
    }

    .form-mono {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
    }

    .form-error {
      display: block;
      font-size: var(--text-xs);
      color: var(--loss);
      margin-top: 2px;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-3);
      padding-top: var(--space-2);
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

    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }
    .btn-secondary:hover:not(:disabled) { opacity: 0.8; }

    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes scaleIn {
      from { transform: scale(0.96); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  `],
})
export class StrategyFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);

  open = input(false);
  strategy = input<StrategyDto | null>(null);

  submitted = output<CreateStrategyRequest | UpdateStrategyRequest>();
  cancelled = output<void>();

  submitting = signal(false);

  readonly strategyTypes = STRATEGY_TYPES;
  readonly timeframes = TIMEFRAMES;
  readonly timeframeLabels = TIMEFRAME_LABELS;

  form!: FormGroup;

  ngOnInit(): void {
    this.form = this.fb.group({
      name: ['', Validators.required],
      symbol: ['', Validators.required],
      timeframe: ['H1'],
      strategyType: ['MovingAverageCrossover'],
      parametersJson: [''],
      riskProfileId: [null],
      description: [''],
    });
  }

  ngOnChanges(): void {
    const s = this.strategy();
    if (s && this.form) {
      this.form.patchValue({
        name: s.name,
        symbol: s.symbol,
        timeframe: s.timeframe,
        strategyType: s.strategyType,
        parametersJson: s.parametersJson ?? '',
        riskProfileId: s.riskProfileId,
        description: s.description,
      });
    } else if (this.form) {
      this.form.reset({
        name: '',
        symbol: '',
        timeframe: 'H1',
        strategyType: 'MovingAverageCrossover',
        parametersJson: '',
        riskProfileId: null,
        description: '',
      });
    }
  }

  formatType(type: string): string {
    return type.replace(/([A-Z])/g, ' $1').trim();
  }

  onSubmit(): void {
    if (this.form.invalid) return;
    const val = this.form.value;
    const data: any = {
      name: val.name,
      description: val.description || '',
      strategyType: val.strategyType,
      symbol: val.symbol,
      timeframe: val.timeframe,
      parametersJson: val.parametersJson || null,
      riskProfileId: val.riskProfileId || null,
    };
    this.submitted.emit(data);
  }

  onCancel(): void {
    this.cancelled.emit();
  }
}
