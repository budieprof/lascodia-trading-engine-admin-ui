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
      <nav class="breadcrumbs">
        @for (crumb of breadcrumbs(); track crumb.route; let last = $last) {
          @if (last) {
            <span class="crumb current">{{ crumb.label }}</span>
          } @else {
            <a [routerLink]="crumb.route" class="crumb link">{{ crumb.label }}</a>
            <span class="separator">›</span>
          }
        }
      </nav>
    }
  `,
  styles: [`
    .breadcrumbs {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
      font-size: var(--text-sm);
    }

    .crumb.link {
      color: var(--text-secondary);
      text-decoration: none;
      transition: color 0.15s ease;
    }

    .crumb.link:hover {
      color: var(--accent);
    }

    .crumb.current {
      color: var(--text-primary);
      font-weight: var(--font-medium);
    }

    .separator {
      color: var(--text-tertiary);
      font-size: 12px;
    }
  `],
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

  private buildBreadcrumbs(route: ActivatedRoute, url = '', crumbs: Breadcrumb[] = []): Breadcrumb[] {
    const children = route.children;
    if (children.length === 0) return crumbs;

    for (const child of children) {
      const routeUrl = child.snapshot.url.map((s) => s.path).join('/');
      if (routeUrl) {
        url += `/${routeUrl}`;
      }
      const label = child.snapshot.data['breadcrumb'];
      if (label) {
        crumbs.push({ label, route: url });
      }
      return this.buildBreadcrumbs(child, url, crumbs);
    }

    return crumbs;
  }
}
