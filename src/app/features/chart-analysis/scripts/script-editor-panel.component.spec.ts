import { afterEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { of } from 'rxjs';

import { ChartScriptService } from './chart-script.service';
import { ScriptEditorPanelComponent } from './script-editor-panel.component';

// What a new editor panel starts from. The page mounts the panel only while the editor is the
// dock's front tab, so every open is a new panel: once the page has nothing to load into it (the
// script it showed was removed), it must come up on the starter template. Signal inputs are swapped
// for writable ones before the first render (JIT harness — see the inputs-form spec); the panel's
// children, whose signal inputs JIT cannot bind, are stood in for by decorator-input stubs.

@Component({ selector: 'app-pine-editor', template: '' })
class PineEditorStubComponent {
  @Input() value = '';
  @Input() diagnostics: unknown = [];
  @Input() height = '';
  @Output() valueChange = new EventEmitter<string>();
  @Output() saveRequested = new EventEmitter<void>();
}

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

describe('ScriptEditorPanelComponent — what a new panel starts from', () => {
  let fixture: ComponentFixture<ScriptEditorPanelComponent>;
  afterEach(() => fixture?.destroy());

  function render(
    initialSource: string | null,
    externalSource: { text: string; seq: number } | null = null,
  ) {
    TestBed.configureTestingModule({
      imports: [ScriptEditorPanelComponent],
      providers: [{ provide: ChartScriptService, useValue: { compile: () => of(null) } }],
    });
    TestBed.overrideComponent(ScriptEditorPanelComponent, {
      set: { imports: [PineEditorStubComponent, ChartIconStubComponent] },
    });
    fixture = TestBed.createComponent(ScriptEditorPanelComponent);
    const cmp = fixture.componentInstance as any;
    cmp.initialSource = signal(initialSource);
    cmp.initialName = signal(initialSource === null ? null : 'Smart Algo v2');
    cmp.externalSource = signal(externalSource);
    const emitted: string[] = [];
    cmp.sourceChange.subscribe((t: string) => emitted.push(t));
    fixture.detectChanges();
    return { cmp, emitted, host: fixture.nativeElement as HTMLElement };
  }

  it('with nothing to load — the editor was cleared — the starter template, as a new script', () => {
    const { cmp, emitted, host } = render(null);
    expect(cmp.source()).toContain('indicator("My script"');
    expect(emitted.at(-1)).toContain('indicator("My script"');
    expect((host.querySelector('.editor__name') as HTMLInputElement).value).toBe('My script');
  });

  it('with a script on the chart, its source', () => {
    const { cmp, host } = render('//@version=6\nindicator("v2")');
    expect(cmp.source()).toBe('//@version=6\nindicator("v2")');
    expect((host.querySelector('.editor__name') as HTMLInputElement).value).toBe('Smart Algo v2');
  });

  it('text the assistant wrote replaces the buffer', () => {
    const { cmp } = render(null, { text: '// written by the assistant', seq: 4 });
    expect(cmp.source()).toBe('// written by the assistant');
  });
});
