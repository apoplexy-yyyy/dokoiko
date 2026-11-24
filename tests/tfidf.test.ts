import { describe, expect, it } from 'vitest';
import { areaTfIdf, rankInView } from '../src/discover/pick';
import { computeIdf, extractTerms } from '../scripts/lib/terms';
import type { Spot, Term } from '../src/types';

describe('extractTerms', () => {
  it('タグと名前から特徴語を作り、同じ語はまとめる', () => {
    expect(extractTerms({ natural: 'waterfall' }, '不動滝')).toEqual(['滝']);
    expect(extractTerms({ leisure: 'park' }, '田浦梅林', true).sort()).toEqual(['公園', '広い公園', '梅'].sort());
    expect(extractTerms({ leisure: 'park' }, '横浜公園')).toEqual(['公園']); // 「浜」は地名なので海辺にしない
  });
  it('IDF はどこにでもある語ほど小さい', () => {
    const idf = computeIdf([['公園'], ['公園'], ['公園'], ['公園', '滝']]);
    expect(idf.get('公園')!).toBeLessThan(idf.get('滝')!);
  });
});

const mk = (id: string, t: number[], over: Partial<Spot> = {}): Spot => ({
  id, name: id, lat: 35.45, lon: 139.4, cat: 'park', indoor: false, f: [], kid: 0.6, nov: 1, rich: 0.4, apl: 1, t, ...over,
});
const terms: Term[] = [
  { label: '公園', idf: 0.4 },
  { label: '滝', idf: 6 },
];

describe('areaTfIdf', () => {
  it('珍しい語を持つスポットの特徴度が高く、ありふれた語は特徴に出ない', () => {
    const spots = [...Array.from({ length: 50 }, (_, i) => mk('p' + i, [0])), mk('fall', [1], { cat: 'nature' })];
    const { score, keywords } = areaTfIdf(spots, terms);
    expect(score.get('fall')).toBe(1);
    expect(score.get('p0')!).toBeLessThan(0.5);
    expect(keywords.map((k) => k.label)).toEqual(['滝']);
  });

  it('TF-IDF を使うと、公園だらけの範囲でも滝が選ばれやすい', () => {
    const spots = [...Array.from({ length: 200 }, (_, i) => mk('p' + i, [0], { lat: 35.41 + i * 0.0003 })), mk('fall', [1], { cat: 'park' })];
    const view = { south: 35.4, west: 139.3, north: 35.5, east: 139.5 };
    let withT = 0;
    let without = 0;
    for (let d = 0; d < 100; d++) {
      const base = { count: 2, rainy: false, seen: new Set<string>(), seed: 'd' + d };
      if (rankInView(spots, view, { ...base, terms }).picks.some((s) => s.id === 'fall')) withT++;
      if (rankInView(spots, view, base).picks.some((s) => s.id === 'fall')) without++;
    }
    expect(withT).toBeGreaterThan(without * 3);
  });
});
