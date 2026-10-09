import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';

import type { ScriptLibraryDetailDto, ScriptLibraryDto } from '@core/api/scripting.types';
import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PineCatalogService } from '../../services/pine-catalog.service';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import {
  LibrariesPageComponent,
  NEW_LIBRARY_TEMPLATE,
  aliasFor,
  importLine,
  isBuiltin,
} from './libraries-page.component';

// The page is driven through its methods: its header (app-page-header) has a required signal
// input the JIT test harness cannot bind, so the template is not rendered here.

const STD: ScriptLibraryDto = {
  id: 1,
  publisher: 'lascodia',
  name: 'std',
  version: 1,
  visibility: 'Shared',
  description: 'Built-in helpers',
  exports: [{ kind: 'function', name: 'pips', signature: 'pips(float price) → float' }],
};
const MINE_V1: ScriptLibraryDto = {
  id: 10,
  publisher: 'ola',
  name: 'Tools',
  version: 1,
  visibility: 'Private',
};
const MINE_V2: ScriptLibraryDto = {
  id: 11,
  publisher: 'ola',
  name: 'Tools',
  version: 2,
  visibility: 'Private',
};
const OTHER: ScriptLibraryDto = {
  id: 20,
  publisher: 'amy',
  name: 'Bands',
  version: 3,
  visibility: 'Shared',
};

const LIBRARY_SOURCE = '//@version=6\nlibrary("Tools")\nexport f(float x) => x\n';

/**
 * An engine refusal, delivered on a later task like a real response. (An error raised in the same
 * turn rejects before the page's native `await` attaches, which zone.js reports as unhandled
 * under vitest — the CLI build downlevels async/await for zone.js, so the app never sees this.)
 */
const refuse = (err: ScriptingApiError) =>
  new Observable<never>((sub) => {
    const t = setTimeout(() => sub.error(err));
    return () => clearTimeout(t);
  });

