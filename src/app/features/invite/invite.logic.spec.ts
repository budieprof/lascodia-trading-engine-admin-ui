import { describe, expect, it } from 'vitest';

import { isPlausibleInviteToken, newlyActive } from './invite.logic';

describe('invitation accept page', () => {
  it('accepts only link-shaped tokens', () => {
    expect(isPlausibleInviteToken('Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA')).toBe(true);
    expect(isPlausibleInviteToken('short')).toBe(false);
    expect(isPlausibleInviteToken('has spaces in it, nope!!')).toBe(false);
    expect(isPlausibleInviteToken('../../etc/passwd/aaaaaaaaaaaaaa')).toBe(false);
    expect(isPlausibleInviteToken(null)).toBe(false);
  });

  it('finds the organisations the invitation opened', () => {
    const before = [
      { tenantId: 1, slug: 'house', name: 'House', status: 'Active' },
      { tenantId: 3, slug: 'acme', name: 'Acme', status: 'Invited' },
    ];
    const after = [
      { tenantId: 1, slug: 'house', name: 'House', status: 'Active' },
      { tenantId: 3, slug: 'acme', name: 'Acme', status: 'Active' },
    ];
    expect(newlyActive(before, after).map((m) => m.slug)).toEqual(['acme']);
    expect(newlyActive(after, after)).toEqual([]);
  });
});
