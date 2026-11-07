/**
 * U12 / C9 + C3 — how a stored backtest was made, read from what the engine stored: the run manifest (`manifestJson`,
 * camelCase: engine build, simulator, script runtime, strategy hashes, libraries, data series + fingerprint, cost model
 * + calibration, every config key read) and the result's intrabar evidence (`AmbiguousBars`, `MagnifierCoverage`
 * fractions). Absent fields stay absent. Pure.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parse(raw: unknown): Json | null {
  if (isObj(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** PascalCase or camelCase. */
function prop(o: Json, camel: string): unknown {
  return camel in o ? o[camel] : o[camel[0].toUpperCase() + camel.slice(1)];
}

export interface ManifestSection {
  title: string;
  rows: { label: string; value: string }[];
}

export interface ManifestView {
  sections: ManifestSection[];
  libraries: string[];
  series: { key: string; count: number | null; span: string; sha: string }[];
  configKeys: { key: string; value: string }[];
  rerunOfRunId: number | null;
}

const short = (h: string, n = 12) => (h.length > n ? `${h.slice(0, n)}…` : h);
const msDay = (v: unknown) => {
  const n = num(v);
  return n === null ? '' : new Date(n).toISOString().slice(0, 16).replace('T', ' ');
};

export function manifestView(raw: unknown, dataFingerprint?: string | null): ManifestView | null {
  const m = parse(raw);
  if (!m) return null;
  const engine = isObj(m['engine']) ? m['engine'] : {};
  const strat = isObj(m['strategy']) ? m['strategy'] : {};
  const data = isObj(m['data']) ? m['data'] : {};
  const costs = isObj(m['costs']) ? m['costs'] : {};
  const calib = isObj(costs['calibration']) ? costs['calibration'] : null;
  const config = isObj(m['config']) ? m['config'] : {};
  const rows = (pairs: [string, unknown][]) =>
    pairs.map(([label, v]) => ({ label, value: str(v) })).filter((r) => r.value !== '');
  const sections: ManifestSection[] = [
    {
      title: 'Engine',
      rows: rows([
        ['Build', engine['informationalVersion'] ?? engine['buildId']],
        ['Source revision', engine['sourceRevision']],
        ['Role', engine['role']],
        ['Simulator', m['simulator']],
        ['Script language', m['scriptLanguageVersion']],
        ['Pine runtime', m['scriptRuntimeVersion']],
        [
          'Elapsed',
          num(m['elapsedMs']) !== null ? `${(num(m['elapsedMs'])! / 1000).toFixed(1)} s` : '',
        ],
      ]),
    },
    {
      title: 'Strategy',
      rows: rows([
        ['Configuration (C1)', strat['strategyConfigHash']],
        [
          'Script source sha256',
          str(strat['scriptSourceSha256']) && short(str(strat['scriptSourceSha256']), 16),
        ],
        [
          'Parameters sha256',
          str(strat['parametersSha256']) && short(str(strat['parametersSha256']), 16),
        ],
        ['Market', [str(strat['symbol']), str(strat['timeframe'])].filter(Boolean).join(' ')],
        [
          'Window (UTC)',
          [str(strat['fromUtc']).slice(0, 10), str(strat['toUtc']).slice(0, 10)]
            .filter(Boolean)
            .join(' → '),
        ],
        ['Initial balance', strat['initialBalance']],
      ]),
    },
    {
      title: 'Data and costs',
      rows: rows([
        [
          'Data fingerprint',
          str(data['fingerprint'] ?? dataFingerprint ?? '') &&
            short(str(data['fingerprint'] ?? dataFingerprint), 16),
        ],
        ['Cost model', costs['costModel'] ?? costs['costModelKey']],
        ['TCA profile', costs['tcaProfile']],
        [
          'Options snapshot sha256',
          str(costs['optionsSnapshotSha256']) && short(str(costs['optionsSnapshotSha256']), 16),
        ],
        [
          'Calibration',
          calib
            ? [str(calib['mode']), str(calib['brokerKey']), str(calib['fitVersion'])]
                .filter(Boolean)
                .join(' · ')
            : '',
        ],
        ['Config hash', str(config['hash']) && short(str(config['hash']), 16)],
      ]),
    },
  ].filter((s) => s.rows.length > 0);
  const libraries = (Array.isArray(m['libraries']) ? m['libraries'] : [])
    .filter(isObj)
    .map((l) => `${str(l['publisher'])}/${str(l['name'])}/${str(l['version'])}`);
  const series = (Array.isArray(data['series']) ? data['series'] : []).filter(isObj).map((s) => ({
    key: str(s['key']),
    count: num(s['count']),
    span: [msDay(s['firstMs']), msDay(s['lastMs'])].filter(Boolean).join(' → '),
    sha: short(str(s['sha256']), 12),
  }));
  const keys = isObj(config['keys']) ? config['keys'] : {};
  const configKeys = Object.entries(keys)
    .map(([key, v]) => ({ key, value: str(v) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { sections, libraries, series, configKeys, rerunOfRunId: num(m['rerunOfRunId']) };
}

export interface IntrabarEvidence {
  ambiguousBars: number | null;
  /** Fractions (0..1) of walked bars by fill path. */
  coverage: {
    tick: number | null;
    m1: number | null;
    lower: number | null;
    ohlc: number | null;
    bars: number | null;
  } | null;
  resolution: string;
}

/** The engine result's C3 fields (`AmbiguousBars`, `MagnifierCoverage`, `script.intrabarResolution`); null when none. */
export function intrabarEvidence(resultJson: unknown): IntrabarEvidence | null {
  const r = parse(resultJson);
  if (!r) return null;
  const amb = num(prop(r, 'ambiguousBars'));
  const cov = prop(r, 'magnifierCoverage');
  const script = prop(r, 'script');
  const resolution = isObj(script) ? str(script['intrabarResolution']) : '';
  const coverage = isObj(cov)
    ? {
        tick: num(prop(cov, 'tick')),
        m1: num(prop(cov, 'm1') ?? cov['M1']),
        lower: num(prop(cov, 'lower')),
        ohlc: num(prop(cov, 'ohlc')),
        bars: num(prop(cov, 'bars')),
      }
    : null;
  if (amb === null && !coverage && !resolution) return null;
  return { ambiguousBars: amb, coverage, resolution };
}
