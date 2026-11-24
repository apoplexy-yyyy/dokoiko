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
  other: { label: 'スポット', icon: '✦', color: '#8a7a5c' },
};

export const FEAT: Record<Feature, { label: string; icon: string }> = {
  playground: { label: '遊具', icon: '🛝' },
  toilets: { label: 'トイレ', icon: '🚻' },
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
