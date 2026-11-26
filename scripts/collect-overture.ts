// ⑧ Overture Maps の施設データ（Meta・Microsoft・Foursquare などの店舗・施設情報を統合したオープンデータ）
// 子供と行ける種類だけを取り出し、OSM と同じ形（疑似タグ）にして .work/overture.json に保存する
// ライセンス：CDLA Permissive 2.0（Foursquare 由来は Apache 2.0、AllThePlaces 由来は CC0）
import { DuckDBInstance } from '@duckdb/node-api';
import region from '../config/region.json' with { type: 'json' };
import { fetchJson } from './lib/http.ts';
import { isMain, writeWork } from './lib/work.ts';
import { loadCityOf } from './lib/cities.ts';

/** Overture のカテゴリ → OSM の疑似タグ（categories.json のルールで分類される） */
export const CATEGORY_TAGS: Record<string, Record<string, string>> = {
  playground: { leisure: 'playground' },
  amusement_park: { tourism: 'theme_park' },
  water_park: { leisure: 'water_park' },
  swimming_pool: { leisure: 'water_park' },
  zoo: { tourism: 'zoo' },
  petting_zoo: { tourism: 'zoo' },
  aquarium: { tourism: 'aquarium' },
  museum: { tourism: 'museum' },
  art_museum: { tourism: 'museum' },
  history_museum: { tourism: 'museum' },
  science_museum: { tourism: 'museum' },
  childrens_museum: { tourism: 'museum' },
  community_museum: { tourism: 'museum' },
  sports_museum: { tourism: 'museum' },
  cartooning_museum: { tourism: 'museum' },
  aviation_museum: { tourism: 'museum' },
  computer_museum: { tourism: 'museum' },
  photography_museum: { tourism: 'museum' },
  design_museum: { tourism: 'museum' },
  planetarium: { amenity: 'planetarium' },
  observatory: { amenity: 'planetarium' },
  library: { amenity: 'library' },
  botanical_garden: { leisure: 'nature_reserve' },
  nature_reserve: { leisure: 'nature_reserve' },
  national_park: { leisure: 'nature_reserve' },
  waterfall: { natural: 'waterfall' },
  beach: { natural: 'beach' },
  campground: { tourism: 'camp_site' },
  farmers_market: { shop: 'farm' },
  farm: { shop: 'farm' },
  urban_farm: { shop: 'farm' },
  dairy_farm: { shop: 'farm' },
  indoor_playcenter: { leisure: 'indoor_play' },
  kids_recreation_and_party: { leisure: 'indoor_play' },
  rock_climbing_gym: { dokoiko: 'climbing' },
  rock_climbing_spot: { dokoiko: 'climbing' },
  glass_blowing_venue: { dokoiko: 'craft' },
  bowling_alley: { leisure: 'bowling_alley' },
  hiking_trail: { dokoiko: 'hiking' },
  mountain: { natural: 'peak' },
  lake: { dokoiko: 'lake' },
  ice_skating_rink: { leisure: 'ice_rink' },
  fishing_area: { leisure: 'fishing' },
  go_kart_track: { tourism: 'theme_park' },
};
/**
 * 名前で種類を決めるもの（カテゴリは「教室」「ギャラリー」「公園」などまちまちなので、どのカテゴリでも名前で拾う）。
 * 上から順に判定する
 */
export const NAME_TAGS: [RegExp, Record<string, string>][] = [
  [/フィールドアスレチック|冒険の森|ジップライン|アスレチック(場|広場|コース)/, { dokoiko: 'athletic' }],
  [/陶芸(体験|教室|工房)|ガラス工房|吹きガラス|体験工房|とんぼ玉|そば打ち体験|ものづくり体験|手作り体験/, { dokoiko: 'craft' }],
  [/釣り堀|つり堀|釣堀|管理釣り場/, { leisure: 'fishing' }],
  [/ボルダリング|クライミング/, { dokoiko: 'climbing' }],
];
/** 史跡は数が多いので、子供と見に行けそうなものだけ */
const HISTORIC_NAME = /城跡|城址|古墳|遺跡|貝塚|台場|砲台|関所|陣屋|一里塚|横穴/;
/** 山・湖・ハイキングコースは名前だけの小さなものも多いので、それらしい名前のものだけ */
const NATURE_NAME: Record<string, RegExp> = {
  mountain: /山|岳|峰|峠|丘/,
  lake: /湖|池|沼|ダム/,
  hiking_trail: /ハイキング|コース|自然歩道|遊歩道|散策路|トレイル|みち|道/,
};

