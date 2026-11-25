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
  | 'kids'
  | 'creature'
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
  t?: number[]; // 特徴語（Meta.terms の添字）
  tl?: string[]; // 収集時のみ使う特徴語ラベル（出力前に t に変換して削除）
  vis?: number; // 年間来訪者数（千人、神奈川県 入込観光客調査）
  ages?: string[]; // 対象年齢（乳幼児・小学生など）
  obs?: { ja: string; n: number; m: number[]; key: number }[]; // 生きもの観察（GBIF）：和名・記録数・記録された月
  src?: string; // OSM 以外の出典（Overture・神奈川県・GBIF）
}

/** 特徴語と、県全体での珍しさ（IDF = ln(全スポット数 / その語を持つスポット数)） */
export interface Term {
  label: string;
  idf: number;
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
  terms: Term[];
}

export function tileKey(lat: number, lon: number, size: number): string {
  return `${Math.floor(lon / size)}_${Math.floor(lat / size)}`;
}

/** 子供向けイベント（自治体のイベント情報から毎日収集） */
export interface EventItem {
  id: string;
  title: string;
  dates: string[]; // 開催日 YYYY-MM-DD（収集日以降・昇順）
  time?: string; // 「14:00〜16:00」
  lat: number;
  lon: number;
  /** true なら会場の座標が無く、区・市の中心で代用している */
  approx?: boolean;
  city: string; // 川崎市中原区 など
  venue?: string;
  target?: string; // 乳児,幼児,小学生 など
  cost?: string;
  url: string;
  src: string; // 出典名
  spot?: string; // 会場と一致したスポットID
  spotName?: string;
}

export interface EventsData {
  updatedAt: string;
  events: EventItem[];
  sources: { name: string; license: string; url: string }[];
}
