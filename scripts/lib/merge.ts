// OSM 以外の情報源（Overture・神奈川県・GBIF）を、OSM 由来のスポットに統合する
import { distKm } from '../../src/discover/pick.ts';
import { COAST_KM, PLACE_KM, coastDistKm, misplacedFamous, misplacedPlace, type Famous, type Place } from './fake.ts';
import { normName } from './name.ts';
export { normName };
import type { Spot } from '../../src/types.ts';
import type { GbifObs } from '../collect-gbif.ts';
import type { OvertureSpot } from '../collect-overture.ts';
import type { BabyCare, PrefKids, PrefLibrary, PrefPark, PrefVisitors } from '../collect-pref.ts';
import type { WdSpot } from '../collect-wikidata.ts';
import { wikidataClosure } from './closed.ts';
import { PointIndex, toSpot } from './score.ts';

type Near = { playgrounds: PointIndex; toilets: PointIndex };

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
export function findSame(spots: Spot[], lat: number, lon: number, name: string, km: number, city?: string): Spot | undefined {
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
export function mergePrefKids(spots: Spot[], kids: PrefKids[], near: Near, src = '神奈川県'): number {
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
    n.src = src;
    spots.push(n);
    added++;
  }
  return added;
}

/** Overture：OSM に無い施設だけを追加する（近くに同じ名前があれば URL だけ補う） */
export function mergeOverture(
  spots: Spot[],
  ov: OvertureSpot[],
  near: Near,
  famous: Famous[] = [],
  dropped: string[] = [],
  coast: [number, number][] = [],
  places: Place[] = [],
): number {
  let added = 0;
  for (const o of ov) {
    // Overture は座標が数百mずれることがあるので、少し広めに同じ名前を探す
    const s = findSame(spots, o.lat, o.lon, o.name, 0.8, o.city);
    if (s) {
      if (!s.web && o.web) s.web = o.web;
      continue;
    }
    // 有名な施設の名前を借りた場所（本物は遠くにある）は入れない
    const f = misplacedFamous(o.name, o.lat, o.lon, famous);
    if (f) {
      dropped.push(`${o.name}（${o.city}。本物の「${f.name}」は遠く）`);
      continue;
    }
    // 砂浜・海水浴場なのに海から遠い場所（「湘南 鵠沼海岸」が横浜市南区にあるなど）は入れない
    if (o.tags.natural === 'beach' || o.tags.leisure === 'beach_resort') {
      const d = coastDistKm(o.lat, o.lon, coast);
      if (d > COAST_KM) {
        dropped.push(`${o.name}（${o.city}。海から ${d.toFixed(1)}km）`);
        continue;
      }
      // 名前の地名が近くに無い（「津久井浜」が横浜市金沢区にあるなど）
      const pl = misplacedPlace(o.name, o.lat, o.lon, places);
      if (pl) {
        dropped.push(`${o.name}（${o.city}。「${pl}」は ${PLACE_KM}km より遠く）`);
        continue;
      }
    }
    const n = toSpot({ id: o.id, lat: o.lat, lon: o.lon, city: o.city, tags: o.tags }, { website: o.web }, near);
    if (!n) continue;
    n.src = 'Overture';
    spots.push(n);
    added++;
  }
  return added;
}

/**
 * Wikidata の県内施設：OSM に無いものを追加し、閉館・廃止日のあるものは同じ施設を地図から消す
 * 戻り値：追加数・削除したスポット名
 */
