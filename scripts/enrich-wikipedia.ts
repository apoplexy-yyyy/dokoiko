// ③ Wikipedia（日本語版）：記事冒頭の要約を取得（CC BY-SA、出典リンク付きで表示）
import { chunk, fetchJson } from './lib/http.ts';
import { argLimit, isMain, readWork, writeWork } from './lib/work.ts';
import type { OsmWork } from './collect-osm.ts';
import type { WdInfo } from './enrich-wikidata.ts';

export type WpWork = Record<string, string>; // 記事タイトル -> 要約

interface QueryRes {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: Record<string, { title: string; extract?: string; missing?: string }>;
  };
}

/** Wikidata の jawiki、なければ OSM の wikipedia タグ（"ja:タイトル"）から記事タイトルを決める */
export function wikiTitle(tags: Record<string, string>, wd?: WdInfo): string | undefined {
  if (wd?.jawiki) return wd.jawiki;
  const t = tags.wikipedia;
  if (t?.startsWith('ja:')) return t.slice(3);
  return undefined;
}

export async function enrichWikipedia(): Promise<WpWork> {
  const osm = await readWork<OsmWork>('osm.json');
  const wd = await readWork<Record<string, WdInfo>>('wikidata.json', {});
  const match = await readWork<Record<string, string>>('wd-match.json', {});
  let titles = [
    ...new Set(
      osm.spots
        .map((s) => {
          const q = s.tags.wikidata ?? match[s.id];
          return wikiTitle(s.tags, q ? wd[q] : undefined);
        })
        .filter((t): t is string => !!t),
    ),
  ];
  const limit = argLimit();
  if (limit) titles = titles.slice(0, limit);
  console.log(`[wikipedia] ${titles.length} 記事`);

  const out: WpWork = {};
  for (const batch of chunk(titles, 20)) {
    const url =
      'https://ja.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&exsentences=3&exlimit=20&redirects=1' +
      `&titles=${encodeURIComponent(batch.join('|'))}`;
    try {
      const res = await fetchJson<QueryRes>(url, { ttlHours: 24 * 6, intervalMs: 500 });
      const q = res.query;
      if (!q?.pages) continue;
      const byTitle = new Map(
        Object.values(q.pages)
          .filter((p) => p.extract)
          .map((p) => [p.title, p.extract!]),
      );
      for (const t of batch) {
        // 要求したタイトル → 正規化 → リダイレクト先 を辿る
        let cur = t;
        for (const n of q.normalized ?? []) if (n.from === cur) cur = n.to;
        for (const r of q.redirects ?? []) if (r.from === cur) cur = r.to;
        const ex = byTitle.get(cur);
        if (ex) out[t] = ex.replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    } catch (err) {
      console.warn(`[wikipedia] バッチ失敗（スキップ）: ${(err as Error).message}`);
    }
  }
  await writeWork('wikipedia.json', out);
  console.log(`[wikipedia] 取得 ${Object.keys(out).length} 件`);
  return out;
}

if (isMain(import.meta.url))
  enrichWikipedia().catch((e) => {
    console.error(e);
    process.exit(1);
  });
