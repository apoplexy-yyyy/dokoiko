// 利用者ごとの記録（ブラウザ内のみ）：おすすめに出た場所（seen）・閲覧履歴（viewed）など
import type { Spot } from '../types';

export interface SavedSpot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  cat: Spot['cat'];
  city?: string;
  at: number;
}

type ListName = 'seen' | 'viewed' | 'want' | 'went';
const KEY = 'dokoiko:v1:';

// 一覧は読み込んだらメモリに持ち、保存はまとめて後で行う。
// 地図を動かすたびに「全件を読む→書き換える→全件を保存」を繰り返すと、最大2000件の変換と保存でスマホが引っかかるため
const cache = new Map<ListName, SavedSpot[]>();
const dirty = new Set<ListName>();
let flushTimer = 0;

function read(name: ListName): SavedSpot[] {
  let list = cache.get(name);
  if (!list) {
    try {
      const v = localStorage.getItem(KEY + name);
      list = v ? (JSON.parse(v) as SavedSpot[]) : [];
    } catch {
      list = [];
    }
    cache.set(name, list);
  }
  return list;
}

function flush() {
  flushTimer = 0;
  for (const name of dirty) {
    try {
      localStorage.setItem(KEY + name, JSON.stringify(read(name)));
    } catch {
      /* プライベートモード等では保存しない */
    }
  }
  dirty.clear();
}

function write(name: ListName, list: SavedSpot[]) {
  cache.set(name, list.slice(-2000));
  dirty.add(name);
  // 手が空いたときに保存する（閉じる前には必ず保存）
  if (!flushTimer) {
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    flushTimer = ric ? ric(flush, { timeout: 3000 }) : window.setTimeout(flush, 1000);
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
}

const toSaved = (s: Spot): SavedSpot => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, cat: s.cat, city: s.city, at: Date.now() });

export const history = {
  list: read,
  ids(name: ListName): Set<string> {
    return new Set(read(name).map((s) => s.id));
  },
  has(name: ListName, id: string) {
    return read(name).some((s) => s.id === id);
  },
  add(name: ListName, spot: Spot) {
    this.addMany(name, [spot]);
  },
  /** まとめて追加する（すでにあるものは新しい位置へ） */
  addMany(name: ListName, spots: Spot[]) {
    if (!spots.length) return;
    const ids = new Set(spots.map((s) => s.id));
    const list = read(name).filter((s) => !ids.has(s.id));
    list.push(...spots.map(toSaved));
    write(name, list);
  },
  remove(name: ListName, id: string) {
    write(
      name,
      read(name).filter((s) => s.id !== id),
    );
  },
  clear(name: ListName) {
    write(name, []);
  },
  toggle(name: ListName, spot: Spot): boolean {
    if (this.has(name, spot.id)) {
      this.remove(name, spot.id);
      return false;
    }
    this.add(name, spot);
    return true;
  },
  prefs: {
    get<T>(k: string, d: T): T {
      try {
        const v = localStorage.getItem(KEY + 'pref:' + k);
        return v ? (JSON.parse(v) as T) : d;
      } catch {
        return d;
      }
    },
    set(k: string, v: unknown) {
      try {
        localStorage.setItem(KEY + 'pref:' + k, JSON.stringify(v));
      } catch {
        /* noop */
      }
    },
  },
};
