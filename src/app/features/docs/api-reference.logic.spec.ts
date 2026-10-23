import { describe, expect, it } from 'vitest';

import { accessText, filterReference, shortPath } from './api-reference.logic';
import type { ApiReference } from './api-reference.types';

const ref: ApiReference = {
  title: 'API',
  version: 'v1',
  source: 'test',
  basePath: '/api/v1/lascodia-trading-engine',
  endpointCount: 3,
  groups: [
    {
      name: 'Demo',
      endpoints: [
        {
          method: 'GET',
          path: '/api/v1/lascodia-trading-engine/demo',
          summary: 'Replay clock',
          access: 'anonymous',
          parameters: [],
        },
      ],
    },
    {
      name: 'Machine',
      endpoints: [
        {
          method: 'GET',
          path: '/api/v1/lascodia-trading-engine/machine/enrollments',
          summary: 'Tokens',
          access: 'permission',
          permission: 'accounts.read',
          parameters: [],
        },
        {
          method: 'POST',
          path: '/api/v1/lascodia-trading-engine/machine/enroll',
          summary: 'Enroll',
          access: 'anonymous',
          parameters: [],
        },
      ],
    },
  ],
};

describe('API reference', () => {
  it('filters by words across group, path, summary and permission, and by access', () => {
    expect(
      filterReference(ref, { text: 'accounts.read', access: 'all' })
        .flatMap((g) => g.endpoints)
        .map((e) => e.path),
    ).toEqual(['/api/v1/lascodia-trading-engine/machine/enrollments']);
    expect(filterReference(ref, { text: '', access: 'anonymous' }).map((g) => g.name)).toEqual([
      'Demo',
      'Machine',
    ]);
    expect(filterReference(ref, { text: 'machine post', access: 'all' })[0].endpoints).toHaveLength(
      1,
    );
    expect(filterReference(null, { text: '', access: 'all' })).toEqual([]);
  });

  it('shortens paths and names access', () => {
    expect(shortPath('/api/v1/lascodia-trading-engine/demo', ref.basePath)).toBe('/demo');
    expect(shortPath('/health', ref.basePath)).toBe('/health');
    expect(accessText(ref.groups[1].endpoints[0])).toBe('accounts.read');
    expect(accessText(ref.groups[0].endpoints[0])).toBe('No sign-in');
  });
});
