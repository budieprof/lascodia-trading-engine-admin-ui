import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { of, throwError } from 'rxjs';

import { ScriptingApiError } from '@core/services/scripting.service';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { ChartScriptService, type SavedChartScript } from './chart-script.service';
import { ScriptEditorPanelComponent } from './script-editor-panel.component';

// What a new editor panel starts from. The page mounts the panel only while the editor is the
// dock's front tab, so every open is a new panel: once the page has nothing to load into it (the
// script it showed was removed), it must come up on the starter template. Signal inputs are swapped
// for writable ones before the first render (JIT harness — see the inputs-form spec); the panel's
// children, whose signal inputs JIT cannot bind, are stood in for by decorator-input stubs.

@Component({ selector: 'app-pine-editor', template: '' })
class PineEditorStubComponent {
  @Input() value = '';
  @Input() diagnostics: unknown = [];
  @Input() height = '';
  @Output() valueChange = new EventEmitter<string>();
  @Output() saveRequested = new EventEmitter<void>();
}

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

const SAVED: SavedChartScript = {
  id: '7',
  name: 'Saved EMA',
  source: '//@version=6\nindicator("EMA pair")\nplot(close)\n',
  kind: 'indicator',
  updatedAt: Date.now() - 60_000,
  inputs: { len: 9 },
  revision: 'r1',
  visibility: 'Private',
  ownedByMe: true,
  latestVersion: 3,
};

