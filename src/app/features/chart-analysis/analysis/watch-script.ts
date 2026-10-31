/**
 * "Watch this" (SP-I5): the Structure Watch scripts the chart writes for the operator. Each follows the watch contract
 * the engine checks before arming (engine `ScriptWatchContract`): an `indicator()` that declares
 * `armedAt = input.time(0, "armedAt")` (the engine sets it; steps count only from it), judges closed candles only, and
 * publishes the plots "step", "ready" and "broken" (and "stop" where the setup has one). They are built on the
 * engine's tested watch library (`import lascodia/plan/1 as plan`) — the same templates the AI's watches use — so a
 * chart watch and an AI watch follow a setup the same way: arming, ordered steps, latched breaks, frozen once ready.
 * Pure: no Angular.
 */

/** Which way a setup leans: "up" setups are called off by a close below, "down" ones by a close above. */
export type WatchLean = 'up' | 'down';

export interface WatchTemplate {
  id: 'closeAbove' | 'closeBelow' | 'dipReclaim' | 'pushFail' | 'breakRetestUp' | 'breakRetestDown';
  /** Menu text. */
  label: string;
  /** What it waits for, in plain words, with the level as {level}. */
  explain: string;
  lean: WatchLean;
  /** The trade it usually sets up, offered as the watch's planned side. */
  side: 'Buy' | 'Sell' | null;
}

export const WATCH_TEMPLATES: readonly WatchTemplate[] = [
  {
    id: 'closeAbove',
    label: 'A candle closes above the level',
    explain: 'Ready when a candle closes above {level}.',
    lean: 'up',
    side: null,
  },
  {
    id: 'closeBelow',
    label: 'A candle closes below the level',
    explain: 'Ready when a candle closes below {level}.',
    lean: 'down',
    side: null,
  },
  {
    id: 'dipReclaim',
    label: 'Dip below, close back above, higher low (buy setup)',
    explain:
      'Step 1: price dips clearly below {level}. Step 2: a candle closes back above it. Ready: a higher low turns up. ' +
      'Called off if price falls a full candle-size (ATR) under the level before the reclaim, or under the dip low after it.',
    lean: 'up',
    side: 'Buy',
  },
  {
    id: 'pushFail',
    label: 'Push above, close back below, lower high (sell setup)',
    explain:
      'Step 1: price pokes clearly above {level}. Step 2: a candle closes back below it. Ready: a lower high turns down. ' +
      'Called off if price rises a full candle-size (ATR) over the level before the rejection, or over the push high after it.',
    lean: 'down',
    side: 'Sell',
  },
  {
    id: 'breakRetestUp',
    label: 'Break above, then a retest that holds (buy setup)',
    explain:
      'Step 1: a candle closes above {level}. Ready: price comes back to it and the candle still closes above. ' +
      'Called off if a candle closes a full candle-size (ATR) back under the level.',
    lean: 'up',
    side: 'Buy',
  },
  {
    id: 'breakRetestDown',
    label: 'Break below, then a retest that holds (sell setup)',
    explain:
      'Step 1: a candle closes below {level}. Ready: price comes back to it and the candle still closes below. ' +
      'Called off if a candle closes a full candle-size (ATR) back over the level.',
    lean: 'down',
    side: 'Sell',
  },
];

export function watchTemplate(id: string): WatchTemplate | null {
  return WATCH_TEMPLATES.find((t) => t.id === id) ?? null;
}

export interface WatchScriptInput {
  template: WatchTemplate['id'];
  level: number;
  /** Optional extra guard: a close beyond this price calls the watch off (below for "up" setups, above for "down"). */
  calledOff?: number | null;
  /** Symbol decimals, for printing prices. */
  precision: number;
}

/** Why the input cannot make a watch, or null when it can. */
export function watchInputProblem(input: WatchScriptInput): string | null {
  const t = watchTemplate(input.template);
  if (!t) return 'Pick what to wait for.';
  if (!Number.isFinite(input.level) || input.level <= 0) return 'Set the level to watch.';
  const off = input.calledOff;
  if (off !== null && off !== undefined) {
    if (!Number.isFinite(off) || off <= 0) return 'The "called off" price is not a price.';
    if (t.lean === 'up' && off >= input.level)
      return 'For this setup the "called off" price must be below the level.';
    if (t.lean === 'down' && off <= input.level)
      return 'For this setup the "called off" price must be above the level.';
  }
  return null;
}

