import { describe, expect, it } from 'vitest';

import {
  closeConfirmationOk,
  closeOutcome,
  closureStatusLabel,
  daysUntil,
  exportInProgress,
  exportStatusLabel,
  exportTone,
  formatBytes,
  imageFileProblem,
  isValidColour,
  lighten,
  planSummary,
  purgeConfirmationOk,
  readableTextOn,
} from './lifecycle.logic';
import type {
  TenantClosure,
  TenantClosureState,
  TenantDataExport,
  TenantPurgePlan,
} from './lifecycle.types';

const NOW = Date.parse('2026-10-20T09:00:00Z');

function exportRow(over: Partial<TenantDataExport> = {}): TenantDataExport {
  return {
    id: 1,
    status: 'Ready',
    requestedBy: 'admin-user:7',
    requestedAtUtc: '2026-10-20T08:00:00Z',
    startedAtUtc: null,
    completedAtUtc: null,
    expiresAtUtc: '2026-10-27T08:00:00Z',
    sizeBytes: 2048,
    sha256: 'abc',
    tableCount: 3,
    rowCount: 10,
    failureReason: null,
    downloadCount: 0,
    lastDownloadedAtUtc: null,
    canDownload: true,
    ...over,
  };
}

const state: TenantClosureState = {
  tenantId: 7001,
  slug: 'acme',
  name: 'Acme',
  status: 'Active',
  isHouse: false,
  openPositions: 0,
  workingOrders: 0,
  owners: 1,
  needsSecondOwner: false,
  graceDays: 30,
  activeMachineCredentials: 2,
  members: 3,
  canClose: true,
  blockers: [],
};

function plan(over: Partial<TenantPurgePlan> = {}): TenantPurgePlan {
  return {
    tenantId: 7001,
    slug: 'acme',
    name: 'Acme',
    generatedAtUtc: '2026-11-20T09:00:00Z',
    canRun: true,
    rows: 1234,
    steps: [{ table: 'Order', entity: 'Order', ownership: 'TenantOwned', rows: 1200 }],
    tablesVisited: 140,
    cascades: [],
    blockers: [],
    auditEventsKept: 50,
    people: [
      { adminUserId: 7, username: 'owner', action: 'remove' },
      { adminUserId: 8, username: 'shared', action: 'keep: member of another organisation' },
    ],
    identityProviderOrganizationId: 'kc',
    identityProviderEnabled: true,
    notes: [],
    ...over,
  };
}

function closure(over: Partial<TenantClosure> = {}): TenantClosure {
  return {
    id: 1,
    tenantId: 7001,
    slug: 'acme',
    name: 'Acme',
    status: 'Closed',
    reason: 'moving',
    requestedBy: 'admin-user:7',
    approvedBy: null,
    closedAtUtc: '2026-10-20T09:00:00Z',
    graceEndsAtUtc: '2026-11-19T09:00:00Z',
    effects: null,
    reopenedAtUtc: null,
    reopenedBy: null,
    reopenReason: null,
    plannedAtUtc: null,
    plan: null,
    purgeRequestedAtUtc: null,
    purgeRequestedBy: null,
    purgeStartedAtUtc: null,
    purgeCompletedAtUtc: null,
    purgeReport: null,
    purgeError: null,
    canReopen: true,
    canSchedulePurge: false,
    ...over,
  };
}

describe('formatting', () => {
  it('formats sizes and days left', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('—');
    expect(daysUntil('2026-10-27T09:00:00Z', NOW)).toBe(7);
    expect(daysUntil('2026-10-01T00:00:00Z', NOW)).toBe(0);
    expect(daysUntil(null, NOW)).toBe(0);
  });
});

describe('branding images', () => {
  it('accepts the engine formats within their limits', () => {
    expect(imageFileProblem('logo', { name: 'l.png', size: 1000, type: 'image/png' })).toBeNull();
    expect(imageFileProblem('logo', { name: 'l.webp', size: 1000, type: 'image/webp' })).toBeNull();
    expect(imageFileProblem('favicon', { name: 'f.ico', size: 1000, type: '' })).toBeNull();
  });

  it('refuses other types, empty and oversize files before sending them', () => {
    expect(
      imageFileProblem('logo', { name: 'l.svg', size: 1000, type: 'image/svg+xml' }),
    ).toContain('PNG');
    expect(
      imageFileProblem('favicon', { name: 'f.jpg', size: 1000, type: 'image/jpeg' }),
    ).toContain('PNG or ICO');
    expect(
      imageFileProblem('logo', { name: 'l.png', size: 300 * 1024, type: 'image/png' }),
    ).toContain('256 KB');
    expect(imageFileProblem('favicon', { name: 'f.png', size: 0, type: 'image/png' })).toContain(
      'empty',
    );
  });

  it('checks colours and picks readable text', () => {
    expect(isValidColour('#1f6feb')).toBe(true);
    expect(isValidColour('')).toBe(true);
    expect(isValidColour('red')).toBe(false);
    expect(isValidColour('#12345')).toBe(false);
    expect(readableTextOn('#ffffff')).toBe('#000000');
    expect(readableTextOn('#000000')).toBe('#ffffff');
    expect(readableTextOn('#ffd60a')).toBe('#000000');
    expect(lighten('#000000', 0.5)).toBe('#808080');
  });
});

