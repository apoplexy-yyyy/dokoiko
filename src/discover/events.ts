// イベントの日付しぼり込みと、表示範囲での抽出
import type { EventItem } from '../types';
import type { Bounds } from './pick';

export type When = 'today' | 'weekend' | 'soon';

export const WHEN_LABEL: Record<When, string> = { today: '今日', weekend: '今週末', soon: '2週間' };

const pad = (n: number) => String(n).padStart(2, '0');
/** 端末の現地時刻での YYYY-MM-DD */
export const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** しぼり込みに使う日付の一覧。今週末は、土日ならその日から日曜まで、平日なら次の土日 */
export function whenDays(when: When, now = new Date()): string[] {
  if (when === 'today') return [localYmd(now)];
  if (when === 'soon') return Array.from({ length: 14 }, (_, i) => localYmd(plus(now, i)));
  const dow = now.getDay(); // 0=日 6=土
  if (dow === 0) return [localYmd(now)];
  if (dow === 6) return [localYmd(now), localYmd(plus(now, 1))];
  return [localYmd(plus(now, 6 - dow)), localYmd(plus(now, 7 - dow))];
}

export interface EventHit {
  ev: EventItem;
  /** 期間内で最初の開催日 */
  day: string;
  /** 期間内の開催日数 */
  times: number;
}

const inside = (b: Bounds, lat: number, lon: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/** 表示範囲と日付でしぼり込み、日付順（同じ日なら会場が分かるもの優先）に並べる */
export function eventsInView(events: EventItem[], b: Bounds, days: string[]): EventHit[] {
  const set = new Set(days);
  const hits: EventHit[] = [];
  for (const ev of events) {
    if (!inside(b, ev.lat, ev.lon)) continue;
    const ds = ev.dates.filter((d) => set.has(d));
    if (ds.length) hits.push({ ev, day: ds[0], times: ds.length });
  }
  return hits.sort((a, b) => a.day.localeCompare(b.day) || Number(!!a.ev.approx) - Number(!!b.ev.approx) || a.ev.title.localeCompare(b.ev.title, 'ja'));
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
/** "2026-11-28" → { md: "11/28", dow: "土" } */
export function dayLabel(ymd: string): { md: string; dow: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { md: `${m}/${d}`, dow: DOW[new Date(y, m - 1, d).getDay()] };
}
