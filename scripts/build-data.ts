// 収集結果を統合・スコアリングし、public/data/<region>/ にタイル分割した静的JSONを出力
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import region from '../config/region.json' with { type: 'json' };
import feeds from '../config/feeds.json' with { type: 'json' };
import manualClosed from '../config/closed.json' with { type: 'json' };
import manualWrongList from '../config/wrong.json' with { type: 'json' };
import { isMain, readWork, writeJson, writeWork } from './lib/work.ts';
import { PointIndex, dedupe, matchNews, toSpot } from './lib/score.ts';
import { computeIdf } from './lib/terms.ts';
import { tileKey, type CityInfo, type Meta, type NewsData, type Spot, type Term } from '../src/types.ts';
import type { OsmWork } from './collect-osm.ts';
import type { WdInfo } from './enrich-wikidata.ts';
import type { WpWork } from './enrich-wikipedia.ts';
import { wikiTitle } from './enrich-wikipedia.ts';
import type { CommonsWork } from './enrich-commons.ts';
import type { GeoImageWork } from './enrich-commons-geo.ts';
import type { RawNews } from './collect-news.ts';
import type { OvertureSpot } from './collect-overture.ts';
import { HAMAHUG_PAGE, type BabyCare, type PrefKids, type PrefLibrary, type PrefPark, type PrefVisitors } from './collect-pref.ts';
import type { GbifObs } from './collect-gbif.ts';
import { applyBabyCare, applyVisitors, gbifSpots, mergeOverture, mergePrefKids, mergePrefLibraries, mergePrefParks, mergeWikidata } from './lib/merge.ts';
import type { WdSpot } from './collect-wikidata.ts';
import { SUSPECT_FACTOR, deadLink, manualClosure, osmClosure, pastClosure, webClosure, wikidataClosure, wikipediaClosure, type Closure, type WebCheck } from './lib/closed.ts';
import { loadCityOf } from './lib/cities.ts';
import { manualWrong, type Famous, type ManualWrong, type Place } from './lib/fake.ts';
import { normName } from './lib/name.ts';

const OUT = join('public', 'data', region.id);

