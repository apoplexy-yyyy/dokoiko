// ⑨ 神奈川県オープンデータ（CC BY 4.0）
//   - 児童館等：開館時間・対象年齢・公式URL。座標が空のものは国土地理院の住所検索で補う
//   - 入込観光客調査 第4表：主要な観光施設ごとの年間来訪者数（有名すぎるかどうかの判定に使う）
//   - 公園：遊具・トイレ・水遊び・小動物などの設備（県・市町村の連携データ）
//   - 図書館：オムツ交換台・授乳室・読み聞かせスペース（県・市町村の連携データ）
//   - 子育て応援パスポート協力施設：おむつ替え・授乳スペース
//   横浜市オープンデータ（CC BY）
//   - 親と子のつどいの広場、ハマハグ協賛店舗・施設（授乳室・おむつ交換台）
import ExcelJS from 'exceljs';
import { fetchJson, fetchText } from './lib/http.ts';
import { isMain, writeWork } from './lib/work.ts';
import { loadCityOf } from './lib/cities.ts';

const CKAN = 'https://catalog.opendata.pref.kanagawa.jp/api/3/action/package_show?id=';
const KIDS_ID = '1fac5576e78c7c11000c569570a08454';
const VISITORS_ID = 'd15baed36468b613d92bd78b8e23187f';
const UA = 'dokoiko-collector/0.1 (open data prototype; https://github.com/)';

export interface PrefKids {
  id: string;
  name: string;
  lat: number;
  lon: number;
  city: string;
  hours?: string;
  closed?: string;
  web?: string;
  ages: string[];
}

export interface PrefVisitors {
  name: string;
  city: string;
  kind: string; // 施設・地点・行事
  thousand: number; // 年間来訪者（千人）
  year: string;
}

interface Resource {
  format: string;
  name: string;
  url: string;
}

async function resources(id: string): Promise<Resource[]> {
  const r = await fetchJson<{ result: { resources: Resource[] } }>(CKAN + id, { ttlHours: 24 });
  return r.result.resources;
}

