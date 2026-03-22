export const lascodiaTheme = {
  color: [
    '#0071E3',
    '#34C759',
    '#FF3B30',
    '#FF9500',
    '#AF52DE',
    '#5AC8FA',
    '#FF2D55',
    '#64D2FF',
  ],
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