/** 農場は個人の畑も多いので、見学・体験・直売できそうな名前のものだけ */
const FARM_NAME = /農園|牧場|ファーム|ファーマーズ|体験|もぎ|狩り|直売|朝市|マルシェ|観光|ふれあい/i;
const FARM_CATS = new Set(['farm', 'urban_farm', 'dairy_farm', 'farmers_market']);
/** 動物園・水族館のカテゴリには展示名（「アカウミガメ」）やバス停も混ざるので、施設らしい名前だけ */
const ZOO_NAME = /動物|水族|zoo|アクア|牧場|ふれあい|園|館|カフェ|小屋|広場|パーク|ランド/i;
const ZOO_CATS = new Set(['zoo', 'petting_zoo', 'aquarium']);
/** 子供向けでないもの・会社・停留所・海の家、座標の誤りで混ざる県外の施設 */
const EXCLUDE = /ソープ|風俗|キャバ|ホスト|アダルト|エアソフト|airsoft|サバゲ|スナック|居酒屋|パブ|株式会社|有限会社|(株)|（株）|商店|問屋|前$|停留所|駅$|海の家|東京|品川|渋谷|新宿|中央区|千代田|港区|世田谷|大田区|八王子|町田市|静岡|山梨|奥多摩|高尾|^富士山$|商事|寺$|神社$|団地$|駐輪場|駐車場|管財部|事務所|本社|営業所|小路$/i;
/** 日本語（かな・漢字）を含む名前だけ。英語・韓国語だけの名前は、多くが有名施設の外国語表記の重複 */
const JAPANESE = /[぀-ヿ一-鿿]/;

export interface OvertureSpot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  city: string;
  cat: string;
  tags: Record<string, string>;
  web?: string;
  src: string[];
}

async function latestRelease(): Promise<string> {
  const cat = await fetchJson<{ links: { rel: string; href: string }[] }>('https://stac.overturemaps.org/catalog.json', { ttlHours: 24 });
  const rel = cat.links
    .filter((l) => l.rel === 'child')
    .map((l) => l.href.match(/(\d{4}-\d{2}-\d{2}\.\d+)/)?.[1])
    .filter((x): x is string => !!x)
    .sort();
  if (!rel.length) throw new Error('Overture のリリースが見つかりません');
  return rel[rel.length - 1];
}

export async function collectOverture(): Promise<OvertureSpot[]> {
  const release = await latestRelease();
  const [s, w, n, e] = region.bbox;
  const cats = Object.keys(CATEGORY_TAGS)
    .map((c) => `'${c}'`)
    .join(',');
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  await con.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
  console.log(`[overture] ${release} から取得中…`);
  const res = await con.runAndReadAll(`
    SELECT id, names.primary AS name, taxonomy.primary AS cat, confidence, operating_status AS st, websites[1] AS web,
      (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat, list_distinct([x.dataset for x in sources]) AS src
    FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*', hive_partitioning = 1)
    WHERE bbox.xmin BETWEEN ${w} AND ${e} AND bbox.ymin BETWEEN ${s} AND ${n}
      AND (taxonomy.primary IN (${cats}) OR taxonomy.primary = 'historic_site' OR regexp_matches(names.primary, '${NAME_TAGS.map(([re]) => re.source).join('|')}'))`);
  const rows = res.getRowObjectsJson() as unknown as {
    id: string;
    name: string | null;
    cat: string | null;
    confidence: number;
    st: string | null;
    web: string | null;
    lon: number;
    lat: number;
    src: string[];
  }[];
  const cityOf = await loadCityOf();
  const out: OvertureSpot[] = [];
  for (const r of rows) {
    const name = r.name?.trim();
    const cat = r.cat ?? '';
    if (!name || r.confidence < 0.6) continue;
    if (r.st && r.st !== 'open') continue;
    if (!JAPANESE.test(name) || EXCLUDE.test(name)) continue;
    if (FARM_CATS.has(cat) && !FARM_NAME.test(name)) continue;
    if (ZOO_CATS.has(cat) && !ZOO_NAME.test(name)) continue;
    if (cat === 'aquarium' && /^.{1,3}水族館$/.test(name)) continue; // 「〇〇水族館」の多くは熱帯魚店
    if (NATURE_NAME[cat] && !NATURE_NAME[cat].test(name)) continue;
    const byName = NAME_TAGS.find(([re]) => re.test(name))?.[1];
    if (/教室|スクール|クラブ/.test(name) && !byName?.dokoiko) continue; // 習い事（陶芸教室だけは体験できることが多いので残す）
    const tags = byName ?? CATEGORY_TAGS[cat] ?? (cat === 'historic_site' && HISTORIC_NAME.test(name) ? { historic: 'ruins' } : undefined);
    if (!tags) continue;
    const city = cityOf(r.lat, r.lon);
    if (!city) continue;
    out.push({
      id: 'o' + r.id.replace(/-/g, '').slice(0, 16),
      name,
      lat: +Number(r.lat).toFixed(5),
      lon: +Number(r.lon).toFixed(5),
      city,
      cat: cat,
      tags: { ...tags, name },
      web: r.web ?? undefined,
      src: r.src,
    });
  }
  await writeWork('overture.json', out);
  console.log(`[overture] ${rows.length} 件中 ${out.length} 件を採用`);
  return out;
}

if (isMain(import.meta.url)) {
  collectOverture().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