/** 引用符つきに対応した最小限の CSV パーサ */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 国土地理院の住所検索（座標が空の行を補う） */
async function geocode(address: string): Promise<[number, number] | undefined> {
  const r = await fetchJson<{ geometry: { coordinates: [number, number] } }[]>(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`,
    { ttlHours: 24 * 90, intervalMs: 1000 },
  );
  const c = r[0]?.geometry.coordinates;
  return c ? [c[1], c[0]] : undefined;
}

const hm = (t: string) => t.slice(0, 5);

async function collectKids(cityOf: (lat: number, lon: number) => string | undefined): Promise<PrefKids[]> {
  const csv = (await resources(KIDS_ID)).find((r) => r.format.toUpperCase() === 'CSV');
  if (!csv) throw new Error('児童館等の CSV が見つかりません');
  const rows = parseCsv(await fetchText(csv.url, { ttlHours: 24 * 6 }));
  const head = rows[0];
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const C = {
    id: col('ID'),
    name: col('名称'),
    addr: col('所在地'),
    lat: col('緯度'),
    lon: col('経度'),
    wdS: col('開始時間（平日）'),
    wdE: col('終了時間（平日）'),
    heS: col('開始時間（土日'),
    heE: col('終了時間（土日'),
    note: col('利用可能日時特記事項'),
    url: col('URL'),
    baby: col('乳幼児'),
    elem: col('小学生'),
    jr: col('中学生'),
  };
  const out: PrefKids[] = [];
  for (const r of rows.slice(1)) {
    const name = r[C.name]?.trim();
    if (!name) continue;
    let lat = Number(r[C.lat]);
    let lon = Number(r[C.lon]);
    if (!lat || !lon) {
      const g = r[C.addr] ? await geocode(r[C.addr]) : undefined;
      if (!g) continue;
      [lat, lon] = g;
    }
    const city = cityOf(lat, lon);
    if (!city) continue;
    const wd = r[C.wdS] && r[C.wdE] ? `平日 ${hm(r[C.wdS])}〜${hm(r[C.wdE])}` : '';
    const he = r[C.heS] && r[C.heE] ? `土日祝 ${hm(r[C.heS])}〜${hm(r[C.heE])}` : '';
    const ages = [r[C.baby] === '1' && '乳幼児', r[C.elem] === '1' && '小学生', r[C.jr] === '1' && '中学生'].filter((x): x is string => !!x);
    out.push({
      id: 'pk' + r[C.id],
      name,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      city,
      hours: [wd, he].filter(Boolean).join('・') || undefined,
      closed: r[C.note]?.trim() || undefined,
      web: /^https?:\/\//.test(r[C.url] ?? '') ? r[C.url] : undefined,
      ages,
    });
  }
  return out;
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
};

async function collectVisitors(): Promise<PrefVisitors[]> {
  const files = (await resources(VISITORS_ID)).filter((r) => /xlsx/i.test(r.format));
  const latest = files[files.length - 1];
  if (!latest) throw new Error('入込観光客調査の xlsx が見つかりません');
  const year = latest.name.match(/^(R\d+|H\d+)/)?.[1] ?? '';
  const res = await fetch(latest.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${latest.url}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const out: PrefVisitors[] = [];
  let city = ''; // シートをまたいで前の市町村の続きになる
  for (const ws of wb.worksheets.filter((w) => /第[4４]表/.test(w.name))) {
    // 左右2段組み（名称・調査区分・観光客数）。左の段を上から読み、続けて右の段を読む。
    // 【横浜市】のような見出しで市町村が変わり、右の段の先頭は左の段の最後の市町村の続き
    const rows: ExcelJS.Row[] = [];
    ws.eachRow((row) => rows.push(row));
    for (const c0 of [1, 5])
      for (const row of rows) {
        const name = cellText(row.getCell(c0).value).replace(/\s+/g, ' ').trim();
        const m = name.match(/^【\s*(.+?)\s*】$/);
        if (m) {
          city = m[1].replace(/\s/g, '');
          continue;
        }
        const kind = cellText(row.getCell(c0 + 1).value).trim();
        const n = Number(cellText(row.getCell(c0 + 2).value));
        if (name && /施設|地点|行事/.test(kind) && Number.isFinite(n) && n > 0) out.push({ name, city, kind, thousand: n, year });
      }
  }
  return out;
}

/** 横浜市「親と子のつどいの広場」（乳幼児と保護者が遊べる場所。CC BY） */
const TSUDOI_PAGE = 'https://www.city.yokohama.lg.jp/kosodate-kyoiku/kosodateshien/asobiba/tsudoi/tsudoinohiroba.html';
const TSUDOI_CSV = 'https://www.city.yokohama.lg.jp/kosodate-kyoiku/kosodateshien/asobiba/tsudoi/tsudoinohiroba.files/0029_20251218.csv';

async function collectYokohamaTsudoi(cityOf: (lat: number, lon: number) => string | undefined): Promise<PrefKids[]> {
  const rows = parseCsv(await fetchText(TSUDOI_CSV, { ttlHours: 24 * 6 }));
  const head = rows[0];
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const C = { name: col('名称'), lat: col('緯度'), lon: col('経度') };
  const out: PrefKids[] = [];
  rows.slice(1).forEach((r, i) => {
    const lat = Number(r[C.lat]);
    const lon = Number(r[C.lon]);
    const name = r[C.name]?.trim();
    if (!name || !lat || !lon) return;
    const city = cityOf(lat, lon);
    if (!city) return;
    out.push({ id: `yt${i}`, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), city, web: TSUDOI_PAGE, ages: ['乳幼児'] });
  });
  return out;
}

// ---------------- 公園（県・市町村の連携データ。遊具・トイレなどの設備つき、座標なし） ----------------

const PARK_ID = 'd1dd79afd3bcfe4ae56b139f5f7f7bb3';
const LIBRARY_ID = '7762fb99daa687050cd86e85403dc81e';
const PASSPORT_ID = '497d10d7e4f8831495e2726cfe9b27a9';

export interface PrefPark {
  id: string;
  name: string;
  city: string; // 所在地から（横浜市泉区 など）
  lat?: number; // 目立つ公園だけ住所から求める
  lon?: number;
  ha?: number;
  play: boolean; // 遊具あり
  toilets: boolean;
  terms: string[]; // 特徴語（ふわふわドーム・水遊び など）
  hours?: string;
  web?: string;
}

const PLAY_COLS = ['スプリング遊具・スイング遊具', '砂場', '複合遊具', 'ブランコ', 'すべり台', 'ジャングルジム', '鉄棒', 'シーソー', 'ターザンロープ', 'ローラースライダー', 'ふわふわドーム'];
/** 設備の列 → 特徴語 */
const PARK_TERMS: Record<string, string> = {
  ふわふわドーム: 'ふわふわドーム',
  ローラースライダー: 'ローラー滑り台',
  ターザンロープ: 'ターザンロープ',
  水遊び: '水遊び',
  'ウサギ・モルモット': 'ふれあい動物',
  ハムスター: 'ふれあい動物',
  ひよこ: 'ふれあい動物',
  '馬・ポニー': '乗馬',
  バーベキュー場: 'バーベキュー',
  芝生広場: '芝生広場',
  プール: 'プール',
};
/** 住所から位置を求めて、スポットに無ければ追加する公園（珍しい設備があるか、1ha 以上で遊具がある） */
const SPECIAL = ['ふわふわドーム', 'ローラースライダー', '水遊び', 'ウサギ・モルモット', 'ハムスター', 'ひよこ', '馬・ポニー'];

/** 所在地から市区町村（横浜市泉区・足柄上郡開成町→開成町 など） */
export function cityOfAddress(addr: string): string {
  const a = addr.replace(/^神奈川県/, '');
  return a.match(/^(.+?市.+?区|.+?[市町村])/)?.[1]?.replace(/^.+?郡/, '') ?? '';
}

async function collectParks(): Promise<PrefPark[]> {
  const csv = (await resources(PARK_ID)).find((r) => r.format.toUpperCase() === 'CSV');
  if (!csv) throw new Error('公園の CSV が見つかりません');
  const rows = parseCsv(await fetchText(csv.url, { ttlHours: 24 * 6 }));
  const head = rows[0].map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const out: PrefPark[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < head.length - 2) continue;
    const name = r[col('名称')]?.trim();
    const addr = r[col('所在地')]?.trim() ?? '';
    if (!name || !addr) continue;
    const yes = (k: string) => r[col(k)] === '1';
    const ha = Number(r[col('面積')]) / 10000 || undefined;
    const play = PLAY_COLS.some(yes);
    const terms = [...new Set(Object.entries(PARK_TERMS).filter(([k]) => yes(k)).map(([, v]) => v))];
    const p: PrefPark = {
      id: 'pp' + r[col('ID')],
      name,
      city: cityOfAddress(addr),
      ha: ha ? Math.round(ha * 10) / 10 : undefined,
      play,
      toilets: yes('トイレ'),
      terms,
      hours: [r[col('開園時間')], r[col('休園日')] && `休園：${r[col('休園日')]}`].filter((x) => x && x !== '-').join(' ').slice(0, 120) || undefined,
      web: /^https?:\/\//.test(r[col('関連リンク')] ?? '') ? r[col('関連リンク')] : undefined,
    };
    if (SPECIAL.some(yes) || (play && (ha ?? 0) >= 1)) {
      const g = await geocode(addr);
      if (g) [p.lat, p.lon] = [+g[0].toFixed(5), +g[1].toFixed(5)];
    }
    out.push(p);
  }
  return out;
}

// ---------------- 赤ちゃん連れの設備（おむつ替え・授乳） ----------------

/** おむつ替え・授乳ができる施設。スポットと名前・場所で照らし合わせて「おむつ・授乳」を付ける */
export interface BabyCare {
  name: string;
  lat?: number;
  lon?: number;
  city?: string;
  src: string;
}

/** 県の図書館データ（座標・開館時間・オムツ交換台・授乳室・読み聞かせスペース） */
export interface PrefLibrary {
  id: string;
  name: string;
  lat: number;
  lon: number;
  city: string;
  baby: boolean;
  story: boolean; // 絵本の読み聞かせスペース
  web?: string;
}

async function collectLibraries(cityOf: (lat: number, lon: number) => string | undefined): Promise<PrefLibrary[]> {
  const csv = (await resources(LIBRARY_ID)).find((r) => r.format.toUpperCase() === 'CSV');
  if (!csv) throw new Error('図書館の CSV が見つかりません');
  const rows = parseCsv(await fetchText(csv.url, { ttlHours: 24 * 6 }));
  const head = rows[0].map((h) => h.trim());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const out: PrefLibrary[] = [];
  for (const r of rows.slice(1)) {
    const name = r[col('名称')]?.trim();
    if (!name) continue;
    let lat = Number(r[col('緯度')]);
    let lon = Number(r[col('経度')]);
    if (!lat || !lon) {
      const g = r[col('所在地')] ? await geocode(r[col('所在地')]) : undefined;
      if (!g) continue;
      [lat, lon] = g;
    }
    const city = cityOf(lat, lon);
    if (!city) continue;
    out.push({
      id: 'pl' + r[col('ID')],
      name,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      city,
      baby: r[col('オムツ交換台')] === '1' || r[col('授乳室')] === '1',
      story: r[col('絵本読み聞かせスペース')] === '1',
      web: /^https?:\/\//.test(r[col('URL')] ?? '') ? r[col('URL')] : undefined,
    });
  }
  return out;
}

/** 横浜市「ハマハグ」協賛店舗・施設（CC BY。授乳室・おむつ交換台の有無と座標つき） */
export const HAMAHUG_PAGE = 'https://www.city.yokohama.lg.jp/kosodate-kyoiku/kosodateshien/shiensodan/default2020091.html';
const HAMAHUG_CKAN = 'https://data.city.yokohama.lg.jp/api/3/action/package_show?id=kodomo_default2020091';

async function collectHamahug(): Promise<BabyCare[]> {
  const r = await fetchJson<{ result: { resources: Resource[] } }>(HAMAHUG_CKAN, { ttlHours: 24 });
  const csv = r.result.resources.find((x) => x.format.toUpperCase() === 'CSV'); // 先頭が最新
  if (!csv) throw new Error('ハマハグの CSV が見つかりません');
  // この CSV は Shift_JIS
  const res = await fetch(csv.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${csv.url}`);
  const rows = parseCsv(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
  const head = rows[0].map((h) => h.trim());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const C = { name: col('施設: 施設名'), lat: col('施設位置 (緯度)'), lon: col('施設位置 (経度)'), room: col('授乳室'), space: col('授乳スペース'), diaper: col('おむつ交換台') };
  const has = (v: string | undefined) => !!v && v !== '0' && v !== '';
  const out: BabyCare[] = [];
  for (const row of rows.slice(1)) {
    const name = row[C.name]?.trim();
    const lat = Number(row[C.lat]);
    const lon = Number(row[C.lon]);
    if (!name || !lat || !lon) continue;
    if (!(has(row[C.room]) || has(row[C.space]) || has(row[C.diaper]))) continue;
    out.push({ name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), src: 'ハマハグ' });
  }
  return out;
}

