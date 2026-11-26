// 静的JSONの読み込み：広域表示ではおすすめ（highlights.json）だけ、拡大時は表示範囲のタイルだけを取得する
import { type EventsData, type Meta, type NewsData, type Spot } from '../types';
import type { Bounds } from '../discover/pick';

const BASE = `${import.meta.env.BASE_URL}data/kanagawa/`;
const tileCache = new Map<string, Promise<Spot[]>>();

/** これより広い範囲（ズームが小さい）では highlights.json を使う */
export const DETAIL_ZOOM = 12;

export async function loadMeta(): Promise<Meta> {
  const res = await fetch(BASE + 'meta.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('データを読み込めませんでした');
  return res.json();
}

const getJson = <T>(url: string, fallback: T): Promise<T> =>
  fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<T>) : fallback))
    .catch(() => fallback);

let newsPromise: Promise<NewsData | null> | undefined;
export function loadNews(): Promise<NewsData | null> {
  newsPromise ??= getJson<NewsData | null>(BASE + 'news.json', null);
  return newsPromise;
}

let eventsPromise: Promise<EventsData | null> | undefined;
/** イベントは毎日更新されるので、ブラウザのキャッシュを使わず確認する */
export function loadEvents(): Promise<EventsData | null> {
  eventsPromise ??= fetch(BASE + 'events.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<EventsData>) : null))
    .catch(() => null);
  return eventsPromise;
}

let highlightsPromise: Promise<Spot[]> | undefined;
export function loadHighlights(): Promise<Spot[]> {
  highlightsPromise ??= getJson<Spot[]>(BASE + 'highlights.json', []);
  return highlightsPromise;
}

function loadTile(key: string): Promise<Spot[]> {
  let p = tileCache.get(key);
  if (!p) {
    p = getJson<Spot[]>(`${BASE}tiles/${key}.json`, []);
    tileCache.set(key, p);
  }
  return p;
}

/** 表示範囲を覆うタイルを読み込む */
export async function loadBounds(meta: Meta, b: Bounds): Promise<Spot[]> {
  const s = meta.tileSize;
  const have = new Set(meta.tiles);
  const keys: string[] = [];
  for (let y = Math.floor(b.south / s); y <= Math.floor(b.north / s); y++)
    for (let x = Math.floor(b.west / s); x <= Math.floor(b.east / s); x++) {
      const k = `${x}_${y}`;
      if (have.has(k)) keys.push(k);
    }
  const lists = await Promise.all(keys.map(loadTile));
  return lists.flat();
}

/**
 * 表示範囲のまわり（1タイル分）を、手が空いたときに先読みしておく。
 * 次に地図を動かしたときに通信を待たずに済む（スマホでは初回の読み込みに 200ms ほどかかるため）
 */
export function prefetchAround(meta: Meta, b: Bounds, ring = 1): void {
  const s = meta.tileSize;
  const have = new Set(meta.tiles);
  const keys: string[] = [];
  for (let y = Math.floor(b.south / s) - ring; y <= Math.floor(b.north / s) + ring; y++)
    for (let x = Math.floor(b.west / s) - ring; x <= Math.floor(b.east / s) + ring; x++) {
      const k = `${x}_${y}`;
      if (have.has(k) && !tileCache.has(k)) keys.push(k);
    }
  if (!keys.length) return;
  // 画面の中心に近い順に読む
  const cy = (b.south + b.north) / 2 / s;
  const cx = (b.west + b.east) / 2 / s;
  const d = (k: string) => {
    const [x, y] = k.split('_').map(Number);
    return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
  };
  keys.sort((a, b) => d(a) - d(b));
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const run = () => keys.slice(0, 16).forEach(loadTile);
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 500);
}
