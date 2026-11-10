import { describe, expect, it, vi } from 'vitest';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { of, throwError } from 'rxjs';

import { StrategyTemplateActions, loadableTemplates } from './strategy-template-actions';

// b10-ui: the strategy form's "Load from template" / "Save as template…" (StrategyTemplateActions), run against a
// form of the strategy form's shape and stubbed services.

function form(name = 'EURUSD MA Cross') {
  return new FormGroup({
    name: new FormControl(name, Validators.required),
    symbol: new FormControl('EURUSD'),
    strategyType: new FormControl('CompositeML'),
    parametersJson: new FormControl(''),
    riskProfileId: new FormControl<number | null>(null),
    description: new FormControl('mine'),
    riskOverridesJson: new FormControl(''),
    sizingConfigJson: new FormControl('{"mode":"FixedLot","value":0.1}'),
    sessionFilterJson: new FormControl(''),
    regimeGateJson: new FormControl(''),
    multiTimeframeGateJson: new FormControl(''),
  });
}

const TEMPLATES = [
  { id: 1, name: 'legacy', strategyType: 'RuleBased' },
  { id: 2, name: 'ml', strategyType: 'CompositeML', parametersJson: '{"period":14}', riskProfileId: 3, description: null },
];

function setup(f = form()) {
  const svc = {
    listTemplates: vi.fn(() => of({ status: true, data: TEMPLATES })),
    createTemplate: vi.fn(() => of({ status: true, data: 9 })),
  };
  const notifications = { success: vi.fn() };
  const t = new StrategyTemplateActions({
    strategiesService: svc as never,
    notifications,
    form: () => f,
  });
  return { t, svc, notifications, f };
}

describe('strategy form — templates', () => {
  it('never offers a legacy JSON-rules (Pine type) template', () => {
    const { t } = setup();
    t.load();
    expect(t.availableTemplates().map((x) => x.id)).toEqual([2]);
    expect(loadableTemplates(null)).toEqual([]);
  });

  it('loading a template fills the settings but never the symbol or the name', () => {
    const { t, f, notifications } = setup();
    t.load();
    t.onTemplateSelect('2');
    expect(t.selectedTemplateId()).toBe(2);
    expect(f.value).toMatchObject({
      name: 'EURUSD MA Cross',
      symbol: 'EURUSD',
      parametersJson: '{"period":14}',
      riskProfileId: 3,
      sizingConfigJson: '',
      description: 'mine', // the template has none: the form's stays
    });
    expect(notifications.success).toHaveBeenCalledWith('Loaded template: ml');
    t.onTemplateSelect('');
    expect(t.selectedTemplateId()).toBeNull();
  });

  it('"Save as template…" proposes the name, saves the form, refreshes the list and closes', () => {
    const { t, svc } = setup();
    t.saveAsTemplate();
    expect(t.templateNameDraft()).toBe('EURUSD MA Cross template');
    t.confirmSaveTemplate();
    expect(svc.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'EURUSD MA Cross template',
        strategyType: 'CompositeML',
        parametersJson: '{}',
        sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
        riskOverridesJson: null,
      }),
      { silent: true },
    );
    expect(t.templateNameDraft()).toBeNull();
    expect(svc.listTemplates).toHaveBeenCalledTimes(1);
  });

  it('the engine’s refusal stays in the panel; an invalid form opens nothing', () => {
    const { t, svc } = setup();
    svc.createTemplate.mockReturnValue(of({ status: false, message: 'A template with that name exists' }) as never);
    t.saveAsTemplate();
    t.confirmSaveTemplate();
    expect(t.templateNameDraft()).toBe('EURUSD MA Cross template');
    expect(t.templateError()).toBeTruthy();
    expect(t.savingTemplate()).toBe(false);

    svc.createTemplate.mockReturnValue(throwError(() => new Error('down')) as never);
    t.confirmSaveTemplate();
    expect(t.templateError()).toBeTruthy();
    t.cancelSaveTemplate();
    expect(t.templateNameDraft()).toBeNull();

    const blank = setup(form(''));
    blank.t.saveAsTemplate();
    expect(blank.t.templateNameDraft()).toBeNull();
  });
});
