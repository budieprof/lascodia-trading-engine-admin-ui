import type { EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

/**
 * Broker identity derived from trading accounts + EA instances.
 *
 * The engine ships no first-class Broker resource, so both the list page and
 * the detail page infer brokers from `TradingAccount`. They must infer them the
 * SAME way or a card on the list leads to a "not found" on the detail — hence
 * one module owns the grouping key, the aggregates, and the URL slug.
 *
 * Grouping key is the broker's *server family* (the part of `brokerServer`
 * before the first dash — "MetaQuotes-Demo" → "MetaQuotes",
 * "Exness-MT5Trial9" → "Exness"), falling back to the company name with its
 * legal suffix stripped. Grouping on the raw company string split one
 * MetaQuotes-Demo server into two "brokers" because two accounts reported
 * "MetaQuotes Ltd." and "MetaQuotes Software Corp." for the same server.
 */
export interface BrokerGroup {
  /** Canonical broker identity — what the card is titled with. */
  key: string;
  /** URL-safe form of `key` used for `/brokers/:id`. */
  slug: string;
  /** Every distinct server the accounts in this group connect to. */
  servers: string[];
  /** Every distinct company string the broker reported for itself. */
  companies: string[];
  /** Distinct account currencies (usually one). */
  currencies: string[];
  accounts: TradingAccountDto[];
  eaInstances: EAInstanceDto[];
  realAccounts: number;
  demoAccounts: number;
  contestAccounts: number;
  paperAccounts: number;
  activeAccounts: number;
  totalBalance: number;
  totalEquity: number;
  totalMargin: number;
  totalMarginAvailable: number;
  marginUtilizationPct: number;
  activeEas: number;
  shuttingDownEas: number;
  disconnectedEas: number;
  newestHeartbeatAgeSec: number | null;
  oldestHeartbeatAgeSec: number | null;
  symbolsCovered: string[];
  /** Most recent `lastSyncedAt` across the group's accounts, or null. */
  lastSyncedAt: string | null;
}

export type AccountModeClass = 'paper' | 'real' | 'demo' | 'contest' | 'unknown';

/** Suffixes stack ("MetaQuotes Software Corp."), so the stripper peels until stable. */
const LEGAL_SUFFIX =
  /[,.]?\s*(ltd|limited|inc|llc|plc|corp|corporation|software|technologies|group)\.?$/i;

/**
 * Canonical broker identity for an account. Server family first
 * ("Exness-MT5Trial9" → "Exness"), then the company name with its legal
 * suffix stripped ("MetaQuotes Software Corp." → "MetaQuotes"). Sim accounts
 * carry no server and a bare company string, so the fallback still groups.
 */
export function brokerKeyOf(a: TradingAccountDto): string {
  const server = (a.brokerServer ?? '').trim();
  if (server) {
    const family = server.split(/[-_ ]/)[0]?.trim();
    if (family) return family;
  }
  const name = (a.brokerName ?? '').trim();
  if (!name) return 'Unknown broker';
  let stripped = name;
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(stripped); i++) {
    stripped = stripped.replace(LEGAL_SUFFIX, '').trim();
  }
  return stripped || name;
}

/** Lower-case, dash-joined key so it survives a URL round-trip unchanged. */
export function brokerSlug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Account type as the broker reports it. `isPaper` is the engine's own
 * simulation flag and wins; otherwise Demo / Real / Contest. Keying on
 * `isPaper` alone showed "Live" for every row, because the engine leaves it
 * false for demo and sim accounts alike.
 */
export function accountMode(a: TradingAccountDto): { label: string; cls: AccountModeClass } {
  if (a.isPaper) return { label: 'Paper', cls: 'paper' };
  switch (a.accountType) {
    case 'Real':
      return { label: 'Real', cls: 'real' };
    case 'Demo':
      return { label: 'Demo', cls: 'demo' };
    case 'Contest':
      return { label: 'Contest', cls: 'contest' };
    default:
      return { label: '—', cls: 'unknown' };
  }
}

