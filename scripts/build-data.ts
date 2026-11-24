// 収集結果を統合・スコアリングし、public/data/<region>/ にタイル分割した静的JSONを出力
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import region from '../config/region.json' with { type: 'json' };
import feeds from '../config/feeds.json' with { type: 'json' };
import { isMain, readWork, writeJson } from './lib/work.ts';
import { PointIndex, dedupe, matchNews, toSpot } from './lib/score.ts';
import { tileKey, type CityInfo, type Meta, type NewsData, type Spot } from '../src/types.ts';
import type { OsmWork } from './collect-osm.ts';
import type { WdInfo } from './enrich-wikidata.ts';
import type { WpWork } from './enrich-wikipedia.ts';
import { wikiTitle } from './enrich-wikipedia.ts';
import type { CommonsWork } from './enrich-commons.ts';
import type { GeoImageWork } from './enrich-commons-geo.ts';
import type { RawNews } from './collect-news.ts';

const OUT = join('public', 'data', region.id);

/** 広域表示用のおすすめを選ぶ（カテゴリごと上位60件＋市区町村ごと上位6件） */
export function pickHighlights(spots: Spot[]): Spot[] {
  const score = (s: Spot) => s.kid * s.apl * (0.4 + 0.6 * s.nov) * (0.5 + s.rich);
  const sorted = [...spots].sort((a, b) => score(b) - score(a));
  const chosen = new Map<string, Spot>();
  const take = (key: (s: Spot) => string | undefined, n: number) => {
    const count = new Map<string, number>();
    for (const s of sorted) {
      const k = key(s);
      if (!k || (count.get(k) ?? 0) >= n) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
      chosen.set(s.id, s);
    }
  };
  take((s) => s.cat, 60);
  take((s) => s.city, 6);
  return [...chosen.values()];
}

export async function buildData() {
  const osm = await readWork<OsmWork>('osm.json');
  const wd = await readWork<Record<string, WdInfo>>('wikidata.json', {});
  const wp = await readWork<WpWork>('wikipedia.json', {});
  const commons = await readWork<CommonsWork>('commons.json', {});
  const news = await readWork<RawNews[]>('news-raw.json', []);
  const match = await readWork<Record<string, string>>('wd-match.json', {});
  const geoImg = await readWork<GeoImageWork>('commons-geo.json', {});

  const near = { playgrounds: new PointIndex(osm.playgrounds), toilets: new PointIndex(osm.toilets) };

  const built: Spot[] = [];
  for (const raw0 of osm.spots) {
    const q = raw0.tags.wikidata ?? match[raw0.id];
    const raw = q && !raw0.tags.wikidata ? { ...raw0, tags: { ...raw0.tags, wikidata: q } } : raw0;
    const w = q ? wd[q] : undefined;
    const title = wikiTitle(raw.tags, w);
    const s = toSpot(
      raw,
      {
        desc: w?.desc,
        wpTitle: title,
        wpExtract: title ? wp[title] : undefined,
        img: (w?.image ? commons[w.image] : undefined) ?? geoImg[raw.id],
        website: w?.website,
        sitelinks: w?.sitelinks,
      },
      near,
    );
    if (s) built.push(s);
  }
  const spots = dedupe(built);

  // ニュース照合（市町村名は「横浜市緑区」→「横浜市」の単位にそろえる）
  const municipalities = [...new Set(spots.map((s) => s.city?.match(/^.+?[市町村]/)?.[0] ?? s.city).filter((c): c is string => !!c))];
  const matched = matchNews(spots, news, municipalities, feeds.keywords, feeds.excludeKeywords);
  for (const s of spots) if (matched.bySpot[s.id]) s.rich = Math.min(1, Math.round((s.rich + 0.1) * 100) / 100);

  // タイル分割
  const tiles = new Map<string, Spot[]>();
  for (const s of spots) {
    const k = tileKey(s.lat, s.lon, region.tileSize);
    tiles.set(k, [...(tiles.get(k) ?? []), s]);
  }
  await rm(join(OUT, 'tiles'), { recursive: true, force: true });
  for (const [k, list] of tiles) await writeJson(join(OUT, 'tiles', `${k}.json`), list);

  // 広域表示用のおすすめ：ジャンルごとの上位＋市区町村ごとの上位（県全体を読み込まずに済むように）
  const highlights = pickHighlights(spots);
  await writeJson(join(OUT, 'highlights.json'), highlights);

  // 市区町村（起点選択用）：スポットの平均位置
  const cityAgg = new Map<string, { lat: number; lon: number; n: number }>();
  for (const s of spots) {
    if (!s.city) continue;
    const a = cityAgg.get(s.city) ?? { lat: 0, lon: 0, n: 0 };
    a.lat += s.lat;
    a.lon += s.lon;
    a.n++;
    cityAgg.set(s.city, a);
  }
  const cities: CityInfo[] = [...cityAgg]
    .map(([name, a]) => ({ name, lat: +(a.lat / a.n).toFixed(4), lon: +(a.lon / a.n).toFixed(4), count: a.n }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const now = new Date().toISOString();
  const meta: Meta = {
    region: region.id,
    name: region.name,
    updatedAt: now,
    count: spots.length,
    tileSize: region.tileSize,
    tiles: [...tiles.keys()].sort(),
    bbox: region.bbox as Meta['bbox'],
    center: region.center as Meta['center'],
    cities,
    sources: [
      { name: 'OpenStreetMap', license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
      { name: 'Wikidata', license: 'CC0', url: 'https://www.wikidata.org/' },
      { name: 'Wikipedia', license: 'CC BY-SA 4.0', url: 'https://ja.wikipedia.org/' },
      { name: 'Wikimedia Commons', license: '各ファイルのライセンス', url: 'https://commons.wikimedia.org/' },
      ...feeds.feeds.map((f) => ({ name: f.name + ' 新着情報', license: '各サイトの利用規約', url: new URL(f.url).origin })),
    ],
  };
  await writeJson(join(OUT, 'meta.json'), meta, true);
  const newsData: NewsData = { updatedAt: now, ...matched };
  await writeJson(join(OUT, 'news.json'), newsData);

  const files = await readdir(join(OUT, 'tiles'));
  const stats = {
    spots: spots.length,
    tiles: files.length,
    withImage: spots.filter((s) => s.img).length,
    withWikipedia: spots.filter((s) => s.wp).length,
    newsSpots: Object.keys(matched.bySpot).length,
    newsCities: Object.keys(matched.byCity).length,
    highlights: highlights.length,
    maxTile: Math.max(...[...tiles.values()].map((l) => l.length)),
  };
  console.log('[build]', stats);
  return stats;
}

if (isMain(import.meta.url))
  buildData().catch((e) => {
    console.error(e);
    process.exit(1);
  });
