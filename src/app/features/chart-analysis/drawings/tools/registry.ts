import type { DrawingKind } from '../model';
import type { ToolBehavior, ToolBehaviorMap } from './types';
import { BEHAVIORS as TREND } from './trend';
import { BEHAVIORS as FIB_GANN } from './fib-gann';
import { BEHAVIORS as PATTERNS } from './patterns';
import { BEHAVIORS as FORECAST } from './forecast';
import { BEHAVIORS as SHAPES } from './shapes';
import { BEHAVIORS as TEXT } from './text';
import { MEDIA_BEHAVIORS as MEDIA } from './media';

const ALL: ToolBehaviorMap = {
  ...TREND,
  ...FIB_GANN,
  ...PATTERNS,
  ...FORECAST,
  ...SHAPES,
  ...TEXT,
  ...MEDIA,
};

export function behaviorFor(kind: DrawingKind): ToolBehavior | undefined {
  return ALL[kind];
}
