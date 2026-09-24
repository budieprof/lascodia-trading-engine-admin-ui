/**
 * Snippet templates offered by completion. `${name}` marks a tab stop (CodeMirror snippet syntax);
 * `${}` is the final cursor position. Indentation is four spaces, as Pine requires.
 */
export interface PineSnippet {
  /** What the operator types to find it. */
  label: string;
  detail: string;
  template: string;
  /** Only offered at the start of a line (declarations and statements). */
  lineStart?: boolean;
}

export const PINE_SNIPPETS: readonly PineSnippet[] = [
  {
    label: 'strategy skeleton',
    detail: 'New strategy script',
    lineStart: true,
    template: [
      '//@version=6',
      'strategy("${My strategy}", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10)',
      '',
      'fastLength = input.int(9, "Fast length", minval = 1)',
      'slowLength = input.int(21, "Slow length", minval = 1)',
      '',
      'fast = ta.ema(close, fastLength)',
      'slow = ta.ema(close, slowLength)',
      '',
      'if ta.crossover(fast, slow)',
      '    strategy.entry("Long", strategy.long)',
      'if ta.crossunder(fast, slow)',
      '    strategy.entry("Short", strategy.short)',
      '',
      'plot(fast, "Fast", color.teal)',
      'plot(slow, "Slow", color.orange)',
      '${}',
    ].join('\n'),
  },
  {
    label: 'indicator skeleton',
    detail: 'New indicator script',
    lineStart: true,
    template: [
      '//@version=6',
      'indicator("${My indicator}", overlay = ${true})',
      '',
      'length = input.int(14, "Length", minval = 1)',
      'value = ta.sma(close, length)',
      '',
      'plot(value, "Value", color.blue)',
      '${}',
    ].join('\n'),
  },
  {
    label: 'library skeleton',
    detail: 'New library script',
    lineStart: true,
    template: [
      '//@version=6',
      '// @description ${What this library provides}',
      'library("${MyLibrary}")',
      '',
      '// @function ${Returns the midpoint of two values.}',
      '// @param a First value.',
      '// @param b Second value.',
      '// @returns The midpoint.',
      'export midpoint(float a, float b) =>',
      '    (a + b) / 2',
      '${}',
    ].join('\n'),
  },
  {
    label: 'strategy.entry',
    detail: 'Enter a position',
    template: 'strategy.entry("${Long}", ${strategy.long})${}',
  },
  {
    label: 'strategy.exit',
    detail: 'Stop-loss / take-profit exit',
    template:
      'strategy.exit("${Exit}", from_entry = "${Long}", stop = ${stopPrice}, limit = ${limitPrice})${}',
  },
  {
    label: 'strategy.close',
    detail: 'Close an entry at market',
    template: 'strategy.close("${Long}", comment = "${exit}")${}',
  },
  {
    label: 'input.int',
    detail: 'Integer input',
    template: 'input.int(${14}, "${Length}", minval = ${1})${}',
  },
  {
    label: 'input.float',
    detail: 'Float input',
    template: 'input.float(${1.5}, "${Multiplier}", minval = ${0.0}, step = ${0.1})${}',
  },
  { label: 'input.bool', detail: 'Checkbox input', template: 'input.bool(${true}, "${Show}")${}' },
  {
    label: 'input.string',
    detail: 'Dropdown input',
    template: 'input.string("${A}", "${Mode}", options = ["${A}", "${B}"])${}',
  },
  {
    label: 'input.text_area',
    detail: 'Multi-line text input',
    template: 'input.text_area("${}", "${Notes}")',
  },
  {
    label: 'input.source',
    detail: 'Source input',
    template: 'input.source(${close}, "${Source}")${}',
  },
  {
    label: 'input.timeframe',
    detail: 'Timeframe input',
    template: 'input.timeframe("${1D}", "${Timeframe}")${}',
  },
  { label: 'input.symbol', detail: 'Symbol input', template: 'input.symbol("${}", "${Symbol}")' },
  {
    label: 'input.session',
    detail: 'Session input',
    template: 'input.session("${0800-1700}", "${Session}")${}',
  },
  {
    label: 'input.color',
    detail: 'Color input',
    template: 'input.color(${color.teal}, "${Color}")${}',
  },
  {
    label: 'input.time',
    detail: 'Date/time input',
    template: 'input.time(timestamp("${2024-01-01 00:00}"), "${Start}")${}',
  },
  {
    label: 'input.price',
    detail: 'Price input',
    template: 'input.price(${0.0}, "${Level}")${}',
  },
  {
    label: 'input.enum',
    detail: 'Enum dropdown input',
    template: 'input.enum(${MyEnum.first}, "${Mode}")${}',
  },
  {
    label: 'if',
    detail: 'if block',
    lineStart: true,
    template: 'if ${condition}\n    ${}',
  },
  {
    label: 'if else',
    detail: 'if / else block',
    lineStart: true,
    template: 'if ${condition}\n    ${}\nelse\n    ',
  },
  {
    label: 'for',
    detail: 'Counted loop',
    lineStart: true,
    template: 'for ${i} = ${0} to ${10}\n    ${}',
  },
  {
    label: 'for in',
    detail: 'Collection loop',
    lineStart: true,
    template: 'for [${index}, ${item}] in ${collection}\n    ${}',
  },
  {
    label: 'while',
    detail: 'Conditional loop',
    lineStart: true,
    template: 'while ${condition}\n    ${}',
  },
  {
    label: 'switch',
    detail: 'switch block',
    lineStart: true,
    template: 'switch ${value}\n    ${"a"} => ${resultA}\n    => ${default}${}',
  },
  {
    label: 'function',
    detail: 'User-defined function',
    lineStart: true,
    template: '${name}(${params}) =>\n    ${}',
  },
  {
    label: 'type',
    detail: 'User-defined type',
    lineStart: true,
    template: 'type ${Name}\n    ${float} ${field} = ${na}${}',
  },
  {
    label: 'method',
    detail: 'Method declaration',
    lineStart: true,
    template: 'method ${name}(${Type} ${self}) =>\n    ${}',
  },
  {
    label: 'enum',
    detail: 'Enum declaration',
    lineStart: true,
    template: 'enum ${Name}\n    ${first} = "${First}"\n    ${second} = "${Second}"${}',
  },
  {
    label: 'import',
    detail: 'Import a library',
    lineStart: true,
    template: 'import ${publisher}/${name}/${1} as ${alias}${}',
  },
  {
    label: '//#region',
    detail: 'Collapsible region',
    lineStart: true,
    template: '//#region ${Name}\n${}\n//#endregion',
  },
];
