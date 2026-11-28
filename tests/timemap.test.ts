import { describe, expect, it } from 'vitest';
import { decodeTable, distKm, makeWarp, placeMinutes, warpLatLng, NONE, type TimemapJson } from '../src/timemap/warp';
import { encodeTable } from '../scripts/build-timemap';

// 中心 A と、東に 10km の B（20 分）、北に 10km の C（40 分）、行けない D
const stations: [string, number, number][] = [
  ['A', 35.4, 139.6],
  ['B', 35.4, 139.6 + 10 / (111.32 * Math.cos((35.4 * Math.PI) / 180))],
  ['C', 35.4 + 10 / 110.57, 139.6],
  ['D', 35.3, 139.5],
];
const rows = [
  [0, 20, 40, Infinity],
  [20, 0, 30, Infinity],
  [40, 30, 0, Infinity],
  [Infinity, Infinity, Infinity, 0],
].map((r) => Float64Array.from(r));
const json: TimemapJson = { generatedAt: '', stations, lines: [], edges: [], t: encodeTable(rows, 4) };
const tt = decodeTable(json);

describe('時間地図の表', () => {
  it('base64 の表を読み戻せる（行けない組は 255）', () => {
    expect(tt.n).toBe(4);
    expect(tt.t[0 * 4 + 1]).toBe(20);
    expect(tt.t[2 * 4 + 1]).toBe(30);
    expect(tt.t[0 * 4 + 3]).toBe(NONE);
  });
});

describe('歪め方', () => {
  const w = makeWarp(tt, 0);
  const at = (i: number) => warpLatLng(w, tt.lat[i], tt.lon[i]);
  const fromCenter = (p: [number, number]) => distKm(p[0], p[1], tt.lat[0], tt.lon[0]);
  it('中心駅は動かない', () => {
    expect(fromCenter(at(0))).toBeCloseTo(0, 6);
  });
  it('駅は「所要時間 × 縮尺」の距離に来る', () => {
    // 縮尺は実距離の合計 ÷ 所要時間の合計 = 20 / 60
    expect(w.k).toBeCloseTo(20 / 60, 6);
    expect(fromCenter(at(1))).toBeCloseTo(w.k * 20, 1);
    expect(fromCenter(at(2))).toBeCloseTo(w.k * 40, 1);
  });
  it('所要時間が長い駅ほど中心から遠い（実距離が同じでも）', () => {
    expect(fromCenter(at(2))).toBeGreaterThan(fromCenter(at(1)));
  });
  it('方角は変わらない', () => {
    const b = at(1);
    expect(b[0]).toBeCloseTo(tt.lat[0], 6); // 東の駅は東のまま
  });
});

describe('場所までの時間', () => {
  it('近くの駅まで電車で行き、そこから歩く', () => {
    // B から東に 0.8km（直線 × 1.3 ÷ 分速 80m = 13 分）
    const lon = tt.lon[1] + 0.8 / (111.32 * Math.cos((35.4 * Math.PI) / 180));
    const r = placeMinutes(tt, 0, tt.lat[1], lon);
    expect(r?.via).toBe(1);
    expect(r?.min).toBeCloseTo(20 + 13, 0);
  });
  it('駅から 2km より遠い場所は出さない', () => {
    expect(placeMinutes(tt, 0, 35.0, 139.0)).toBeNull();
  });
});
