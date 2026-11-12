import type { AnalysisMonitorDto, AnalysisMonitorLevel } from '@core/api/api.types';

/**
 * Formatting shared by the monitor board, its cards and the detail drawer, so the three never
 * disagree about what "3h 14m" or "12.4 pips away" means.
 */

/** "3s" / "4m" / "2h 10m" — how long ago something happened. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** "12m" / "3h 14m" / "2d 4h", or "overdue" once past. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'overdue';
  const s = Math.round(seconds);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  return formatAge(s);
}

/**
 * Event notes are written engine-side with C#-style literals ("recurring False → True"); operators
 * read "off → on".
 */
export function humanizeNote(note: string | null | undefined): string {
  if (!note) return '';
  return note.replace(/\bTrue\b/g, 'on').replace(/\bFalse\b/g, 'off');
}

/** Pretty-print a spec, falling back to the raw string — a malformed spec is what you want to SEE. */
export function prettyJson(json: string | null | undefined): string {
  if (!json) return '—';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function utcMs(iso: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
}

/** 0..1 — how much of its armed life (creation → expiry) a monitor has used. */
export function lifeProgress(m: Pick<AnalysisMonitorDto, 'createdAtUtc' | 'expiresAtUtc' | 'status' | 'lastCheckedAtUtc'>, nowMs = Date.now()): number {
  const a = utcMs(m.createdAtUtc);
  const b = utcMs(m.expiresAtUtc);
  if (!(b > a)) return 1;
  // A finished watch stops where it ended, not where the clock is now.
  const end = m.status === 'Active' || m.status === 'Paused' ? nowMs : m.lastCheckedAtUtc ? utcMs(m.lastCheckedAtUtc) : b;
  return Math.min(1, Math.max(0, (end - a) / (b - a)));
}

/**
 * Pip size for a symbol, or null when "pips" means nothing for it. Six-letter FX pairs only: JPY
 * quotes in 0.01, everything else in 0.0001. Metals, indices and crypto get percentages instead.
 */
export function pipSize(symbol: string, price: number): number | null {
  const s = (symbol || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  if (s.length !== 6 || /^(XAU|XAG|XPT|XPD|BTC|ETH)/.test(s)) return null;
  if (price > 500) return null;
  return s.endsWith('JPY') ? 0.01 : 0.0001;
}

/** Signed distance from price to a level: "+12.4 pips" (level above) or "−0.35%". */
export function levelDistance(price: number, level: number, m: Pick<AnalysisMonitorDto, 'symbol'>): string {
  const diff = level - price;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const pip = pipSize(m.symbol, price);
  if (pip) {
    const pips = Math.abs(diff) / pip;
    return `${sign}${pips < 10 ? pips.toFixed(1) : Math.round(pips)} pips`;
  }
  const pct = (Math.abs(diff) / price) * 100;
  return `${sign}${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export interface Proximity {
  level: AnalysisMonitorLevel;
  /** Signed distance in words ("+12.4 pips"). */
  text: string;
  /** 0 (far) .. 1 (at the level) — drives the closeness bar. */
  closeness: number;
  /** Price is above the level. */
  above: boolean;
}

/**
 * The level the watch is closest to WAKING at (trigger or entry; breaks and targets are context,
 * not the thing being waited for), measured from the last price the worker saw.
 */
export function nearestLevel(m: AnalysisMonitorDto): Proximity | null {
  const price = m.lastObservedPrice;
  if (price == null || !m.levels?.length) return null;
  const waits = m.levels.filter((l) => l.kind === 'trigger' || l.kind === 'entry');
  const pool = waits.length ? waits : m.levels;
  let best: AnalysisMonitorLevel | null = null;
  for (const l of pool) if (!best || Math.abs(l.price - price) < Math.abs(best.price - price)) best = l;
  if (!best) return null;
  const pip = pipSize(m.symbol, price);
  // Scale: 100 pips (FX) or 1% (everything else) away reads as "far".
  const far = pip ? 100 * pip : price * 0.01;
  return {
    level: best,
    text: levelDistance(price, best.price, m),
    closeness: Math.max(0, 1 - Math.abs(best.price - price) / far),
    above: price > best.price,
  };
}

/**
 * How often a monitor expects to be evaluated, in seconds — mirrors the engine's
 * `OverdueToleranceSeconds`: deterministic watches every worker loop (2-minute floor), LLM-judged
 * ones at twice their throttle.
 */
export function expectedCadence(m: AnalysisMonitorDto): number {
  return m.evaluationMode === 'Deterministic' ? 120 : Math.max(120, (m.minEvalIntervalSeconds ?? 300) * 2);
}

export function isOverdue(m: AnalysisMonitorDto): boolean {
  if (!m.isLive) return false;
  if (m.secondsSinceLastCheck === null || m.secondsSinceLastCheck === undefined) return true;
  return m.secondsSinceLastCheck > expectedCadence(m);
}

/** Why a live monitor deserves a look now; empty when it does not. */
export function attentionReasons(m: AnalysisMonitorDto): string[] {
  const r: string[] = [];
  if (m.awaitingAckSinceUtc) r.push('needs acknowledgement');
  if ((m.consecutiveEvalErrors ?? 0) > 0) r.push(`${m.consecutiveEvalErrors} failed checks`);
  if (m.status === 'Error') r.push('errored');
  if (isOverdue(m)) r.push('overdue for a check');
  if (m.isLive && (m.secondsToExpiry ?? Infinity) < 3600) r.push('expires within the hour');
  if ((m.maxActionTier ?? 0) >= 2 && !m.dryRunActions) r.push('acts on live trading');
  if ((m.llmSpendCapUsd ?? 0) > 0 && (m.llmSpendUsd ?? 0) / (m.llmSpendCapUsd ?? 1) > 0.8) r.push('near its LLM spend cap');
  return r;
}
