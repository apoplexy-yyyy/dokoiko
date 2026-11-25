// ① OpenStreetMap（Overpass API）からお出かけ候補・遊具・トイレを収集し .work/osm.json に保存
// 市区町村は境界ポリゴンを取得し、手元で点の内外判定をして付与する（Overpass の foreach は重いため）
import region from '../config/region.json' with { type: 'json' };
import categories from '../config/categories.json' with { type: 'json' };
import { fetchJson } from './lib/http.ts';
import { isMain, writeWork } from './lib/work.ts';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

type LatLon = { lat: number; lon: number };

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
  members?: { type: string; role: string; geometry?: LatLon[] }[];
}

export interface RawSpot {
  id: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  city?: string;
  /** おおよその面積（ha）。ウェイ/リレーションの外接矩形から推定 */
  ha?: number;
}

/** 外接矩形からおおよその面積(ha)を推定（形の分だけ 0.65 を掛ける） */
export function approxHa(b: NonNullable<OsmElement['bounds']>): number {
  const h = (b.maxlat - b.minlat) * 111_000;
  const w = (b.maxlon - b.minlon) * 111_000 * Math.cos((((b.maxlat + b.minlat) / 2) * Math.PI) / 180);
  return Math.round(((h * w * 0.65) / 10_000) * 100) / 100;
}

export interface OsmWork {
  fetchedAt: string;
  spots: RawSpot[];
  playgrounds: [number, number][];
  toilets: [number, number][];
}

/** categories.json のルールから Overpass のフィルタ文を生成 */
export function buildFilters(area: string): string {
  // 名前の条件があるルール（building=yes など数が多いタグ）は、名前でしぼって取得する
  const byKey = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const r of categories.rules as { key: string; value: string; nameMatch?: string }[]) {
    const [map, k] = r.nameMatch ? [byName, `${r.key}\t${r.nameMatch}`] : [byKey, r.key];
    map.set(k, (map.get(k) ?? new Set()).add(r.value));
  }
  return [
    ...[...byKey].map(([k, vs]) => `nwr(area.${area})["${k}"~"^(${[...vs].join('|')})$"]["name"];`),
    ...[...byName].map(([kn, vs]) => {
      const [k, nm] = kn.split('\t');
      return `nwr(area.${area})["${k}"~"^(${[...vs].join('|')})$"]["name"~"${nm}"];`;
    }),
  ].join('\n  ');
}