describe('ScriptEditorPanelComponent', () => {
  let fixture: ComponentFixture<ScriptEditorPanelComponent>;
  let scripts: Record<string, any>;
  let dialogs: { ask: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    scripts = {
      compile: () => of(null),
      savedScripts: signal<SavedChartScript[]>([SAVED]),
      saveScript: vi.fn((req: { name: string; source: string }) =>
        of({ ...SAVED, id: '99', name: req.name, source: req.source, revision: 'n1' }),
      ),
      findOwnByName: vi.fn(() => null),
      freeName: vi.fn((n: string) => `${n} (2)`),
      latest: vi.fn(() => of({ ...SAVED, source: 'theirs src', revision: 'r9' })),
      versions: vi.fn(() => of([])),
      version: vi.fn(),
      restore: vi.fn(),
      setVisibility: vi.fn(),
      importFromTradingView: vi.fn(),
    };
    dialogs = {
      ask: vi.fn(async () => ({ choice: null, text: '' })),
      confirm: vi.fn(async () => true),
    };
  });
  afterEach(() => {
    fixture?.destroy();
    localStorage.clear();
  });

  function render(
    initialSource: string | null,
    externalSource: { text: string; seq: number } | null = null,
    initialName: string | null = initialSource === null ? null : 'Smart Algo v2',
  ) {
    TestBed.configureTestingModule({
      imports: [ScriptEditorPanelComponent],
      providers: [
        { provide: ChartScriptService, useValue: scripts },
        { provide: ScriptDialogService, useValue: dialogs },
      ],
    });
    TestBed.overrideComponent(ScriptEditorPanelComponent, {
      set: { imports: [PineEditorStubComponent, ChartIconStubComponent] },
    });
    fixture = TestBed.createComponent(ScriptEditorPanelComponent);
    const cmp = fixture.componentInstance as any;
    cmp.initialSource = signal(initialSource);
    cmp.initialName = signal(initialName);
    cmp.externalSource = signal(externalSource);
    cmp.scriptKey = signal(null);
    const emitted: string[] = [];
    cmp.sourceChange.subscribe((t: string) => emitted.push(t));
    fixture.detectChanges();
    return { cmp, emitted, host: fixture.nativeElement as HTMLElement };
  }

  describe('what a new panel starts from', () => {
    it('with nothing to load — the editor was cleared — the starter template, as a new script', () => {
      const { cmp, emitted, host } = render(null);
      expect(cmp.source()).toContain('indicator("My script"');
      expect(emitted.at(-1)).toContain('indicator("My script"');
      expect((host.querySelector('.editor__name') as HTMLInputElement).value).toBe('My script');
      expect(cmp.bound()).toBeNull();
    });

    it('with a script on the chart, its source', () => {
      const { cmp, host } = render('//@version=6\nindicator("v2")');
      expect(cmp.source()).toBe('//@version=6\nindicator("v2")');
      expect((host.querySelector('.editor__name') as HTMLInputElement).value).toBe('Smart Algo v2');
    });

    it('text the assistant wrote replaces the buffer', () => {
      const { cmp } = render(null, { text: '// written by the assistant', seq: 4 });
      expect(cmp.source()).toBe('// written by the assistant');
    });
  });

  describe('PE-07 / C4 — saving', () => {
    it('binds to the saved script it was given (by source) and keeps its saved name', () => {
      const { cmp } = render(SAVED.source, null, 'EMA pair');
      expect(cmp.bound()?.id).toBe('7');
      expect(cmp.name()).toBe('Saved EMA');
      expect(cmp.dirty()).toBe(false);
    });

    it('Save updates the bound script from the revision the edit started on, inputs kept', async () => {
      const { cmp } = render(SAVED.source);
      cmp.onEdit(`${SAVED.source}// edit`);
      expect(cmp.dirty()).toBe(true);
      await cmp.save();
      expect(scripts['saveScript']).toHaveBeenCalledWith({
        name: 'Saved EMA',
        source: `${SAVED.source}// edit`,
        target: { id: '7', revision: 'r1', inputs: { len: 9 } },
      });
      expect(cmp.dirty()).toBe(false);
    });

    it('a new script whose name is taken asks: save under a new name, or replace that one', async () => {
      const { cmp } = render(null);
      scripts['findOwnByName'].mockReturnValue(SAVED);
      cmp.name.set('Saved EMA');
      dialogs.ask.mockResolvedValueOnce({ choice: 'rename', text: 'Saved EMA (2)' });
      await cmp.save();
      expect(dialogs.ask.mock.calls[0][0].field.value).toBe('Saved EMA (2)');
      const created = scripts['saveScript'].mock.calls.at(-1)[0];
      expect(created).toMatchObject({ name: 'Saved EMA (2)', origin: null });
      expect(created.target).toBeUndefined();

      // Replacing it updates that script from its current revision.
      cmp.bound.set(null);
      dialogs.ask.mockResolvedValueOnce({ choice: 'overwrite', text: '' });
      await cmp.save();
      expect(scripts['latest']).toHaveBeenCalledWith('7');
      expect(scripts['saveScript'].mock.calls.at(-1)[0].target).toEqual({
        id: '7',
        revision: 'r9',
        inputs: { len: 9 },
      });
    });

    it('cancelling the name question saves nothing', async () => {
      const { cmp } = render(null);
      scripts['findOwnByName'].mockReturnValue(SAVED);
      await cmp.save();
      expect(scripts['saveScript']).not.toHaveBeenCalled();
    });

    it('a stale save compares, then "load the saved one" replaces the buffer', async () => {
      const { cmp } = render(SAVED.source);
      cmp.onEdit('mine');
      scripts['saveScript'].mockReturnValueOnce(
        throwError(() => new ScriptingApiError('changed since it was loaded', '-409')),
      );
      dialogs.ask.mockResolvedValueOnce({ choice: 'reload', text: '' });
      await cmp.save();
      const opts = dialogs.ask.mock.calls[0][0];
      expect([opts.compare.before, opts.compare.after]).toEqual(['theirs src', 'mine']);
      expect(cmp.source()).toBe('theirs src');
      expect(cmp.bound()?.revision).toBe('r9');
      expect(cmp.dirty()).toBe(false);
    });

    it('…"save mine over it" resends on their revision; "save as a copy" creates', async () => {
      const { cmp } = render(SAVED.source);
      cmp.onEdit('mine');
      scripts['saveScript'].mockReturnValueOnce(
        throwError(() => new ScriptingApiError('changed', '-409')),
      );
      dialogs.ask.mockResolvedValueOnce({ choice: 'overwrite', text: '' });
      await cmp.save();
      expect(scripts['saveScript'].mock.calls[1][0].target.revision).toBe('r9');

      cmp.onEdit('mine again');
      scripts['saveScript'].mockReturnValueOnce(
        throwError(() => new ScriptingApiError('changed', '-409')),
      );
      dialogs.ask.mockResolvedValueOnce({ choice: 'copy', text: '' });
      await cmp.save();
      const copy = scripts['saveScript'].mock.calls.at(-1)[0];
      expect(copy.target).toBeUndefined();
      expect(copy.name).toMatch(/\(copy\) \(2\)$/);
    });

    it("another operator's shared script saves as the operator's own copy", async () => {
      scripts['savedScripts'].set([{ ...SAVED, ownedByMe: false, createdBy: 'bob' }]);
      const { cmp, host } = render(SAVED.source);
      expect(host.textContent).toContain('shared by bob');
      expect(cmp.saveLabel()).toBe('Save a copy');
      await cmp.save();
      expect(scripts['saveScript'].mock.calls[0][0].target).toBeUndefined();
    });
  });

  describe('PE-I3 — an unsaved edit is kept in this browser', () => {
    it('autosaves while edited and offers it back on the next open of that script', () => {
      const first = render(SAVED.source);
      first.cmp.onEdit(`${SAVED.source}// kept`);
      fixture.detectChanges();
      fixture.destroy(); // flushes the pending autosave
      TestBed.resetTestingModule();
      const second = render(SAVED.source);
      expect(second.cmp.restorable()?.source).toContain('// kept');
      second.cmp.restoreLocalDraft();
      expect(second.cmp.source()).toContain('// kept');
    });
  });
});