describe('exports', () => {
  it('labels and tones each state', () => {
    expect(exportStatusLabel(exportRow(), NOW)).toBe('Ready — 7 day(s) left');
    expect(exportTone(exportRow())).toBe('ok');
    expect(exportStatusLabel(exportRow({ status: 'Queued', canDownload: false }), NOW)).toBe(
      'Waiting to start',
    );
    expect(exportTone(exportRow({ status: 'Running', canDownload: false }))).toBe('warn');
    expect(exportTone(exportRow({ status: 'Failed', canDownload: false }))).toBe('bad');
    expect(exportStatusLabel(exportRow({ status: 'Expired', canDownload: false }), NOW)).toBe(
      'Expired (deleted)',
    );
  });

  it('finds the export in progress (one at a time)', () => {
    expect(exportInProgress([exportRow(), exportRow({ id: 2, status: 'Running' })])?.id).toBe(2);
    expect(exportInProgress([exportRow()])).toBeNull();
  });
});

describe('closing', () => {
  it('needs the exact handle and a reason, and nothing in the way', () => {
    expect(closeConfirmationOk(state, 'ACME ', 'leaving')).toBe(true);
    expect(closeConfirmationOk(state, 'acm', 'leaving')).toBe(false);
    expect(closeConfirmationOk(state, 'acme', '  ')).toBe(false);
    expect(closeConfirmationOk({ ...state, canClose: false }, 'acme', 'leaving')).toBe(false);
    expect(closeConfirmationOk(null, 'acme', 'leaving')).toBe(false);
  });

  it('reads a close answer: closed, held for a second Owner, or refused', () => {
    const c = closure();
    expect(
      closeOutcome({
        status: true,
        responseCode: '00',
        message: 'ok',
        data: { closure: c, approvalId: null, expiresAtUtc: null },
      }),
    ).toEqual({ kind: 'closed', closure: c });
    expect(
      closeOutcome({
        status: false,
        responseCode: '-202-approval',
        message: 'needs a second Owner',
        data: { closure: null, approvalId: 41, expiresAtUtc: '2026-10-21T09:00:00Z' },
      }),
    ).toEqual({ kind: 'approval', approvalId: 41, expiresAtUtc: '2026-10-21T09:00:00Z' });
    expect(
      closeOutcome({ status: false, responseCode: '-409', message: 'flatten first', data: null }),
    ).toEqual({
      kind: 'refused',
      message: 'flatten first',
    });
  });

  it('labels closures and summarises plans', () => {
    expect(closureStatusLabel('PurgeScheduled')).toContain('waiting');
    expect(planSummary(plan())).toBe(
      'Would delete 1,234 row(s) in 1 table(s); 1 person(s) removed, 1 kept; 50 audit event(s) kept until their retention passes.',
    );
    expect(
      planSummary(
        plan({
          canRun: false,
          blockers: [{ table: 'X', column: 'Y', referencesTable: 'Z', rows: 1, why: 'w' }],
        }),
      ),
    ).toContain('Blocked');
  });

  it('confirms a deletion only after the grace period, with a runnable plan and the handle typed', () => {
    const ready = closure({ canSchedulePurge: true, plan: plan() });
    expect(purgeConfirmationOk(ready, 'acme', 'acme')).toBe(true);
    expect(purgeConfirmationOk(ready, 'acme', 'nope')).toBe(false);
    expect(
      purgeConfirmationOk(closure({ canSchedulePurge: false, plan: plan() }), 'acme', 'acme'),
    ).toBe(false);
    expect(
      purgeConfirmationOk(
        closure({ canSchedulePurge: true, plan: plan({ canRun: false }) }),
        'acme',
        'acme',
      ),
    ).toBe(false);
  });
});
