// ②' Wikidata 照合：OSM に wikidata タグがないスポットを、Wikidata の県内項目と「名前＋位置」で結び付ける
// （写真・Wikipedia記事のある項目だけを対象。結果は .work/wd-match.json { spotId: QID }）
import region from '../config/region.json' with { type: 'json' };
import { fetchJson } from './lib/http.ts';
import { isMain, readWork, writeWork } from './lib/work.ts';
import { distKm } from './lib/score.ts';
import type { OsmWork } from './collect-osm.ts';

interface WdCandidate {
  q: string;
  name: string;
  lat: number;
  lon: number;
}

interface SparqlRes {
  results: { bindings: Record<string, { value: string }>[] };
}

/** 照合用に名前をそろえる（全角半角・空白・括弧書きを除去） */
export const matchKey = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s・･]/g, '')
    .replace(/ヶ/g, 'ケ');

/** 同名なら1.5km以内、片方がもう片方を含む（4文字以上）なら300m以内で一致とみなす */
export function isMatch(a: string, b: string, km: number): boolean {
  const x = matchKey(a);
  const y = matchKey(b);
  if (!x || !y) return false;
  if (x === y) return km <= 1.5;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short) && km <= 0.3;
}

export async function matchWikidata(): Promise<Record<string, string>> {
  const osm = await readWork<OsmWork>('osm.json');
  const query = `SELECT ?item ?label ?coord WHERE {
  ?item wdt:P131+ wd:${region.wikidata} ; wdt:P625 ?coord .
  ?item rdfs:label ?label FILTER(lang(?label) = "ja")
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> }
  FILTER(BOUND(?image) || BOUND(?a))
}`;
  const res = await fetchJson<SparqlRes>('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
    headers: { Accept: 'application/sparql-results+json' },
    ttlHours: 24 * 6,
    timeoutMs: 180_000,
    validate: (t) => {
      if (!(JSON.parse(t) as SparqlRes).results.bindings.length) throw new Error('SPARQL: 結果が空です');
    },
  });

  // グリッド索引（約1km）
  const grid = new Map<string, WdCandidate[]>();
  const key = (lat: number, lon: number) => `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;
  for (const b of res.results.bindings) {
    const m = b.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!m) continue;
    const c: WdCandidate = { q: b.item.value.split('/').pop()!, name: b.label.value, lon: +m[1], lat: +m[2] };
    const k = key(c.lat, c.lon);
    grid.set(k, [...(grid.get(k) ?? []), c]);
  }

  const out: Record<string, string> = {};
  for (const s of osm.spots) {
    if (s.tags.wikidata) continue;
    const name = s.tags['name:ja'] ?? s.tags.name;
    if (!name) continue;
    const y = Math.floor(s.lat * 100);
    const x = Math.floor(s.lon * 100);
    let best: { q: string; km: number } | undefined;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (const c of grid.get(`${y + dy}_${x + dx}`) ?? []) {
          const km = distKm(s.lat, s.lon, c.lat, c.lon);
          if (isMatch(name, c.name, km) && (!best || km < best.km)) best = { q: c.q, km };
        }
    if (best) out[s.id] = best.q;
  }
  await writeWork('wd-match.json', out);
  console.log(`[wd-match] Wikidata候補 ${res.results.bindings.length} 件 → 新たに ${Object.keys(out).length} スポットと照合`);
  return out;
}

if (isMain(import.meta.url))
  matchWikidata().catch((e) => {
    console.error(e);
    process.exit(1);
  });