/** 県「子育て応援パスポート」協力施設（CC BY。おむつ替え・授乳スペースの有無。座標なし・2021 年時点） */
async function collectPassport(): Promise<BabyCare[]> {
  const file = (await resources(PASSPORT_ID)).find((r) => /xlsx/i.test(r.format));
  if (!file) throw new Error('子育て応援パスポートの xlsx が見つかりません');
  const res = await fetch(file.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${file.url}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const ws = wb.worksheets[0];
  const head = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => cellText(v).trim());
  const col = (name: string) => head.indexOf(name);
  const C = { name: col('施設名'), city: col('地域'), diaper: col('おむつ替えスペース'), nurse: col('授乳・調乳スペース') };
  const out: BabyCare[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const v = (c: number) => cellText(row.getCell(c).value).trim();
    const name = v(C.name);
    if (!name || !(v(C.diaper) === 'あり' || v(C.nurse) === 'あり')) return;
    out.push({ name, city: v(C.city), src: '子育て応援パスポート' });
  });
  return out;
}

export async function collectPref() {
  const cityOf = await loadCityOf();
  const kids = await collectKids(cityOf);
  await writeWork('pref-kids.json', kids);
  console.log(`[pref] 児童館等 ${kids.length} 件`);
  try {
    const tsudoi = await collectYokohamaTsudoi(cityOf);
    await writeWork('city-kids.json', tsudoi);
    console.log(`[pref] 横浜市 親と子のつどいの広場 ${tsudoi.length} 件`);
  } catch (e) {
    console.warn(`[pref] 横浜市 親と子のつどいの広場 失敗（スキップ）: ${(e as Error).message}`);
  }
  const visitors = await collectVisitors();
  await writeWork('pref-visitors.json', visitors);
  console.log(`[pref] 入込観光客（主要施設） ${visitors.length} 件`);
  // 以下はどれも失敗しても続ける（無ければ統合で飛ばす）
  const optional = async <T>(label: string, file: string, run: () => Promise<T[]>) => {
    try {
      const list = await run();
      await writeWork(file, list);
      console.log(`[pref] ${label} ${list.length} 件`);
    } catch (e) {
      console.warn(`[pref] ${label} 失敗（スキップ）: ${(e as Error).message}`);
    }
  };
  await optional('公園', 'pref-parks.json', collectParks);
  await optional('図書館', 'pref-libraries.json', () => collectLibraries(cityOf));
  await optional('ハマハグ（おむつ・授乳）', 'baby-hamahug.json', collectHamahug);
  await optional('子育て応援パスポート（おむつ・授乳）', 'baby-passport.json', collectPassport);
  return { kids, visitors };
}

if (isMain(import.meta.url)) {
  collectPref().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
