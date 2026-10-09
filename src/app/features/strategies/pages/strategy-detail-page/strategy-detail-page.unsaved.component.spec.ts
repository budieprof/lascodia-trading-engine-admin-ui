import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService } from '@core/realtime/realtime.service';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';

import { StrategyDetailPageComponent } from './strategy-detail-page.component';

// PE-14 (unsaved changes on a tab) and PE-I13 (operator access) on the strategy detail page. The
// tabs' own state is stood in for: each tab component reports what it holds unsaved, and these
// specs cover what the page does with that. Kept in its own spec so it never collides with edits
// to the page's main spec.

describe('StrategyDetailPageComponent (unsaved changes, operator access)', () => {
  let cmp: StrategyDetailPageComponent;
  let canOperate: boolean;
  let dialogs: { confirm: ReturnType<typeof vi.fn>; ask: ReturnType<typeof vi.fn> };
  let tabsBar: { activeTab: { set: ReturnType<typeof vi.fn> } };

  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  beforeEach(() => {
    canOperate = true;
    dialogs = { confirm: vi.fn(async () => false), ask: vi.fn() };
    TestBed.configureTestingModule({
      imports: [StrategyDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '41' } } } },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
        { provide: ScriptDialogService, useValue: dialogs },
        { provide: AuthService, useValue: { hasPermission: () => canOperate } },
      ],
    });
    cmp = TestBed.createComponent(StrategyDetailPageComponent).componentInstance;
    tabsBar = { activeTab: { set: vi.fn() } };
    (cmp as any).tabsBar = tabsBar;
  });

  function onExecutionTab(unsaved: boolean): void {
    cmp.activeTab.set('execution');
    (cmp as any).executionPanel = { hasUnsavedChanges: () => unsaved };
  }

  describe('PE-14: switching tabs', () => {
    it('switches at once when the tab holds nothing unsaved', () => {
      onExecutionTab(false);
      cmp.requestTab('signals');
      expect(cmp.activeTab()).toBe('signals');
      expect(dialogs.confirm).not.toHaveBeenCalled();
    });

    it('asks before leaving unsaved binding changes, and stays on "Keep editing"', async () => {
      onExecutionTab(true);
      cmp.requestTab('signals');
      await settle();
      expect(dialogs.confirm).toHaveBeenCalledTimes(1);
      expect(dialogs.confirm.mock.calls[0][0].message).toContain('Execution tab');
      expect(cmp.activeTab()).toBe('execution');
      // The tab bar is put back on the tab being kept.
      expect(tabsBar.activeTab.set).toHaveBeenCalledWith('execution');
    });

    it('switches once the operator discards', async () => {
      onExecutionTab(true);
      dialogs.confirm.mockResolvedValue(true);
      cmp.requestTab('orders');
      await settle();
      expect(cmp.activeTab()).toBe('orders');
    });

    it('asks once, even when the tab bar is clicked again while the question is open', async () => {
      onExecutionTab(true);
      let answer!: (v: boolean) => void;
      dialogs.confirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
      cmp.requestTab('orders');
      cmp.requestTab('signals');
      expect(dialogs.confirm).toHaveBeenCalledTimes(1);
      answer(true);
      await settle();
      expect(cmp.activeTab()).toBe('orders');
    });

    it('guards unsaved alert changes the same way', async () => {
      cmp.strategy.set({ id: 41, strategyType: 'RuleBased', authoringMode: 'Script' } as any);
      cmp.activeTab.set('alerts');
      (cmp as any).alertsTab = { dirty: () => true };
      cmp.requestTab('live');
      await settle();
      expect(dialogs.confirm.mock.calls[0][0].message).toContain('alert changes');
      expect(cmp.activeTab()).toBe('alerts');
    });

    it('routes the header badge and the approval dialog through the same question', async () => {
      onExecutionTab(false);
      cmp.activeTab.set('alerts');
      (cmp as any).alertsTab = { dirty: () => true };
      cmp.openExecutionTab();
      cmp.openPromotionHistory();
      await settle();
      expect(cmp.activeTab()).toBe('alerts');
      expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('PE-14: leaving the page', () => {
    it('reports the unsaved tab to the route guard', () => {
      onExecutionTab(true);
      expect(cmp.hasUnsavedChanges()).toBe(true);
      expect(cmp.unsavedChangesNote()).toContain('Execution tab');
    });

    it('reports an unsaved edit in the edit dialog first', () => {
      onExecutionTab(true);
      (cmp as any).editForm = {
        hasUnsavedChanges: () => true,
        unsavedChangesNote: () => 'The script has unsaved changes',
      };
      expect(cmp.hasUnsavedChanges()).toBe(true);
      expect(cmp.unsavedChangesNote()).toBe('The script has unsaved changes');
    });

    it('lets the page go when nothing is unsaved', () => {
      onExecutionTab(false);
      (cmp as any).editForm = { hasUnsavedChanges: () => false };
      expect(cmp.hasUnsavedChanges()).toBe(false);
    });
  });

  describe('PE-I13: operator access', () => {
    it('opens the edit form for an operator', () => {
      cmp.openEdit();
      expect(cmp.showEditForm()).toBe(true);
    });

    it('keeps the edit form closed without operator access', () => {
      canOperate = false;
      expect(cmp.canOperate()).toBe(false);
      cmp.openEdit();
      expect(cmp.showEditForm()).toBe(false);
    });
  });
});
