/**
 * "Watch this" (SP-I5): the Structure Watch scripts the chart writes for the operator. Each follows the watch contract
 * the engine checks before arming (engine `ScriptWatchContract`): an `indicator()` that declares
 * `armedAt = input.time(0, "armedAt")` (the engine sets it; steps count only from it), judges closed candles only, and
 * publishes the plots "step", "ready" and "broken" (and "stop" where the setup has one). They are built from the
 * engine's tested structure blocks (`import lascodia/structure/1 as st`) — the same blocks the AI's watches use — so a
 * chart watch and an AI watch read the market the same way. Pure: no Angular.
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

  const head = [
    '//@version=6',
    `indicator("${pineText(`Watch: ${t.label} ${lvl}`)}", overlay = true)`,
    'import lascodia/structure/1 as st',
    'armedAt = input.time(0, "armedAt")',
    `level = input.price(${lvl}, "level")`,
    ...(off !== null ? [`calledOff = input.price(${off}, "called off")`] : []),
    'var int step = 0',
    'var bool broken = false',
  ];

  // The extra guard runs first on every candle after armedAt, whatever the step: a close beyond it ends the watch.
  const guard =
    off === null
      ? []
      : [
          `    if ${t.lean === 'up' ? 'close < calledOff' : 'close > calledOff'}`,
          '        broken := true',
        ];

  // Every structure block is evaluated on EVERY candle, outside the step logic: the blocks keep history (ATR,
  // previous candles), and calling them only on some candles would feed them a broken series.
  let signals: string[];
  let body: string[];
  let readyStep: number;
  let extraVars: string[] = [];
  let tail: string[] = [];

  switch (t.id) {
    case 'closeAbove':
    case 'closeBelow':
      readyStep = 1;
      signals = [
        `closedBeyond = st.${t.id === 'closeAbove' ? 'closedAbove' : 'closedBelow'}(level)`,
      ];
      body = ['    if not broken and step == 0 and closedBeyond', '        step := 1'];
      break;
    case 'dipReclaim':
      readyStep = 3;
      extraVars = ['var float dipLow = na'];
      signals = [
        'ruler = st.ruler()',
        'dipped = st.sweptBelow(level)',
        'reclaimed = st.closedAbove(level)',
        'turnedUp = st.higherLow(dipLow)',
      ];
      body = [
        '    if not broken',
        '        if step == 0 and dipped',
        '            step := 1',
        '            dipLow := low',
        '        if step == 1',
        '            dipLow := math.min(dipLow, low)',
        '            if reclaimed',
        '                step := 2',
        '            else if close < level - ruler',
        '                broken := true',
        '        else if step == 2',
        '            if close < dipLow',
        '                broken := true',
        '            else if turnedUp',
        '                step := 3',
      ];
      tail = ['plot(dipLow - 0.5 * ruler, "stop")'];
      break;
    case 'pushFail':
      readyStep = 3;
      extraVars = ['var float pushHigh = na'];
      signals = [
        'ruler = st.ruler()',
        'pushed = st.sweptAbove(level)',
        'rejected = st.closedBelow(level)',
        'turnedDown = st.lowerHigh(pushHigh)',
      ];
      body = [
        '    if not broken',
        '        if step == 0 and pushed',
        '            step := 1',
        '            pushHigh := high',
        '        if step == 1',
        '            pushHigh := math.max(pushHigh, high)',
        '            if rejected',
        '                step := 2',
        '            else if close > level + ruler',
        '                broken := true',
        '        else if step == 2',
        '            if close > pushHigh',
        '                broken := true',
        '            else if turnedDown',
        '                step := 3',
      ];
      tail = ['plot(pushHigh + 0.5 * ruler, "stop")'];
      break;
    case 'breakRetestUp':
      readyStep = 2;
      signals = [
        'ruler = st.ruler()',
        'brokeOut = st.closedAbove(level)',
        'retestHeld = st.retestHoldsAbove(level)',
      ];
      body = [
        '    if not broken',
        '        if step == 0',
        '            if brokeOut',
        '                step := 1',
        '        else if step == 1',
        '            if close < level - ruler',
        '                broken := true',
        '            else if retestHeld',
        '                step := 2',
      ];
      break;
    case 'breakRetestDown':
      readyStep = 2;
      signals = [
        'ruler = st.ruler()',
        'brokeDown = st.closedBelow(level)',
        'retestHeld = st.retestHoldsBelow(level)',
      ];
      body = [
        '    if not broken',
        '        if step == 0',
        '            if brokeDown',
        '                step := 1',
        '        else if step == 1',
        '            if close > level + ruler',
        '                broken := true',
        '            else if retestHeld',
        '                step := 2',
      ];
      break;
  }

  return [
    ...head,
    ...extraVars,
    ...signals,
    // Once ready the watch has done its job: later candles never move the step or break it.
    `if time >= armedAt and step < ${readyStep}`,
    ...guard,
    ...body,
    'plot(step, "step")',
    `plot(step >= ${readyStep} ? 1 : 0, "ready")`,
    'plot(broken ? 1 : 0, "broken")',
    ...tail,
    '',
  ].join('\n');
}

/** The trigger and invalidation every chart Structure Watch is armed with: the script decides both. */
export const SCRIPT_TRIGGER = { v: 2, metric: 'scriptready', op: 'above', value: 0 } as const;
export const SCRIPT_INVALIDATION = { v: 2, metric: 'scriptbroken', op: 'above', value: 0 } as const;
