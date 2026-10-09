import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { downloadTextFile } from '@shared/utils/download';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { StrategyScriptCardComponent } from './strategy-script-card.component';

vi.mock('@shared/utils/download', () => ({ downloadTextFile: vi.fn() }));

declareSignalIo(StrategyScriptCardComponent, {
  inputs: ['strategy'],
  outputs: ['editRequested', 'executionRequested'],
});

// The editor, declaration and inputs panes are stood in for: this spec is about the card's own
// controls — who may export and edit (PE-I13), and what an export does when it fails (PE-11).
@Component({
  selector: 'app-pine-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class EditorStubComponent {
  @Input() value = '';
  @Input() readOnly = false;
  @Input() diagnostics: unknown[] = [];
  @Input() height = '';
  @Input() ariaLabel = '';
}

@Component({
  selector: 'app-declaration-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class DeclarationStubComponent {
  @Input() declaration: unknown = null;
  @Input() emptyText = '';
}

@Component({
  selector: 'app-inputs-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InputsStubComponent {
  @Input() inputs: unknown[] = [];
  @Input() overrides: unknown = null;
  @Input() disabled = false;
  @Input() showReset = true;
}

const SOURCE = '//@version=6\nstrategy("Breakout")\n';
const STRATEGY = {
  id: 41,
  name: 'Pine breakout',
  symbol: 'EURUSD',
  timeframe: 'H1',
  scriptSource: SOURCE,
  scriptInputs: null,
} as unknown as StrategyDto;

describe('StrategyScriptCardComponent', () => {
  let canOperate: boolean;
  let scripting: {
    compile: ReturnType<typeof vi.fn>;
    exportStrategy: ReturnType<typeof vi.fn>;
    strategyScriptSaved$: Subject<number>;
  };
  let toasts: Record<'success' | 'error' | 'info' | 'warning', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    canOperate = true;
    vi.mocked(downloadTextFile).mockReset();
    scripting = {
      compile: vi.fn(() => of({ success: true, diagnostics: [], declaration: null, inputs: [] })),
      exportStrategy: vi.fn(),
      strategyScriptSaved$: new Subject<number>(),
    };
    toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
    TestBed.configureTestingModule({
      imports: [StrategyScriptCardComponent],
      providers: [
        { provide: ScriptingService, useValue: scripting },
        { provide: StrategiesService, useValue: { getById: vi.fn(() => of(null)) } },
        { provide: NotificationService, useValue: toasts },
        { provide: AuthService, useValue: { hasPermission: () => canOperate } },
      ],
    });
    TestBed.overrideComponent(StrategyScriptCardComponent, {
      set: { imports: [EditorStubComponent, DeclarationStubComponent, InputsStubComponent] },
    });
  });

  function render() {
    const fixture = TestBed.createComponent(StrategyScriptCardComponent);
    fixture.componentRef.setInput('strategy', STRATEGY);
    fixture.detectChanges();
    return { fixture, cmp: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  }

  const buttons = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLButtonElement>('.card-head button')].map((b) =>
      b.textContent!.trim(),
    );

  describe('PE-I13: operator access', () => {
    it('offers Export and Edit to an operator', () => {
      const { el } = render();
      expect(buttons(el)).toEqual(expect.arrayContaining(['Export .pine', 'Edit script']));
      expect(el.textContent).not.toContain('Read-only');
    });

    it('shows the script read-only to anyone else, with Copy kept', () => {
      canOperate = false;
      const { el } = render();
      expect(buttons(el)).toEqual(['Copy']);
      expect(el.textContent).toContain('Read-only');
    });
  });

  describe('PE-11: export', () => {
    it('downloads the engine’s file', async () => {
      scripting.exportStrategy.mockReturnValue(
        of({ fileName: 'Pine_breakout.pine', content: 'engine copy' }),
      );
      const { cmp } = render();
      await cmp.export();
      expect(downloadTextFile).toHaveBeenCalledWith('Pine_breakout.pine', 'engine copy');
    });

    it('downloads nothing around a permission refusal, and says why', async () => {
      scripting.exportStrategy.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 403,
              error: { status: false, message: 'Forbidden', responseCode: '-403', data: null },
            }),
        ),
      );
      const { cmp } = render();
      await cmp.export();
      expect(downloadTextFile).not.toHaveBeenCalled();
      expect(toasts['error']).toHaveBeenCalledWith(
        'You do not have permission to export this strategy.',
      );
    });

    it('downloads nothing around an engine refusal envelope', async () => {
      scripting.exportStrategy.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 404,
              error: { status: false, message: 'Strategy not found', responseCode: '-14' },
            }),
        ),
      );
      const { cmp } = render();
      await cmp.export();
      expect(downloadTextFile).not.toHaveBeenCalled();
      expect(toasts['error']).toHaveBeenCalledWith('Strategy not found');
    });

    it('falls back to the source the console holds when the engine cannot be reached', async () => {
      scripting.exportStrategy.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 0 })),
      );
      const { cmp } = render();
      await cmp.export();
      expect(downloadTextFile).toHaveBeenCalledWith('Pine_breakout.pine', SOURCE);
      expect(toasts['info']).toHaveBeenCalled();
    });

    it('falls back on an engine failure (5xx) too', async () => {
      scripting.exportStrategy.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 502 })),
      );
      const { cmp } = render();
      await cmp.export();
      expect(downloadTextFile).toHaveBeenCalledWith('Pine_breakout.pine', SOURCE);
    });
  });
});
