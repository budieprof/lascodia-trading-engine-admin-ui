import { Component, inject } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { buildBreadcrumbTrail } from '@core/routing/breadcrumb-trail';
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
      map(() => buildBreadcrumbTrail(this.route.root)),
    ),
  );
}
