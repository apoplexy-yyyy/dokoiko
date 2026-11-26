// 閉館・閉業の判定（純粋関数。単体テスト対象）
// - closed：はっきり閉館・廃止している → 地図から消す
// - suspect：疑いがある → 得点を下げ、理由を吹き出しに書く

export interface Closure {
  level: 'closed' | 'suspect';
  /** 吹き出しに出す理由 */
  why: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const quote = (s: string, n = 40) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** OSM のタグ：終了日・名前の（閉館）・メモの「休止中」など */
export function osmClosure(tags: Record<string, string>, now = today()): Closure | undefined {
  const name = tags['name:ja'] ?? tags.name ?? '';
  const end = tags.end_date;
  if (end && /^\d{4}(-\d{2})?(-\d{2})?$/.test(end) && end <= now) return { level: 'closed', why: `OSM に終了日 ${end}` };
  if (/[（(](閉館|閉園|閉店|廃止|閉鎖)[^）)]*[）)]|閉館$/.test(name)) return { level: 'closed', why: '名前に「閉館」' };
  if (/^(closed|off)$/i.test(tags.opening_hours ?? '')) return { level: 'suspect', why: 'OSM の営業時間が「休業」' };
  const m = name.match(/[（(](休館|休園|休業|休止|工事)[^）)]*[）)]/);
  if (m) return { level: 'suspect', why: `名前に「${m[0]}」` };
  for (const k of ['description', 'note', 'note:ja', 'description:ja']) {
    const t = tags[k];
    if (!t) continue;
    const hit = t.match(/[^。]{0,20}(休止中|休館中|休園中|閉鎖中|から休止|より休止|閉館しました|閉園しました|営業を終了)/);
    if (hit) return { level: 'suspect', why: `OSM のメモ「${quote(hit[0])}」` };
  }
  return undefined;
}

/** Wikidata の閉館・廃止日 */
export function wikidataClosure(ended: string | undefined, now = today()): Closure | undefined {
  // 江戸時代の関所や戦前の役場など、史跡としては今も見られるものは除く（閉館の判定は近年のものだけ）
  if (ended && ended >= '1990' && ended <= now) return { level: 'closed', why: `Wikidata に閉館・廃止日 ${ended}` };
  return undefined;
}

/**
 * Wikipedia の説明文：施設そのものが閉館した・休館中と書いてあるか。
 * 「かつて〜にあった関所」のような史跡や、別の建物の閉館の話もあるので「疑い」にとどめる
 */
export function wikipediaClosure(text: string | undefined, cat: string): Closure | undefined {
  if (!text || ['history', 'view', 'nature', 'park'].includes(cat)) return undefined;
  const patterns = [
    /[^。]{0,30}(閉館|閉園|閉店|営業を終了|営業終了)(した|となった|された)。/,
    /[^。]{0,20}\d+日(閉館|閉園|閉店)。/,
    /[^。]{0,25}(に|で)(あった|存在した)(水族館|博物館|美術館|資料館|記念館|科学館|遊園地|動物園|テーマパーク|施設|レジャー施設|プール)/,
    /[^。]{0,30}(休館|休園|休止)(中|している)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { level: 'suspect', why: `Wikipedia に「${quote(m[0])}」` };
  }
  return undefined;
}

/** 公式サイトの確認結果（check-websites.ts） */
export interface WebCheck {
  checked: string; // YYYY-MM-DD
  st: 'ok' | 'notfound' | 'dns' | 'notice' | 'parked' | 'error';
  note?: string;
}

/** 季節の営業終了・本日の受付終了などは除く */
const SEASONAL = /[0-9０-９]{4}年[^。をに]{0,10}の|今年度|狩り|あいにく|本日|今日|今季|今シーズン|シーズン|年内|冬季|夏季|本年|今年|期間|臨時|一時|当日|受付|予約|販売|配信|イベント|キャンペーン|募集|工事|改装|リニューアル|移転|年末|年始|午前|午後|時間/;

/** ページ本文から、閉館・閉業のお知らせや、ドメインの売り出しを探す */
export function pageClosure(html: string): Pick<WebCheck, 'st' | 'note'> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  if (/このドメインは.{0,30}(販売|売却|取得|購入)|ドメイン.{0,10}(販売中|売ります)|this domain (is|may be) for sale|buy this domain/i.test(text))
    return { st: 'parked', note: '公式サイトのドメインが売りに出されています' };
  const patterns = [
    /([^。！!]{0,30})(閉館|閉園|閉店|営業を終了|営業終了|閉業)(いた|致)?しました/g,
    /([^。！!]{0,30})をもちまして[^。]{0,20}(閉館|閉園|閉店|営業を終了|閉業)/g,
    /([^。！!]{0,30})(長らく|長い間|永らく)[^。]{0,10}ご愛顧/g,
  ];
  for (const re of patterns)
    for (const m of text.matchAll(re)) {
      if (SEASONAL.test(m[0])) continue;
      // 単語の途中から始まる引用（「AIL PARK」）にならないよう、前の区切りまで戻す
      const start = m.index ?? 0;
      const before = text.slice(Math.max(0, start - 20), start).match(/[^\s。、！!「」]*$/)?.[0] ?? '';
      return { st: 'notice', note: quote(before + m[0], 60) };
    }
  return { st: 'ok' };
}

/** 公式サイトの確認結果 → 閉業の疑い */
export function webClosure(c: WebCheck | undefined): Closure | undefined {
  if (!c) return undefined;
  if (c.st === 'notice') return { level: 'suspect', why: `公式サイトに「${c.note}」（${c.checked} 確認）` };
  if (c.st === 'parked') return { level: 'suspect', why: `${c.note}（${c.checked} 確認）` };
  // ページが無い・ドメインが無いだけでは疑いにしない（自治体サイトの引っ越しや運営会社のサイト統合でよく起きる）。リンクだけ外す
  return undefined;
}

/** リンクを外すべき公式サイト（つながらない・ページが無い） */
export const deadLink = (c: WebCheck | undefined) => c?.st === 'dns' || c?.st === 'notfound';

/** 疑いのあるスポットの得点（行く価値）に掛ける係数 */
export const SUSPECT_FACTOR = 0.35;
