// 時間地図の所要時間の表を作る：全駅から全駅への、電車の「休日の日中の平均」所要時間（分）
//
//   npm run build:timemap                       … distortMap の公開している推定時刻表から作る
//   TIMEMAP_SRC=../distortMap/data/osm_estimate.js npm run build:timemap … 手元のファイルから作る
//
// 入力：distortMap の推定時刻表（OpenStreetMap の路線から作ったもの。window.OSM_EST）
// 求め方は distortMap の「平均」と同じ：
//   1. 休日ダイヤ（無い路線は平日ダイヤ）の 10〜15 時の各 1 時間で、その時間に出発駅を出る全列車で探索し、駅ごとに一番速い行き方を取る
//   2. 6 つの時間帯の値の中央の値を、その駅への所要時間とする
// 探索は Connection Scan。乗換は同じ駅名どうしで 5 分（駅によって違う）、徒歩連絡の駅どうしも乗り換えられる
// 出力：public/data/kanagawa/timemap.json
//   stations: [[駅名, 緯度, 経度], …]、lines: [路線名…]、edges: [[駅番号, 駅番号, 路線番号], …]
//   t: 所要時間（分）の 駅数×駅数 の表（行が出発駅）を Uint8 で base64 にしたもの。255 は行けない
// 1 駅あたり約 1,000 回の探索になるので、CPU の数だけ worker で並列に計算する
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { fetchText } from './lib/http.ts';
import { isMain, writeJson } from './lib/work.ts';

const SRC_URL = 'https://apoplexy-yyyy.github.io/distortMap/data/osm_estimate.js';
const OUT = 'public/data/kanagawa/timemap.json';
/** 出発時刻の範囲（分）：10:00〜15:59 */
const HOURS = [10, 11, 12, 13, 14, 15];
/** 探索する先の長さ（分） */
const HORIZON = 240;
/** 乗換にかかる時間（分）。distortMap と同じ */
const TRANSFER_MIN: Record<string, number> = { 横浜: 6, 上大岡: 4, 弘明寺: 10, 金沢八景: 4, 菊名: 3, センター北: 3, センター南: 3 };
const TRANSFER_DEFAULT = 5;
/** 駅名の違う駅どうしの徒歩連絡（分）。distortMap と同じ */
const WALK: [string, string, number][] = [
  ['杉田', '新杉田', 7],
  ['逗子', '逗子・葉山', 6],
  ['久里浜', '京急久里浜', 6],
  ['元町・中華街', '石川町', 8],
  ['東神奈川', '京急東神奈川', 4],
  ['川崎', '京急川崎', 6],
];

interface EstLine {
  stations: string[];
  trains: [string, number[]][];
  trainsHoliday?: [string, number[]][];
}
interface Est {
  network: { lines: string[]; stations: { id: string; name: string; lat: number; lng: number }[]; edges: { source: string; target: string; line: string }[] };
  lines: Record<string, EstLine>;
}

/** 探索に使う形（数値の配列）。worker にもそのまま渡す */
export interface Graph {
  names: string[]; // 駅名（出力の駅の順）
  nodeName: Int32Array; // ノード（路線ごとの駅）→ 駅番号
  trOff: Int32Array; // 乗換：ノードごとの先頭
  trTo: Int32Array;
  trMin: Float64Array;
  from: Int32Array; // 区間（発車順）
  to: Int32Array;
  dep: Float64Array;
  arr: Float64Array;
  trip: Int32Array;
  tripCount: number;
}

