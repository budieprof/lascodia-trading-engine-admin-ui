import { ActivatedRoute } from '@angular/router';

/** A single breadcrumb: its label and the URL it points at. */
export interface Breadcrumb {
  label: string;
  route: string;
}

/**
 * Walks the activated-route tree collecting `data.breadcrumb` labels.
 *
 * <p>Shared by the breadcrumb bar and the assistant's page context, which need the same
 * answer to "where is the operator" and must not drift apart. Duplicate consecutive crumbs
 * are skipped: a parent route and its empty-path child commonly carry the same label for the
 * same URL, which renders as "Orders › Orders" and trips NG0955 on the track expression.</p>
 */
export function buildBreadcrumbTrail(
  route: ActivatedRoute,
  url = '',
  crumbs: Breadcrumb[] = [],
): Breadcrumb[] {
  const children = route.children;
  if (children.length === 0) return crumbs;

  for (const child of children) {
    const snapshot = child.snapshot;
    if (!snapshot) return crumbs;

    const routeUrl = (snapshot.url ?? []).map((s) => s.path).join('/');
    if (routeUrl) url += `/${routeUrl}`;

    const label = snapshot.data?.['breadcrumb'];
    if (label) {
      const previous = crumbs[crumbs.length - 1];
      if (!previous || previous.route !== url || previous.label !== label) {
        crumbs.push({ label, route: url });
      }
    }
    return buildBreadcrumbTrail(child, url, crumbs);
  }

  return crumbs;
}
