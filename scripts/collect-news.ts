// ⑤ 新着情報・イベント：自治体等のRSS/Atomと（任意で）Google News RSS を取得して .work/news-raw.json に保存
// スポットとの照合は build-data.ts で行う
import { XMLParser } from 'fast-xml-parser';
import feeds from '../config/feeds.json' with { type: 'json' };
import { fetchText } from './lib/http.ts';
import { isMain, readWork, writeWork } from './lib/work.ts';
import type { NewsItem } from '../src/types.ts';
import type { OsmWork } from './collect-osm.ts';

export interface RawNews extends NewsItem {
  city?: string; // 自治体フィード由来なら市町村名
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text'] ?? (v as Record<string, unknown>)['@href'] ?? '');
  return String(v).trim();
};
const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** RSS 2.0 / RSS 1.0(RDF) / Atom を共通の形に変換 */
export function parseFeed(xml: string, source: string, city?: string): RawNews[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const items: any[] = doc.rss
    ? arr(doc.rss.channel?.item)
    : doc['rdf:RDF']
      ? arr(doc['rdf:RDF'].item)
      : doc.feed
        ? arr(doc.feed.entry)
        : [];
  const out: RawNews[] = [];
  for (const it of items) {
    const title = text(it.title);
    let link = text(it.link);
    if (!link && Array.isArray(it.link)) link = text(it.link.find((l: any) => l['@rel'] !== 'self') ?? it.link[0]);
    const rawDate = text(it.pubDate ?? it['dc:date'] ?? it.updated ?? it.published);
    const d = rawDate ? new Date(rawDate) : undefined;
    // Google News は「タイトル - 媒体名」形式。媒体名を出典にする
    const src = text(it.source) || source;
    if (title && link) out.push({ title, link, date: d && !isNaN(+d) ? d.toISOString() : undefined, source: src, city });
  }
  return out;
}

const gnUrl = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;

export async function collectNews(): Promise<RawNews[]> {
  const all: RawNews[] = [];
  const targets: { name: string; url: string; city?: string }[] = [...feeds.feeds];

  if (feeds.googleNews.enabled) {
    for (const q of feeds.googleNews.queries) targets.push({ name: 'Google ニュース', url: gnUrl(q) });
    if (feeds.googleNews.perCity) {
      const osm = await readWork<OsmWork>('osm.json', { spots: [], playgrounds: [], toilets: [], fetchedAt: '' });
      const cities = [...new Set(osm.spots.map((s) => s.city).filter((c): c is string => !!c))];
      for (const c of cities) targets.push({ name: 'Google ニュース', url: gnUrl(`${c} ${feeds.googleNews.cityQuerySuffix}`), city: c });
    }
  }

  for (const t of targets) {
    try {
      const xml = await fetchText(t.url, { ttlHours: 6, intervalMs: 1500, retries: 1, timeoutMs: 30_000 });
      const items = parseFeed(xml, t.name, t.city);
      all.push(...items);
      console.log(`[news] ${t.name}: ${items.length} 件`);
    } catch (e) {
      console.warn(`[news] 失敗（スキップ） ${t.name}: ${(e as Error).message}`);
    }
  }

  // 古い記事を除外・重複除去
  const cutoff = Date.now() - feeds.maxAgeDays * 86400_000;
  const seen = new Set<string>();
  const fresh = all.filter((n) => {
    if (n.date && +new Date(n.date) < cutoff) return false;
    if (seen.has(n.link)) return false;
    seen.add(n.link);
    return true;
  });
  await writeWork('news-raw.json', fresh);
  console.log(`[news] 合計 ${fresh.length} 件`);
  return fresh;
}

if (isMain(import.meta.url))
  collectNews().catch((e) => {
    console.error(e);
    process.exit(1);
  });
