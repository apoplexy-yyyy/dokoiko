// スポット化・スコアリング・重複除去・ニュース照合（純粋関数。単体テスト対象）
import categories from '../../config/categories.json' with { type: 'json' };
import type { Category, Feature, NewsItem, Spot, SpotImage } from '../../src/types.ts';

export interface RawLike {
  id: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  city?: string;
  ha?: number;
}

export interface Enrich {
  desc?: string;
  wpTitle?: string;
  wpExtract?: string;
  img?: SpotImage;
  website?: string;
  sitelinks?: number;
}

/** 近傍判定用のグリッド索引 */
export class PointIndex {
  private cells = new Map<string, [number, number][]>();
  constructor(
    points: [number, number][],
    private size = 0.01,
  ) {
    for (const p of points) {
      const k = this.key(p[0], p[1]);
      const c = this.cells.get(k);
      if (c) c.push(p);
      else this.cells.set(k, [p]);
    }
  }
  private key(lat: number, lon: number) {
    return `${Math.floor(lat / this.size)}_${Math.floor(lon / this.size)}`;
  }
  /** 半径 km 以内に点があるか */
  hasWithin(lat: number, lon: number, km: number): boolean {
    const y = Math.floor(lat / this.size);
    const x = Math.floor(lon / this.size);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const p of this.cells.get(`${y + dy}_${x + dx}`) ?? []) if (distKm(lat, lon, p[0], p[1]) <= km) return true;
    return false;
  }
}

export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** タグに一致するルールのうち、子供向け基礎点が最も高いものを採用 */
export function classify(tags: Record<string, string>) {
  let best: (typeof categories.rules)[number] | undefined;
  const name = tags['name:ja'] ?? tags.name ?? '';
  for (const r of categories.rules) {
    if (tags[r.key] !== r.value) continue;
    const nm = (r as { nameMatch?: string }).nameMatch;
    if (nm && !new RegExp(nm).test(name)) continue; // 例：児童館という名前の community_centre だけ
    if (!best || r.base > best.base) best = r;
  }
  return best;
}

const SIZE_BASED: Category[] = ['park', 'playground'];
const NUMBERED = /第[一二三四五六七八九十〇0-9０-９]+(公園|広場|緑地|遊園)$|[0-9０-９]+号(公園|緑地)$|児童遊園|ちびっこ広場/;

/**
 * 行く価値（わざわざ出かけたくなるか）0-1
 * 公園・遊び場は広さで決め、番号付きの街区公園は控えめにする。それ以外の施設は基本的に高い。
 */
export function appeal(cat: Category, name: string, ha: number | undefined, en: Enrich): number {
  if (!SIZE_BASED.includes(cat)) return cat === 'other' ? 0.6 : cat === 'view' ? 0.7 : 1;
  let a = ha == null ? 0.3 : ha < 0.1 ? 0.12 : ha < 0.3 ? 0.2 : ha < 1 ? 0.4 : ha < 2 ? 0.6 : ha < 5 ? 0.8 : 1;
  if (NUMBERED.test(name)) a *= 0.6;
  if (en.img || en.wpExtract) a += 0.3;
  return clamp(a, 0.05, 1);
}

const FREE_BY_DEFAULT: Category[] =['playground', 'park', 'nature', 'view', 'water', 'history', 'library'];

