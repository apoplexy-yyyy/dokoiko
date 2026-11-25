// ⑦ 生きもの観察：GBIF（地球規模生物多様性情報機構）の観察記録から、子供に人気の生きものが見つかった場所を集める
// ライセンスは CC0 と CC BY のものだけ使う（非営利限定 CC BY-NC は除く）。1km 四方ごとにまとめて .work/gbif.json に保存
import { fetchJson } from './lib/http.ts';
import { isMain, writeWork } from './lib/work.ts';

/** 子供に人気の生きもの（和名・学名・見られる季節の目安） */
export const CREATURES: { ja: string; sci: string }[] = [
  { ja: 'カブトムシ', sci: 'Trypoxylus dichotomus' },
  { ja: 'ノコギリクワガタ', sci: 'Prosopocoilus inclinatus' },
  { ja: 'ミヤマクワガタ', sci: 'Lucanus maculifemoratus' },
  { ja: 'コクワガタ', sci: 'Dorcus rectus' },
  { ja: 'ゲンジボタル', sci: 'Luciola cruciata' },
  { ja: 'ヘイケボタル', sci: 'Aquatica lateralis' },
  { ja: 'オオムラサキ', sci: 'Sasakia charonda' },
  { ja: 'タマムシ', sci: 'Chrysochroa fulgidissima' },
  { ja: 'オニヤンマ', sci: 'Anotogaster sieboldii' },
  { ja: 'アメリカザリガニ', sci: 'Procambarus clarkii' },
  { ja: 'アカテガニ', sci: 'Chiromantes haematocheir' },
  { ja: 'カワセミ', sci: 'Alcedo atthis' },
  { ja: 'ニホンリス', sci: 'Sciurus lis' },
  { ja: 'ムササビ', sci: 'Petaurista leucogenys' },
  { ja: 'ニホンカモシカ', sci: 'Capricornis crispus' },
];

const BBOX = { s: 35.12, w: 138.91, n: 35.68, e: 139.8 };
const POLY = `POLYGON((${BBOX.w} ${BBOX.s},${BBOX.e} ${BBOX.s},${BBOX.e} ${BBOX.n},${BBOX.w} ${BBOX.n},${BBOX.w} ${BBOX.s}))`;
/** まとめる升目の大きさ（度）。約 1km */
export const CELL = 0.01;

export interface GbifObs {
  cell: string;
  lat: number;
  lon: number;
  /** 生きものごとの記録数と、記録された月 */
  sp: { ja: string; key: number; n: number; months: number[] }[];
  /** 記録の多いライセンス */
  licenses: string[];
}

interface Occ {
  decimalLatitude?: number;
  decimalLongitude?: number;
  month?: number;
  license?: string;
}

const LICENSES = ['CC0_1_0', 'CC_BY_4_0'];

async function taxonKey(sci: string): Promise<number | undefined> {
  const m = await fetchJson<{ usageKey?: number; matchType?: string }>(
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`,
    { ttlHours: 24 * 30, intervalMs: 300 },
  );
  return m.matchType && m.matchType !== 'NONE' ? m.usageKey : undefined;
}

async function occurrences(key: number): Promise<Occ[]> {
  const out: Occ[] = [];
  for (let offset = 0; offset < 3000; offset += 300) {
    const q = new URLSearchParams({
      taxonKey: String(key),
      geometry: POLY,
      hasCoordinate: 'true',
      hasGeospatialIssue: 'false',
      coordinateUncertaintyInMeters: '0,1000',
      year: '2000,2100',
      limit: '300',
      offset: String(offset),
    });
    for (const l of LICENSES) q.append('license', l);
    const res = await fetchJson<{ results: Occ[]; endOfRecords: boolean }>(`https://api.gbif.org/v1/occurrence/search?${q}`, {
      ttlHours: 24 * 6,
      intervalMs: 500,
      timeoutMs: 60_000,
    });
    out.push(...res.results);
    if (res.endOfRecords) break;
  }
  return out;
}

/** 記録を 1km 升目にまとめる */
export function aggregate(records: { ja: string; key: number; occ: Occ }[]): GbifObs[] {
  const cells = new Map<string, { lat: number[]; lon: number[]; sp: Map<string, { key: number; n: number; months: Set<number> }>; lic: Map<string, number> }>();
  for (const { ja, key, occ } of records) {
    const { decimalLatitude: lat, decimalLongitude: lon } = occ;
    if (lat == null || lon == null) continue;
    const id = `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;
    let c = cells.get(id);
    if (!c) cells.set(id, (c = { lat: [], lon: [], sp: new Map(), lic: new Map() }));
    c.lat.push(lat);
    c.lon.push(lon);
    const sp = c.sp.get(ja) ?? { key, n: 0, months: new Set<number>() };
    sp.n++;
    if (occ.month) sp.months.add(occ.month);
    c.sp.set(ja, sp);
    if (occ.license) c.lic.set(occ.license, (c.lic.get(occ.license) ?? 0) + 1);
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return [...cells].map(([cell, c]) => ({
    cell,
    lat: +mean(c.lat).toFixed(5),
    lon: +mean(c.lon).toFixed(5),
    sp: [...c.sp]
      .map(([ja, v]) => ({ ja, key: v.key, n: v.n, months: [...v.months].sort((a, b) => a - b) }))
      .sort((a, b) => b.n - a.n),
    licenses: [...c.lic].sort((a, b) => b[1] - a[1]).map(([l]) => l),
  }));
}

export async function collectGbif(): Promise<GbifObs[]> {
  const records: { ja: string; key: number; occ: Occ }[] = [];
  for (const c of CREATURES) {
    try {
      const key = await taxonKey(c.sci);
      if (!key) {
        console.warn(`[gbif] 学名が見つからない: ${c.sci}`);
        continue;
      }
      const occ = await occurrences(key);
      records.push(...occ.map((o) => ({ ja: c.ja, key, occ: o })));
      console.log(`[gbif] ${c.ja}: ${occ.length} 件`);
    } catch (e) {
      console.warn(`[gbif] 失敗（スキップ） ${c.ja}: ${(e as Error).message}`);
    }
  }
  const cells = aggregate(records);
  await writeWork('gbif.json', cells);
  console.log(`[gbif] 合計 ${records.length} 件 → ${cells.length} 地点`);
  return cells;
}

if (isMain(import.meta.url)) {
  collectGbif().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
