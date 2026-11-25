// ⑥ 子供向けイベント：自治体のイベント情報を取得し、public/data/kanagawa/events.json に直接書き出す
// 施設データ（タイル）とは独立しているので、毎日これだけを実行できる
//   - 川崎市「かわさきイベントアプリ」Web API（CC BY 2.1 JP。会場の座標・対象年齢つき）
//   - 横浜市 イベント検索のデータ（ジャンル「子育て」。会場の座標が無いので区の中心に置く）
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJson } from './lib/http.ts';
import { isMain, writeJson } from './lib/work.ts';
import { distKm } from '../src/discover/pick.ts';
import type { CityInfo, EventItem, EventsData, Meta, Spot } from '../src/types.ts';

const OUT = 'public/data/kanagawa';
/** 何日先までのイベントを載せるか */
export const DAYS_AHEAD = 45;
const BBOX = [35.12, 138.91, 35.68, 139.8];

export const SOURCES: EventsData['sources'] = [
  { name: '川崎市 かわさきイベントアプリ', license: 'CC BY 2.1 JP', url: 'https://eventapp.city.kawasaki.jp/data/api/v1/reference.html' },
  { name: '横浜市 イベント情報', license: 'タイトル・日付・リンクのみ', url: 'https://www.city.yokohama.lg.jp/' },
];