/** The template's explanation with the level printed. */
export function explainWatch(input: WatchScriptInput): string {
  const t = watchTemplate(input.template);
  if (!t) return '';
  const lvl = fmt(input.level, input.precision);
  let text = t.explain.replace('{level}', lvl).replace('{level}', lvl);
  if (
    input.calledOff !== null &&
    input.calledOff !== undefined &&
    Number.isFinite(input.calledOff)
  ) {
    text += ` Also called off if a candle closes ${t.lean === 'up' ? 'below' : 'above'} ${fmt(input.calledOff, input.precision)}.`;
  }
  return text;
}

function fmt(v: number, precision: number): string {
  return v.toFixed(Math.max(0, Math.min(10, precision)));
}

/** Text safe inside a Pine string literal. */
function pineText(s: string): string {
  return s.replace(/["\\]/g, '');
}

/** The watch's Pine source. */
export function buildWatchScript(input: WatchScriptInput): string {
  const t = watchTemplate(input.template);
  if (!t) throw new Error('unknown watch template');
  const lvl = fmt(input.level, input.precision);
  const hasOff =
    input.calledOff !== null && input.calledOff !== undefined && Number.isFinite(input.calledOff);
  const off = hasOff ? fmt(input.calledOff as number, input.precision) : null;
  const dir = t.lean === 'up' ? 1 : -1;
  const offArg = off !== null ? ', calledOff = calledOff' : '';

  const head = [
    '//@version=6',
    `indicator("${pineText(`Watch: ${t.label} ${lvl}`)}", overlay = true)`,
    'import lascodia/plan/1 as plan',
    'armedAt = input.time(0, "armedAt")',
    `level = input.price(${lvl}, "level")`,
    ...(off !== null ? [`calledOff = input.price(${off}, "called off")`] : []),
  ];

  // The library keeps the steps: nothing before armedAt, steps in order, broken latched, frozen once ready, the
  // "called off" price judged on closes. Every condition is computed on every candle.
  let body: string[];
  let plotStop = false;
  switch (t.id) {
    case 'closeAbove':
    case 'closeBelow':
      body = [
        `var w = plan.watch(armedAt, 1${off !== null ? (dir > 0 ? ', invalidBelow = calledOff' : ', invalidAbove = calledOff') : ''})`,
        'w.update()',
        `bool beyond = ${t.id === 'closeAbove' ? 'close > level' : 'close < level'}`,
        'w.stepIf(0, beyond)',
        '[step, ready, broken, entry, stop] = w.outputs()',
      ];
      break;
    case 'dipReclaim':
    case 'pushFail':
      // No time limit on the reclaim (maxWait = 0): the chart's watch waits as long as the level stays in play.
      body = [
        `[step, ready, broken, entry, stop] = plan.reclaim(${dir}, armedAt, level, maxWait = 0${offArg})`,
      ];
      plotStop = true;
      break;
    case 'breakRetestUp':
    case 'breakRetestDown':
      // Called off by a close a full candle-size (ATR) back through the level; no time limit on the retest.
      body = [
        `[step, ready, broken, entry, stop] = plan.breakRetest(${dir}, armedAt, level, maxWait = 0, failAtr = 1.0${offArg})`,
      ];
      break;
  }

  return [
    ...head,
    ...body,
    'plot(step, "step")',
    'plot(ready, "ready")',
    'plot(broken, "broken")',
    ...(plotStop ? ['plot(stop, "stop")'] : []),
    '',
  ].join('\n');
}

/** The trigger and invalidation every chart Structure Watch is armed with: the script decides both. */
export const SCRIPT_TRIGGER = { v: 2, metric: 'scriptready', op: 'above', value: 0 } as const;
export const SCRIPT_INVALIDATION = { v: 2, metric: 'scriptbroken', op: 'above', value: 0 } as const;
