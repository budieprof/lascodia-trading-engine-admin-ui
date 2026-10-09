import type { ScriptExportDto, ScriptLibraryDto } from '@core/api/scripting.types';

type LibraryRef = Pick<ScriptLibraryDto, 'publisher' | 'name'>;

const sameLibrary = (a: LibraryRef, b: LibraryRef) =>
  a.publisher.toLowerCase() === b.publisher.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

/** Every listed version of a library, newest first. */
export function versionsOf<T extends ScriptLibraryDto>(list: readonly T[], lib: LibraryRef): T[] {
  return list.filter((l) => sameLibrary(l, lib)).sort((a, b) => b.version - a.version);
}

/** The newest listed version of a library (the library itself when it is not listed). */
export function newestVersionOf<T extends ScriptLibraryDto>(list: readonly T[], lib: T): T {
  return versionsOf(list, lib)[0] ?? lib;
}

/** The version just below `lib`, or null for a first version. */
export function previousVersionOf<T extends ScriptLibraryDto>(
  list: readonly T[],
  lib: T,
): T | null {
  return versionsOf(list, lib).find((l) => l.version < lib.version) ?? null;
}

export interface ExportChange {
  name: string;
  before: string;
  after: string;
}

export interface ExportChanges {
  added: ScriptExportDto[];
  removed: ScriptExportDto[];
  /** Same name, another kind or signature. */
  changed: ExportChange[];
}

const describeExport = (e: ScriptExportDto) => e.signature?.trim() || `${e.kind} ${e.name}`;

/** What a library's exports gained, lost and changed between two versions. */
export function exportChanges(
  before: readonly ScriptExportDto[],
  after: readonly ScriptExportDto[],
): ExportChanges {
  const was = new Map(before.map((e) => [e.name, e]));
  const now = new Map(after.map((e) => [e.name, e]));
  const added = after.filter((e) => !was.has(e.name));
  const removed = before.filter((e) => !now.has(e.name));
  const changed: ExportChange[] = [];
  for (const e of after) {
    const old = was.get(e.name);
    if (!old) continue;
    const a = describeExport(old);
    const b = describeExport(e);
    if (a !== b || old.kind !== e.kind) changed.push({ name: e.name, before: a, after: b });
  }
  return { added, removed, changed };
}
