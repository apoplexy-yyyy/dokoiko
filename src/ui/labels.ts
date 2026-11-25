import type { Category, Feature } from '../types';

export const CAT: Record<Category, { label: string; icon: string; color: string }> = {
  playground: { label: '遊び場', icon: '🛝', color: '#e8743b' },
  park: { label: '公園', icon: '🌳', color: '#4f9a5b' },
  nature: { label: '自然', icon: '🍃', color: '#3d8a74' },
  water: { label: '水辺', icon: '🌊', color: '#2f86b8' },
  zoo: { label: '生きもの', icon: '🐾', color: '#c0803a' },
  museum: { label: 'ミュージアム', icon: '🏛️', color: '#7a5fb0' },
  library: { label: '図書館', icon: '📚', color: '#5a6fb5' },
  history: { label: '歴史', icon: '🏯', color: '#a0573f' },
  view: { label: '見晴らし', icon: '⛰️', color: '#5f7f8f' },
  farm: { label: '農園・直売', icon: '🍓', color: '#c94b62' },
  play: { label: 'あそび', icon: '🎡', color: '#d4583d' },
  kids: { label: '児童館・子育てひろば', icon: '🧸', color: '#d9639a' },
  creature: { label: '生きもの観察', icon: '🪲', color: '#6b8e23' },
  other: { label: 'スポット', icon: '✦', color: '#8a7a5c' },
};

export const FEAT: Record<Feature, { label: string; icon: string }> = {
  playground: { label: '遊具', icon: '🛝' },
  toilets: { label: 'トイレ有', icon: '🚻' },
  free: { label: '無料', icon: '🆓' },
  wheelchair: { label: 'バリアフリー', icon: '♿' },
  baby: { label: 'おむつ替え', icon: '🍼' },
  indoor: { label: '屋内', icon: '☔' },
  large: { label: '広い', icon: '🏞️' },
};

/** 距離に応じて、徒歩・自転車・車のどれで行くかの目安を付ける */
export function travelText(km: number): string {
  const m = km < 2 ? { verb: '徒歩', speed: 4 } : km < 6 ? { verb: '自転車', speed: 12 } : { verb: '車', speed: 25 };
  const min = Math.max(1, Math.round(((km * 1.3) / m.speed) * 60));
  const dist = km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
  return `${dist}・${m.verb}${min}分ほど`;
}

/**
 * 地図のラベル用に、頭の市名を省いて短くする（「川崎市大戸こども文化センター」→「大戸こども文化センター」）。
 * 「横浜市民プール」「横浜市電保存館」のように市名が名前の一部になっているものはそのまま。
 */
export function shortName(name: string): string {
  const m = name.match(/^(横浜|川崎|相模原|横須賀|藤沢|平塚)市(立)?/);
  if (!m) return name;
  const rest = name.slice(m[0].length);
  if (!m[2] && /^[民電営役内外場政]/.test(rest)) return name;
  return rest.length >= 2 ? rest : name;
}

/** 施設名（＋市区町村）でのGoogle検索 */
export const googleSearchUrl = (name: string, city?: string) =>
  `https://www.google.com/search?q=${encodeURIComponent([name, city].filter(Boolean).join(' '))}`;
