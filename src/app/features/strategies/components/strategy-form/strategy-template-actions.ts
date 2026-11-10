import { signal } from '@angular/core';
import type { FormGroup } from '@angular/forms';

import type { CreateStrategyTemplateRequest, StrategyTemplateDto } from '@core/api/api.types';
import type { NotificationService } from '@core/notifications/notification.service';
import type { StrategiesService } from '@core/services/strategies.service';
import { failureMessage } from '../../util/api-failure';

/**
 * Strategy types authored as Pine v6 scripts. Their Parameters JSON used to hold the retired JSON
 * rules DSL: a saved row without a script is legacy and never runs.
 */
export const PINE_STRATEGY_TYPES: readonly string[] = ['RuleBased', 'LlmProposal'];

/** Templates that can still seed a strategy — never a legacy JSON-rules (Pine type) one. */
export function loadableTemplates(list: StrategyTemplateDto[] | null | undefined): StrategyTemplateDto[] {
  return (list ?? []).filter((t) => !PINE_STRATEGY_TYPES.includes(t.strategyType));
}

/** What the strategy form's templates read and drive. */
export interface StrategyTemplateActionsDeps {
  strategiesService: Pick<StrategiesService, 'listTemplates' | 'createTemplate'>;
  notifications: Pick<NotificationService, 'success'>;
  /** The strategy form (created in its ngOnInit — read when used). */
  form: () => FormGroup;
}

/**
 * b10-ui — the strategy form's templates: "Load from template" (create mode; the templates that can still seed a
 * strategy) and "Save as template…" (the inline name panel and the engine's verdict). Moved out of
 * StrategyFormComponent behaviour for behaviour; the form's template reads it as `templates`.
 */
export class StrategyTemplateActions {
  constructor(private readonly deps: StrategyTemplateActionsDeps) {}

  savingTemplate = signal(false);
  /** Name being typed for "Save as template…"; null while that panel is closed. */
  templateNameDraft = signal<string | null>(null);
  templateError = signal<string | null>(null);
  availableTemplates = signal<StrategyTemplateDto[]>([]);
  selectedTemplateId = signal<number | null>(null);

  /**
   * Lazy-load the template chooser the first time the modal mounts. Volume is operator-curated (typically <50
   * templates) so a single fetch is fine.
   */
  load(): void {
    this.deps.strategiesService.listTemplates().subscribe({
      next: (res) => this.availableTemplates.set(loadableTemplates(res?.data)),
      error: () => this.availableTemplates.set([]),
    });
  }

  /** The form was pointed at another strategy (or reset): the save panel closes. */
  closeSavePanel(): void {
    this.templateNameDraft.set(null);
    this.templateError.set(null);
  }

  /**
   * Hydrate the form from a template — does NOT touch Symbol or Name (those are
   * always strategy-specific). Operators usually load a template, then tweak the
   * symbol + give the new strategy a fresh name. Pre-filling those would be wrong.
   */
  onTemplateSelect(rawId: string): void {
    if (!rawId) {
      this.selectedTemplateId.set(null);
      return;
    }
    const id = Number(rawId);
    if (!Number.isFinite(id)) return;
    const t = this.availableTemplates().find((x) => x.id === id);
    if (!t) return;
    this.selectedTemplateId.set(id);
    const form = this.deps.form();
    form.patchValue({
      strategyType: t.strategyType,
      parametersJson: t.parametersJson ?? '',
      riskProfileId: t.riskProfileId,
      riskOverridesJson: t.riskOverridesJson ?? '',
      sizingConfigJson: t.sizingConfigJson ?? '',
      sessionFilterJson: t.sessionFilterJson ?? '',
      regimeGateJson: t.regimeGateJson ?? '',
      multiTimeframeGateJson: t.multiTimeframeGateJson ?? '',
      description: t.description ?? form.get('description')?.value,
    });
    this.deps.notifications.success(`Loaded template: ${t.name}`);
  }

  /**
   * Opens the inline "Save as template" panel, pre-filled with the strategy
   * name + " template" (so "EURUSD MA Cross" proposes "EURUSD MA Cross
   * template"). The engine's verdict — e.g. a name clash — shows in the panel.
   */
  saveAsTemplate(): void {
    const form = this.deps.form();
    if (form.invalid) return;
    const baseName = (form.value.name as string)?.trim() || 'Untitled';
    this.templateError.set(null);
    this.templateNameDraft.set(`${baseName} template`);
  }

  cancelSaveTemplate(): void {
    if (this.savingTemplate()) return;
    this.templateNameDraft.set(null);
    this.templateError.set(null);
  }

  confirmSaveTemplate(): void {
    const name = this.templateNameDraft()?.trim();
    if (!name || this.savingTemplate()) return;
    const val = this.deps.form().getRawValue();
    const data: CreateStrategyTemplateRequest = {
      name,
      description: val.description || null,
      strategyType: val.strategyType,
      parametersJson: val.parametersJson || '{}',
      riskProfileId: val.riskProfileId || null,
      riskOverridesJson: val.riskOverridesJson || null,
      sizingConfigJson: val.sizingConfigJson || null,
      sessionFilterJson: val.sessionFilterJson || null,
      regimeGateJson: val.regimeGateJson || null,
      multiTimeframeGateJson: val.multiTimeframeGateJson || null,
    };

    this.savingTemplate.set(true);
    this.templateError.set(null);
    this.deps.strategiesService.createTemplate(data, { silent: true }).subscribe({
      next: (res) => {
        this.savingTemplate.set(false);
        if (res?.status) {
          this.deps.notifications.success(`Template '${name}' saved`);
          this.templateNameDraft.set(null);
          // Refresh dropdown so the new template appears immediately.
          this.deps.strategiesService.listTemplates().subscribe({
            next: (list) => this.availableTemplates.set(loadableTemplates(list?.data)),
          });
        } else {
          this.templateError.set(failureMessage(res, 'The engine did not save the template.'));
        }
      },
      error: (err) => {
        this.savingTemplate.set(false);
        this.templateError.set(failureMessage(err, 'Saving the template failed.'));
      },
    });
  }
}
