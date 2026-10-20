import { describe, expect, it } from 'vitest';

import catalogJson from '../../../../docs/permission-catalog.json';
// The generator is plain ESM under scripts/; its pure functions are exercised here.
import {
  identifierFor,
  renderModule,
  validateCatalog,
} from '../../../../scripts/generate-permissions.mjs';
import {
  PERMISSION_CATALOG,
  Permission,
  isPermissionKey,
  permissionDefinition,
} from './permissions.generated';

const valid = {
  key: 'orders.read',
  category: 'Orders',
  description: 'View orders.',
  scopeable: true,
  stepUp: false,
  twoPerson: false,
  deprecated: false,
};

describe('permissions.generated.ts', () => {
  it('matches the checked-in catalog copy exactly (regenerate after refreshing the JSON)', () => {
    const fromJson = [...(catalogJson as typeof PERMISSION_CATALOG)]
      .map((p) => ({ ...p }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    expect(PERMISSION_CATALOG.map((p) => ({ ...p }))).toEqual(fromJson);
  });

  it('names every key once', () => {
    expect(Object.values(Permission).sort()).toEqual(PERMISSION_CATALOG.map((p) => p.key).sort());
    expect(Permission.OrdersRead).toBe('orders.read');
    expect(Permission.IamAccessReview).toBe('iam.access_review');
  });

  it('tells known keys from unknown ones', () => {
    expect(isPermissionKey('orders.read')).toBe(true);
    expect(isPermissionKey('orders.read.everything')).toBe(false);
    expect(permissionDefinition('users.manage')?.category).toBe('Administration');
    expect(permissionDefinition('nope.nope')).toBeUndefined();
  });
});

describe('generate-permissions', () => {
  it('derives identifiers from keys', () => {
    expect(identifierFor('orders.cancel.batch')).toBe('OrdersCancelBatch');
    expect(identifierFor('iam.access_review')).toBe('IamAccessReview');
    expect(identifierFor('llmbacktest.view')).toBe('LlmbacktestView');
  });

  it('sorts entries by key whatever order the engine wrote them in', () => {
    const out = validateCatalog([{ ...valid, key: 'z.b' }, { ...valid, key: 'a.b' }]);
    expect(out.map((e: { key: string }) => e.key)).toEqual(['a.b', 'z.b']);
  });

  it('refuses a malformed catalog and names every problem', () => {
    expect(() => validateCatalog({})).toThrow(/JSON array/);
    expect(() => validateCatalog([])).toThrow(/empty/);
    expect(() => validateCatalog([{ ...valid, key: 'Orders Read' }])).toThrow(/bad key/);
    expect(() => validateCatalog([{ ...valid, stepUp: 'yes' }])).toThrow(/stepUp must be a boolean/);
    expect(() => validateCatalog([valid, valid])).toThrow(/duplicate key/);
    expect(() => validateCatalog([{ ...valid, category: '' }, { ...valid, key: 'x' }])).toThrow(
      /bad category[\s\S]*bad key/,
    );
  });

  it('refuses two keys that would share one identifier', () => {
    const entries = validateCatalog([valid, { ...valid, key: 'orders_read.x' }, { ...valid, key: 'orders.read_x' }]);
    expect(() => renderModule(entries)).toThrow(/both map to/);
  });

  it('escapes quotes in descriptions', () => {
    const src = renderModule(validateCatalog([{ ...valid, description: "it's \\ fine" }]));
    expect(src).toContain("description: 'it\\'s \\\\ fine'");
  });
});
