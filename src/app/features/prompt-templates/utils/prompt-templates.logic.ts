import type { PromptTemplateSummary } from '@core/services/prompt-template.service';

export interface TemplateCounts {
  versions: number;
  active: PromptTemplateSummary | null;
  drafts: number;
  archived: number;
}

export function templateCounts(rows: PromptTemplateSummary[]): TemplateCounts {
  return {
    versions: rows.length,
    active: rows.find((r) => r.isActive) ?? null,
    drafts: rows.filter((r) => !r.isActive && !r.isArchived).length,
    archived: rows.filter((r) => r.isArchived).length,
  };
}

export interface VersionEvent {
  at: string;
  id: number;
  version: string;
  kind: 'created' | 'forked' | 'promoted' | 'archived';
  text: string;
}

/** Every dated change across the versions (create / fork / promote / archive), newest first. */
export function versionEvents(rows: PromptTemplateSummary[]): VersionEvent[] {
  const out: VersionEvent[] = [];
  for (const r of rows) {
    out.push({
      at: r.createdAt,
      id: r.id,
      version: r.version,
      kind: r.forkedFromId != null ? 'forked' : 'created',
      text:
        r.forkedFromId != null
          ? `forked from #${r.forkedFromId} by ${r.createdBy}`
          : `created by ${r.createdBy}`,
    });
    if (r.promotedAt) {
      out.push({
        at: r.promotedAt,
        id: r.id,
        version: r.version,
        kind: 'promoted',
        text: 'promoted to active',
      });
    }
    if (r.archivedAt) {
      out.push({
        at: r.archivedAt,
        id: r.id,
        version: r.version,
        kind: 'archived',
        text: 'archived',
      });
    }
  }
  // Same instant (a row created and promoted together): the later step reads first.
  const rank = { created: 0, forked: 0, promoted: 1, archived: 2 } as const;
  return out.sort((a, b) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id || rank[b.kind] - rank[a.kind],
  );
}

/**
 * The two versions worth diffing by default: the active one against the version it replaced
 * (its fork ancestor, else the most recently archived), so the diff page opens with content.
 */
export function defaultDiffPair(
  rows: PromptTemplateSummary[],
): { left: number; right: number } | null {
  if (rows.length < 2) return null;
  const byNewest = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const active = rows.find((r) => r.isActive) ?? byNewest[0];
  const ancestor =
    (active.forkedFromId != null ? rows.find((r) => r.id === active.forkedFromId) : undefined) ??
    byNewest.find((r) => r.id !== active.id && r.isArchived && r.systemPromptLength > 200) ??
    byNewest.find((r) => r.id !== active.id);
  if (!ancestor) return null;
  return { left: ancestor.id, right: active.id };
}
