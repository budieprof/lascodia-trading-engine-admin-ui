import type { PineCatalog, PineCatalogParam } from '@core/api/scripting.types';

const p = (
  name: string,
  type: string,
  optional = false,
  doc = '',
  defaultText: string | null = null,
): PineCatalogParam => ({
  name,
  type,
  qualifier: type.split(' ')[0],
  optional,
  defaultText,
  doc,
});

/** A small slice of the language catalog for specs — shaped exactly like `GET scripting/catalog`. */
export const TEST_CATALOG: PineCatalog = {
  version: 'test-v1',
  languageVersion: 6,
  keywords: [
    'and',
    'or',
    'not',
    'if',
    'else',
    'switch',
    'for',
    'to',
    'by',
    'in',
    'while',
    'var',
    'varip',
    'import',
    'export',
    'as',
    'enum',
    'type',
    'method',
    'break',
    'continue',
    'true',
    'false',
    'na',
    'series',
    'simple',
    'const',
  ],
  types: [
    { name: 'float', doc: 'Floating point type.' },
    { name: 'array', doc: 'Array type.', generic: true },
  ],
  annotations: [{ name: '@version=', doc: 'Language version.' }],
  namespaces: ['ta', 'math', 'strategy', 'color', 'array', 'input', 'request', 'str', 'syminfo'],
  functions: [
    {
      name: 'ta.ema',
      doc: 'Exponential moving average.',
      overloads: [
        {
          signature: 'ta.ema(source, length) → series float',
          params: [
            p('source', 'series int/float', false, 'Series of values to process.'),
            p('length', 'simple int', false, 'Number of bars.'),
          ],
          returns: 'series float',
          flags: ['RequiresEveryBar'],
        },
      ],
    },
    {
      name: 'ta.sma',
      doc: 'Simple moving average.',
      overloads: [
        {
          signature: 'ta.sma(source, length) → series float',
          params: [p('source', 'series int/float'), p('length', 'series int')],
          returns: 'series float',
        },
      ],
    },
    {
      name: 'ta.crossover',
      doc: 'True when source1 crosses over source2.',
      overloads: [
        {
          signature: 'ta.crossover(source1, source2) → series bool',
          params: [p('source1', 'series int/float'), p('source2', 'series int/float')],
          returns: 'series bool',
        },
      ],
    },
    {
      name: 'plot',
      doc: 'Plots a series of data on the chart.',
      overloads: [
        {
          signature: 'plot(series, title, color, linewidth) → plot',
          params: [
            p('series', 'series int/float', false, 'Series of data to be plotted.'),
            p('title', 'const string', true, 'Title of the plot.'),
            p('color', 'series color', true),
            p('linewidth', 'input int', true, '', '1'),
          ],
          returns: 'plot',
        },
      ],
    },
    {
      name: 'strategy',
      doc: 'Declares a strategy script.',
      overloads: [
        {
          signature: 'strategy(title, shorttitle, overlay) → void',
          params: [
            p('title', 'const string'),
            p('shorttitle', 'const string', true),
            p('overlay', 'const bool', true),
          ],
          returns: 'void',
        },
      ],
    },
    {
      name: 'strategy.entry',
      doc: 'Enters a position.',
      overloads: [
        {
          signature: 'strategy.entry(id, direction, qty) → void',
          params: [
            p('id', 'series string'),
            p('direction', 'series strategy_direction'),
            p('qty', 'series int/float', true),
          ],
          returns: 'void',
        },
      ],
    },
    {
      name: 'math.max',
      doc: 'Greatest of multiple values.',
      overloads: [
        {
          signature: 'math.max(number0, number1) → int',
          params: [p('number0', 'int'), p('number1', 'int')],
          returns: 'int',
          variadic: true,
        },
        {
          signature: 'math.max(number0, number1) → float',
          params: [p('number0', 'float'), p('number1', 'float')],
          returns: 'float',
          variadic: true,
        },
      ],
    },
    {
      name: 'input.int',
      doc: 'Integer input.',
      overloads: [
        {
          signature: 'input.int(defval, title, minval, maxval) → input int',
          params: [
            p('defval', 'const int'),
            p('title', 'const string', true),
            p('minval', 'const int', true),
            p('maxval', 'const int', true),
          ],
          returns: 'input int',
        },
      ],
    },
    {
      name: 'array.new<type>',
      doc: 'Creates a new array.',
      overloads: [
        {
          signature: 'array.new<type>(size, initial_value) → array<type>',
          params: [p('size', 'series int', true), p('initial_value', 'series <type>', true)],
          returns: 'array<type>',
          templateParam: 'T',
        },
      ],
    },
    {
      name: 'array.push',
      doc: 'Appends a value to an array.',
      overloads: [
        {
          signature: 'array.push(id, value) → void',
          params: [p('id', 'any array type'), p('value', 'series <type of the array elements>')],
          returns: 'void',
          method: true,
        },
      ],
    },
    {
      name: 'array.size',
      doc: 'Number of elements.',
      overloads: [
        {
          signature: 'array.size(id) → series int',
          params: [p('id', 'any array type')],
          returns: 'series int',
          method: true,
        },
      ],
    },
    {
      name: 'request.security',
      doc: 'Requests data from another symbol or timeframe.',
      overloads: [
        {
          signature: 'request.security(symbol, timeframe, expression) → series <type>',
          params: [
            p('symbol', 'series string'),
            p('timeframe', 'series string'),
            p('expression', 'variable'),
          ],
          returns: 'series <type>',
        },
      ],
    },
    {
      name: 'str.tostring',
      doc: 'Converts a value to a string.',
      overloads: [
        {
          signature: 'str.tostring(value) → series string',
          params: [p('value', 'series int/float')],
          returns: 'series string',
          method: true,
        },
      ],
    },
    {
      name: 'time',
      doc: 'Bar open time for a timeframe/session.',
      overloads: [
        {
          signature: 'time(timeframe, session) → series int',
          params: [p('timeframe', 'series string'), p('session', 'series string', true)],
          returns: 'series int',
        },
      ],
    },
  ],
  variables: [
    { name: 'close', type: 'series float', doc: 'Close price of the current bar.' },
    { name: 'open', type: 'series float', doc: 'Open price.' },
    { name: 'bar_index', type: 'series int', doc: 'Current bar index.' },
    { name: 'time', type: 'series int', doc: 'Bar open time (ms).' },
    { name: 'syminfo.tickerid', type: 'simple string', doc: 'Ticker id.' },
  ],
  constants: [
    { name: 'color.red', type: 'const color', valueText: '#F23645', doc: 'Red.' },
    { name: 'color.teal', type: 'const color', valueText: '#089981', doc: 'Teal.' },
    { name: 'strategy.long', type: 'const strategy_direction', doc: 'Long direction.' },
    { name: 'strategy.short', type: 'const strategy_direction', doc: 'Short direction.' },
  ],
};
