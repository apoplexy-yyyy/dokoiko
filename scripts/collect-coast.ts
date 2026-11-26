// 海岸線（OSM の natural=coastline）を 150m おきの点にして .work/coast.json に保存する
// 「海岸」「海水浴場」なのに海から遠い場所（Overture の Meta 由来に多い）を見分けるのに使う
import region from '../config/region.json' with { type: 'json' };
import { overpass } from './collect-osm.ts';
import { isMain, writeWork } from './lib/work.ts';
import { distKm } from '../src/discover/pick.ts';

export async function collectCoast(): Promise<[number, number][]> {
  const [s, w, n, e] = region.bbox;
  const els = await overpass(`[out:json][timeout:180];
way["natural"="coastline"](${s - 0.05},${w - 0.05},${n + 0.05},${e + 0.05});
out geom;`);
  const pts: [number, number][] = [];
  for (const el of els) {
    let last: [number, number] | undefined;
    for (const g of el.geometry ?? []) {
      if (last && distKm(last[0], last[1], g.lat, g.lon) < 0.15) continue;
      last = [+g.lat.toFixed(5), +g.lon.toFixed(5)];
      pts.push(last);
    }
  }
  await writeWork('coast.json', pts);
  console.log(`[coast] 海岸線 ${els.length} 本 → ${pts.length} 点`);
  return pts;
}

if (isMain(import.meta.url))
  collectCoast().catch((e) => {
    console.error(e);
    process.exit(1);
  });
