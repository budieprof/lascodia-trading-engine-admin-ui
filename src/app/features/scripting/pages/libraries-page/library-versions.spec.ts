import { describe, expect, it } from 'vitest';

import type { ScriptLibraryDto } from '@core/api/scripting.types';
import { exportChanges, newestVersionOf, previousVersionOf, versionsOf } from './library-versions';

const lib = (id: number, version: number, name = 'Tools', publisher = 'ola'): ScriptLibraryDto => ({
  id,
  publisher,
  name,
  version,
  visibility: 'Private',
});

const LIST = [lib(1, 1), lib(3, 3), lib(2, 2), lib(9, 1, 'Bands'), lib(7, 5, 'tools', 'amy')];

describe('library versions', () => {
  it('lists a library’s versions newest first, by publisher and name', () => {
    expect(versionsOf(LIST, LIST[0]).map((l) => l.version)).toEqual([3, 2, 1]);
    expect(newestVersionOf(LIST, LIST[0]).id).toBe(3);
    expect(previousVersionOf(LIST, LIST[1])!.id).toBe(2);
    expect(previousVersionOf(LIST, LIST[0])).toBeNull();
  });

  it('falls back to the library itself when it is not listed', () => {
    const lone = lib(42, 4, 'Lone');
    expect(newestVersionOf(LIST, lone)).toBe(lone);
  });
});

describe('exportChanges', () => {
  it('finds added, removed and re-signed exports', () => {
    const c = exportChanges(
      [
        { kind: 'function', name: 'f', signature: 'f(float x) → float' },
        { kind: 'function', name: 'g', signature: 'g() → int' },
        { kind: 'type', name: 'Pair' },
      ],
      [
        { kind: 'function', name: 'f', signature: 'f(float x, int n) → float' },
        { kind: 'type', name: 'Pair' },
        { kind: 'const', name: 'K' },
      ],
    );
    expect(c.added.map((e) => e.name)).toEqual(['K']);
    expect(c.removed.map((e) => e.name)).toEqual(['g']);
    expect(c.changed).toEqual([
      { name: 'f', before: 'f(float x) → float', after: 'f(float x, int n) → float' },
    ]);
  });
});
