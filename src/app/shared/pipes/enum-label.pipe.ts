import { Pipe, PipeTransform } from '@angular/core';

const LABEL_MAPS: Record<string, Record<string, string>> = {
  orderStatus: {
    Pending: 'Pending',
    Submitted: 'Submitted',
    PartialFill: 'Partial Fill',
    Filled: 'Filled',
    Cancelled: 'Cancelled',
    Rejected: 'Rejected',
    Expired: 'Expired',
  },
  positionStatus: {
    Open: 'Open',
    Closed: 'Closed',
    Closing: 'Closing',
  },
  strategyStatus: {
    Active: 'Active',
    Paused: 'Paused',
    Backtesting: 'Backtesting',
    Stopped: 'Stopped',
  },
  signalStatus: {
    Pending: 'Pending',
    Approved: 'Approved',
    Executed: 'Executed',
    Rejected: 'Rejected',
    Expired: 'Expired',
  },
  brokerStatus: {
    Connected: 'Connected',
    Disconnected: 'Disconnected',
    Error: 'Error',
  },
  runStatus: {
    Queued: 'Queued',
    Running: 'Running',
    Completed: 'Completed',
    Failed: 'Failed',
  },
  marketRegime: {
    Trending: 'Trending',
    Ranging: 'Ranging',
    HighVolatility: 'High Volatility',
    LowVolatility: 'Low Volatility',
    Crisis: 'Crisis',
    Breakout: 'Breakout',
  },
  recoveryMode: {
    Normal: 'Normal',
    Reduced: 'Reduced',
    Halted: 'Halted',
  },
  timeframe: {
    M1: '1 Min',
    M5: '5 Min',
    M15: '15 Min',
    H1: '1 Hour',
    H4: '4 Hours',
    D1: 'Daily',
  },
};

@Pipe({
  name: 'enumLabel',
  standalone: true,
})
export class EnumLabelPipe implements PipeTransform {
  transform(value: string | null | undefined, enumType?: string): string {
    if (!value) return '-';
    if (enumType && LABEL_MAPS[enumType]) {
      return LABEL_MAPS[enumType][value] || value;
    }
    return value.replace(/([A-Z])/g, ' $1').trim();
  }
}