export function buildGraph(est: Est): Graph {
  const names = est.network.stations.map((s) => s.name);
  const nameNo = new Map(names.map((n, i) => [n, i]));
  const nodes: number[] = []; // ノード → 駅番号
  const nodeOf = new Map<string, number>();
  const conns: [number, number, number, number, number][] = [];
  let trips = 0;
  for (const [line, l] of Object.entries(est.lines)) {
    const ids = l.stations.map((n) => {
      const k = line + '|' + n;
      if (!nodeOf.has(k)) {
        if (!nameNo.has(n)) nameNo.set(n, names.push(n) - 1);
        nodeOf.set(k, nodes.length);
        nodes.push(nameNo.get(n)!);
      }
      return nodeOf.get(k)!;
    });
    for (const [, s] of l.trainsHoliday ?? l.trains) {
      for (let j = 0; j + 3 < s.length; j += 2) conns.push([ids[s[j]], s[j + 1], ids[s[j + 2]], s[j + 3], trips]);
      trips++;
    }
  }
  conns.sort((a, b) => a[1] - b[1]);
  // 乗換：同じ駅名のノードどうしと、徒歩連絡の駅どうし
  const byName = new Map<number, number[]>();
  nodes.forEach((st, i) => byName.set(st, [...(byName.get(st) ?? []), i]));
  const tr: [number, number][][] = nodes.map(() => []);
  for (const [st, ids] of byName) {
    const min = TRANSFER_MIN[names[st]] ?? TRANSFER_DEFAULT;
    for (const a of ids) for (const b of ids) if (a !== b) tr[a].push([b, min]);
  }
  for (const [a, b, min] of WALK) {
    for (const x of byName.get(nameNo.get(a) ?? -1) ?? [])
      for (const y of byName.get(nameNo.get(b) ?? -1) ?? []) {
        tr[x].push([y, min]);
        tr[y].push([x, min]);
      }
  }
  const trOff = new Int32Array(nodes.length + 1);
  tr.forEach((l, i) => (trOff[i + 1] = trOff[i] + l.length));
  const trTo = new Int32Array(trOff[nodes.length]);
  const trMin = new Float64Array(trOff[nodes.length]);
  tr.forEach((l, i) => l.forEach(([to, m], k) => ((trTo[trOff[i] + k] = to), (trMin[trOff[i] + k] = m))));
  const n = conns.length;
  const g: Graph = {
    names,
    nodeName: Int32Array.from(nodes),
    trOff,
    trTo,
    trMin,
    from: new Int32Array(n),
    to: new Int32Array(n),
    dep: new Float64Array(n),
    arr: new Float64Array(n),
    trip: new Int32Array(n),
    tripCount: trips,
  };
  conns.forEach(([f, d, t, a, tp], k) => ((g.from[k] = f), (g.dep[k] = d), (g.to[k] = t), (g.arr[k] = a), (g.trip[k] = tp)));
  return g;
}

/**
 * 出発駅 src（駅番号）から各駅への「休日の日中の平均」所要時間（分）。行けない駅は Infinity
 * 各時間帯で一番速い行き方を取り、6 つの時間帯の中央の値（distortMap と同じく、偶数個なら小さい方の中央）
 */
export function rowFrom(g: Graph, src: number): Float64Array {
  const N = g.nodeName.length;
  const M = g.names.length;
  const srcNodes: number[] = [];
  for (let i = 0; i < N; i++) if (g.nodeName[i] === src) srcNodes.push(i);
  const isSrc = new Uint8Array(N);
  srcNodes.forEach((i) => (isSrc[i] = 1));
  // 出発時刻の候補：出発駅を出る列車の発車時刻
  const starts = new Set<number>();
  for (let k = 0; k < g.from.length; k++) if (isSrc[g.from[k]] && HOURS.includes(Math.floor(g.dep[k] / 60))) starts.add(g.dep[k]);
  const best = HOURS.map(() => new Float64Array(M).fill(Infinity)); // 時間帯 → 駅 → 最速
  const arr = new Float64Array(N);
  const boarded = new Uint8Array(g.tripCount);
  for (const t0 of starts) {
    arr.fill(Infinity);
    boarded.fill(0);
    const reach = (n: number, t: number) => {
      if (t >= arr[n]) return;
      arr[n] = t;
      for (let e = g.trOff[n]; e < g.trOff[n + 1]; e++) {
        const m = g.trTo[e];
        const tt = t + g.trMin[e];
        if (tt < arr[m]) arr[m] = tt;
      }
    };
    for (const n of srcNodes) reach(n, t0);
    let lo = 0;
    let hi = g.dep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.dep[mid] < t0) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < g.dep.length && g.dep[k] <= t0 + HORIZON; k++) {
      const tp = g.trip[k];
      if (boarded[tp] || arr[g.from[k]] <= g.dep[k]) {
        boarded[tp] = 1;
        reach(g.to[k], g.arr[k]);
      }
    }
    const b = best[HOURS.indexOf(Math.floor(t0 / 60))];
    for (let i = 0; i < N; i++) {
      const v = arr[i] - t0;
      if (v < b[g.nodeName[i]]) b[g.nodeName[i]] = v;
    }
  }
  const out = new Float64Array(M).fill(Infinity);
  for (let m = 0; m < M; m++) {
    if (m === src) {
      out[m] = 0;
      continue;
    }
    const vals = best.map((b) => b[m]).filter((v) => v < Infinity).sort((a, b) => a - b);
    if (vals.length) out[m] = vals[Math.floor((vals.length - 1) / 2)];
  }
  return out;
}

