import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';

import type { ScriptLibraryDetailDto, ScriptLibraryDto } from '@core/api/scripting.types';
import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PineCatalogService } from '../../services/pine-catalog.service';
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
      });
      await flush();
      expect(cmp.draft()).toBeNull();
      expect(language.refreshLibraries).toHaveBeenCalled();
      expect(cmp.selectedId()).toBe(12);
    });

    it('publishes a new version under the same name, from the current source', async () => {
      await cmp.select(11);
      cmp.startNewVersion(MINE_V2);
      expect(cmp.draft()).toMatchObject({
        baseId: 11,
        name: 'Tools',
        source: LIBRARY_SOURCE,
        visibility: 'Private',
      });
      cmp.patchDraft({ source: `${LIBRARY_SOURCE}export g(float x) => x * 2\n` });
      await cmp.publish();
      expect(api['createLibrary']).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Tools', visibility: 'Private' }),
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
});
