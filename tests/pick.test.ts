import { describe, expect, it } from 'vitest';
import { hash01, rankInView, weight, type Bounds } from '../src/discover/pick';
import type { Spot } from '../src/types';

const spot = (id: string, over: Partial<Spot> = {}): Spot => ({
  id,
  name: id,
  lat: 35.45,
  lon: 139.4,
  cat: 'park',
  indoor: false,
  f: [],
  kid: 0.6,
  nov: 1,
  rich: 0.4,
  apl: 1,
  ...over,
});

const view: Bounds = { south: 35.4, west: 139.3, north: 35.5, east: 139.5 };
const opts = { count: 3, rainy: false, seen: new Set<string>(), seed: '2026-11-24' };

describe('rankInView', () => {
  it('表示範囲外のスポットは選ばない', () => {
    const r = rankInView([spot('in'), spot('out', { lat: 35.6 })], view, opts);
    expect(r.picks.map((s) => s.id)).toEqual(['in']);
    expect(r.total).toBe(1);
  });

  it('重複なしで指定件数を返し、同じ種・同じ範囲なら結果は同じ', () => {
    const spots = Array.from({ length: 40 }, (_, i) => spot('s' + i, { lat: 35.41 + i * 0.001 }));
    const a = rankInView(spots, view, opts).picks.map((s) => s.id);
    const b = rankInView([...spots].reverse(), view, opts).picks.map((s) => s.id);
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
    expect(b).toEqual(a);
  });

  it('少し地図を動かしても、範囲内に残った候補は入れ替わらない', () => {
    const spots = Array.from({ length: 40 }, (_, i) => spot('s' + i, { lat: 35.41 + i * 0.002 }));
    const a = rankInView(spots, view, opts).picks;
    const moved = { ...view, north: 35.52, south: 35.405 };
    const b = rankInView(spots, moved, opts).picks.map((s) => s.id);
    for (const s of a) if (s.lat >= moved.south) expect(b).toContain(s.id);
  });

  it('種（日付）が変わると顔ぶれが変わる', () => {
    const spots = Array.from({ length: 60 }, (_, i) => spot('s' + i));
    const a = rankInView(spots, view, opts).picks.map((s) => s.id).join();
    const b = rankInView(spots, view, { ...opts, seed: '2026-11-25' }).picks.map((s) => s.id).join();
    expect(a).not.toBe(b);
  });

  it('skip に含まれるものは選ばない', () => {
    const r = rankInView([spot('a'), spot('b')], view, { ...opts, skip: new Set(['a']) });
    expect(r.picks.map((s) => s.id)).toEqual(['b']);
  });

  it('見たことのある場所・雨の日の屋外は重みが下がる', () => {
    const base = { rainy: false, seen: new Set<string>() };
    const s = spot('x');
    const w = weight(s, base);
    expect(weight(s, { ...base, seen: new Set(['x']) })).toBeLessThan(w * 0.2);
    expect(weight(s, { ...base, rainy: true })).toBeLessThan(w * 0.1);
    expect(weight(spot('y', { indoor: true }), { ...base, rainy: true })).toBeCloseTo(w);
  });

  it('雨の日は屋内が足りれば屋内だけから選ぶ', () => {
    const spots = [
      ...Array.from({ length: 30 }, (_, i) => spot('out' + i, { kid: 1 })),
      ...Array.from({ length: 3 }, (_, i) => spot('in' + i, { indoor: true, cat: 'museum' })),
    ];
    const r = rankInView(spots, view, { ...opts, rainy: true });
    expect(r.picks.every((s) => s.indoor)).toBe(true);
  });

  it('公園が大半でも、ほかのグループが混ざる', () => {
    const spots = [
      ...Array.from({ length: 300 }, (_, i) => spot('p' + i, { lat: 35.41 + i * 0.0002 })),
      ...Array.from({ length: 5 }, (_, i) => spot('m' + i, { cat: 'museum', indoor: true })),
      ...Array.from({ length: 5 }, (_, i) => spot('w' + i, { cat: 'water' })),
      ...Array.from({ length: 5 }, (_, i) => spot('z' + i, { cat: 'zoo' })),
    ];
    let parks = 0;
    let total = 0;
    for (let d = 1; d <= 50; d++) {
      for (const s of rankInView(spots, view, { ...opts, count: 6, seed: `day${d}` }).picks) {
        total++;
        if (s.cat === 'park') parks++;
      }
    }
    expect(parks / total).toBeLessThan(0.5);
  });
});

describe('hash01', () => {
  it('0〜1 の範囲で安定している', () => {
    expect(hash01('abc')).toBe(hash01('abc'));
    for (const s of ['a', 'b', 'n123', 'w9999']) {
      expect(hash01(s)).toBeGreaterThan(0);
      expect(hash01(s)).toBeLessThan(1);
    }
  });
});