export function toSpot(raw: RawLike, en: Enrich, near: { playgrounds: PointIndex; toilets: PointIndex }): Spot | null {
  const t = raw.tags;
  const name = t['name:ja'] ?? t.name;
  if (!name || name.length < categories.minNameLength) return null;
  if (categories.excludeAccess.includes(t.access)) return null;
  if (Object.keys(t).some((k) => k.startsWith('disused:') || k.startsWith('abandoned:'))) return null;
  const rule = classify(t);
  if (!rule) return null;

  const cat = rule.cat as Category;
  if (new RegExp(categories.excludeNamePattern).test(name)) return null;
  const catEx = (categories.excludeNameByCategory as Record<string, string>)[cat];
  if (catEx && new RegExp(catEx).test(name)) return null;
  const indoor = !!(rule as { indoor?: boolean }).indoor || t.indoor === 'yes';
  const f: Feature[] = [];
  let kid = rule.base;

  if (cat === 'playground' || near.playgrounds.hasWithin(raw.lat, raw.lon, 0.15)) {
    f.push('playground');
    if (cat !== 'playground') kid += 0.15;
  }
  if (t.toilets === 'yes' || near.toilets.hasWithin(raw.lat, raw.lon, 0.2)) {
    f.push('toilets');
    kid += 0.05;
  }
  if (t.fee === 'no' || (t.fee !== 'yes' && FREE_BY_DEFAULT.includes(cat))) {
    f.push('free');
    kid += 0.05;
  }
  if (t.wheelchair === 'yes') {
    f.push('wheelchair');
    kid += 0.03;
  }
  if (t.changing_table === 'yes' || t.diaper === 'yes') {
    f.push('baby');
    kid += 0.05;
  }
  if (indoor) f.push('indoor');
  const largeArea = raw.ha != null && raw.ha >= 2 && ['park', 'playground', 'nature'].includes(cat);
  if (largeArea) f.unshift('large');

  // 有名すぎる場所（多言語版Wikipediaが多い）ほど意外性を下げる
  const nov = clamp(1 - Math.log10(1 + (en.sitelinks ?? 0)) / 2.2, 0.15, 1);

  const web = t.website ?? t['contact:website'] ?? en.website;
  let rich = 0.4;
  if (en.img) rich += 0.25;
  if (en.wpExtract || en.desc) rich += 0.2;
  if (t.opening_hours || web) rich += 0.1;

  const spot: Spot = {
    id: raw.id,
    name,
    lat: +raw.lat.toFixed(5),
    lon: +raw.lon.toFixed(5),
    cat,
    indoor,
    f,
    kid: r2(clamp(kid)),
    nov: r2(nov),
    rich: r2(clamp(rich)),
    apl: r2(appeal(cat, name, raw.ha, en)),
  };
  if (largeArea) spot.ha = Math.round(raw.ha! * 10) / 10;
  if (raw.city) spot.city = raw.city;
  if (t.opening_hours) spot.hours = t.opening_hours.slice(0, 80);
  if (web && /^https?:\/\//.test(web)) spot.web = web;
  if (t.wikidata) spot.wd = t.wikidata;
  if (en.desc) spot.desc = en.desc;
  if (en.wpTitle && en.wpExtract) spot.wp = { title: en.wpTitle, extract: en.wpExtract };
  if (en.img) spot.img = en.img;
  return spot;
}

const normName = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

/** 同名で 400m 以内のものは1件にまとめる（情報が多い方を残す） */
export function dedupe(spots: Spot[]): Spot[] {
  const byName = new Map<string, Spot[]>();
  for (const s of spots) {
    const k = normName(s.name);
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }
  const out: Spot[] = [];
  const score = (s: Spot) => s.rich * 2 + s.kid + (s.id[0] === 'n' ? 0 : 0.1);
  for (const group of byName.values()) {
    const kept: Spot[] = [];
    for (const s of [...group].sort((a, b) => score(b) - score(a))) {
      const dup = kept.find((k) => distKm(k.lat, k.lon, s.lat, s.lon) < 0.4);
      if (dup) {
        for (const ft of s.f) if (!dup.f.includes(ft)) dup.f.push(ft);
      } else kept.push(s);
    }
    out.push(...kept);
  }
  return out;
}

export interface NewsMatchInput extends NewsItem {
  city?: string;
}

/**
 * ニュースをスポット・市町村に紐付ける
 * - スポット：タイトルにスポット名（4文字以上・地域内で唯一の名前）を含む
 * - 市町村：自治体フィード由来、またはタイトルに市町村名を含み、子供向けキーワードに該当
 */
export function matchNews(
  spots: Spot[],
  news: NewsMatchInput[],
  municipalities: string[],
  keywords: string[],
  excludeKeywords: string[] = [],
  perKey = 5,
): { bySpot: Record<string, NewsItem[]>; byCity: Record<string, NewsItem[]> } {
  const nameCount = new Map<string, number>();
  for (const s of spots) nameCount.set(normName(s.name), (nameCount.get(normName(s.name)) ?? 0) + 1);
  // 「イノシシ」「グラウンド」のような一般名詞を避けるため、漢字を含むか6文字以上の固有名だけを使う
  const candidates = spots.filter((s) => {
    const n = normName(s.name);
    return n.length >= 4 && nameCount.get(n) === 1 && (/\p{Script=Han}/u.test(n) || n.length >= 6);
  });

  const bySpot: Record<string, NewsItem[]> = {};
  const byCity: Record<string, NewsItem[]> = {};
  const push = (m: Record<string, NewsItem[]>, k: string, n: NewsItem) => {
    const list = (m[k] ??= []);
    if (list.length < perKey && !list.some((x) => x.link === n.link)) list.push(n);
  };
  const sorted = [...news].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  for (const raw of sorted) {
    const { city, ...n } = raw;
    if (excludeKeywords.some((k) => n.title.includes(k))) continue; // 入札・募集などの行政手続き
    const title = normName(n.title);
    const hits = candidates.filter((s) => title.includes(normName(s.name)));
    // 「林間公園」と「相模湖林間公園」が両方当たる場合は長い方だけを採用
    for (const s of hits)
      if (!hits.some((o) => o !== s && o.name.length > s.name.length && normName(o.name).includes(normName(s.name))))
        push(bySpot, s.id, n);
    if (!keywords.some((k) => n.title.includes(k))) continue;
    const c = city ?? municipalities.find((m) => n.title.includes(m));
    if (c) push(byCity, c, n);
  }
  return { bySpot, byCity };
}
