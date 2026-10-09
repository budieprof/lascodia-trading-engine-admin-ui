import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ScriptDialogService, confirmDiscard } from './script-dialog.service';

// The dialog is created on demand and attached to <body>, so specs drive it through the DOM like
// the operator does: buttons, the text field, Escape.

function dialogEl(): HTMLDialogElement | null {
  return document.body.querySelector('dialog.scd');
}

function button(label: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll<HTMLButtonElement>('dialog.scd button')].find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b) throw new Error(`No button "${label}"`);
  return b;
}

describe('ScriptDialogService — questions from anywhere', () => {
  let service: ScriptDialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ScriptDialogService);
  });
  afterEach(() => {
    for (const d of document.body.querySelectorAll('app-script-choice-dialog')) d.remove();
  });

  it('shows the question and resolves with the choice clicked, then goes away', async () => {
    const answer = service.ask({
      title: 'Overwrite?',
      message: 'A script called EMA exists.',
      details: ['Saved 2 min ago'],
      choices: [
        { id: 'overwrite', label: 'Overwrite', tone: 'danger' },
        { id: 'copy', label: 'Save a copy' },
      ],
    });
    expect(service.isOpen).toBe(true);
    expect(dialogEl()?.textContent).toContain('A script called EMA exists.');
    expect(dialogEl()?.textContent).toContain('Saved 2 min ago');
    button('Save a copy').click();
    expect(await answer).toEqual({ choice: 'copy', text: '' });
    expect(service.isOpen).toBe(false);
    expect(dialogEl()).toBeNull();
  });

  it('Cancel and Escape answer null', async () => {
    const a = service.ask({ title: 't', message: 'm', choices: [{ id: 'x', label: 'X' }] });
    button('Cancel').click();
    expect((await a).choice).toBeNull();

    const b = service.ask({ title: 't', message: 'm', choices: [{ id: 'x', label: 'X' }] });
    dialogEl()!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect((await b).choice).toBeNull();
  });

  it('a choice that needs the text field waits for it and returns what was typed', async () => {
    const a = service.ask({
      title: 'Save as',
      message: 'Name the copy.',
      field: { label: 'Name', value: '' },
      choices: [{ id: 'save', label: 'Save', needsText: true }],
    });
    expect(button('Save').disabled).toBe(true);
    const input = document.body.querySelector<HTMLInputElement>('dialog.scd input')!;
    input.value = 'EMA (copy)';
    input.dispatchEvent(new Event('input'));
    TestBed.inject(ApplicationRef).tick();
    expect(button('Save').disabled).toBe(false);
    button('Save').click();
    expect(await a).toEqual({ choice: 'save', text: 'EMA (copy)' });
  });

  it('confirm() and confirmDiscard() are yes / no', async () => {
    const yes = service.confirm({ title: 't', message: 'm', confirmLabel: 'Do it' });
    button('Do it').click();
    expect(await yes).toBe(true);

    const keep = confirmDiscard(service, 'The script has unsaved changes');
    expect(dialogEl()?.textContent).toContain('The script has unsaved changes. Leaving now');
    button('Keep editing').click();
    expect(await keep).toBe(false);
  });
});
