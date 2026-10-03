import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, filter, firstValueFrom, map } from 'rxjs';

import type { StrategyDto, UpdateStrategyRequest } from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';
import { failureMessage } from '../../util/api-failure';
import { MarketDataService } from '@core/services/market-data.service';
import { AssistantDockService } from '@core/assistant/assistant-dock.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { UiCommandService } from '@core/assistant/ui-command.service';
import { pineAssistCommands, pineEditorFacts } from '@shared/pine-assist/pine-assist';
import { createStrategyPineAdapter } from '../../pine-assist/strategy-pine-adapter';

/**
 * Full-page strategy editor (/strategies/:id/edit): the same form as the detail page's Edit
 * dialog, laid out at full width so the Pine editor, its inputs and the preview chart each get
 * room to work. Save, Cancel and Clone return to the strategy's detail page.
 */
@Component({
  selector: 'app-strategy-edit-page',
  standalone: true,
  imports: [PageHeaderComponent, StrategyFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        [title]="'Edit — ' + (strategy()?.name ?? '#' + strategyId())"
        [subtitle]="subtitle()"
      >
        <button type="button" class="btn-ghost" (click)="backToDetail()">← Detail</button>
      </app-page-header>

      @if (loadError()) {
        <p class="muted">The strategy could not be loaded.</p>
      } @else if (!strategy()) {
        <p class="muted">Loading…</p>
      } @else {
        <app-strategy-form
          layout="page"
          [open]="true"
          [strategy]="strategy()"
          [saving]="saving()"
          [submitError]="submitError()"
          (submitted)="onUpdate($event)"
          (cancelled)="backToDetail()"
          (strategyChanged)="load()"
          (executionRequested)="backToDetail('execution')"
        />
      }
    </div>
  `,
})
export class StrategyEditPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  readonly strategyId = signal(0);
  readonly strategy = signal<StrategyDto | null>(null);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly submitError = signal<string | null>(null);

  private readonly marketData = inject(MarketDataService);
  private readonly dock = inject(AssistantDockService);
  private readonly uiCommands = inject(UiCommandService);
  private readonly pageContext = inject(PageContextService);
  private readonly form = viewChild(StrategyFormComponent);

  /** The Pine editor as the assistant drives it (pine.* / strategy.* page commands). */
  readonly pineAdapter = createStrategyPineAdapter({
    strategy: () => this.strategy(),
    panel: () => this.form()?.scriptPanel(),
    showScript: () => this.form()?.activeTab.set('inputs'),
    save: (reason) =>
      this.form()?.saveScriptForAssistant(reason) ??
      Promise.resolve({ ok: false, message: 'The strategy form is not open.' }),
    readBuffer: async (name) => {
      const sessionId = this.dock.conversationId();
      if (sessionId == null) return null;
      return firstValueFrom(this.marketData.getAssistantBuffer(sessionId, name));
    },
  });
  /** Withdraws the registered commands; null while none are registered. */
  private unregisterCommands: (() => void) | null = null;

  constructor() {
    // The commands exist only while a Pine strategy's script editor is on the page.
    effect(() => {
      const f = this.form();
      const active = !!f?.scriptPanel() && f.isScriptAuthoring();
      untracked(() => {
        if (active && !this.unregisterCommands) this.registerPineCommands();
        else if (!active && this.unregisterCommands) this.withdrawPineCommands();
      });
    });
    this.destroyRef.onDestroy(() => this.withdrawPineCommands());

    // Read at send time, so the facts are always current.
    this.pageContext.publish(() => {
      const s = this.strategy();
      const f = this.form();
      const editing = !!this.unregisterCommands && !!f?.scriptPanel();
      return {
        headline: s
          ? `Editing strategy #${s.id} "${s.name}" (${s.symbol} ${s.timeframe}, ${s.strategyType})`
          : 'Loading a strategy for editing',
        ...(s ? { record: { kind: 'strategy', id: s.id, label: s.name ?? undefined } } : {}),
        ...(editing ? { filters: { ...pineEditorFacts(this.pineAdapter) } } : {}),
      };
    });
  }

  private registerPineCommands(): void {
    let withdraw: (() => void) | null = null;
    // A scoped DestroyRef: the registration ends when the editor goes away, not only with the page.
    const scope = {
      destroyed: false,
      onDestroy: (cb: () => void) => {
        withdraw = cb;
        return () => (withdraw = null);
      },
    } as unknown as DestroyRef;
    this.uiCommands.register(pineAssistCommands(this.pineAdapter), scope);
    this.unregisterCommands = () => withdraw?.();
  }

  private withdrawPineCommands(): void {
    const fn = this.unregisterCommands;
    this.unregisterCommands = null;
    fn?.();
  }

  subtitle(): string {
    const s = this.strategy();
    return s ? `${s.symbol} · ${s.timeframe} · ${s.strategyType}` : '';
  }

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        map((p) => Number(p.get('id'))),
        filter((id) => Number.isFinite(id) && id > 0),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        this.strategyId.set(id);
        this.strategy.set(null);
        this.loadError.set(false);
        this.load();
      });
  }

  load(): void {
    this.strategiesService.getById(this.strategyId()).subscribe({
      next: (res) => (res?.data ? this.strategy.set(res.data) : this.loadError.set(true)),
      error: () => this.loadError.set(true),
    });
  }

  /** Same contract as the detail page's dialog: a refusal keeps the form open with the reason. */
  onUpdate(data: unknown): void {
    this.saving.set(true);
    this.submitError.set(null);
    this.strategiesService
      .update(this.strategyId(), data as UpdateStrategyRequest, { silent: true })
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          if (!res?.status) {
            this.submitError.set(failureMessage(res, 'The engine did not apply the update.'));
            return;
          }
          this.notifications.success('Strategy updated');
          this.backToDetail();
        },
        error: (err) => {
          this.saving.set(false);
          this.submitError.set(failureMessage(err, 'The update failed.'));
        },
      });
  }

  backToDetail(tab?: string): void {
    if (this.saving()) return;
    this.router.navigate(['/strategies', this.strategyId()], {
      queryParams: tab ? { tab } : {},
    });
  }
}
