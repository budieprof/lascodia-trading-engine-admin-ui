import { Input, Output, type Type } from '@angular/core';

/**
 * Component specs run under Angular's JIT compiler without the CLI's transform that turns `input()` /
 * `output()` fields into metadata (see vitest.components.config.mts), so `setInput()` cannot reach a
 * signal input. This applies the metadata the transform would emit — `@Input({ isSignal: true })` and
 * `@Output()` — once per class, before the first `TestBed.createComponent`.
 */
const done = new WeakMap<object, Set<string>>();

export function declareSignalIo(type: Type<unknown>, io: { inputs?: readonly string[]; outputs?: readonly string[] }): void {
  const proto = type.prototype as object;
  const seen = done.get(proto) ?? new Set<string>();
  done.set(proto, seen);
  for (const name of io.inputs ?? []) {
    if (seen.has(`i:${name}`)) continue;
    seen.add(`i:${name}`);
    (Input as unknown as (o: object) => PropertyDecorator)({ isSignal: true, alias: name, required: false })(proto, name);
  }
  for (const name of io.outputs ?? []) {
    if (seen.has(`o:${name}`)) continue;
    seen.add(`o:${name}`);
    (Output as unknown as (alias?: string) => PropertyDecorator)(name)(proto, name);
  }
}
