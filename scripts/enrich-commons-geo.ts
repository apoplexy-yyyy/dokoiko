// ④' Wikimedia Commons 位置検索：写真のないスポットについて、近くで撮影され、ファイル名にスポット名を含む写真を探す
// 1) list=geosearch でファイル名だけを高速に取得 → 2) 名前が合ったファイルだけ imageinfo を50件ずつまとめて取得
// 対象は実際に表示されうるスポット（カテゴリ判定を通るもの。公園・遊び場は1ha以上）に限定する
import { chunk, fetchJson } from './lib/http.ts';
import { argLimit, isMain, readWork, writeWork } from './lib/work.ts';
import { stripHtml } from './enrich-commons.ts';
import { matchKey } from './match-wikidata.ts';
import { classify } from './lib/score.ts';
import type { OsmWork, RawSpot } from './collect-osm.ts';
import type { WdInfo } from './enrich-wikidata.ts';
import type { SpotImage } from '../src/types.ts';

export type GeoImageWork = Record<string, SpotImage>; // spotId -> 画像

interface GeoRes {
  query?: { geosearch?: { title: string; dist: number }[] };
}
interface InfoRes {
  query?: {
    normalized?: { from: string; to: string }[];
    pages?: Record<string, { title: string; imageinfo?: { thumburl?: string; descriptionurl?: string; mime?: string; extmetadata?: Record<string, { value: string }> }[] }>;
  };
}

const GENERIC = /(公園|緑地|広場|図書館|博物館|美術館|資料館|神社|寺|山|展望台)$/;

/** ファイル名がスポット名を含むか（「〇〇公園」は「〇〇」部分が3文字以上あればそれでも可） */
export function titleMatches(fileTitle: string, spotName: string): boolean {
  const t = matchKey(fileTitle.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''));
  const n = matchKey(spotName);
  if (n.length >= 3 && t.includes(n)) return true;
  const core = n.replace(GENERIC, '');
  return core.length >= 3 && core !== n && t.includes(core);
}

function worthImage(s: RawSpot): boolean {
  const rule = classify(s.tags);
  if (!rule || rule.cat === 'view') return false; // 山頂などは写真があっても場所が分かりにくいので対象外
  if (rule.cat === 'park' || rule.cat === 'playground') return (s.ha ?? 0) >= 1;
  return true;
}

export async function enrichCommonsGeo(): Promise<GeoImageWork> {
  const osm = await readWork<OsmWork>('osm.json');
  const wd = await readWork<Record<string, WdInfo>>('wikidata.json', {});
  const match = await readWork<Record<string, string>>('wd-match.json', {});
  let targets = osm.spots.filter((s) => {
    const q = s.tags.wikidata ?? match[s.id];
    return !(q && wd[q]?.image) && (s.tags['name:ja'] ?? s.tags.name) && worthImage(s);
  });
  const limit = argLimit();
  if (limit) targets = targets.slice(0, limit);
  console.log(`[commons-geo] ${targets.length} スポットを位置検索`);

  // 1) ファイル名だけを位置検索し、スポット名を含む最も近いファイルを選ぶ
  const fileFor = new Map<string, string>(); // spotId -> File:...
  let done = 0;
  for (const s of targets) {
    const name = s.tags['name:ja'] ?? s.tags.name;
    const radius = Math.min(1000, Math.max(150, Math.round(Math.sqrt((s.ha ?? 0) * 10_000))));
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&list=geosearch&gsnamespace=6&gslimit=50' +
      `&gscoord=${s.lat.toFixed(5)}|${s.lon.toFixed(5)}&gsradius=${radius}`;
    try {
      const res = await fetchJson<GeoRes>(url, { ttlHours: 24 * 13, intervalMs: 300, retries: 2, timeoutMs: 30_000 });
      const hit = (res.query?.geosearch ?? [])
        .filter((g) => /\.(jpe?g|png)$/i.test(g.title) && titleMatches(g.title, name))
        .sort((a, b) => a.dist - b.dist)[0];
      if (hit) fileFor.set(s.id, hit.title);
    } catch (e) {
      console.warn(`[commons-geo] 失敗（スキップ） ${name}: ${(e as Error).message}`);
    }
    if (++done % 250 === 0) console.log(`[commons-geo] ${done}/${targets.length}（一致 ${fileFor.size}）`);
  }

  // 2) 一致したファイルのサムネイル・作者・ライセンスをまとめて取得
  const info = new Map<string, SpotImage>();
  for (const batch of chunk([...new Set(fileFor.values())], 50)) {
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=640' +
      `&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent(batch.join('|'))}`;
    try {
      const res = await fetchJson<InfoRes>(url, { ttlHours: 24 * 13, intervalMs: 500, timeoutMs: 60_000 });
      const norm = new Map((res.query?.normalized ?? []).map((n) => [n.to, n.from]));
      for (const p of Object.values(res.query?.pages ?? {})) {
        const ii = p.imageinfo?.[0];
        if (!ii?.thumburl) continue;
        const md = ii.extmetadata ?? {};
        info.set(norm.get(p.title) ?? p.title, {
          url: ii.thumburl,
          page: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
          artist: md.Artist ? stripHtml(md.Artist.value).slice(0, 80) : undefined,
          license: md.LicenseShortName ? stripHtml(md.LicenseShortName.value) : undefined,
        });
      }
    } catch (e) {
      console.warn(`[commons-geo] 画像情報の取得失敗（スキップ）: ${(e as Error).message}`);
    }
  }

  const out: GeoImageWork = {};
  for (const [id, file] of fileFor) {
    const img = info.get(file);
    if (img) out[id] = img;
  }
  await writeWork('commons-geo.json', out);
  console.log(`[commons-geo] 写真 ${Object.keys(out).length} 件`);
  return out;
}

if (isMain(import.meta.url))
  enrichCommonsGeo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