/** Split the engine's CSV `symbols` field into a clean array. */
export function eaSymbols(ea: EAInstanceDto): string[] {
  if (!ea?.symbols) return [];
  return ea.symbols
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Compact age ("42s ago") for a number of seconds. */
export function formatAge(ageSec: number): string {
  if (ageSec < 60) return `${Math.floor(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

/** Seconds since an ISO timestamp, or null when missing / unparseable. */
export function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/** Distinct brokers with derived aggregates, most accounts first. */
export function buildBrokerGroups(
  accounts: readonly TradingAccountDto[],
  eaInstances: readonly EAInstanceDto[],
  nowMs: number,
): BrokerGroup[] {
  const accountsByBroker = new Map<string, TradingAccountDto[]>();
  const accountIdToBroker = new Map<number, string>();
  for (const a of accounts) {
    const k = brokerKeyOf(a);
    accountIdToBroker.set(a.id, k);
    const bucket = accountsByBroker.get(k) ?? [];
    bucket.push(a);
    accountsByBroker.set(k, bucket);
  }

  const eaByBroker = new Map<string, EAInstanceDto[]>();
  for (const ea of eaInstances) {
    const brokerKey = accountIdToBroker.get(ea.tradingAccountId);
    if (brokerKey === undefined) continue;
    const bucket = eaByBroker.get(brokerKey) ?? [];
    bucket.push(ea);
    eaByBroker.set(brokerKey, bucket);
  }

  const distinct = (values: (string | null | undefined)[]): string[] =>
    Array.from(new Set(values.map((v) => (v ?? '').trim()).filter((v) => v.length > 0))).sort();

  const out: BrokerGroup[] = [];
  for (const [key, group] of accountsByBroker) {
    const eas = eaByBroker.get(key) ?? [];
    const totalBalance = group.reduce((acc, a) => acc + (a.balance ?? 0), 0);
    const totalEquity = group.reduce((acc, a) => acc + (a.equity ?? 0), 0);
    const totalMargin = group.reduce((acc, a) => acc + (a.marginUsed ?? 0), 0);
    const totalMarginAvailable = group.reduce((acc, a) => acc + (a.marginAvailable ?? 0), 0);
    const heartbeats = eas
      .map((ea) => ageSec(ea.lastHeartbeat, nowMs))
      .filter((v): v is number => v !== null);
    const syncTimes = group
      .map((a) => new Date(a.lastSyncedAt ?? '').getTime())
      .filter((t) => !isNaN(t));

    out.push({
      key,
      slug: brokerSlug(key),
      servers: distinct(group.map((a) => a.brokerServer)),
      companies: distinct(group.map((a) => a.brokerName)),
      currencies: distinct(group.map((a) => a.currency)),
      accounts: group,
      eaInstances: eas,
      realAccounts: group.filter((a) => !a.isPaper && a.accountType === 'Real').length,
      demoAccounts: group.filter((a) => !a.isPaper && a.accountType === 'Demo').length,
      contestAccounts: group.filter((a) => !a.isPaper && a.accountType === 'Contest').length,
      paperAccounts: group.filter((a) => a.isPaper).length,
      activeAccounts: group.filter((a) => a.isActive).length,
      totalBalance,
      totalEquity,
      totalMargin,
      totalMarginAvailable,
      marginUtilizationPct: totalEquity > 0 ? (totalMargin / totalEquity) * 100 : 0,
      activeEas: eas.filter((ea) => ea.status === 'Active').length,
      shuttingDownEas: eas.filter((ea) => ea.status === 'ShuttingDown').length,
      disconnectedEas: eas.filter((ea) => ea.status === 'Disconnected').length,
      newestHeartbeatAgeSec: heartbeats.length > 0 ? Math.min(...heartbeats) : null,
      oldestHeartbeatAgeSec: heartbeats.length > 0 ? Math.max(...heartbeats) : null,
      symbolsCovered: distinct(eas.flatMap(eaSymbols)),
      lastSyncedAt: syncTimes.length > 0 ? new Date(Math.max(...syncTimes)).toISOString() : null,
    });
  }
  return out.sort((a, b) => b.accounts.length - a.accounts.length || a.key.localeCompare(b.key));
}
