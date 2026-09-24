/**
 * The fixed vocabulary of Pine Script v6 — keywords, qualifiers, type keywords, annotations and
 * namespaces — taken from the v6 reference. The live catalog (`GET scripting/catalog`) supplies
 * the built-in functions, variables and constants; these lists cover what the language itself
 * defines and what the highlighter needs before the catalog arrives.
 */

/** Keywords that start or shape control flow. */
export const PINE_CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'else',
  'switch',
  'for',
  'to',
  'by',
  'in',
  'while',
  'break',
  'continue',
  'once',
]);

/** Keywords that declare something. */
export const PINE_DEFINITION_KEYWORDS: ReadonlySet<string> = new Set([
  'var',
  'varip',
  'import',
  'export',
  'as',
  'enum',
  'type',
  'method',
]);

/** Logical operators spelled as words. */
export const PINE_OPERATOR_KEYWORDS: ReadonlySet<string> = new Set(['and', 'or', 'not']);

/** Type qualifiers (`input` is also a qualifier in docs, but in code it is the `input.*` namespace). */
export const PINE_QUALIFIERS: ReadonlySet<string> = new Set(['const', 'simple', 'series']);

export const PINE_LITERAL_KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'na']);

/** Every reserved word, for completion. */
export const PINE_KEYWORDS: readonly string[] = [
  ...PINE_CONTROL_KEYWORDS,
  ...PINE_DEFINITION_KEYWORDS,
  ...PINE_OPERATOR_KEYWORDS,
  ...PINE_QUALIFIERS,
  ...PINE_LITERAL_KEYWORDS,
];

/** Built-in type keywords. `chart.point` is the only dotted one. */
export const PINE_TYPES: readonly string[] = [
  'int',
  'float',
  'bool',
  'string',
  'color',
  'line',
  'label',
  'box',
  'table',
  'linefill',
  'polyline',
  'array',
  'matrix',
  'map',
  'chart.point',
  'footprint',
  'volume_row',
];

export const PINE_TYPE_SET: ReadonlySet<string> = new Set(PINE_TYPES);

/** Compiler annotations (written as `//@name`). */
export const PINE_ANNOTATIONS: readonly string[] = [
  '@version=',
  '@description',
  '@function',
  '@param',
  '@returns',
  '@variable',
  '@type',
  '@field',
  '@enum',
  '@strategy_alert_message',
];

/** Namespaces of the v6 built-ins (every proper prefix of a dotted built-in name). */
export const PINE_NAMESPACES: readonly string[] = [
  'adjustment',
  'alert',
  'array',
  'backadjustment',
  'barmerge',
  'barstate',
  'box',
  'chart',
  'chart.point',
  'color',
  'currency',
  'dayofweek',
  'display',
  'dividends',
  'earnings',
  'extend',
  'font',
  'footprint',
  'format',
  'hline',
  'input',
  'label',
  'line',
  'linefill',
  'location',
  'log',
  'map',
  'math',
  'matrix',
  'order',
  'plot',
  'polyline',
  'position',
  'request',
  'runtime',
  'scale',
  'session',
  'settlement_as_close',
  'shape',
  'size',
  'splits',
  'str',
  'strategy',
  'strategy.closedtrades',
  'strategy.commission',
  'strategy.direction',
  'strategy.oca',
  'strategy.opentrades',
  'strategy.risk',
  'syminfo',
  'ta',
  'table',
  'text',
  'ticker',
  'timeframe',
  'volume_row',
  'xloc',
  'yloc',
];

/** The series an `input.source()` can pick (sent as the series name, §9). */
export const PINE_SOURCES: readonly string[] = [
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
  'volume',
];

/**
 * One-line docs for the language's own keywords and type keywords — the catalog carries docs for
 * types but only names for keywords, and hover should explain both.
 */
export const PINE_KEYWORD_DOCS: Readonly<Record<string, string>> = {
  if: 'Runs its local block when the condition is true. Usable as an expression: `x = if cond`.',
  else: 'The branch of an `if` structure that runs when no previous condition was true.',
  switch:
    'Transfers control to the first matching `value => block` (or the first true condition). Usable as an expression.',
  for: 'Count-controlled loop: `for i = from to end [by step]`. Returns the last evaluated value.',
  to: 'Upper bound of a `for` loop counter.',
  by: 'Step of a `for` loop counter.',
  in: '`for x in collection` / `for [i, x] in collection` iterates an array, matrix rows or map pairs.',
  while: 'Condition-controlled loop: runs its block while the condition stays true.',
  break: 'Exits the innermost loop.',
  continue: 'Skips to the next iteration of the innermost loop.',
  once: 'Runs its local block the first time its condition is true on a closed bar, then never again.',
  var: 'Declares a variable initialised once, on the first bar; it keeps its value across bars.',
  varip:
    'Like `var`, but the value also persists across realtime updates of the same bar (no rollback).',
  import: 'Loads a published library: `import publisher/name/version as alias`.',
  export: 'Makes a library function, method, type, enum or constant available to importing scripts.',
  as: 'Names the alias of an imported library.',
  enum: 'Declares an enumeration of named members, each with a `const string` title.',
  type: 'Declares a user-defined type (UDT) with fields; instantiate with `TypeName.new()`.',
  method: 'Declares a function callable with dot notation on its first parameter.',
  and: 'Logical AND (lazy: the right side is only evaluated when the left side is true).',
  or: 'Logical OR (lazy: the right side is only evaluated when the left side is false).',
  not: 'Logical negation.',
  const: 'Qualifier: the value is known at compile time and never changes.',
  simple: 'Qualifier: the value is known on the first bar and does not change afterwards.',
  series: 'Qualifier: the value can change on every bar.',
  true: 'Boolean literal.',
  false: 'Boolean literal.',
  na: '"Not available" — the missing value of any type. Test with `na(x)`.',
  int: 'Integer type.',
  float: 'Floating-point type.',
  bool: 'Boolean type (strictly `true` or `false` in v6).',
  string: 'String type.',
  color: 'Color type — `#RRGGBB`, `#RRGGBBAA`, `color.*` constants or `color.new()`/`color.rgb()`.',
  line: 'Drawing type created with `line.new()`.',
  label: 'Drawing type created with `label.new()`.',
  box: 'Drawing type created with `box.new()`.',
  table: 'Table type created with `table.new()`.',
  linefill: 'Fill between two lines, created with `linefill.new()`.',
  polyline: 'Drawing type created with `polyline.new()`.',
  array: 'Generic collection: `array<float>`, created with `array.new<T>()` or `array.from()`.',
  matrix: 'Generic 2-D collection: `matrix<float>`, created with `matrix.new<T>()`.',
  map: 'Generic key-value collection: `map<string, float>`, created with `map.new<K, V>()`.',
  'chart.point': 'A chart coordinate (time/index and price) used by drawings.',
  footprint: 'Volume footprint of a bar, returned by `request.footprint()`.',
  volume_row: 'One price row of a footprint.',
};