async function overpass(query: string, minElements = 1): Promise<OsmElement[]> {
  let lastErr: unknown;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetchJson<{ elements: OsmElement[] }>(ep, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        ttlHours: 20,
        intervalMs: 5000,
        retries: 4,
        timeoutMs: 600_000,
        // タイムアウト等は HTTP 200 + remark で返るので検証してキャッシュしない
        validate: (text) => {
          const j = JSON.parse(text) as { elements?: unknown[]; remark?: string };
          if (j.remark && /error|timed out|out of memory/i.test(j.remark)) throw new Error(`Overpass: ${j.remark}`);
          if ((j.elements?.length ?? 0) < minElements) throw new Error('Overpass: 結果が空です');
        },
      });
      return res.elements;
    } catch (e) {
      console.warn(`  Overpass失敗 ${ep}: ${(e as Error).message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 境界（複数のウェイの集合）に対する偶奇判定。リングを組み立てずに全線分で交差回数を数える */
export class Boundary {
  segs: [number, number, number, number][] = []; // lon1, lat1, lon2, lat2
  bbox = [Infinity, Infinity, -Infinity, -Infinity]; // minLat, minLon, maxLat, maxLon
  constructor(
    public name: string,
    public level: number,
    ways: LatLon[][],
  ) {
    for (const w of ways)
      for (let i = 1; i < w.length; i++) {
        this.segs.push([w[i - 1].lon, w[i - 1].lat, w[i].lon, w[i].lat]);
        this.bbox[0] = Math.min(this.bbox[0], w[i].lat);
        this.bbox[1] = Math.min(this.bbox[1], w[i].lon);
        this.bbox[2] = Math.max(this.bbox[2], w[i].lat);
        this.bbox[3] = Math.max(this.bbox[3], w[i].lon);
      }
  }
  contains(lat: number, lon: number): boolean {
    const b = this.bbox;
    if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) return false;
    let inside = false;
    for (const [x1, y1, x2, y2] of this.segs) {
      if (y1 > lat !== y2 > lat && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }
}

const coord = (e: OsmElement): [number, number] | undefined =>
  e.lat != null
    ? [e.lat, e.lon!]
    : e.center
      ? [e.center.lat, e.center.lon]
      : e.bounds
        ? [(e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2]
        : undefined;

const prefix = { node: 'n', way: 'w', relation: 'r' } as const;

export async function collectOsm(): Promise<OsmWork> {
  const pref = `area["ISO3166-2"="${region.iso}"]->.pref;`;

  console.log('[osm] 市区町村の境界を取得中…');
  const bEls = await overpass(
    `[out:json][timeout:300];${pref}rel(area.pref)["boundary"="administrative"]["admin_level"~"^(7|8)$"];out geom qt;`,
  );
  const bounds = bEls
    .filter((e) => e.tags?.name && e.members)
    .map(
      (e) =>
        new Boundary(
          e.tags!.name,
          Number(e.tags!.admin_level),
          e.members!.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry!),
        ),
    );
  const cities = bounds.filter((b) => b.level === 7);
  const wards = bounds.filter((b) => b.level === 8);
  if (!cities.length) throw new Error("市町村の境界を取得できませんでした");
  console.log(`[osm] 市町村 ${cities.length} / 区 ${wards.length}`);
  // ほかの情報源（Overture・GBIF・県のデータ）の場所にも市区町村を付けられるよう、境界を保存しておく
  await writeWork('boundaries.json', bounds.map((b) => ({ name: b.name, level: b.level, segs: b.segs, bbox: b.bbox })));
  const cityOf = (lat: number, lon: number): string | undefined => {
    const c = cities.find((b) => b.contains(lat, lon));
    if (!c) return undefined;
    const w = wards.find((b) => b.contains(lat, lon));
    return w ? c.name + w.name : c.name;
  };

  console.log('[osm] スポット取得中…');
  const els = await overpass(`[out:json][timeout:300];
${pref}
(
  ${buildFilters('pref')}
);
out tags bb qt;`);
  const spots: RawSpot[] = [];
  for (const e of els) {
    const c = coord(e);
    if (!c || !e.tags) continue;
    const city = cityOf(c[0], c[1]);
    if (!city) continue; // 県外（area判定の境界付近）は除外
    const s: RawSpot = { id: prefix[e.type] + e.id, lat: c[0], lon: c[1], tags: e.tags, city };
    if (e.bounds) s.ha = approxHa(e.bounds);
    spots.push(s);
  }

  // 遊具・トイレ（名前なしも含む）は位置だけ取得し、近くにあるかの判定に使う
  console.log('[osm] 遊具・トイレの位置を取得中…');
  const playgrounds: [number, number][] = [];
  const toilets: [number, number][] = [];
  const aEls = await overpass(`[out:json][timeout:300];
${pref}
(
  nwr(area.pref)["leisure"="playground"];
  nwr(area.pref)["amenity"="toilets"]["access"!~"^(private|no|customers)$"];
);
out tags center qt;`);
  for (const e of aEls) {
    const c = coord(e);
    if (!c) continue;
    const rc: [number, number] = [+c[0].toFixed(5), +c[1].toFixed(5)];
    if (e.tags?.leisure === 'playground') playgrounds.push(rc);
    else if (e.tags?.amenity === 'toilets') toilets.push(rc);
  }

  const work: OsmWork = { fetchedAt: new Date().toISOString(), spots, playgrounds, toilets };
  console.log(`[osm] スポット ${spots.length} / 遊具 ${playgrounds.length} / トイレ ${toilets.length}`);
  await writeWork('osm.json', work);
  return work;
}

if (isMain(import.meta.url))
  collectOsm().catch((e) => {
    console.error(e);
    process.exit(1);
  });
