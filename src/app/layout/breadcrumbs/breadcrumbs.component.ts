import { Component, inject } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';

interface Breadcrumb {
  label: string;
  route: string;
}

@Component({
  selector: 'app-breadcrumbs',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (breadcrumbs() && breadcrumbs()!.length > 0) {
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <ol class="crumb-list">
          @for (crumb of breadcrumbs(); track $index; let last = $last) {
            <li class="crumb-item">
              @if (last) {
                <span class="crumb current" aria-current="page">{{ crumb.label }}</span>
              } @else {
                <a [routerLink]="crumb.route" class="crumb link">{{ crumb.label }}</a>
                <span class="separator" aria-hidden="true">›</span>
              }
            </li>
          }
        </ol>
      </nav>
    }
  `,
  styles: [
    `
      .breadcrumbs {
        margin-bottom: var(--space-4);
        font-size: var(--text-sm);
      }
      .crumb-list {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .crumb-item {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .crumb.link {
        color: var(--text-secondary);
        text-decoration: none;
        transition: color 0.15s ease;
      }

      .crumb.link:hover {
        color: var(--accent);
      }
      .crumb.link:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
        border-radius: 2px;
      }

      .crumb.current {
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }

      .separator {
        color: var(--text-tertiary);
        font-size: 12px;
      }
    `,
  ],
})
export class BreadcrumbsComponent {
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  breadcrumbs = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => this.buildBreadcrumbs(this.route.root)),
    ),
  );

  private buildBreadcrumbs(
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
      if (routeUrl) {
        url += `/${routeUrl}`;
      }
      const label = snapshot.data?.['breadcrumb'];
      if (label) {
        // Skip duplicate crumbs — parent route + empty-path child can both
        // carry the same breadcrumb label for the same URL (e.g. app.routes
        // declares `breadcrumb: 'Orders'` on the lazy feature, and the
        // feature's `path: ''` does the same). Without this the user sees
        // "Orders › Orders" and Angular logs NG0955 on the track expression.
        const previous = crumbs[crumbs.length - 1];
        if (!previous || previous.route !== url || previous.label !== label) {
          crumbs.push({ label, route: url });
        }
      }
      return this.buildBreadcrumbs(child, url, crumbs);
    }

    return crumbs;
  }
}