export function mergeWikidata(spots: Spot[], items: WdSpot[], near: Near): { added: number; removed: string[] } {
  let added = 0;
  const removed: string[] = [];
  for (const w of items) {
    const byQ = spots.findIndex((s) => s.wd === w.q);
    if (wikidataClosure(w.ended)) {
      // 消すときは確実なものだけ：同じ QID か、1km 以内で同じ名前
      const i = byQ >= 0 ? byQ : spots.findIndex((s) => normName(s.name) === normName(w.name) && distKm(s.lat, s.lon, w.lat, w.lon) <= 1);
      if (i >= 0) removed.push(...spots.splice(i, 1).map((s) => `${s.name}（${w.ended} 閉館・廃止）`));
      continue;
    }
    const i = byQ >= 0 ? byQ : spots.indexOf(findSame(spots, w.lat, w.lon, w.name, 0.6, w.city)!);
    if (i >= 0) {
      const s = spots[i];
      if (!s.wd) s.wd = w.q;
      if (!s.desc && w.desc) s.desc = w.desc;
      if (!s.web && w.web) s.web = w.web;
      continue;
    }
    const n = toSpot({ id: w.q, lat: w.lat, lon: w.lon, city: w.city, tags: w.tags }, { desc: w.desc, website: w.web, sitelinks: w.sitelinks }, near);
    if (!n) continue;
    n.src = 'Wikidata';
    spots.push(n);
    added++;
  }
  return { added, removed };
}

const addFeature = (s: Spot, f: Spot['f'][number], kid = 0) => {
  if (s.f.includes(f)) return;
  s.f.push(f);
  s.kid = Math.round(Math.min(1, s.kid + kid) * 100) / 100;
};
const addTerms = (s: Spot, terms: string[]) => {
  if (terms.length) s.tl = [...new Set([...(s.tl ?? []), ...terms])];
};

const PARK_CATS: Spot['cat'][] = ['park', 'playground', 'nature'];
/** 公園の名前を比べる形に（空白・県立など・「ケ」「ヶ」「ヵ」の違いをそろえる） */
export const parkKey = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/^(神奈川)?(県立|市立|町立|村立)/, '')
    .replace(/[ケヵｹ]/g, 'ヶ');
/** 市区町村を比べる形に（横浜市保土ケ谷区と横浜市保土ヶ谷区を同じに） */
const cityKey = (city?: string) => (city ?? '').normalize('NFKC').replace(/[ケヵｹ]/g, 'ヶ');

/**
 * 県の公園データ：名前と市町村が合うスポットに遊具・トイレ・設備（特徴語）を足す。
 * 住所から位置を求めた目立つ公園（珍しい設備・1ha 以上で遊具）は、スポットに無ければ追加する
 */
export function mergePrefParks(spots: Spot[], parks: PrefPark[], near: Near): { matched: number; added: number } {
  let matched = 0;
  let added = 0;
  const apply = (s: Spot, p: PrefPark) => {
    if (p.play) addFeature(s, 'playground', 0.1);
    if (p.toilets) addFeature(s, 'toilets', 0.05);
    addTerms(s, p.terms);
    if (!s.hours && p.hours) s.hours = p.hours;
    if (!s.web && p.web) s.web = p.web;
  };
  // 公園は「〇〇第三公園」「〇〇第五公園」のように一字違いの別の公園が多いので、名前が正規化して完全に同じで、
  // 同じ区・市町村の公園・遊び場・自然のスポットだけを同じとみなす（位置の分かる公園は 3km 以内）
  const byKey = new Map<string, Spot[]>();
  for (const s of spots)
    if (PARK_CATS.includes(s.cat)) {
      const k = parkKey(s.name) + '|' + cityKey(s.city);
      byKey.set(k, [...(byKey.get(k) ?? []), s]);
    }
  for (const p of parks) {
    const cands = byKey.get(parkKey(p.name) + '|' + cityKey(p.city)) ?? [];
    // 住所から求めた位置はずれることがあるので、同じ区・市町村に同じ名前の公園が 1 つだけなら位置によらず同じとみなす
    const s = cands.length === 1 ? cands[0] : cands.find((c) => p.lat == null || distKm(p.lat, p.lon!, c.lat, c.lon) <= 3);
    if (s) {
      apply(s, p);
      matched++;
      continue;
    }
    if (p.lat == null || p.lon == null) continue;
    // 近くに似た名前のスポットがあれば追加しない（「〇〇公園 花の苑地」のような一部の区域の名前のもの）
    if (findSame(spots, p.lat, p.lon, p.name, 0.5)) continue;
    const n = toSpot({ id: p.id, lat: p.lat, lon: p.lon, city: p.city, ha: p.ha, tags: { leisure: 'park', name: p.name } }, { website: p.web }, near);
    if (!n) continue;
    apply(n, p);
    n.src = '神奈川県';
    spots.push(n);
    added++;
  }
  return { matched, added };
}

