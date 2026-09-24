import { Input, Output, type Type } from '@angular/core';

/**
 * Component specs run under Angular's JIT compiler without the Angular CLI's JIT transform
 * (see `vitest.components.config.mts`). That transform is what turns `input()` / `output()` class
 * fields into metadata the JIT compiler can see; without it `setInput()` and host-template
 * bindings cannot reach a signal input (the NG0950 / NG0303 failures the other specs skip over).
 *
 * This applies the same metadata the transform would emit — `@Input({ isSignal: true })` and
 * `@Output()` — so a spec can drive signal inputs for real. Call it at module scope, before the
 * first `TestBed.createComponent` compiles the class.
 */
const declared = new WeakMap<object, Set<string>>();

export function declareSignalIo(
  type: Type<unknown>,
  io: { inputs?: readonly string[]; outputs?: readonly string[] },
): void {
  const proto = type.prototype as object;
  let seen = declared.get(proto);
  if (!seen) {
    seen = new Set<string>();
    declared.set(proto, seen);
  }
  for (const name of io.inputs ?? []) {
    if (seen.has(`in:${name}`)) continue;
    seen.add(`in:${name}`);
    // `isSignal` is the internal flag the JIT transform sets; it is not on the public type.
    (Input as unknown as (opts: object) => PropertyDecorator)({
      isSignal: true,
      alias: name,
      required: false,
    })(proto, name);
  }
  for (const name of io.outputs ?? []) {
    if (seen.has(`out:${name}`)) continue;
    seen.add(`out:${name}`);
    (Output as unknown as (alias?: string) => PropertyDecorator)(name)(proto, name);
  }
}
