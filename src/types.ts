// 収集スクリプトとフロントエンドで共有するデータ型

export type Category =
  | 'playground'
  | 'park'
  | 'nature'
  | 'water'
  | 'zoo'
  | 'museum'
  | 'library'
  | 'history'
  | 'view'
  | 'farm'
  | 'play'
  | 'other';

/** 子供向けポイント（カードにアイコン表示） */
export type Feature =
  | 'playground' // 遊具あり（近く）
  | 'toilets' // トイレあり（近く）
  | 'free' // 無料
  | 'wheelchair' // バリアフリー
  | 'baby' // おむつ替え
  | 'indoor' // 屋内（雨の日OK）
  | 'large'; // 広い（2ha以上）

export interface SpotImage {
  url: string; // サムネイルURL
  page: string; // Commonsのファイルページ
  artist?: string;
  license?: string;
}

export interface Spot {
  id: string; // OSM: n123 / w456 / r789
  name: string;
  lat: number;
  lon: number;
  cat: Category;
  city?: string;
  indoor: boolean;
  f: Feature[];
  hours?: string;
  web?: string;
  wd?: string; // Wikidata QID
  desc?: string; // Wikidata の説明文
  wp?: { title: string; extract: string };
  img?: SpotImage;
  kid: number; // 子供向け度 0-1
  nov: number; // 意外性（有名すぎない）0-1
  rich: number; // 情報の充実度 0-1
  apl: number; // 行く価値（広さ・施設の種類）0-1
  ha?: number; // 広い公園のおおよその面積(ha)
}

export interface NewsItem {
  title: string;
  link: string;
  date?: string; // ISO
  source: string;
}

export interface NewsData {
  updatedAt: string;
  bySpot: Record<string, NewsItem[]>;
  byCity: Record<string, NewsItem[]>;
}

export interface CityInfo {
  name: string;
  lat: number;
  lon: number;
  count: number;
}

export interface Meta {
  region: string;
  name: string;
  updatedAt: string;
  count: number;
  tileSize: number;
  tiles: string[]; // "x_y"
  bbox: [number, number, number, number]; // [south, west, north, east]
  center: [number, number];
  cities: CityInfo[];
  sources: { name: string; license: string; url: string }[];
}

export function tileKey(lat: number, lon: number, size: number): string {
  return `${Math.floor(lon / size)}_${Math.floor(lat / size)}`;
}
