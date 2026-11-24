import { describe, expect, it } from 'vitest';
import { Boundary } from '../scripts/collect-osm';

const p = (lat: number, lon: number) => ({ lat, lon });

describe('Boundary', () => {
  it('分割されたウェイと穴（inner）を偶奇判定で扱える', () => {
    // 外周を2本のウェイに分割、内側に穴
    const outerA = [p(0, 0), p(0, 10), p(10, 10)];
    const outerB = [p(10, 10), p(10, 0), p(0, 0)];
    const hole = [p(4, 4), p(4, 6), p(6, 6), p(6, 4), p(4, 4)];
    const b = new Boundary('テスト市', 7, [outerA, outerB, hole]);
    expect(b.contains(2, 2)).toBe(true);
    expect(b.contains(5, 5)).toBe(false);
    expect(b.contains(11, 5)).toBe(false);
  });
});
