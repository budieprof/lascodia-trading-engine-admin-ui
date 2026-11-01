import { describe, expect, it } from 'vitest';

import {
  PRUNE_COPY,
  PRUNE_FILES_ACTION,
  jobWords,
  parsePruneResult,
  pruneConfirmLabel,
  pruneDryRunText,
  pruneFileLabel,
  pruneGroups,
  pruneOutcomeText,
} from './selfheal.logic';

// Shape of the host supervisor's prune.run() result (lascodia_supervisor/prune.py).
const dryRun = {
  dryRun: true,
  fileCount: 3,
  totalBytes: 3_500_000,
  deletedCount: 0,
  freedBytes: 0,
  failures: [],
  files: [
    { path: 'C:\\MT5\\logs\\20261001.log', bytes: 500_000, reason: 'terminal journal older than 14 days' },
    { path: 'C:\\MT5\\MQL5\\Files\\Lascodia\\ledger\\LASC-OLD-1_events.jsonl', bytes: 2_000_000, reason: 'instance LASC-OLD-1 silent for 30+ days' },
    { path: 'C:\\MT5\\logs\\20261002.log', bytes: 1_000_000, reason: 'terminal journal older than 14 days' },
  ],
  truncated: false,
};

describe('clean up old files (PruneFiles)', () => {
  it('the health card fix action is the engine route name', () => {
    expect(PRUNE_FILES_ACTION).toBe('prune-files');
    expect(jobWords('PruneFiles')).toBe('Clean up old files');
  });

  it('parses the supervisor result and rejects anything that is not one', () => {
    const r = parsePruneResult(dryRun)!;
    expect(r.dryRun).toBe(true);
    expect(r.fileCount).toBe(3);
    expect(r.files).toHaveLength(3);
    expect(parsePruneResult(null)).toBeNull();
    expect(parsePruneResult({ path: 'x', text: 'log' })).toBeNull();
    // Missing optional fields default instead of crashing the dialog.
    const thin = parsePruneResult({ fileCount: 0 })!;
    expect(thin).toMatchObject({ dryRun: true, fileCount: 0, files: [], failures: [], truncated: false });
    expect(parsePruneResult({ fileCount: 1, dryRun: false })!.dryRun).toBe(false);
  });

  it('groups files by why they go, biggest group first and biggest file first', () => {
    const groups = pruneGroups(parsePruneResult(dryRun)!.files);
    expect(groups.map((g) => [g.reason, g.count, g.bytes])).toEqual([
      ['instance LASC-OLD-1 silent for 30+ days', 1, 2_000_000],
      ['terminal journal older than 14 days', 2, 1_500_000],
    ]);
    expect(groups[1].files.map((f) => f.bytes)).toEqual([1_000_000, 500_000]);
  });

  it('shows a long Windows path as name + its folder', () => {
    expect(pruneFileLabel('C:\\MT5\\MQL5\\Files\\Lascodia\\ledger\\a.jsonl')).toEqual({ name: 'a.jsonl', folder: 'Lascodia/ledger' });
    expect(pruneFileLabel('/x/y.log')).toEqual({ name: 'y.log', folder: 'x' });
  });

  it('words the dry run, the confirm button and the outcome plainly', () => {
    const r = parsePruneResult(dryRun)!;
    expect(pruneDryRunText(r)).toBe('3 files can be deleted, freeing 3.3 MB.');
    expect(pruneConfirmLabel(r)).toBe('Delete 3 files (3.3 MB)');
    expect(pruneDryRunText({ ...r, fileCount: 0, files: [] })).toMatch(/^Nothing to clean up/);
    expect(pruneConfirmLabel(null)).toBe('Delete files');
    expect(pruneDryRunText({ ...r, fileCount: 900, truncated: true })).toContain('Only the first 3 are listed');

    const done = parsePruneResult({ ...dryRun, dryRun: false, deletedCount: 1, freedBytes: 1_000_000, failures: ['a.log: PermissionError'] })!;
    expect(pruneOutcomeText(done)).toBe('Deleted 1 file, freed 977 KB. 1 file could not be deleted (in use or no permission).');
    expect(pruneOutcomeText({ ...done, deletedCount: 0, failures: [] })).toBe('No file was deleted.');
  });

  it('promises only what the supervisor keeps', () => {
    for (const kept of ['credentials', 'templates', 'outbox', 'retry queue', 'dead letters', 'newest file']) {
      expect(PRUNE_COPY.safe).toContain(kept);
    }
    expect(PRUNE_COPY.intro).toContain('Nothing is deleted until you confirm');
  });
});
