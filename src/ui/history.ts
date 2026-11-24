// 利用者ごとの記録（ブラウザ内のみ）：発見済み・行ってみたい・行った
import type { Spot } from '../types';

export interface SavedSpot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  cat: Spot['cat'];
  at: number;
}

type ListName = 'seen' | 'want' | 'went';
const KEY = 'dokoiko:v1:';

function read(name: ListName): SavedSpot[] {
  try {
    const v = localStorage.getItem(KEY + name);
    return v ? (JSON.parse(v) as SavedSpot[]) : [];
  } catch {
    return [];
  }
}

function write(name: ListName, list: SavedSpot[]) {
  try {
    localStorage.setItem(KEY + name, JSON.stringify(list.slice(-2000)));
  } catch {
    /* プライベートモード等では保存しない */
  }
}

const toSaved = (s: Spot): SavedSpot => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, cat: s.cat, at: Date.now() });

export const history = {
  list: read,
  ids(name: ListName): Set<string> {
    return new Set(read(name).map((s) => s.id));
  },
  has(name: ListName, id: string) {
    return read(name).some((s) => s.id === id);
  },
  add(name: ListName, spot: Spot) {
    const list = read(name).filter((s) => s.id !== spot.id);
    list.push(toSaved(spot));
    write(name, list);
  },
  remove(name: ListName, id: string) {
    write(
      name,
      read(name).filter((s) => s.id !== id),
    );
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
