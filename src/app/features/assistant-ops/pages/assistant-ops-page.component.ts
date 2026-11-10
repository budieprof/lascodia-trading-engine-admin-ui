import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';

import { AssistantHealthPanelComponent } from '../components/assistant-health-panel.component';
import { AssistantLessonsPanelComponent } from '../components/assistant-lessons-panel.component';
import { AssistantEvalsPanelComponent } from '../components/assistant-evals-panel.component';
import { AssistantQualityPanelComponent } from '../components/assistant-quality-panel.component';

type Tab = 'health' | 'evals' | 'quality' | 'lessons';
const TABS: readonly Tab[] = ['health', 'evals', 'quality', 'lessons'];

function tabOf(v: string | null): Tab {
  return (TABS as readonly string[]).includes(v ?? '') ? (v as Tab) : 'health';
}

/**
 * `/assistant` — how the admin assistant is doing (Health) and what it has learned (Lessons).
 * The tab is kept in `?tab=` so a link can open the review queue directly.
 */
@Component({
  selector: 'app-assistant-ops-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    TabsComponent,
    AssistantHealthPanelComponent,
    AssistantLessonsPanelComponent,
    AssistantEvalsPanelComponent,
    AssistantQualityPanelComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Assistant"
        subtitle="How the admin assistant is answering, how it scores on tests, and the lessons it may be given"
      />
      <ui-tabs [tabs]="tabs" [activeTab]="tab()" (tabChange)="select($event)">
        @switch (tab()) {
          @case ('lessons') {
            <app-assistant-lessons-panel />
          }
          @case ('evals') {
            <app-assistant-evals-panel [initialRun]="initialRun()" />
          }
          @case ('quality') {
            <app-assistant-quality-panel />
          }
          @default {
            <app-assistant-health-panel />
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
    `,
  ],
})
export class AssistantOpsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs: TabItem[] = [
    { label: 'Health', value: 'health' },
    { label: 'Evals', value: 'evals' },
    { label: 'Quality', value: 'quality' },
    { label: 'Lessons', value: 'lessons' },
  ];

  readonly tab = signal<Tab>(tabOf(this.route.snapshot.queryParamMap.get('tab')));
  /** `?run=<id>` (a lesson's "run #n" link) opens that eval run on the Evals tab. */
  protected readonly initialRun = signal<number | null>(
    Number(this.route.snapshot.queryParamMap.get('run')) || null,
  );

  constructor() {
    // In-page links (a lesson's "run #n") change the query without re-creating the page.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((q) => {
      this.tab.set(tabOf(q.get('tab')));
      this.initialRun.set(Number(q.get('run')) || null);
    });
  }

  select(value: string): void {
    const next = tabOf(value);
    if (next === this.tab()) return;
    this.tab.set(next);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: next === 'health' ? null : next, run: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