/** 広域表示用のおすすめを選ぶ（カテゴリごと上位60件＋市区町村ごと上位6件） */
export function pickHighlights(spots: Spot[], terms: Term[] = []): Spot[] {
  const maxIdf = Math.max(1, ...terms.map((t) => t.idf));
  const rare = (s: Spot) => Math.max(0, ...(s.t ?? []).map((i) => terms[i]?.idf ?? 0)) / maxIdf;
  const score = (s: Spot) => s.kid * s.apl * (0.4 + 0.6 * s.nov) * (0.5 + s.rich) * (0.3 + 0.7 * rare(s));
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
  const removed: string[] = []; // 閉館・廃止で消したスポット
  const suspects = new Map<string, Closure>(); // スポットID → 疑いの理由
  const ownWd = new Set<string>(); // 説明文（Wikidata・Wikipedia）がそのスポット自身のもの
  for (const raw0 of osm.spots) {
    const q = raw0.tags.wikidata ?? match[raw0.id];
    const raw = q && !raw0.tags.wikidata ? { ...raw0, tags: { ...raw0.tags, wikidata: q } } : raw0;
    const w = q ? wd[q] : undefined;
    const closure = osmClosure(raw.tags) ?? wikidataClosure(w?.ended);
    if (closure?.level === 'closed') {
      removed.push(`${raw.tags.name}（${closure.why}）`);
      continue;
    }
    if (closure) suspects.set(raw.id, closure);
    // wikidata タグが直接付いている、または項目の名前がスポットの名前と同じ
    if (raw0.tags.wikidata || (w?.label && normName(w.label) === normName(raw.tags.name ?? ''))) ownWd.add(raw.id);
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

  // OSM 以外の情報源を統合（それぞれ無ければ飛ばす）
  const fakes: string[] = [];
  const famous = await readWork<Famous[]>('wd-famous.json', []);
  const extra = {
    prefKids: mergePrefKids(spots, await readWork<PrefKids[]>('pref-kids.json', []), near),
    cityKids: mergePrefKids(spots, await readWork<PrefKids[]>('city-kids.json', []), near, '横浜市'),
    overture: mergeOverture(spots, await readWork<OvertureSpot[]>('overture.json', []), near, famous, fakes, await readWork<[number, number][]>('coast.json', []), await readWork<Place[]>('places.json', [])),
    gbif: 0,
    wikidata: 0,
    visitors: applyVisitors(spots, await readWork<PrefVisitors[]>('pref-visitors.json', [])),
    parks: mergePrefParks(spots, await readWork<PrefPark[]>('pref-parks.json', []), near),
    libraries: mergePrefLibraries(spots, await readWork<PrefLibrary[]>('pref-libraries.json', []), near),
    babyCare: applyBabyCare(spots, [...(await readWork<BabyCare[]>('baby-hamahug.json', [])), ...(await readWork<BabyCare[]>('baby-passport.json', []))]),
  };
  const wdm = mergeWikidata(spots, await readWork<WdSpot[]>('wd-spots.json', []), near);
  extra.wikidata = wdm.added;
  removed.push(...wdm.removed);
  const gbif = await readWork<GbifObs[]>('gbif.json', []);
  if (gbif.length) {
    const g = gbifSpots(gbif, await loadCityOf());
    spots.push(...g);
    extra.gbif = g.length;
  }
  console.log('[build] 追加した情報源', extra);
  if (fakes.length) console.log(`[build] 実在しない・場所が違う場所を除外 ${fakes.length} 件:\n  ${fakes.join('\n  ')}`);

  // 閉館を確認したが元のデータに反映されていない施設（config/closed.json）・実在しない場所（config/wrong.json）
  const wrongs: string[] = [];
  const cityOf = await loadCityOf();
  for (let i = spots.length - 1; i >= 0; i--) {
    const c = manualClosure(spots[i], manualClosed.closed);
    if (c) removed.push(...spots.splice(i, 1).map((x) => `${x.name}（${c.why}）`));
    else {
      const w = manualWrong(spots[i], manualWrongList.wrong as ManualWrong[]);
      if (w?.lat !== undefined && w.lon !== undefined) {
        // 位置（と名前）を直す
        const x = spots[i];
        wrongs.push(`${x.name}（${x.city ?? ''} → 位置を直した。${w.reason}）`);
        x.lat = w.lat;
        x.lon = w.lon;
        x.city = cityOf(w.lat, w.lon) ?? x.city;
        if (w.name_to) x.name = w.name_to;
      } else if (w) wrongs.push(...spots.splice(i, 1).map((x) => `${x.name}（${x.city ?? ''}。${w.reason}）`));
    }
  }

  if (wrongs.length) console.log(`[build] 手で登録した実在しない場所を除外 ${wrongs.length} 件`, wrongs);

  // 説明文が「〜にあった施設」と過去形のもの：自身の説明文なら消し、そうでなければ疑いにする
  for (let i = spots.length - 1; i >= 0; i--) {
    const s = spots[i];
    const past = pastClosure([s.desc, s.wp?.extract], s.cat, s.src === 'Wikidata' || ownWd.has(s.id));
    if (past?.level === 'closed') removed.push(...spots.splice(i, 1).map((x) => `${x.name}（${past.why}）`));
    else if (past && !suspects.has(s.id)) suspects.set(s.id, past);
  }

  // 閉館・休業の疑い：OSM のメモ・Wikipedia の説明文・公式サイトの閉館のお知らせ。得点を下げて理由を書く
  // 確認する公式サイトの一覧（リンクを外す前のもの。外したリンクも毎週確認し直す）
  await writeWork('websites.json', [...new Set(spots.map((s) => s.web).filter((u): u is string => !!u && /^https?:\/\//.test(u)))]);
  const web = await readWork<Record<string, WebCheck>>('web-check.json', {});
  let dead = 0;
  for (const s of spots) {
    const c = s.web ? web[s.web] : undefined;
    if (deadLink(c)) {
      delete s.web; // つながらないリンクは出さない
      dead++;
    }
    const why = suspects.get(s.id) ?? webClosure(c) ?? wikipediaClosure(s.wp?.extract, s.cat);
    if (!why) continue;
    s.warn = why.why;
    s.apl = Math.round(s.apl * SUSPECT_FACTOR * 100) / 100;
  }
  const warned = spots.filter((s) => s.warn);
  console.log(`[build] 閉館・廃止で削除 ${removed.length} 件`, removed);
  console.log(`[build] 閉館・休業の疑い ${warned.length} 件`, warned.map((s) => `${s.name}：${s.warn}`));
  console.log(`[build] つながらない公式サイトのリンクを外した ${dead} 件`);

  // ニュース照合（市町村名は「横浜市緑区」→「横浜市」の単位にそろえる）
  const municipalities = [...new Set(spots.map((s) => s.city?.match(/^.+?[市町村]/)?.[0] ?? s.city).filter((c): c is string => !!c))];
  const matched = matchNews(spots, news, municipalities, feeds.keywords, feeds.excludeKeywords);
  for (const s of spots) if (matched.bySpot[s.id]) s.rich = Math.min(1, Math.round((s.rich + 0.1) * 100) / 100);

  // 特徴語の IDF（県全体での珍しさ）を計算し、スポットには語の添字だけを持たせる
  const idf = computeIdf(spots.map((s) => s.tl ?? []));
  const termList: Term[] = [...idf].map(([label, v]) => ({ label, idf: v })).sort((a, b) => b.idf - a.idf);
  const termIndex = new Map(termList.map((t, i) => [t.label, i]));
  for (const s of spots) {
    if (s.tl?.length) s.t = s.tl.map((l) => termIndex.get(l)!);
    delete s.tl;
  }

  // タイル分割
  const tiles = new Map<string, Spot[]>();
  for (const s of spots) {
    const k = tileKey(s.lat, s.lon, region.tileSize);
    tiles.set(k, [...(tiles.get(k) ?? []), s]);
  }
  await rm(join(OUT, 'tiles'), { recursive: true, force: true });
  for (const [k, list] of tiles) await writeJson(join(OUT, 'tiles', `${k}.json`), list);

  // 広域表示用のおすすめ：ジャンルごとの上位＋市区町村ごとの上位（県全体を読み込まずに済むように）
  const highlights = pickHighlights(spots, termList);
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
    terms: termList,
    sources: [
      { name: 'OpenStreetMap', license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
      { name: 'Wikidata', license: 'CC0', url: 'https://www.wikidata.org/' },
      { name: 'Wikipedia', license: 'CC BY-SA 4.0', url: 'https://ja.wikipedia.org/' },
      { name: 'Wikimedia Commons', license: '各ファイルのライセンス', url: 'https://commons.wikimedia.org/' },
      { name: 'Overture Maps', license: 'CDLA Permissive 2.0（Foursquare 由来は Apache 2.0）', url: 'https://overturemaps.org/' },
      { name: 'GBIF.org 生きもの観察記録', license: 'CC0・CC BY 4.0', url: 'https://www.gbif.org/' },
      { name: '神奈川県オープンデータ（児童館等・公園・図書館・子育て応援パスポート協力施設・入込観光客調査）', license: 'CC BY 4.0', url: 'https://catalog.opendata.pref.kanagawa.jp/' },
      { name: '横浜市オープンデータ（親と子のつどいの広場）', license: 'CC BY', url: 'https://data.city.yokohama.lg.jp/dataset/kodomo_tsudoinohiroba' },
      { name: '横浜市オープンデータ（ハマハグ協賛店舗・施設）', license: 'CC BY', url: HAMAHUG_PAGE },
      { name: '時間地図の電車の所要時間（distortMap の推定。OpenStreetMap・国土数値情報・Wikipedia から）', license: 'ODbL・CC BY 4.0・CC BY-SA 4.0', url: 'https://apoplexy-yyyy.github.io/distortMap/' },
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
