// 時間地図：選んだ駅からの電車の所要時間（休日の日中の平均・推定）に合わせて、地図・ピン・駅を歪めて見せる。
// 時間地図ボタンを初めて押したときに読み込む（ふだんの地図の読み込みには入らない）
import type L from 'leaflet';
import { WarpBaseLayer } from './baseLayer';
import { decodeTable, makeWarp, nearestStation, placeMinutes, warpLatLng, type TimemapJson, type TimeTable, type Warp } from './warp';

export class TimeMap {
  private warp: Warp;
  private layer: WarpBaseLayer;

  private constructor(
    private tt: TimeTable,
    private map: L.Map,
    center: number,
    tile: { url: string; maxNativeZoom: number },
    private onChange: () => void,
  ) {
    this.warp = makeWarp(tt, center);
    this.layer = new WarpBaseLayer(tt, this.warp, tile.url, tile.maxNativeZoom, (i) => this.setCenter(i));
    this.layer.addTo(map);
    if (import.meta.env.DEV) (window as unknown as { __timemap?: TimeMap }).__timemap = this; // 開発中の確認用
  }

  /**
   * 表を読み込んで時間地図を始める。中心駅は、前回の中心駅（名前）があればそれ、無ければ画面の中心にいちばん近い駅
   */
  static async start(
    url: string,
    map: L.Map,
    tile: { url: string; maxNativeZoom: number },
    lastCenter: string | null,
    onChange: () => void,
  ): Promise<TimeMap> {
    const res = await fetch(url);
    if (!res.ok) throw new Error('所要時間のデータを読み込めませんでした');
    const tt = decodeTable((await res.json()) as TimemapJson);
    const c = map.getCenter();
    const named = lastCenter ? tt.names.indexOf(lastCenter) : -1;
    return new TimeMap(tt, map, named >= 0 ? named : nearestStation(tt, c.lat, c.lng), tile, onChange);
  }

  get centerName(): string {
    return this.tt.names[this.warp.center];
  }

  /** 中心駅を変える（地図の画面の中心も新しい中心駅へ動かす） */
  setCenter(i: number) {
    this.warp = makeWarp(this.tt, i);
    this.layer.setWarp(this.warp);
    this.map.panTo([this.tt.lat[i], this.tt.lon[i]]);
    this.onChange();
  }

  /** 背景の地図の種類を変えたとき */
  setTile(url: string, maxNativeZoom: number) {
    this.layer.setTileUrl(url, maxNativeZoom);
  }

  /** 緯度経度を歪めた位置へ（スポット・イベントの座標を置き換えるのに使う） */
  place<T extends { lat: number; lon: number }>(x: T): T {
    const [lat, lon] = warpLatLng(this.warp, x.lat, x.lon);
    return { ...x, lat, lon };
  }

  /** 中心駅から、ある場所まで電車＋徒歩の時間（分）と降りる駅の名前 */
  minutesTo(lat: number, lon: number): { min: number; via: string } | null {
    const r = placeMinutes(this.tt, this.warp.center, lat, lon);
    return r ? { min: Math.round(r.min), via: this.tt.names[r.via] } : null;
  }

  stop() {
    this.layer.remove();
  }
}
