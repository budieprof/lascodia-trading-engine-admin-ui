import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StrategyVersionDiffComponent } from '../strategy-version-diff/strategy-version-diff.component';
import { StrategyVersionHistoryComponent } from './strategy-version-history.component';

declareSignalIo(StrategyVersionHistoryComponent, {
  inputs: ['strategy', 'current', 'inputDefs', 'isScriptEdited'],
  outputs: ['restored', 'changed'],
});
declareSignalIo(StrategyVersionDiffComponent, {
  inputs: ['version', 'current', 'inputDefs'],
  outputs: ['closed'],
});

const STRATEGY = { id: 42, name: 'Breakout', scriptSource: 'x' } as any;
const CURRENT = {
  name: 'Breakout',
  description: null,
  parametersJson: null,
  riskProfileId: null,
  riskOverridesJson: null,
  sizingConfigJson: null,
  sessionFilterJson: null,
  regimeGateJson: null,
  multiTimeframeGateJson: null,
  scriptSource: 'x',
  scriptInputs: null,
};
const V3 = {
  id: 9,
  versionNumber: 3,
  capturedAt: '2026-11-01T10:00:00Z',
  createdBy: 'ops',
  changeReason: 'before tweak',
};

describe('StrategyVersionHistoryComponent (U13 split of the strategy form)', () => {
  let fixture: ComponentFixture<StrategyVersionHistoryComponent>;
  let cmp: StrategyVersionHistoryComponent;
  let el: HTMLElement;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let notify: Record<string, ReturnType<typeof vi.fn>>;
  let dialogs: { confirm: ReturnType<typeof vi.fn> };
  let restored: unknown[];
  let changed: number;

  function create(scriptEdited = false): void {
    fixture = TestBed.createComponent(StrategyVersionHistoryComponent);
    cmp = fixture.componentInstance;
    fixture.componentRef.setInput('strategy', STRATEGY);
    fixture.componentRef.setInput('current', CURRENT);
    fixture.componentRef.setInput('isScriptEdited', () => scriptEdited);
    restored = [];
    changed = 0;
    cmp.restored.subscribe((r) => restored.push(r));
    cmp.changed.subscribe(() => changed++);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    api = {
      getVersions: vi.fn(() => of({ status: true, data: [V3] })),
      captureVersion: vi.fn(() => of({ status: true, message: 'Snapshot captured' })),
      rollbackVersion: vi.fn(() => of({ status: true, data: 1, message: 'Rolled back' })),
      getById: vi.fn(() => of({ status: true, data: { ...STRATEGY, scriptSource: 'v3' } })),
    };
    notify = { success: vi.fn(), error: vi.fn() };
    dialogs = { confirm: vi.fn(async () => true) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [StrategyVersionHistoryComponent],
      providers: [
        { provide: StrategiesService, useValue: api },
        { provide: NotificationService, useValue: notify },
        { provide: ScriptDialogService, useValue: dialogs },
      ],
    });
  });

  it('loads the versions only when first expanded, and lists them', () => {
    create();
    expect(api['getVersions']).not.toHaveBeenCalled();
    const toggle = el.querySelector<HTMLButtonElement>('.version-history-head button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    fixture.detectChanges();
    expect(api['getVersions']).toHaveBeenCalledWith(42, 100);
    expect(el.querySelectorAll('.version-table tbody tr')).toHaveLength(1);
    expect(el.textContent).toContain('v3');
    expect(el.textContent).toContain('before tweak');
    // Collapsing and expanding again does not re-read.
    toggle.click();
    toggle.click();
    expect(api['getVersions']).toHaveBeenCalledTimes(1);
  });

  it('captures a snapshot with the typed reason and re-reads the list', () => {
    create();
    cmp.toggleVersionHistory();
    cmp.manualCaptureReason.set('bookmark');
    cmp.captureVersionNow();
    expect(api['captureVersion']).toHaveBeenCalledWith(42, 'bookmark');
    expect(notify['success']).toHaveBeenCalledWith('Snapshot captured');
    expect(cmp.manualCaptureReason()).toBe('');
    expect(api['getVersions']).toHaveBeenCalledTimes(2);
  });

  it('opens the diff of a version against the current values', () => {
    create();
    cmp.toggleVersionHistory();
    fixture.detectChanges();
    cmp.diffWithCurrent(V3 as any);
    fixture.detectChanges();
    expect(el.querySelector('app-strategy-version-diff')).not.toBeNull();
  });

  it('a confirmed rollback hands the re-read strategy to the form and tells the host', async () => {
    create(true);
    await cmp.rollbackToVersion(V3 as any);
    expect(dialogs.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Roll back to v3?',
        details: ['Your unsaved script edit is replaced by the script of that version.'],
        tone: 'danger',
      }),
    );
    expect(api['rollbackVersion']).toHaveBeenCalledWith(42, 9);
    expect(restored).toEqual([expect.objectContaining({ scriptSource: 'v3' })]);
    expect(changed).toBe(1);
    expect(notify['success']).toHaveBeenCalledWith('Rolled back');
    expect(cmp.rollingBack()).toBe(false);
  });

  it('without an unsaved script edit the confirmation has no warning', async () => {
    create(false);
    await cmp.rollbackToVersion(V3 as any);
    expect(dialogs.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ details: [], tone: 'primary' }),
    );
  });

  it('when the re-read fails the rollback still counts (host re-reads), nothing is patched', async () => {
    api['getById'].mockReturnValueOnce(throwError(() => new Error('down')));
    create();
    await cmp.rollbackToVersion(V3 as any);
    expect(restored).toEqual([]);
    expect(changed).toBe(1);
    expect(notify['success']).toHaveBeenCalledWith(
      'Rolled back to v3 (form will refresh on next open)',
    );
  });

  it('a refused rollback is reported and changes nothing', async () => {
    api['rollbackVersion'].mockReturnValueOnce(of({ status: false, message: 'Refused' }));
    create();
    await cmp.rollbackToVersion(V3 as any);
    expect(notify['error']).toHaveBeenCalledWith('Refused');
    expect(restored).toEqual([]);
    expect(changed).toBe(0);
  });

  it('does nothing when the operator declines', async () => {
    dialogs.confirm.mockResolvedValueOnce(false);
    create();
    await cmp.rollbackToVersion(V3 as any);
    expect(api['rollbackVersion']).not.toHaveBeenCalled();
  });

  it('reset closes the drawer and forgets the versions', () => {
    create();
    cmp.toggleVersionHistory();
    cmp.diffWithCurrent(V3 as any);
    cmp.reset();
    expect(cmp.showVersionHistory()).toBe(false);
    expect(cmp.versions()).toEqual([]);
    expect(cmp.diffVersion()).toBeNull();
  });
});
