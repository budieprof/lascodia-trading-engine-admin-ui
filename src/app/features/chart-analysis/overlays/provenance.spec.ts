import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { EURUSD_H1 } from './__fixtures__/eurusd-h1';
import { marketStructure, type StructureMarker } from './market-structure';
import {
  PROVENANCE,
  provenanceOf,
  structureLevelKey,
  structureMarkerKey,
  structureZoneKey,
  type ProvenanceKey,
} from './provenance';
import { HitRegistry } from './overlay-hits';

const REAL: Ohlc[] = EURUSD_H1.map(([time, open, high, low, close, volume]) => ({
  time,
  open,
  high,
  low,
  close,
  volume,
}));

const KEYS = Object.keys(PROVENANCE) as ProvenanceKey[];

describe('provenance map (PR-4)', () => {
  it('has a title and at least one plain sentence for every key, with or without facts', () => {
    const s = marketStructure(REAL);
    for (const key of KEYS) {
      for (const facts of [{}, { structure: s.basis, bars: 120, rows: 48, label: 'London 20 Oct', touches: 3 }]) {
        const p = provenanceOf(key, facts);
        expect(p.title.length, key).toBeGreaterThan(0);
        expect(p.title, key).toBe(p.title.trim());
        expect(p.lines.length, key).toBeGreaterThan(0);
        for (const line of p.lines) {
          expect(line, key).not.toMatch(/undefined|NaN|\[object/);
          expect(line.trim().length, key).toBeGreaterThan(0);
          expect(line, key).not.toMatch(/ {2}/);
        }
      }
    }
  });

  it('maps every label the structure read draws to its own entry', () => {
    const s = marketStructure(REAL);
    const keys = new Set<ProvenanceKey>([
      ...s.levels.map(structureLevelKey),
      ...s.zones.map(structureZoneKey),
      ...s.markers.map(structureMarkerKey),
    ]);
    for (const k of keys) expect(KEYS).toContain(k);
    // Labels map to the entry that explains THAT label, not a neighbour's.
    const byLabel = Object.fromEntries(s.levels.map((l) => [l.label, structureLevelKey(l)]));
    expect(byLabel).toMatchObject({
      'Range high': 'structure.rangeHigh',
      'Range low': 'structure.rangeLow',
      POC: 'structure.poc',
      VAH: 'structure.vah',
      VAL: 'structure.val',
      Last: 'structure.last',
    });
    for (const z of s.zones) {
      expect(structureZoneKey(z)).toBe(
        z.kind === 'balance' ? 'structure.balance' : z.kind === 'pool' ? 'structure.pool' : 'structure.value',
      );
    }
    const marker = (kind: StructureMarker['kind']) => ({ time: 0, price: 1, label: '', kind });
    expect(structureMarkerKey(marker('spring'))).toBe('structure.spring');
    expect(structureMarkerKey(marker('upthrust'))).toBe('structure.upthrust');
    expect(structureMarkerKey(marker('climax'))).toBe('structure.climax');
  });

  it('says the stop pool is an estimate placed N × ATR beyond the range edge, in pips', () => {
    const s = marketStructure(REAL);
    const p = provenanceOf('structure.pool', { structure: s.basis });
    expect(p.estimate).toBe(true);
    expect(p.title).toMatch(/estimate/i);
    expect(p.lines[0]).toMatch(/^An estimate, not stop data: a band 0\.4 × ATR\(14\) ≈ [\d.]+ pips beyond the range edge/);
    // Nothing else is flagged as an estimate.
    expect(KEYS.filter((k) => provenanceOf(k).estimate)).toEqual(['structure.pool']);
  });

  it('states the balance threshold and bar count from the read itself', () => {
    const s = marketStructure(REAL);
    const line = provenanceOf('structure.balance', { structure: s.basis }).lines[0];
    expect(line).toContain(`${s.basis!.balanceBars} bars here`);
    expect(line).toMatch(/6 × ATR\(14\) ≈ \d+ pips/);
  });

  it('says volume is tick volume wherever a profile is involved', () => {
    for (const key of KEYS.filter((k) => k.startsWith('profile.') && k !== 'profile.npoc'))
      expect(provenanceOf(key).lines.join(' '), key).toMatch(/tick volume/i);
  });
});

describe('hit registry', () => {
  it('prefers a label, then the nearest line, then an area', () => {
    const r = new HitRegistry();
    r.add({ type: 'area', key: 'profile.visible', facts: {}, x0: 0, y0: 0, x1: 100, y1: 100 });
    r.add({ type: 'line', key: 'profile.poc', facts: {}, x0: 0, y0: 50, x1: 100, y1: 50 });
    r.add({ type: 'tag', key: 'profile.vah', facts: {}, x0: 10, y0: 45, x1: 40, y1: 55 });
    expect(r.hit(20, 50)?.key).toBe('profile.vah');
    expect(r.hit(60, 53)?.key).toBe('profile.poc');
    expect(r.hit(60, 80)?.key).toBe('profile.visible');
    expect(r.hit(200, 50)).toBeNull();
  });

  it('finds the alertable level under a right-click, and only alertable ones', () => {
    const r = new HitRegistry();
    r.add({ type: 'line', key: 'sr.level', facts: {}, x0: 0, y0: 30, x1: 100, y1: 30 });
    r.add({
      type: 'line',
      key: 'profile.npoc',
      facts: {},
      x0: 50,
      y0: 60,
      x1: 100,
      y1: 60,
      level: { label: 'nPOC London 20 Oct', price: 1.16234 },
    });
    expect(r.levelAt(70, 64)).toEqual({ label: 'nPOC London 20 Oct', price: 1.16234 });
    // Beyond the line's drawn span, or too far from it: not that level.
    expect(r.levelAt(20, 60)).toBeNull();
    expect(r.levelAt(70, 70)).toBeNull();
    // S/R lines explain themselves on hover but carry no alert.
    expect(r.levelAt(50, 30)).toBeNull();
  });

  it('ignores regions that could not be projected', () => {
    const r = new HitRegistry();
    r.add({ type: 'line', key: 'profile.poc', facts: {}, x0: 0, y0: Number.NaN, x1: 10, y1: 5 });
    expect(r.size).toBe(0);
  });
});