/** 県の図書館データ：おむつ・授乳と読み聞かせスペースを足す。スポットに無い図書館は追加する */
export function mergePrefLibraries(spots: Spot[], libs: PrefLibrary[], near: Near): { matched: number; added: number } {
  let matched = 0;
  let added = 0;
  for (const l of libs) {
    // 図書館どうしが 300m 以内に並ぶことはまず無いので、近くの図書館は名前が違っても同じとみなす（「港北図書館・菊名地区センター」など）
    let s =
      findSame(spots, l.lat, l.lon, l.name, 0.5, l.city) ??
      spots.find((c) => c.cat === 'library' && Math.abs(c.lat - l.lat) < 0.004 && Math.abs(c.lon - l.lon) < 0.005 && distKm(l.lat, l.lon, c.lat, c.lon) <= 0.3);
    if (!s) {
      const n = toSpot({ id: l.id, lat: l.lat, lon: l.lon, city: l.city, tags: { amenity: 'library', name: l.name } }, { website: l.web }, near);
      if (!n) continue;
      n.src = '神奈川県';
      spots.push(n);
      added++;
      s = n;
    } else matched++;
    if (l.baby) addFeature(s, 'baby', 0.05);
    if (l.story) addTerms(s, ['読み聞かせ']);
    if (!s.web && l.web) s.web = l.web;
  }
  return { matched, added };
}

/** 施設名を比べる形に（空白・かっこ・「横浜市立」「県立」などを除く） */
const facilityKey = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/[\s「」『』"“”・]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/^(神奈川県立|横浜市立|川崎市立|相模原市立|横浜市|県立|市立)/, '')
    .replace(/[ケヵｹ]/g, 'ヶ');
const SHOP = /(薬局|医院|クリニック|病院|歯科|店)$/;
/** 同じ施設の名前か：同じか、片方がもう片方をほぼ丸ごと含む（短い方が長い方の 7 割以上） */
export function sameFacility(a: string, b: string): boolean {
  const x = facilityKey(a);
  const y = facilityKey(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return l.includes(s) && s.length / l.length >= 0.7;
}

/**
 * おむつ替え・授乳ができる施設（ハマハグ・子育て応援パスポート）：同じ施設のスポットに「おむつ・授乳」を付ける。
 * お店や病院が多く、「〇〇駅前薬局」と「〇〇駅前公園」のような取り違えが起きやすいので、名前はほぼ同じものだけ。
 * 座標があれば 200m 以内、無ければ同じ区・市町村の中で探す
 */
export function applyBabyCare(spots: Spot[], list: BabyCare[]): number {
  let hit = 0;
  for (const b of list) {
    const s = spots.find((c) => {
      if (b.lat != null && b.lon != null) {
        if (Math.abs(c.lat - b.lat) > 0.003 || Math.abs(c.lon - b.lon) > 0.004 || distKm(b.lat, b.lon, c.lat, c.lon) > 0.2) return false;
      } else if (!b.city || cityKey(c.city) !== cityKey(b.city)) return false;
      // お店・病院は名前が同じときだけ（「よみうりランド薬局」を「よみうりランド」としない）
      if (SHOP.test(b.name.trim())) return facilityKey(c.name) === facilityKey(b.name);
      return sameFacility(c.name, b.name);
    });
    if (!s || s.f.includes('baby')) continue;
    addFeature(s, 'baby', 0.05);
    hit++;
  }
  return hit;
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
