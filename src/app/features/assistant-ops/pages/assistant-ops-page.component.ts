import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';

import { AssistantHealthPanelComponent } from '../components/assistant-health-panel.component';
import { AssistantLessonsPanelComponent } from '../components/assistant-lessons-panel.component';

type Tab = 'health' | 'lessons';

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
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Assistant"
        subtitle="How the admin assistant is answering, and the lessons it may be given"
      />
      <ui-tabs [tabs]="tabs" [activeTab]="tab()" (tabChange)="select($event)">
        @switch (tab()) {
          @case ('lessons') {
            <app-assistant-lessons-panel />
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
    { label: 'Lessons', value: 'lessons' },
  ];

  readonly tab = signal<Tab>(
    this.route.snapshot.queryParamMap.get('tab') === 'lessons' ? 'lessons' : 'health',
  );

  select(value: string): void {
    const next: Tab = value === 'lessons' ? 'lessons' : 'health';
    if (next === this.tab()) return;
    this.tab.set(next);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: next === 'health' ? null : next },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
