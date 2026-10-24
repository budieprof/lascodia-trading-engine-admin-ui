import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SecurityApiService } from '../security-api.service';
import { COMPONENT_LABELS, filterReleases } from '../security.logic';
import type { ReleaseComponent, ReleaseNote } from '../security.types';

/**
 * Release notes of the engine, console, Expert Advisor and CME feed (`releases.read`), generated from each release's
 * commits and published by platform staff (engine `tools/release-notes/`). Newest first; security and breaking changes
 * are flagged.
 */
@Component({
  selector: 'app-release-notes-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Release notes"
        subtitle="What changed in each release of the platform."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="notes.reload()"
          [disabled]="notes.loading()"
        >
          {{ notes.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <div class="row">
        <label class="field">
          <span class="label">Component</span>
          <select
            class="select"
            name="component"
            [ngModel]="component()"
            (ngModelChange)="component.set($event)"
          >
            <option [ngValue]="null">All</option>
            @for (c of components; track c) {
              <option [ngValue]="c">{{ labels[c] }}</option>
            }
          </select>
        </label>
      </div>

      @if (notes.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (notes.loaded() && shown().length === 0) {
        <p class="pad muted">No release notes published yet.</p>
      }

      @for (n of shown(); track n.id) {
        <section class="card">
          <header class="card-head">
            <h3>{{ labels[n.component] }} {{ n.version }}</h3>
            @if (n.hasSecurityFixes) {
              <span class="chip bad">security</span>
            }
            @if (n.hasBreakingChanges) {
              <span class="chip warn">breaking changes</span>
            }
            <span class="spacer"></span>
            <span class="small muted">{{ when(n.releasedAtUtc) }}</span>
          </header>
          <div class="card-body">
            <p class="small">
              {{ n.summary }}
              <span class="muted"
                >· {{ n.commitCount }} commit{{ n.commitCount === 1 ? '' : 's' }} ·
                <code>{{ n.fromRef || 'start' }}..{{ n.toRef }}</code></span
              >
            </p>
            @for (s of n.sections; track s.kind) {
              <h4 class="small">{{ s.title }}</h4>
              <ul class="small">
                @for (i of s.items; track $index) {
                  <li>
                    @if (i.scope) {
                      <strong>{{ i.scope }}:</strong>
                    }
                    {{ i.subject }}
                    @if (i.breaking) {
                      <span class="chip warn">breaking</span>
                    }
                    @if (i.sha) {
                      <code class="muted">{{ i.sha }}</code>
                    }
                  </li>
                }
              </ul>
            }
          </div>
        </section>
      }
    </div>
  `,
})
export class ReleaseNotesPageComponent {
  private readonly api = inject(SecurityApiService);

  protected readonly when = when;
  protected readonly labels = COMPONENT_LABELS;
  protected readonly components = Object.keys(COMPONENT_LABELS) as ReleaseComponent[];

  readonly component = signal<ReleaseComponent | null>(null);
  readonly notes = iamResource<ReleaseNote[]>(
    () => this.api.releaseNotes(null, 100),
    [],
    'Could not load the release notes.',
  );
  readonly shown = computed(() => filterReleases(this.notes.value(), this.component()));

  constructor() {
    this.notes.reload();
  }
}
