import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DocsContentService } from '../docs-content.service';
import { accessText, filterReference, shortPath, type ApiReferenceFilter } from '../api-reference.logic';
import type { ApiReference } from '../api-reference.types';

/**
 * The engine's API reference (`/docs/api`): every endpoint with its method, path, summary, who may call
 * it (permission key, no sign-in, or own session), its rate-limit policy, parameters, body and answer
 * types. Generated from the engine's OpenAPI document by the engine's ApiReferenceDocumentTests and
 * shipped with the console release — it describes the engine build it was copied from.
 */
@Component({
  selector: 'app-api-reference-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .method {
        display: inline-block;
        min-width: 52px;
        font-family: var(--font-mono, monospace);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .GET {
        color: #2e7d32;
      }
      .POST {
        color: #1565c0;
      }
      .PUT,
      .PATCH {
        color: #b26a00;
      }
      .DELETE {
        color: #c62828;
      }
      .group-title {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      code.path {
        word-break: break-all;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: center;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="API reference"
        [subtitle]="subtitle()"
      >
        <a class="btn btn-secondary" routerLink="/docs/api-overview">API overview</a>
        <a class="btn btn-secondary" routerLink="/docs">All guides</a>
      </app-page-header>

      <section class="card">
        <header class="card-head filters">
          <input
            class="input search"
            type="search"
            aria-label="Search endpoints"
            placeholder="Search path, summary, permission (e.g. machine enrollments)"
            [ngModel]="filter().text"
            (ngModelChange)="patch({ text: $event })"
          />
          <select
            class="select"
            aria-label="Who may call it"
            [ngModel]="filter().access"
            (ngModelChange)="patch({ access: $event })"
          >
            <option value="all">Everyone and every permission</option>
            <option value="anonymous">No sign-in</option>
            <option value="session">Own session only</option>
            <option value="permission">Needs a permission</option>
          </select>
          <span class="muted small">{{ shown() }} of {{ reference()?.endpointCount ?? 0 }} endpoints</span>
        </header>
        @if (error(); as e) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ e }}</p>
        } @else if (!reference()) {
          <p class="pad muted">Loading…</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Who may call it</th>
                  <th>Parameters</th>
                  <th>Body → answer</th>
                </tr>
              </thead>
              <tbody>
                @for (g of groups(); track g.name) {
                  <tr>
                    <td colspan="4" class="group-title">{{ g.name }}</td>
                  </tr>
                  @for (e of g.endpoints; track e.method + e.path) {
                    <tr>
                      <td>
                        <span class="method" [class]="e.method">{{ e.method }}</span>
                        <code class="path">{{ short(e.path) }}</code>
                        @if (e.summary) {
                          <span class="sub">{{ e.summary }}</span>
                        }
                      </td>
                      <td class="small">
                        @if (e.access === 'permission') {
                          <code>{{ e.permission }}</code>
                        } @else {
                          {{ access(e) }}
                        }
                        @if (e.rateLimit) {
                          <span class="sub">rate limit: {{ e.rateLimit }}</span>
                        }
                      </td>
                      <td class="small">
                        @for (p of e.parameters; track p.in + p.name) {
                          <div>
                            <code>{{ p.name }}</code> <span class="muted">{{ p.in }}{{ p.required ? ', required' : '' }}{{ p.type ? ' · ' + p.type : '' }}</span>
                          </div>
                        }
                      </td>
                      <td class="small">
                        @if (e.body) {
                          <code>{{ e.body }}</code> →
                        }
                        <code>{{ e.response ?? '—' }}</code>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
})
export class ApiReferencePageComponent {
  private readonly content = inject(DocsContentService);

  readonly reference = signal<ApiReference | null>(null);
  readonly error = signal<string | null>(null);
  readonly filter = signal<ApiReferenceFilter>({ text: '', access: 'all' });
  readonly groups = computed(() => filterReference(this.reference(), this.filter()));
  readonly shown = computed(() => this.groups().reduce((n, g) => n + g.endpoints.length, 0));
  readonly subtitle = computed(() => {
    const r = this.reference();
    return r
      ? `${r.title} ${r.version} — base path ${r.basePath}. Generated from the engine's OpenAPI document.`
      : 'Generated from the engine\'s OpenAPI document.';
  });

  constructor() {
    this.content.apiReference().subscribe({
      next: (r) => this.reference.set(r),
      error: () => this.error.set('The API reference is not part of this console release (npm run docs:api).'),
    });
  }

  patch(p: Partial<ApiReferenceFilter>): void {
    this.filter.update((f) => ({ ...f, ...p }));
  }

  short(path: string): string {
    return shortPath(path, this.reference()?.basePath ?? '');
  }

  access = accessText;
}
