import type { ApiReference, ApiReferenceEndpoint, ApiReferenceGroup } from './api-reference.types';

export interface ApiReferenceFilter {
  text: string;
  access: 'all' | 'anonymous' | 'permission' | 'session';
}

/** Groups and endpoints matching the filter: text in the path, summary, permission or group name. */
export function filterReference(ref: ApiReference | null, f: ApiReferenceFilter): ApiReferenceGroup[] {
  if (!ref) return [];
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (g: ApiReferenceGroup, e: ApiReferenceEndpoint) => {
    if (f.access !== 'all' && e.access !== f.access) return false;
    const hay = `${g.name} ${e.method} ${e.path} ${e.summary ?? ''} ${e.permission ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return ref.groups
    .map((g) => ({ name: g.name, endpoints: g.endpoints.filter((e) => hit(g, e)) }))
    .filter((g) => g.endpoints.length > 0);
}

/** The path below the base path, so the table stays readable. */
export function shortPath(path: string, basePath: string): string {
  return path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

/** Who may call it, in words. */
export function accessText(e: ApiReferenceEndpoint): string {
  switch (e.access) {
    case 'anonymous':
      return 'No sign-in';
    case 'session':
      return 'Any signed-in caller (own session)';
    case 'permission':
      return e.permission ?? 'Permission';
    default:
      return e.access;
  }
}
