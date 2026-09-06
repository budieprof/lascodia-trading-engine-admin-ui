/**
 * Value-axis tick formatter shared by both themes.
 *
 * Large magnitudes collapse to k / M / B so a P&L or volume axis reads "-100k … 20k" instead of
 * seven-digit labels that overrun each other ("-100,000,000,000,000 0 20,000" was the literal
 * rendering on the dashboard's P&L-by-symbol chart, the alerts rules-by-symbol chart and the
 * audit-trail decision-type chart on 2026-09-05). Small magnitudes — prices, ratios, percentages
 * under 10k — are left exactly as ECharts would print them, so a 1.16139 price axis is untouched.
 */
export function compactAxisNumber(value: number | string): string {
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return String(value);
  const abs = Math.abs(v);
  if (abs < 10_000) return String(value);
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [div, suffix] of units) {
    if (abs >= div) {
      const scaled = v / div;
      const text =
        Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

/**
 * Axis-label defaults applied through the theme so every chart inherits them without each page
 * repeating the same three lines. `hideOverlap` drops a tick label rather than drawing it on top
 * of its neighbour; the formatter keeps big numbers short enough that fewer collide to begin with.
 * A page can still override either per axis.
 */
const categoryAxisLabelDefaults = { hideOverlap: true };
const valueAxisLabelDefaults = { hideOverlap: true, formatter: compactAxisNumber };

export const lascodiaTheme = {
  color: ['#0071E3', '#34C759', '#FF3B30', '#FF9500', '#AF52DE', '#5AC8FA', '#FF2D55', '#64D2FF'],
  backgroundColor: 'transparent',
  textStyle: {
    fontFamily:
      "'SF Pro Display', 'SF Pro Text', 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  },
  title: {
    textStyle: {
      color: '#1D1D1F',
      fontSize: 17,
      fontWeight: 600,
    },
    subtextStyle: {
      color: '#6E6E73',
      fontSize: 13,
    },
  },
  line: {
    itemStyle: {
      borderWidth: 2,
    },
    lineStyle: {
      width: 2,
    },
    symbolSize: 0,
    symbol: 'circle',
    smooth: false,
  },
  bar: {
    itemStyle: {
      barBorderWidth: 0,
      barBorderColor: 'transparent',
      borderRadius: [4, 4, 0, 0],
    },
  },
  pie: {
    itemStyle: {
      borderWidth: 2,
      borderColor: '#FFFFFF',
    },
  },
  categoryAxis: {
    axisLine: {
      show: true,
      lineStyle: {
        color: 'rgba(0, 0, 0, 0.06)',
      },
    },
    axisTick: {
      show: false,
    },
    axisLabel: {
      color: '#6E6E73',
      fontSize: 11,
      ...categoryAxisLabelDefaults,
    },
    splitLine: {
      show: false,
    },
  },
  valueAxis: {
    axisLine: {
      show: false,
    },
    axisTick: {
      show: false,
    },
    axisLabel: {
      color: '#6E6E73',
      fontSize: 11,
      ...valueAxisLabelDefaults,
    },
    splitLine: {
      show: true,
      lineStyle: {
        color: 'rgba(0, 0, 0, 0.04)',
        type: 'dashed',
      },
    },
  },
  tooltip: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderColor: 'rgba(0, 0, 0, 0.06)',
    borderWidth: 1,
    borderRadius: 12,
    padding: [12, 16],
    textStyle: {
      color: '#1D1D1F',
      fontSize: 13,
    },
    extraCssText:
      'backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);',
  },
  legend: {
    textStyle: {
      color: '#6E6E73',
      fontSize: 13,
    },
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 16,
  },
  grid: {
    left: '3%',
    right: '3%',
    bottom: '3%',
    top: '15%',
    containLabel: true,
  },
  candlestick: {
    itemStyle: {
      color: '#34C759',
      color0: '#FF3B30',
      borderColor: '#34C759',
      borderColor0: '#FF3B30',
      borderWidth: 1,
    },
  },
};

export const lascodiaDarkTheme = {
  ...lascodiaTheme,
  title: {
    textStyle: {
      color: '#F5F5F7',
      fontSize: 17,
      fontWeight: 600,
    },
    subtextStyle: {
      color: '#A1A1A6',
      fontSize: 13,
    },
  },
  categoryAxis: {
    axisLine: {
      show: true,
      lineStyle: {
        color: 'rgba(255, 255, 255, 0.08)',
      },
    },
    axisTick: {
      show: false,
    },
    axisLabel: {
      color: '#A1A1A6',
      fontSize: 11,
      ...categoryAxisLabelDefaults,
    },
    splitLine: {
      show: false,
    },
  },
  valueAxis: {
    axisLine: {
      show: false,
    },
    axisTick: {
      show: false,
    },
    axisLabel: {
      color: '#A1A1A6',
      fontSize: 11,
      ...valueAxisLabelDefaults,
    },
    splitLine: {
      show: true,
      lineStyle: {
        color: 'rgba(255, 255, 255, 0.06)',
        type: 'dashed',
      },
    },
  },
  tooltip: {
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderRadius: 12,
    padding: [12, 16],
    textStyle: {
      color: '#F5F5F7',
      fontSize: 13,
    },
    extraCssText:
      'backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);',
  },
  legend: {
    textStyle: {
      color: '#A1A1A6',
      fontSize: 13,
    },
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 16,
  },
  pie: {
    itemStyle: {
      borderWidth: 2,
      borderColor: '#000000',
    },
  },
  candlestick: {
    itemStyle: {
      color: '#34C759',
      color0: '#FF3B30',
      borderColor: '#34C759',
      borderColor0: '#FF3B30',
      borderWidth: 1,
    },
  },
};