describe('LibrariesPageComponent', () => {
  let cmp: LibrariesPageComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let language: { refreshLibraries: ReturnType<typeof vi.fn> };
  let notify: Record<string, ReturnType<typeof vi.fn>>;
  let navigate: ReturnType<typeof vi.fn>;
  let dialogs: { ask: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(async () => {
    api = {
      listLibraries: vi.fn().mockReturnValue(of([MINE_V1, OTHER, MINE_V2, STD])),
      getLibrary: vi.fn((id: number) =>
        of({
          ...[STD, MINE_V1, MINE_V2, OTHER].find((l) => l.id === id)!,
          source: LIBRARY_SOURCE,
        } as ScriptLibraryDetailDto),
      ),
      createLibrary: vi.fn().mockReturnValue(of({ ...MINE_V2, id: 12, version: 3 })),
      deleteLibrary: vi.fn().mockReturnValue(of(undefined)),
      getMyPublisher: vi.fn().mockReturnValue(of('ola')),
      getLibraryUsage: vi.fn().mockReturnValue(
        of({
          libraryId: 11,
          importPath: 'ola/Tools/2',
          strategies: [
            {
              id: 4,
              name: 'Breakout',
              symbol: 'EURUSD',
              timeframe: 'H1',
              status: 'Active',
              lifecycleStage: 'Active',
              direct: true,
              blocksDelete: true,
            },
          ],
          chartScripts: [],
          libraries: [],
        }),
      ),
    };
    dialogs = {
      ask: vi.fn(async () => ({ choice: null, text: '' })),
      confirm: vi.fn(async () => false),
    };
    language = { refreshLibraries: vi.fn().mockResolvedValue(undefined) };
    notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
    navigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      imports: [LibrariesPageComponent],
      providers: [
        { provide: ScriptingService, useValue: api },
        {
          provide: PineCatalogService,
          useValue: { ...language, catalog: signal(null), libraries: signal([]) },
        },
        { provide: NotificationService, useValue: notify },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: Router, useValue: { navigate } },
        { provide: ScriptDialogService, useValue: dialogs },
      ],
    });
    cmp = TestBed.createComponent(LibrariesPageComponent).componentInstance;
    cmp.ngOnInit();
    await flush();
  });

  describe('listing', () => {
    it('lists the built-in library first, then by publisher, name and newest version', () => {
      expect(cmp.libraries().map((l) => l.id)).toEqual([1, 20, 11, 10]);
      expect(isBuiltin(cmp.libraries()[0])).toBe(true);
      expect(cmp.myPublisher()).toBe('ola');
    });

    it('filters by publisher and name on the server', async () => {
      cmp.publisherFilter.set('ola');
      cmp.nameFilter.set('Too');
      await cmp.load();
      expect(api['listLibraries']).toHaveBeenLastCalledWith({ publisher: 'ola', name: 'Too' });
      cmp.toggleMine('ola');
      expect(cmp.publisherFilter()).toBe('');
    });

    it('shows the load failure', async () => {
      api['listLibraries'].mockReturnValueOnce(refuse(new ScriptingApiError('Engine down')));
      await cmp.load();
      expect(cmp.listError()).toBe('Engine down');
    });
  });

  describe('reading a library', () => {
    it('loads its source and exports, and remembers the selection in the URL', async () => {
      await cmp.select(1);
      expect(api['getLibrary']).toHaveBeenCalledWith(1);
      expect(cmp.detail()?.source).toBe(LIBRARY_SOURCE);
      expect(cmp.exportsOf(STD).map((e) => e.name)).toEqual(['pips']);
      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { id: 1 } }),
      );
    });

    it('builds and copies the import line', async () => {
      expect(importLine(MINE_V2)).toBe('import ola/Tools/2 as Tools');
      expect(aliasFor('my-lib 2')).toBe('my_lib_2');
      expect(aliasFor('3d')).toBe('lib_3d');
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await cmp.copyImport(OTHER);
      expect(writeText).toHaveBeenCalledWith('import amy/Bands/3 as Bands');
      expect(notify['success']).toHaveBeenCalled();
    });
  });

  describe('publishing', () => {
    it('publishes a new library from the template, named from its library() title when blank', async () => {
      cmp.startNew();
      expect(cmp.draft()?.source).toBe(NEW_LIBRARY_TEMPLATE);
      expect(cmp.suggestedName()).toBe('MyLibrary');
      cmp.patchDraft({ description: '  Helpers  ', visibility: 'Shared' });
      cmp.draftCompile.set({
        success: true,
        diagnostics: [],
        declaration: { kind: 'library', title: 'MyLibrary' },
        inputs: [],
        exports: [{ kind: 'function', name: 'midpoint' }],
      });
      expect(cmp.canPublish()).toBe(true);
      await cmp.publish();
      expect(api['createLibrary']).toHaveBeenCalledWith({
        name: 'MyLibrary',
        description: 'Helpers',
        visibility: 'Shared',
        source: NEW_LIBRARY_TEMPLATE,
        // PE-I12: a new library knows no version yet.
        basedOnVersion: 0,
      });
      await flush();
      expect(cmp.draft()).toBeNull();
      expect(language.refreshLibraries).toHaveBeenCalled();
      expect(cmp.selectedId()).toBe(12);
    });

    it('publishes a new version under the same name, from the current source', async () => {
      await cmp.select(11);
      await cmp.startNewVersion(MINE_V2);
      expect(cmp.draft()).toMatchObject({
        baseId: 11,
        name: 'Tools',
        source: LIBRARY_SOURCE,
        visibility: 'Private',
        basedOnVersion: 2,
      });
      expect(dialogs.ask).not.toHaveBeenCalled();
      cmp.patchDraft({ source: `${LIBRARY_SOURCE}export g(float x) => x * 2\n` });
      await cmp.publish();
      expect(api['createLibrary']).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Tools', visibility: 'Private', basedOnVersion: 2 }),
      );
    });

    it('will not publish a script with errors or without library()', () => {
      cmp.startNew();
      cmp.draftCompile.set({
        success: false,
        diagnostics: [
          {
            code: 'PS1001',
            severity: 'error',
            message: 'x',
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 2,
          },
        ],
        declaration: null,
        inputs: [],
      });
      expect(cmp.publishBlockedReason()).toBe('Fix the compile errors first');
      cmp.draftCompile.set({
        success: true,
        diagnostics: [],
        declaration: { kind: 'indicator', title: 'I' },
        inputs: [],
      });
      expect(cmp.canPublish()).toBe(false);
      expect(cmp.draftKindWarning()).toContain('indicator()');
    });

    it('keeps the draft and shows the engine refusal', async () => {
      api['createLibrary'].mockReturnValueOnce(
        refuse(new ScriptingApiError('Name already taken by another publisher', '-409')),
      );
      cmp.startNew();
      await cmp.publish();
      expect(cmp.draft()).not.toBeNull();
      expect(cmp.publishError()).toBe('Name already taken by another publisher');
    });
  });

  describe('deleting', () => {
    it('deletes after confirmation and refreshes the lists', async () => {
      await cmp.select(10);
      cmp.askDelete(MINE_V1);
      expect(cmp.deleteMessage()).toContain('ola/Tools/1');
      await cmp.confirmDelete();
      expect(api['deleteLibrary']).toHaveBeenCalledWith(10, false);
      expect(cmp.deleteTarget()).toBeNull();
      expect(cmp.selectedId()).toBeNull();
      expect(language.refreshLibraries).toHaveBeenCalled();
    });

    it('explains a conflict with a live strategy and offers the forced delete', async () => {
      api['deleteLibrary']
        .mockReturnValueOnce(refuse(new ScriptingApiError('In use by strategy #4', '-409')))
        .mockReturnValueOnce(of(undefined));
      cmp.askDelete(MINE_V2);
      await cmp.confirmDelete();
      expect(cmp.deleteConflict()).toBe(true);
      expect(cmp.deleteTarget()).toEqual(MINE_V2);
      expect(cmp.deleteMessage()).toContain('A live strategy imports');
      await cmp.confirmDelete();
      expect(api['deleteLibrary']).toHaveBeenLastCalledWith(11, true);
      expect(cmp.deleteTarget()).toBeNull();
    });

    it('shows any other refusal in the dialog', async () => {
      api['deleteLibrary'].mockReturnValueOnce(
        refuse(new ScriptingApiError('Forbidden', null, null, 403)),
      );
      cmp.askDelete(OTHER);
      await cmp.confirmDelete();
      expect(cmp.deleteError()).toBe('Forbidden');
      expect(cmp.deleteTarget()).toEqual(OTHER);
    });
  });
  describe('PE-I12 / PE-14: versions', () => {
    const sources: Record<number, string> = {
      10: '//@version=6\nlibrary("Tools")\nexport f(float x) => x\nexport g(float x) => x * 2\n',
      11: LIBRARY_SOURCE,
    };
    const exportsById: Record<number, { kind: string; name: string; signature?: string }[]> = {
      10: [
        { kind: 'function', name: 'f', signature: 'f(float x) → float' },
        { kind: 'function', name: 'g', signature: 'g(float x) → float' },
      ],
      11: [{ kind: 'function', name: 'f', signature: 'f(float x) → float' }],
    };

    beforeEach(() => {
      api['getLibrary'].mockImplementation((id: number) =>
        of({
          ...[STD, MINE_V1, MINE_V2, OTHER].find((l) => l.id === id)!,
          source: sources[id] ?? LIBRARY_SOURCE,
          exports: exportsById[id],
        } as ScriptLibraryDetailDto),
      );
    });

    it('starting a new version from an older one asks which version to start from', async () => {
      await cmp.select(10);
      dialogs.ask.mockResolvedValueOnce({ choice: 'newest', text: '' });
      await cmp.startNewVersion(MINE_V1);
      expect(dialogs.ask.mock.calls[0][0].message).toContain('v2 is');
      expect(cmp.draft()).toMatchObject({ source: LIBRARY_SOURCE, basedOnVersion: 2 });

      cmp.draft.set(null);
      dialogs.ask.mockResolvedValueOnce({ choice: 'this', text: '' });
      await cmp.startNewVersion(MINE_V1);
      // Still based on v2: the engine compares against the newest version, whichever source.
      expect(cmp.draft()).toMatchObject({ source: sources[10], basedOnVersion: 2 });

      cmp.draft.set(null);
      dialogs.ask.mockResolvedValueOnce({ choice: null, text: '' });
      await cmp.startNewVersion(MINE_V1);
      expect(cmp.draft()).toBeNull();
    });

    it('asks before publishing a version that drops exports the newest one has', async () => {
      await cmp.select(10);
      dialogs.ask.mockResolvedValueOnce({ choice: 'this', text: '' });
      await cmp.startNewVersion(MINE_V1);
      // Based on v2 (exports f only): compiled exports without f.
      cmp.draftCompile.set({
        success: true,
        diagnostics: [],
        declaration: { kind: 'library', title: 'Tools' },
        inputs: [],
        exports: [{ kind: 'function', name: 'g' }],
      });
      await cmp.publish();
      expect(dialogs.confirm.mock.calls[0][0].message).toContain('drops an export v2 has: f');
      expect(api['createLibrary']).not.toHaveBeenCalled();
      dialogs.confirm.mockResolvedValueOnce(true);
      await cmp.publish();
      expect(api['createLibrary']).toHaveBeenCalledTimes(1);
    });

    it('opens a comparison when a newer version was published meanwhile, and can publish anyway', async () => {
      await cmp.select(11);
      await cmp.startNewVersion(MINE_V2);
      const v3 = { ...MINE_V2, id: 12, version: 3 };
      api['listLibraries'].mockReturnValue(of([MINE_V1, MINE_V2, v3, STD]));
      api['createLibrary']
        .mockReturnValueOnce(
          refuse(
            new ScriptingApiError(
              'ola/Tools/3 was published after the version this source started from (v2).',
              '-409',
            ),
          ),
        )
        .mockReturnValueOnce(of({ ...MINE_V2, id: 13, version: 4 }));
      dialogs.ask.mockResolvedValueOnce({ choice: 'publish', text: '' });
      await cmp.publish();
      await flush();
      const asked = dialogs.ask.mock.calls[0][0];
      expect(asked.title).toBe('A newer version was published');
      expect(asked.compare).toMatchObject({ beforeLabel: 'v3', afterLabel: 'Your draft' });
      expect(api['createLibrary']).toHaveBeenLastCalledWith(
        expect.objectContaining({ basedOnVersion: 3 }),
      );
      expect(notify['success']).toHaveBeenCalledWith('Published ola/Tools/4');
    });

    it('keeps the draft with a note when the operator keeps editing instead', async () => {
      await cmp.select(11);
      await cmp.startNewVersion(MINE_V2);
      api['listLibraries'].mockReturnValue(of([MINE_V2, { ...MINE_V2, id: 12, version: 3 }]));
      api['createLibrary'].mockReturnValueOnce(
        refuse(new ScriptingApiError('ola/Tools/3 was published after …', '-409')),
      );
      await cmp.publish();
      await flush();
      expect(cmp.draft()).not.toBeNull();
      expect(cmp.publishError()).toContain('v3 was published after this draft started');
      expect(api['createLibrary']).toHaveBeenCalledTimes(1);
    });

    it('compares a version with the previous one, sources and exports', async () => {
      await cmp.select(11);
      cmp.openChanges(MINE_V2);
      await flush();
      expect(cmp.compareId()).toBe(10);
      const pair = cmp.comparePair()!;
      expect([pair.older.version, pair.newer.version]).toEqual([1, 2]);
      expect(cmp.exportDiff()!.removed.map((e) => e.name)).toEqual(['g']);
      expect(cmp.otherVersions(MINE_V2).map((l) => l.id)).toEqual([10]);
    });

    it('lists what imports a version', async () => {
      await cmp.select(11);
      await cmp.openUsage(MINE_V2);
      expect(api['getLibraryUsage']).toHaveBeenCalledWith(11);
      expect(cmp.usage()!.strategies[0].name).toBe('Breakout');
      api['getLibraryUsage'].mockReturnValueOnce(refuse(new ScriptingApiError('Engine down')));
      await cmp.select(10);
      await cmp.openUsage(MINE_V1);
      expect(cmp.usageError()).toBe('Engine down');
    });

    it('asks before an unpublished draft is thrown away', async () => {
      cmp.startNew();
      expect(cmp.hasUnsavedChanges()).toBe(false);
      cmp.patchDraft({ source: NEW_LIBRARY_TEMPLATE + '// more\n' });
      expect(cmp.hasUnsavedChanges()).toBe(true);
      await cmp.select(1);
      expect(dialogs.confirm).toHaveBeenCalledTimes(1);
      expect(cmp.draft()).not.toBeNull();
      await cmp.cancelDraft();
      expect(cmp.draft()).not.toBeNull();
      dialogs.confirm.mockResolvedValueOnce(true);
      await cmp.cancelDraft();
      expect(cmp.draft()).toBeNull();
    });
  });
});
