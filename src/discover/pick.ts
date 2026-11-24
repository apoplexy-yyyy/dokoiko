// 発見ロジック：地図の表示範囲にあるスポットから
// 「子供向け × 行く価値 × 意外性 × 情報量 × まだ見ていない」で重み付けし、ジャンルが偏らないように選ぶ。
// 乱数は「スポットID＋今日の日付」から決まるので、同じ日・同じ範囲なら地図を少し動かしても結果が入れ替わらない。
import type { Category, Spot } from '../types';

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface RankOptions {
  count: number;
  rainy: boolean;
  seen: ReadonlySet<string>;
  skip?: ReadonlySet<string>;
  seed: string;
}

/** ジャンルのグループと、そのグループが選ばれる目安の割合 */
export const GROUPS: Record<string, { cats: Category[]; share: number }> = {
  park: { cats: ['park', 'playground'], share: 0.3 },
  nature: { cats: ['nature', 'water', 'view'], share: 0.25 },
  learn: { cats: ['museum', 'library', 'history'], share: 0.2 },
  fun: { cats: ['zoo', 'play', 'farm', 'other'], share: 0.25 },
};
/** グループの重み合計がこれ以上あれば、目安の割合どおりに枠を配る */
const GROUP_REF = 0.8;
const groupOf = new Map<Category, string>(
  Object.entries(GROUPS).flatMap(([g, v]) => v.cats.map((c) => [c, g] as [Category, string])),
);

export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function weight(spot: Spot, opts: Pick<RankOptions, 'rainy' | 'seen'>): number {
  let w = spot.kid * (spot.apl ?? 1) * (0.4 + 0.6 * spot.nov) * (0.5 + spot.rich);
  if (opts.seen.has(spot.id)) w *= 0.12; // 前に見た場所は出にくく
  if (opts.rainy && !spot.indoor) w *= 0.05;
  return Math.max(w, 0);
}

/** 文字列から 0〜1 の安定した乱数（FNV-1a ＋ 末尾の撹拌。末尾1文字の違いでも全ビットが変わる） */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967296;
}

export const inBounds = (s: Spot, b: Bounds) => s.lat >= b.south && s.lat <= b.north && s.lon >= b.west && s.lon <= b.east;

/**
 * 表示範囲から count 件を選ぶ。
 * 重み付きランダム（u^(1/w) の大きい順＝Efraimidis–Spirakis法）でグループ内の順位を決め、
 * グループごとの目安割合に従って枠を配る。
 */
export function rankInView(spots: Spot[], bounds: Bounds, opts: RankOptions): { picks: Spot[]; total: number } {
  let pool: { s: Spot; w: number; key: number; g: string }[] = [];
  for (const s of spots) {
    if (!inBounds(s, bounds) || opts.skip?.has(s.id)) continue;
    const w = weight(s, opts);
    if (w <= 0) continue;
    pool.push({ s, w, key: Math.log(hash01(opts.seed + ":" + s.id)) / w, g: groupOf.get(s.cat) ?? 'fun' });
  }
  const total = pool.length;
  if (opts.rainy) {
    const indoor = pool.filter((x) => x.s.indoor);
    if (indoor.length >= opts.count) pool = indoor;
  }

  const byGroup = new Map<string, typeof pool>();
  for (const x of pool) byGroup.set(x.g, [...(byGroup.get(x.g) ?? []), x]);
  const lanes = [...byGroup].map(([g, list]) => {
    const sum = list.reduce((a, x) => a + x.w, 0);
    return { g, list: list.sort((a, b) => b.key - a.key), quota: (GROUPS[g]?.share ?? 0.1) * Math.min(1, sum / GROUP_REF), used: 0 };
  });

  const picks: Spot[] = [];
  const catUsed = new Map<string, number>();
  while (picks.length < opts.count) {
    // まだ割り当ての少ないグループから（D'Hondt 方式）
    const open = lanes.filter((l) => l.used < l.list.length);
    if (!open.length) break;
    const lane = open.reduce((a, b) => (b.quota / (b.used + 1) > a.quota / (a.used + 1) ? b : a));
    // 同じカテゴリが続かないよう、グループ内で未使用カテゴリを少し優先
    const rest = lane.list.slice(lane.used);
    const idx = rest.findIndex((x, i) => i < 3 && !catUsed.has(x.s.cat));
    const chosen = rest[idx > 0 ? idx : 0];
    lane.list.splice(lane.list.indexOf(chosen), 1);
    lane.list.splice(lane.used, 0, chosen);
    lane.used++;
    picks.push(chosen.s);
    catUsed.set(chosen.s.cat, (catUsed.get(chosen.s.cat) ?? 0) + 1);
  }
  return { picks, total };
}

/** 今日の日付（ローカル）を乱数の種にする */
export const todaySeed = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