/** 日本時間の日付 YYYY-MM-DD */
export function ymd(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
const addDays = (s: string, n: number) => ymd(new Date(Date.parse(s + 'T00:00:00+09:00') + n * 86400_000));

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const hm = (t: string | undefined) => (t ? t.slice(0, 5) : '');

/** 大人向け・事務的なものを除く */
const EXCLUDE = /両親学級|母親学級|指導者|養成|説明会|研修|講習会|講演|セミナー|フォーラム|相談会|会議|入札|募集は終了|終了しました|中止|延期|職員|ボランティア募集|虐待|啓発|オンライン/;
/** 期間中ほぼ毎日ある長期の募集・展示は、出かける理由になりにくいので除く */
const MAX_DAYS = 30;

// ---------------- 川崎市 ----------------

interface KwEvent {
  title: string;
  status: string;
  date_list: { date: string; time_from: string; time_to: string; time_ext: string }[];
  type1: string;
  target: string;
  place: string;
  event_location: { latitude: number; longitude: number; venue_address: string; place: string }[];
  place_adr: string;
  place_lat: number | null;
  place_lon: number | null;
  cost_ext: string;
  open_url: string;
  rel_list: { rel_url: string }[];
  upd_date: string;
}
interface KwResponse {
  page: number;
  total_pages: number;
  event_data?: KwEvent[];
}

const KIDS_TARGET = /乳児|幼児|小学生/;
/** 表示する対象（年齢順） */
const AGES = ['乳児', '幼児', '小学生', '中学生'];
const KIDS_TYPE = /遊び|子ども・子育て|小学生向け/;

/** 住所の後ろに続く施設名（「…4階 川崎市総合自治会館」→「川崎市総合自治会館」） */
export function venueName(adr: string): string | undefined {
  const parts = clean(adr).split(' ');
  if (parts.length < 2) return undefined;
  // 部屋・階の表記（「4階」「501会議室」「和室」「１・２階」）は施設名ではない
  const names = parts.slice(1).filter((p) => !/(階|室|号)$/.test(p) && !/^[0-9０-９・ー－-]+$/.test(p) && !/^[（(]/.test(p) && !/^[A-Za-zＡ-Ｚ]?[0-9０-９]+$/.test(p));
  return names[names.length - 1];
}

export function fromKawasaki(e: KwEvent, today: string, until: string): EventItem | null {
  const title = clean(e.title);
  if (!title || EXCLUDE.test(title)) return null;
  if (e.status && e.status !== '公開中') return null;
  const target = clean(e.target);
  // 対象に全世代が並ぶものは「子供向け」ではないので、ジャンルで判断する
  const broad = !target || target === '指定なし' || target.split(',').length >= 6;
  const kids = (!broad && KIDS_TARGET.test(target)) || (broad && KIDS_TYPE.test(e.type1));
  if (!kids) return null;
  const days = e.date_list.filter((d) => d.date >= today && d.date <= until);
  if (!days.length || days.length > MAX_DAYS) return null;
  const loc = e.event_location?.[0];
  const lat = loc?.latitude ?? e.place_lat ?? undefined;
  const lon = loc?.longitude ?? e.place_lon ?? undefined;
  if (lat == null || lon == null || lat < BBOX[0] || lat > BBOX[2] || lon < BBOX[1] || lon > BBOX[3]) return null;
  const ward = loc?.place ?? e.place;
  const first = days[0];
  const time = first.time_from && first.time_from !== '00:00:00' ? `${hm(first.time_from)}〜${hm(first.time_to)}`.replace(/〜$/, '') : clean(first.time_ext);
  const url = e.open_url || e.rel_list?.[0]?.rel_url;
  if (!url) return null;
  const cost = clean(e.cost_ext);
  return {
    id: 'kw:' + url.replace(/^https?:\/\//, '') + ':' + title.slice(0, 20),
    title,
    dates: [...new Set(days.map((d) => d.date))].sort(),
    time: time || undefined,
    lat,
    lon,
    city: /区$/.test(ward) ? `川崎市${ward}` : '川崎市',
    venue: venueName(loc?.venue_address ?? e.place_adr),
    target: AGES.filter((a) => target.includes(a)).join(',') || undefined,
    // 費用欄に持ち物などが書かれていることがあるので、金額らしいものだけ
    cost: /円|無料/.test(cost) ? (cost.length > 30 ? cost.slice(0, 30) + '…' : cost) : undefined,
    url,
    src: '川崎市',
  };
}

async function collectKawasaki(today: string, until: string): Promise<EventItem[]> {
  const base = 'https://eventapp.city.kawasaki.jp/data/api/v1/events';
  const out = new Map<string, EventItem>();
  // 対象（乳児・幼児・小学生）とジャンル（遊び・子ども子育て・小学生向け）の2通りで取り、まとめる
  for (const q of ['target=1,2,3', 'type=3,8,20']) {
    for (let page = 1; page <= 20; page++) {
      const url = `${base}?format=JSON&from=${today}&to=${until}&${q}&page=${page}`;
      const res = await fetchJson<KwResponse>(url, { ttlHours: 6, intervalMs: 1000, retries: 2, timeoutMs: 30_000 });
      for (const e of res.event_data ?? []) {
        const ev = fromKawasaki(e, today, until);
        if (ev) out.set(ev.id, ev);
      }
      if (page >= res.total_pages) break;
    }
  }
  return [...out.values()];
}

// ---------------- 横浜市 ----------------

interface YkRow {
  column0: string; // イベント名
  column1: string; // 開催エリア（区名, 市内全域 など）
  column2: string; // ジャンル
  column3: string; // 開催日 "2026/11/28" / "2026/04/09,2026/05/14" / "2026/07/11-2026/12/25"
  column4: string; // パス
}

/** 横浜市の開催日表記を日付の配列にする。31日を超える期間（長期の募集・展示）は除く */
export function parseYkDates(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map((x) => x.trim().replace(/\//g, '-'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) continue;
    if (!b) out.push(a);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(b)) {
      const n = Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
      if (n < 0 || n > 31) continue;
      for (let i = 0; i <= n; i++) out.push(addDays(a, i));
    }
  }
  return out;
}

export function fromYokohama(r: YkRow, today: string, until: string, cities: CityInfo[]): EventItem | null {
  const title = clean(r.column0);
  if (!title || !/子育て/.test(r.column2) || EXCLUDE.test(title)) return null;
  const days = parseYkDates(r.column3).filter((d) => d >= today && d <= until);
  if (!days.length || days.length > MAX_DAYS) return null;
  const area = clean(r.column1).split(/[,、]/)[0];
  if (area === 'オンライン' || area === '市外') return null;
  const city = /区$/.test(area) ? `横浜市${area}` : '横浜市';
  const c = cities.find((x) => x.name === city) ?? cities.find((x) => x.name === '横浜市中区');
  if (!c) return null;
  const url = new URL(r.column4, 'https://www.city.yokohama.lg.jp/').href;
  return {
    id: 'yk:' + r.column4,
    title,
    dates: [...new Set(days)].sort(),
    lat: c.lat,
    lon: c.lon,
    approx: true,
    city,
    url,
    src: '横浜市',
  };
}

async function collectYokohama(today: string, until: string, cities: CityInfo[]): Promise<EventItem[]> {
  const res = await fetchJson<{ contents: YkRow[] }>('https://www.city.yokohama.lg.jp/search-event/event.json', {
    ttlHours: 6,
    retries: 2,
    timeoutMs: 30_000,
  });
  return res.contents.map((r) => fromYokohama(r, today, until, cities)).filter((e): e is EventItem => !!e);
}

// ---------------- 施設との照合 ----------------

/** 会場名・タイトルに施設名が含まれる、1.2km以内の施設と結び付ける（近いだけでは別の施設のことが多い） */
export function attachSpots(events: EventItem[], spots: Spot[]) {
  for (const ev of events) {
    let best: { s: Spot; score: number } | undefined;
    for (const s of spots) {
      if (ev.approx) {
        // 区の中心しか分からないので、同じ区で、タイトルに5文字以上の施設名が含まれる場合だけ
        if (s.city !== ev.city || s.name.length < 5 || !ev.title.includes(s.name)) continue;
        const score = s.name.length;
        if (!best || score > best.score) best = { s, score };
        continue;
      }
      const d = distKm(ev.lat, ev.lon, s.lat, s.lon);
      if (d > 1.2) continue; // 広い公園は中心から会場まで離れていることがある
      const named = s.name.length >= 3 && ((ev.venue ?? '').includes(s.name) || ev.title.includes(s.name));
      if (!named) continue;
      const score = s.name.length - d * 10;
      if (!best || score > best.score) best = { s, score };
    }
    if (best) {
      ev.spot = best.s.id;
      ev.spotName = best.s.name;
      if (ev.approx) {
        ev.lat = best.s.lat;
        ev.lon = best.s.lon;
        delete ev.approx;
      }
    }
  }
}

async function loadSpots(): Promise<Spot[]> {
  const dir = join(OUT, 'tiles');
  const files = await readdir(dir);
  const lists = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Spot[]));
  return lists.flat();
}

export async function collectEvents(now = new Date()) {
  const today = ymd(now);
  const until = addDays(today, DAYS_AHEAD);
  const meta = JSON.parse(await readFile(join(OUT, 'meta.json'), 'utf8')) as Meta;

  const events: EventItem[] = [];
  const tasks: [string, () => Promise<EventItem[]>][] = [
    ['川崎市', () => collectKawasaki(today, until)],
    ['横浜市', () => collectYokohama(today, until, meta.cities)],
  ];
  let ok = 0;
  for (const [name, fn] of tasks) {
    try {
      const list = await fn();
      events.push(...list);
      ok++;
      console.log(`[events] ${name}: ${list.length} 件`);
    } catch (e) {
      console.warn(`[events] 失敗（スキップ） ${name}: ${(e as Error).message}`);
    }
  }
  if (!ok) throw new Error('イベントを1件も取得できませんでした');

  attachSpots(events, await loadSpots());
  events.sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || a.title.localeCompare(b.title, 'ja'));
  const data: EventsData = { updatedAt: now.toISOString(), events, sources: SOURCES };
  await writeJson(join(OUT, 'events.json'), data);
  console.log(`[events] 合計 ${events.length} 件（施設と一致 ${events.filter((e) => e.spot).length} 件）→ ${OUT}/events.json`);
  return data;
}

if (isMain(import.meta.url)) {
  collectEvents().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
