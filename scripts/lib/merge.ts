// OSM 以外の情報源（Overture・神奈川県・GBIF）を、OSM 由来のスポットに統合する
import { distKm } from '../../src/discover/pick.ts';
import type { Spot } from '../../src/types.ts';
import type { GbifObs } from '../collect-gbif.ts';
import type { OvertureSpot } from '../collect-overture.ts';
import type { PrefKids, PrefVisitors } from '../collect-pref.ts';
import { PointIndex, toSpot } from './score.ts';

type Near = { playgrounds: PointIndex; toilets: PointIndex };

/** 名前の比較用：全角半角・空白・かっこ・「市立」などの接頭辞をそろえる */
export function normName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[≪《].*?[≫》]|公式/g, '')
    .replace(/[\s・･「」『』()（）［］[\]【】〈〉<>"'’`~〜-]/g, '')
    .replace(/^(神奈川県立|県立|横浜市立|川崎市立|相模原市立|[^\s]{1,4}[市町村]立|(横浜|川崎|相模原|横須賀|藤沢|平塚|小田原|茅ヶ崎|鎌倉)市)/, '')
    .toLowerCase();
}

const GENERIC =
  /(こども文化センター|子ども文化センター|こどもセンター|子どもセンター|子育て支援センター|児童センター|児童館|児童室|子どもの家|こどもの家|図書館|図書室|分館|美術館|博物館|資料館|記念館|科学館|水族館|動物園|植物園|ミュージアム|センター|キャンプ場|オートキャンプ場|農園|牧場|ファーム|直売所|海岸|海水浴場|ビーチ|の滝|滝|展望台|公園)$/;

/** 同じ施設を指していそうか（片方がもう片方を含む、または文字の重なりが大きい） */
export function sameName(a: string, b: string): boolean {
  const x0 = normName(a);
  const y0 = normName(b);
  if (x0.length < 2 || y0.length < 2) return false;
  if (x0 === y0) return true;
  // 「〇〇こどもセンター」「〇〇図書館」のような共通の語尾は除き、固有の部分で比べる（別の分館を同じとみなさないため）
  const gx = x0.match(GENERIC)?.[0];
  const gy = y0.match(GENERIC)?.[0];
  if (gx && gy && gx !== gy) return false; // 「金沢図書館」と「金沢動物園」は別
  const x = x0.replace(GENERIC, '');
  const y = y0.replace(GENERIC, '');
  if (x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) return true;
  const bi = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const bx = bi(x);
  const by = bi(y);
  let common = 0;
  for (const g of bx) if (by.has(g)) common++;
  return (2 * common) / (bx.size + by.size) >= 0.75;
}

const municipality = (city?: string) => city?.match(/^.+?[市町村]/)?.[0] ?? city;

/**
 * 同じ施設とみなせるスポット：近く（km 以内）で名前が一致するもの。
 * city を渡すと、同じ市町村で 4 文字以上の名前が一致するものも同じとみなす（座標のずれに強くする）
 */
function findSame(spots: Spot[], lat: number, lon: number, name: string, km: number, city?: string): Spot | undefined {
  let best: Spot | undefined;
  let bd = Infinity;
  if (city && normName(name).length >= 4) {
    const m = municipality(city);
    const hit = spots.find((s) => municipality(s.city) === m && normName(s.name).length >= 4 && sameName(s.name, name));
    if (hit) return hit;
  }
  for (const s of spots) {
    if (Math.abs(s.lat - lat) > 0.02 || Math.abs(s.lon - lon) > 0.025) continue;
    const d = distKm(lat, lon, s.lat, s.lon);
    if (d <= km && d < bd && sameName(s.name, name)) {
      best = s;
      bd = d;
    }
  }
  return best;
}

/** 県の児童館データ：既存の児童館に開館時間・対象年齢・URLを足し、無ければ追加する */
export function mergePrefKids(spots: Spot[], kids: PrefKids[], near: Near): number {
  let added = 0;
  for (const k of kids) {
    const hours = [k.hours, k.closed].filter(Boolean).join('（') + (k.hours && k.closed ? '）' : '');
    const s = findSame(spots, k.lat, k.lon, k.name, 0.6);
    if (s) {
      if (!s.hours && hours) s.hours = hours.slice(0, 120);
      if (!s.web && k.web) s.web = k.web;
      if (k.ages.length) s.ages = k.ages;
      if (s.cat !== 'kids') s.cat = 'kids';
      continue;
    }
    const n = toSpot({ id: k.id, lat: k.lat, lon: k.lon, city: k.city, tags: { leisure: 'indoor_play', name: k.name } }, { website: k.web }, near);
    if (!n) continue;
    if (hours) n.hours = hours.slice(0, 120);
    if (k.ages.length) n.ages = k.ages;
    n.src = '神奈川県';
    spots.push(n);
    added++;
  }
  return added;
}

/** Overture：OSM に無い施設だけを追加する（近くに同じ名前があれば URL だけ補う） */
export function mergeOverture(spots: Spot[], ov: OvertureSpot[], near: Near): number {
  let added = 0;
  for (const o of ov) {
    // Overture は座標が数百mずれることがあるので、少し広めに同じ名前を探す
    const s = findSame(spots, o.lat, o.lon, o.name, 0.8, o.city);
    if (s) {
      if (!s.web && o.web) s.web = o.web;
      continue;
    }
    const n = toSpot({ id: o.id, lat: o.lat, lon: o.lon, city: o.city, tags: o.tags }, { website: o.web }, near);
    if (!n) continue;
    n.src = 'Overture';
    spots.push(n);
    added++;
  }
  return added;
}

/** 入込観光客調査：主要施設の年間来訪者数。来訪者が多いほど「意外性」を下げる */
export function applyVisitors(spots: Spot[], visitors: PrefVisitors[]): number {
  let hit = 0;
  const byCity = new Map<string, PrefVisitors[]>();
  for (const v of visitors) if (v.kind !== '行事') byCity.set(v.city, [...(byCity.get(v.city) ?? []), v]);
  for (const s of spots) {
    const city = s.city?.match(/^.+?[市町村]/)?.[0];
    const list = city ? byCity.get(city) : undefined;
    const v = list?.find((x) => sameName(x.name, s.name));
    if (!v) continue;
    s.vis = v.thousand;
    const byVisitors = Math.min(1, Math.max(0.15, 1 - Math.log10(1 + v.thousand) / 3.5));
    s.nov = Math.round(Math.min(s.nov, byVisitors) * 100) / 100;
    hit++;
  }
  return hit;
}

/** GBIF：生きものが見つかった 1km 升目を「生きもの観察」スポットにする */
export function gbifSpots(cells: GbifObs[], cityOf: (lat: number, lon: number) => string | undefined): Spot[] {
  const out: Spot[] = [];
  for (const c of cells) {
    const city = cityOf(c.lat, c.lon);
    if (!city) continue;
    const total = c.sp.reduce((a, x) => a + x.n, 0);
    const names = c.sp.map((x) => x.ja);
    out.push({
      id: 'g' + c.cell,
      name: `${names.slice(0, 2).join('・')}${names.length > 2 ? 'など' : ''}の観察地点`,
      lat: c.lat,
      lon: c.lon,
      cat: 'creature',
      city,
      indoor: false,
      f: [],
      kid: 0.8,
      nov: 1,
      rich: 0.5,
      apl: Math.round(Math.min(1, 0.45 + 0.12 * Math.log2(1 + total) + 0.05 * names.length) * 100) / 100,
      obs: c.sp.map((x) => ({ ja: x.ja, n: x.n, m: x.months, key: x.key })),
      src: 'GBIF',
      tl: ['生きもの観察', ...names],
    });
  }
  return out;
}
