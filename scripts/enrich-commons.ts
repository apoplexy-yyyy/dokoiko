// ④ Wikimedia Commons：Wikidata の画像(P18)のサムネイルURL・作者・ライセンスを取得
import { chunk, fetchJson } from './lib/http.ts';
import { argLimit, isMain, readWork, writeWork } from './lib/work.ts';
import type { WdInfo } from './enrich-wikidata.ts';
import type { SpotImage } from '../src/types.ts';

export type CommonsWork = Record<string, SpotImage>; // ファイル名 -> 画像情報

interface QueryRes {
  query?: {
    normalized?: { from: string; to: string }[];
    pages?: Record<
      string,
      {
        title: string;
        imageinfo?: {
          thumburl?: string;
          descriptionurl?: string;
          extmetadata?: Record<string, { value: string }>;
        }[];
      }
    >;
  };
}

export const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export async function enrichCommons(): Promise<CommonsWork> {
  const wd = await readWork<Record<string, WdInfo>>('wikidata.json', {});
  let files = [...new Set(Object.values(wd).map((w) => w.image).filter((f): f is string => !!f))];
  const limit = argLimit();
  if (limit) files = files.slice(0, limit);
  console.log(`[commons] ${files.length} 画像`);

  const out: CommonsWork = {};
  for (const batch of chunk(files, 50)) {
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640' +
      '&iiextmetadatafilter=Artist|LicenseShortName' +
      `&titles=${encodeURIComponent(batch.map((f) => 'File:' + f).join('|'))}`;
    try {
      const res = await fetchJson<QueryRes>(url, { ttlHours: 24 * 6, intervalMs: 500 });
      const q = res.query;
      if (!q?.pages) continue;
      const norm = new Map((q.normalized ?? []).map((n) => [n.to, n.from]));
      for (const p of Object.values(q.pages)) {
        const ii = p.imageinfo?.[0];
        if (!ii?.thumburl) continue;
        const req = (norm.get(p.title) ?? p.title).replace(/^File:/, '');
        const md = ii.extmetadata ?? {};
        out[req] = {
          url: ii.thumburl,
          page: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
          artist: md.Artist ? stripHtml(md.Artist.value).slice(0, 80) : undefined,
          license: md.LicenseShortName ? stripHtml(md.LicenseShortName.value) : undefined,
        };
      }
    } catch (err) {
      console.warn(`[commons] バッチ失敗（スキップ）: ${(err as Error).message}`);
    }
  }
  await writeWork('commons.json', out);
  console.log(`[commons] 取得 ${Object.keys(out).length} 件`);
  return out;
}

if (isMain(import.meta.url))
  enrichCommons().catch((e) => {
    console.error(e);
    process.exit(1);
  });
