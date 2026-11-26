// ⑩ Wikidata の県内施設：OSM に無い博物館・動物園・滝などを追加する候補と、閉館・廃止された施設の一覧
// 結果は .work/wd-spots.json
import region from '../config/region.json' with { type: 'json' };
import { fetchJson } from './lib/http.ts';
import { isMain, writeWork } from './lib/work.ts';
import { loadCityOf } from './lib/cities.ts';
import type { Famous } from './lib/fake.ts';

/** Wikidata の種類（P31 とその上位） → OSM の疑似タグ */
export const WD_TYPES: Record<string, Record<string, string>> = {
  Q33506: { tourism: 'museum' }, // 博物館（美術館・科学館などを含む）
  Q43501: { tourism: 'zoo' }, // 動物園
  Q2281788: { tourism: 'aquarium' }, // 水族館
  Q194195: { tourism: 'theme_park' }, // 遊園地
  Q2416723: { tourism: 'theme_park' }, // テーマパーク
  Q740326: { leisure: 'water_park' }, // ウォーターパーク
  Q148319: { amenity: 'planetarium' }, // プラネタリウム
  Q167346: { leisure: 'nature_reserve' }, // 植物園
  Q34038: { natural: 'waterfall' }, // 滝
  Q40080: { natural: 'beach' }, // 砂浜
  Q832778: { tourism: 'camp_site' }, // キャンプ場
  Q1440300: { 'tower:type': 'observation' }, // 展望台
  Q39816: { natural: 'cave_entrance' }, // 洞窟
};

export interface WdSpot {
  q: string;
  name: string;
  lat: number;
  lon: number;
  city: string;
  tags: Record<string, string>;
  desc?: string;
  web?: string;
  sitelinks: number;
  /** 閉館・廃止された日 */
  ended?: string;
}

interface SparqlRes {
  results: { bindings: Record<string, { value: string }>[] };
}

export async function collectWikidata(): Promise<WdSpot[]> {
  const query = `SELECT ?item ?label ?coord ?type ?desc ?web ?ended ?sl WHERE {
  VALUES ?type { ${Object.keys(WD_TYPES)
    .map((q) => 'wd:' + q)
    .join(' ')} }
  ?item wdt:P131+ wd:${region.wikidata} ; wdt:P31/wdt:P279* ?type ; wdt:P625 ?coord ; wikibase:sitelinks ?sl .
  ?item rdfs:label ?label FILTER(lang(?label) = "ja")
  OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc) = "ja") }
  OPTIONAL { ?item wdt:P856 ?web }
  OPTIONAL { ?item wdt:P576|wdt:P3999|wdt:P582 ?ended }
}`;
  const res = await fetchJson<SparqlRes>('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
    headers: { Accept: 'application/sparql-results+json' },
    ttlHours: 24 * 6,
    timeoutMs: 180_000,
    validate: (t) => {
      if (!(JSON.parse(t) as SparqlRes).results.bindings.length) throw new Error('SPARQL: 結果が空です');
    },
  });
  const cityOf = await loadCityOf();
  const byQ = new Map<string, WdSpot>();
  for (const b of res.results.bindings) {
    const q = b.item.value.split('/').pop()!;
    const m = b.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!m) continue;
    const lat = +m[2];
    const lon = +m[1];
    const prev = byQ.get(q);
    const ended = b.ended?.value.slice(0, 10);
    if (prev) {
      if (ended && !prev.ended) prev.ended = ended;
      continue;
    }
    const city = cityOf(lat, lon);
    if (!city) continue;
    byQ.set(q, {
      q,
      name: b.label.value,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      city,
      tags: { ...WD_TYPES[b.type.value.split('/').pop()!], name: b.label.value, wikidata: q },
      desc: b.desc?.value,
      web: b.web?.value,
      sitelinks: Number(b.sl.value),
      ended,
    });
  }
  const out = [...byQ.values()];
  await writeWork('wd-spots.json', out);
  console.log(`[wikidata-spots] ${out.length} 件（うち閉館・廃止 ${out.filter((s) => s.ended).length} 件）`);
  return out;
}

/** 全国の有名な施設の種類（種類ごとに1回ずつ問い合わせる。まとめて上位の種類までたどると時間切れになる） */
const FAMOUS_TYPES = [
  'Q33506', // 博物館
  'Q207694', // 美術館
  'Q588140', // 科学館
  'Q16735822', // 歴史博物館
  'Q1970365', // 自然史博物館
  'Q43501', // 動物園
  'Q2281788', // 水族館
  'Q194195', // 遊園地
  'Q2416723', // テーマパーク
  'Q740326', // ウォーターパーク
  'Q167346', // 植物園
  'Q148319', // プラネタリウム
  'Q23397', // 湖
  'Q317995', // せき止め湖（河口湖など）
  'Q204324', // 火口湖
  'Q131681', // 貯水池・ダム湖
  'Q34038', // 滝
];

/**
 * 全国の有名な施設（名前と位置）。Overture に混じる「有名な施設の名前を借りた場所」を見分けるのに使う
 * 結果は .work/wd-famous.json
 */
export async function collectFamous(): Promise<Famous[]> {
  const byQ = new Map<string, Famous>();
  for (const t of FAMOUS_TYPES) {
    const query = `SELECT ?item ?label ?coord ?sl WHERE {
  ?item wdt:P31 wd:${t} ; wdt:P17 wd:Q17 ; wdt:P625 ?coord ; wikibase:sitelinks ?sl .
  ?item rdfs:label ?label FILTER(lang(?label) = "ja")
}`;
    try {
      const res = await fetchJson<SparqlRes>('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
        headers: { Accept: 'application/sparql-results+json' },
        ttlHours: 24 * 6,
        timeoutMs: 90_000,
        intervalMs: 1000,
      });
      for (const b of res.results.bindings) {
        const q = b.item.value.split('/').pop()!;
        const m = b.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
        if (!m || byQ.has(q)) continue;
        byQ.set(q, { q, name: b.label.value, lat: +(+m[2]).toFixed(5), lon: +(+m[1]).toFixed(5), sitelinks: Number(b.sl.value) });
      }
    } catch (e) {
      console.warn(`[wikidata-famous] ${t} 失敗（スキップ）: ${(e as Error).message}`);
    }
  }
  const out = [...byQ.values()];
  await writeWork('wd-famous.json', out);
  console.log(`[wikidata-famous] 全国の有名な施設 ${out.length} 件`);
  return out;
}

if (isMain(import.meta.url))
  Promise.all([collectWikidata(), collectFamous()]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
