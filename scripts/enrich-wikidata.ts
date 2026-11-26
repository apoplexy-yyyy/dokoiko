// ② Wikidata：OSMの wikidata タグから説明文・画像・公式サイト・知名度（sitelink数）を取得
import { chunk, fetchJson } from './lib/http.ts';
import { argLimit, isMain, readWork, writeWork } from './lib/work.ts';
import type { OsmWork } from './collect-osm.ts';

export interface WdInfo {
  label?: string;
  desc?: string;
  image?: string; // Commons ファイル名
  website?: string;
  sitelinks: number;
  jawiki?: string;
  /** 閉館・廃止された日（P576 解散・廃止 / P3999 閉鎖日 / P582 終了日）YYYY-MM-DD */
  ended?: string;
}

export interface WdEntity {
  missing?: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, { mainsnak: { datavalue?: { value: unknown } } }[]>;
  sitelinks?: Record<string, { title: string }>;
}

const claim = (e: WdEntity, p: string) => e.claims?.[p]?.[0]?.mainsnak.datavalue?.value as string | undefined;

/** 閉館・廃止日（いずれかのプロパティの時刻値）を YYYY-MM-DD で返す */
export function endedOf(e: WdEntity): string | undefined {
  for (const p of ['P576', 'P3999', 'P582']) {
    const v = e.claims?.[p]?.[0]?.mainsnak.datavalue?.value as { time?: string } | undefined;
    const m = v?.time?.match(/^\+(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2] === '00' ? '01' : m[2]}-${m[3] === '00' ? '01' : m[3]}`;
  }
  return undefined;
}

export async function enrichWikidata(): Promise<Record<string, WdInfo>> {
  const osm = await readWork<OsmWork>('osm.json');
  const match = await readWork<Record<string, string>>('wd-match.json', {});
  let qids = [...new Set(osm.spots.map((s) => s.tags.wikidata ?? match[s.id]).filter((q): q is string => !!q && /^Q\d+$/.test(q)))];
  const limit = argLimit();
  if (limit) qids = qids.slice(0, limit);
  console.log(`[wikidata] ${qids.length} 件`);

  const out: Record<string, WdInfo> = {};
  for (const ids of chunk(qids, 50)) {
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions|claims|sitelinks' +
      `&languages=ja&ids=${ids.join('|')}`;
    try {
      const res = await fetchJson<{ entities: Record<string, WdEntity> }>(url, { ttlHours: 24 * 6, intervalMs: 500 });
      for (const [q, e] of Object.entries(res.entities)) {
        if (e.missing !== undefined) continue;
        out[q] = {
          label: e.labels?.ja?.value,
          desc: e.descriptions?.ja?.value,
          image: claim(e, 'P18'),
          website: claim(e, 'P856'),
          sitelinks: Object.keys(e.sitelinks ?? {}).length,
          jawiki: e.sitelinks?.jawiki?.title,
          ended: endedOf(e),
        };
      }
    } catch (err) {
      console.warn(`[wikidata] バッチ失敗（スキップ）: ${(err as Error).message}`);
    }
  }
  await writeWork('wikidata.json', out);
  console.log(`[wikidata] 取得 ${Object.keys(out).length} 件`);
  return out;
}

if (isMain(import.meta.url))
  enrichWikidata().catch((e) => {
    console.error(e);
    process.exit(1);
  });
