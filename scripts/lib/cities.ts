// 保存した市区町村の境界（collect-osm が .work/boundaries.json に書き出す）から、座標の市区町村名を求める
import { readWork } from './work.ts';

interface SavedBoundary {
  name: string;
  level: number;
  segs: [number, number, number, number][];
  bbox: number[]; // minLat, minLon, maxLat, maxLon
}

function contains(b: SavedBoundary, lat: number, lon: number): boolean {
  if (lat < b.bbox[0] || lat > b.bbox[2] || lon < b.bbox[1] || lon > b.bbox[3]) return false;
  let inside = false;
  for (const [x1, y1, x2, y2] of b.segs) if (y1 > lat !== y2 > lat && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
  return inside;
}

/** 県内なら「横浜市緑区」「鎌倉市」のような名前、県外なら undefined を返す関数 */
export async function loadCityOf(): Promise<(lat: number, lon: number) => string | undefined> {
  const all = await readWork<SavedBoundary[]>('boundaries.json', []);
  const cities = all.filter((b) => b.level === 7);
  const wards = all.filter((b) => b.level === 8);
  if (!cities.length) throw new Error('.work/boundaries.json がありません。先に collect:osm を実行してください');
  return (lat, lon) => {
    const c = cities.find((b) => contains(b, lat, lon));
    if (!c) return undefined;
    const w = wards.find((b) => contains(b, lat, lon));
    return w ? c.name + w.name : c.name;
  };
}
