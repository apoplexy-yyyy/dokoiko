// 発見ロジック：地図の表示範囲にあるスポットから
// 「子供向け × 行く価値 × 意外性 × 情報量 × まだ見ていない」で重み付けし、ジャンルが偏らないように選ぶ。
// 乱数は「スポットID＋今日の日付」から決まるので、同じ日・同じ範囲なら地図を少し動かしても結果が入れ替わらない。
import type { Category, Spot, Term } from '../types';

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
  /** 特徴語の一覧（Meta.terms）。あれば TF-IDF で重み付けする */
  terms?: Term[];
}

/** ジャンルのグループと、そのグループが選ばれる目安の割合 */
export const GROUPS: Record<string, { cats: Category[]; share: number }> = {
  park: { cats: ['park', 'playground'], share: 0.15 },
  nature: { cats: ['nature', 'water', 'view'], share: 0.2 },
  learn: { cats: ['museum', 'library', 'history'], share: 0.2 },
  kids: { cats: ['kids'], share: 0.2 },
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

export interface AreaKeyword {
  label: string;
  count: number;
}

/** これより IDF が小さい語（公園など、どこにでもある語）は「この範囲の特徴」に出さない */
const COMMON_IDF = 1.5;

/**
 * 表示範囲の TF-IDF。語の重み = (1 + ln 範囲内の出現数) × IDF（県全体での珍しさ）。
 * どこにでもある語（公園）は低く、県内では珍しいがこの範囲にある語（滝・古墳・梅林など）は高くなる。
 * スポットの特徴度 = 持っている語の重みの最大値を、範囲内の最大値で割ったもの（0〜1）。
 */
export function areaTfIdf(spots: Spot[], terms: Term[]): { score: Map<string, number>; keywords: AreaKeyword[] } {
  const count = new Map<number, number>();
  for (const s of spots) for (const t of s.t ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  const tfidf = new Map<number, number>();
  for (const [t, c] of count) tfidf.set(t, (1 + Math.log(c)) * (terms[t]?.idf ?? 0));

  const raw = new Map<string, number>();
  let max = 0;
  for (const s of spots) {
    const v = Math.max(0, ...(s.t ?? []).map((t) => tfidf.get(t) ?? 0));
    raw.set(s.id, v);
    max = Math.max(max, v);
  }
  const score = new Map([...raw].map(([id, v]) => [id, max > 0 ? v / max : 0]));
  const keywords = [...tfidf]
    .filter(([t]) => (terms[t]?.idf ?? 0) >= COMMON_IDF)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t]) => ({ label: terms[t].label, count: count.get(t)! }));
  return { score, keywords };
}

/**
 * 表示範囲から count 件を選ぶ。
 * 基本の重みに「この範囲での特徴度（TF-IDF）」を掛け、
 * 重み付きランダム（u^(1/w) の大きい順＝Efraimidis–Spirakis法）でグループ内の順位を決め、
 * グループごとの目安割合に従って枠を配る。
 */
export function rankInView(
  spots: Spot[],
  bounds: Bounds,
  opts: RankOptions,
): { picks: Spot[]; others: Spot[]; total: number; keywords: AreaKeyword[] } {
  const inView = spots.filter((s) => inBounds(s, bounds) && !opts.skip?.has(s.id));
  const { score, keywords } = areaTfIdf(inView, opts.terms ?? []);
  const useTfIdf = !!opts.terms?.length;

  let pool: { s: Spot; w: number; key: number; g: string }[] = [];
  for (const s of inView) {
    let w = weight(s, opts);
    if (useTfIdf) w *= 0.15 + 0.85 * (score.get(s.id) ?? 0);
    if (w <= 0) continue;
    pool.push({ s, w, key: Math.log(hash01(opts.seed + ':' + s.id)) / w, g: groupOf.get(s.cat) ?? 'fun' });
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
  // 選ばれなかった場所も、同じ重み付きランダムの順に並べて返す（地図に重ならない範囲で出す）
  const chosen = new Set(picks.map((s) => s.id));
  const others = pool.filter((x) => !chosen.has(x.s.id)).sort((a, b) => b.key - a.key).map((x) => x.s);
  return { picks, others, total, keywords };
}

/** 今日の日付（ローカル）を乱数の種にする */
export const todaySeed = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
