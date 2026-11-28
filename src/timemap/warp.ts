// 時間地図の歪め方（distortMap の computePositions・basemap.js の warpKm と同じ考え方）
//   中心駅からの方角はそのままにして、距離だけを「電車の所要時間 × k」に伸び縮みさせる。
//   駅以外の点（スポット・背景地図の頂点）は、近くの駅の伸縮率を、距離の 4 乗の逆数の重みで混ぜた率で伸ばす。
//   駅の位置ではほぼその駅の伸縮率になるので、駅・スポット・背景地図がずれない

/** timemap.json（scripts/build-timemap.ts が作る） */
export interface TimemapJson {
  generatedAt: string;
  stations: [string, number, number][];
  lines: string[];
  edges: [number, number, number][];
  t: string; // base64（Uint8、駅数×駅数、255 は行けない）
}

export interface TimeTable {
  n: number;
  names: string[];
  lat: Float64Array;
  lon: Float64Array;
  /** 所要時間（分）。t[i * n + j] は駅 i から駅 j。255 は行けない */
  t: Uint8Array;
  lines: string[];
  edges: [number, number, number][];
}

export const NONE = 255;

export function decodeTable(j: TimemapJson): TimeTable {
  const n = j.stations.length;
  const bin = atob(j.t);
  const t = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) t[i] = bin.charCodeAt(i);
  if (t.length !== n * n) throw new Error(`所要時間の表の大きさが合いません（${t.length} ≠ ${n}×${n}）`);
  return {
    n,
    names: j.stations.map((s) => s[0]),
    lat: Float64Array.from(j.stations, (s) => s[1]),
    lon: Float64Array.from(j.stations, (s) => s[2]),
    t,
    lines: j.lines,
    edges: j.edges,
  };
}

const KM_LAT = 110.57;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

export interface Warp {
  center: number;
  lat0: number;
  lon0: number;
  kx: number; // 経度 1 度あたりの km（中心の緯度で）
  /** 所要時間 1 分あたりの km（歪めた地図の縮尺） */
  k: number;
  /** 歪めに使う駅：中心からの km 座標（x 東・y 北）と伸縮率 s */
  pts: { x: number; y: number; s: number }[];
  cache: Map<string, [number, number]>;
}

/** 中心駅 center の歪め方を作る。縮尺 k は「全駅の実距離の合計 ÷ 所要時間の合計」（distortMap と同じ） */
export function makeWarp(tt: TimeTable, center: number): Warp {
  const lat0 = tt.lat[center];
  const lon0 = tt.lon[center];
  const kx = kmLon(lat0);
  const geo: { x: number; y: number; r: number; v: number }[] = [];
  let sumR = 0;
  let sumV = 0;
  for (let j = 0; j < tt.n; j++) {
    const v = tt.t[center * tt.n + j];
    if (j === center || v === NONE || v <= 0) continue;
    const x = (tt.lon[j] - lon0) * kx;
    const y = (tt.lat[j] - lat0) * KM_LAT;
    const r = Math.hypot(x, y);
    if (r < 0.05) continue;
    geo.push({ x, y, r, v });
    sumR += r;
    sumV += v;
  }
  const k = sumV > 0 ? sumR / sumV : 1;
  return { center, lat0, lon0, kx, k, pts: geo.map((g) => ({ x: g.x, y: g.y, s: (k * g.v) / g.r })), cache: new Map() };
}

/** 中心からの km 座標 (x 東, y 北) を歪める */
export function warpKm(w: Warp, x: number, y: number): [number, number] {
  if (!w.pts.length) return [x, y];
  let sw = 0;
  let ss = 0;
  for (const p of w.pts) {
    const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
    const wt = 1 / (d2 * d2 + 1e-4); // 距離の 4 乗に反比例（駅の近くではその駅の値に近づく）
    sw += wt;
    ss += wt * p.s;
  }
  const s = ss / sw;
  return [x * s, y * s];
}

/** 緯度経度を歪めた緯度経度にする（同じ点は覚えておく） */
export function warpLatLng(w: Warp, lat: number, lon: number): [number, number] {
  const key = lat + ',' + lon;
  const hit = w.cache.get(key);
  if (hit) return hit;
  const [x, y] = warpKm(w, (lon - w.lon0) * w.kx, (lat - w.lat0) * KM_LAT);
  const p: [number, number] = [w.lat0 + y / KM_LAT, w.lon0 + x / w.kx];
  if (w.cache.size < 300_000) w.cache.set(key, p);
  return p;
}

/** 中心から所要時間 min 分の円の、歪めた地図での半径（km） */
export const ringKm = (w: Warp, min: number) => w.k * min;

/** 2 点間の km（近い距離用） */
export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return Math.hypot((lon2 - lon1) * kmLon((lat1 + lat2) / 2), (lat2 - lat1) * KM_LAT);
}

/** いちばん近い駅（駅番号） */
export function nearestStation(tt: TimeTable, lat: number, lon: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < tt.n; i++) {
    const d = distKm(lat, lon, tt.lat[i], tt.lon[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** 歩く速さ（道なりは直線の 1.3 倍・分速 80m）と、駅から歩いて行く範囲 */
const WALK_DETOUR = 1.3;
const WALK_KM_PER_MIN = 0.08;
const WALK_MAX_KM = 2;

/**
 * 中心駅から、ある場所まで電車＋徒歩で行く時間（分）と、降りる駅。
 * 近くの駅（2km 以内）まで電車で行き、そこから歩く。行けなければ null
 */
export function placeMinutes(tt: TimeTable, center: number, lat: number, lon: number): { min: number; via: number } | null {
  let best: { min: number; via: number } | null = null;
  for (let j = 0; j < tt.n; j++) {
    if (Math.abs(tt.lat[j] - lat) > 0.02 || Math.abs(tt.lon[j] - lon) > 0.025) continue;
    const d = distKm(lat, lon, tt.lat[j], tt.lon[j]);
    if (d > WALK_MAX_KM) continue;
    const v = tt.t[center * tt.n + j];
    if (v === NONE) continue;
    const min = v + (d * WALK_DETOUR) / WALK_KM_PER_MIN;
    if (!best || min < best.min) best = { min, via: j };
  }
  return best;
}