/** 表（分、Uint8。255 は行けない）を base64 に */
export function encodeTable(rows: Float64Array[], n: number): string {
  const t = new Uint8Array(n * n).fill(255);
  rows.forEach((r, i) => r.slice(0, n).forEach((v, j) => (t[i * n + j] = v < 254.5 ? Math.round(v) : 255)));
  return Buffer.from(t).toString('base64');
}

async function loadEst(): Promise<Est> {
  const src = process.env.TIMEMAP_SRC;
  const text = src ? await readFile(src, 'utf8') : await fetchText(SRC_URL, { ttlHours: 24 });
  const w: { window?: unknown; OSM_EST?: Est } = {};
  w.window = w;
  vm.createContext(w);
  vm.runInContext(text, w);
  if (!w.OSM_EST) throw new Error('推定時刻表（OSM_EST）が読めません');
  return w.OSM_EST;
}

async function main() {
  const est = await loadEst();
  const g = buildGraph(est);
  const n = est.network.stations.length;
  console.log(`[timemap] 駅 ${n}・区間 ${g.from.length}・列車 ${g.tripCount}`);
  const workers = Math.max(1, Math.min(cpus().length, 16));
  const rows: Float64Array[] = new Array(n);
  let done = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const mine = Array.from({ length: n }, (_, i) => i).filter((i) => i % workers === w);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { g, mine }, execArgv: ['--import', 'tsx'] });
        worker.on('message', (m: { i: number; row: Float64Array }) => {
          rows[m.i] = m.row;
          if (++done % 50 === 0) console.log(`[timemap] ${done}/${n}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code ? reject(new Error(`worker ${w} 終了コード ${code}`)) : resolve()));
      });
    }),
  );
  const lineNo = new Map(est.network.lines.map((l, i) => [l, i]));
  const idNo = new Map(est.network.stations.map((s, i) => [s.id, i]));
  const out = {
    generatedAt: new Date().toISOString(),
    note: '電車の休日の日中（10〜15時）の平均所要時間（分）。distortMap の推定時刻表（OpenStreetMap の路線から作ったもの）から計算',
    sources: '© OpenStreetMap contributors（ODbL）、国土数値情報（鉄道 N02・駅別乗降客数 S12・バス停留所 P11、CC BY 4.0）、Wikipedia（CC BY-SA 4.0）',
    stations: est.network.stations.map((s) => [s.name, +s.lat.toFixed(5), +s.lng.toFixed(5)]),
    lines: est.network.lines,
    edges: est.network.edges.map((e) => [idNo.get(e.source), idNo.get(e.target), lineNo.get(e.line) ?? -1]).filter((e) => e[0] != null && e[1] != null),
    t: encodeTable(rows, n),
  };
  await writeJson(OUT, out);
  const reach = rows.reduce((a, r) => a + r.slice(0, n).filter((v) => v < Infinity).length, 0);
  console.log(`[timemap] ${Math.round((Date.now() - t0) / 1000)} 秒で ${n}×${n}（行ける組 ${Math.round((reach / n / n) * 100)}%）→ ${join(OUT)}`);
}

if (!isMainThread && workerData) {
  const { g, mine } = workerData as { g: Graph; mine: number[] };
  for (const i of mine) parentPort!.postMessage({ i, row: rowFrom(g, i) });
} else if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
