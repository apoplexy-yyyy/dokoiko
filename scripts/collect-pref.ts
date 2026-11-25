// ⑨ 神奈川県オープンデータ（CC BY 4.0）
//   - 児童館等：開館時間・対象年齢・公式URL。座標が空のものは国土地理院の住所検索で補う
//   - 入込観光客調査 第4表：主要な観光施設ごとの年間来訪者数（有名すぎるかどうかの判定に使う）
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

export async function collectPref() {
  const cityOf = await loadCityOf();
  const kids = await collectKids(cityOf);
  await writeWork('pref-kids.json', kids);
  console.log(`[pref] 児童館等 ${kids.length} 件`);
  const visitors = await collectVisitors();
  await writeWork('pref-visitors.json', visitors);
  console.log(`[pref] 入込観光客（主要施設） ${visitors.length} 件`);
  return { kids, visitors };
}

if (isMain(import.meta.url)) {
  collectPref().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
