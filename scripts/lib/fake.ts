// 実在しない・場所が違う施設の判定（純粋関数。単体テスト対象）
// Overture の Meta（Facebook のチェックイン場所）由来のデータには、「ディズニーランド」が川崎駅前にあるような、
// 有名な施設の名前だけを借りた場所が混じる。全国の有名な施設（Wikidata）と名前を照らし、
// 本物が遠くにしか無いものを見つける
import { normName } from './name.ts';

/** 全国の有名な施設（Wikidata） */
export interface Famous {
  q: string;
  name: string;
  lat: number;
  lon: number;
  /** Wikipedia などの言語版の数（知名度） */
  sitelinks: number;
}

/** 本物がこれより遠くにしか無ければ「場所が違う」とみなす（km） */
export const FAR_KM = 5;

/** 名前の照合用：表記ゆれ（長音・之/の/ノ・ヶ/ケ）をそろえる */
export function fameKey(s: string): string {
  return normName(s)
    .replace(/[ーｰ―‐&＆]/g, '')
    .replace(/[之の]/g, 'ノ')
    .replace(/[ヶヵ]/g, 'ケ');
}

function distKm(a: number, b: number, c: number, d: number): number {
  const r = Math.PI / 180;
  const x = (d - b) * r * Math.cos(((a + c) / 2) * r);
  const y = (c - a) * r;
  return Math.hypot(x, y) * 6371;
}

/**
 * 名前が有名な施設と同じか：同じ表記、または頭に地名などが付いただけ（「東京」ディズニーランド、「鴨川」シーワールド）。
 * 「こども動物園」のような一般的な名前で消さないよう、種類の部分（動物園など）を除いた固有の部分が短いものは除く
 */
function sameFamous(key: string, f: Famous): boolean {
  const fk = fameKey(f.name);
  // 「動物園」「水族館」などの種類の部分を除いた、固有の部分の長さ
  const own = key.replace(GENERIC, '').length;
  // 同じ表記なら、固有の部分が短くても（「金沢」動物園）知名度があれば同じとみなす
  if (fk === key) return own >= 3 || (own >= 2 && f.sitelinks >= 3);
  return own >= 4 && f.sitelinks >= 3 && fk.endsWith(key) && fk.length - key.length <= 4;
}

/** 施設の種類を表す名前の終わり（照合用の表記で） */
const GENERIC = new RegExp(
  '(' +
    ['こども', '子ども', '子供', '動物園', '水族館', '植物園', '美術館', '博物館', '資料館', '記念館', '科学館', '植物館', '温室', '文学館', 'ミュージアム', 'アクアリウム', 'パーク', 'ランド', '遊園地', 'センター', '公園', '海水浴場', '海岸', 'ビーチ', '浜', '湖']
      .map(fameKey)
      .join('|') +
    ')+$',
);

/**
 * 有名な施設の名前なのに、本物が遠くにしか無い → その有名な施設を返す（消す理由）。
 * 近くに同じ名前の施設があれば（支店・分館など）問題なし
 */
export function misplacedFamous(name: string, lat: number, lon: number, famous: Famous[]): Famous | undefined {
  const key = fameKey(name);
  let far: Famous | undefined;
  for (const f of famous) {
    if (!sameFamous(key, f)) continue;
    if (distKm(lat, lon, f.lat, f.lon) <= FAR_KM) return undefined;
    far ??= f;
  }
  return far;
}

/** 砂浜・海水浴場なのに、海岸線からこれより遠い（km）なら場所が違うとみなす */
export const COAST_KM = 1;

/** 海岸線（150m おきの点）から最も近い点までの距離（km）。海岸線のデータが無ければ 0 */
export function coastDistKm(lat: number, lon: number, coast: [number, number][]): number {
  let min = coast.length ? Infinity : 0;
  for (const [a, b] of coast) {
    if (Math.abs(a - lat) > 0.2 || Math.abs(b - lon) > 0.25) continue;
    min = Math.min(min, distKm(lat, lon, a, b));
  }
  return min;
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

/** 地名からの距離の目安（km）。名前に入った地名がこれより遠くにしか無ければ場所が違うとみなす */
export const PLACE_KM = 5;

/** 「津久井一丁目」→「津久井」。照合に使う地名の元の形 */
export const placeBase = (n: string) => n.normalize('NFKC').replace(/[0-9一二三四五六七八九十]+丁目$|[0-9]+$/, '').replace(/\s/g, '');

/**
 * 「地名＋浜・海岸」という名前の砂浜で、その地名が近く（PLACE_KM 以内）に無い → その地名を返す。
 * 「津久井浜」が横浜市金沢区にある（津久井は横須賀市）など。
 * 「長浜」「湘南」のような短い地名・広い地域名は、地名のデータに載っていない場所にも使われるので見ない（3文字以上）
 */
export function misplacedPlace(name: string, lat: number, lon: number, places: Place[]): string | undefined {
  const core = name
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/(海水浴場|海岸|ビーチ|浜)+$/, '');
  if (core.length < 3) return undefined;
  const same = places.filter((p) => placeBase(p.name) === core);
  if (!same.length || same.some((p) => distKm(lat, lon, p.lat, p.lon) <= PLACE_KM)) return undefined;
  return core;
}

/** 実在しない・場所が違うと確認した場所（config/wrong.json） */
export interface ManualWrong {
  name?: string;
  id?: string;
  reason: string;
}

/** 手で登録した「実在しない・場所が違う」場所か：同じ ID、または同じ名前 */
export function manualWrong(s: { id: string; name: string; wd?: string }, list: ManualWrong[]): ManualWrong | undefined {
  const key = normName(s.name);
  return list.find((w) => (w.id && (w.id === s.id || w.id === s.wd)) || (w.name && normName(w.name) === key));
}
