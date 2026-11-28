// 時間地図：選んだ駅からの電車の所要時間（休日の日中の平均・推定）に合わせて、地図・ピン・駅を歪めて見せる。
// 時間地図ボタンを初めて押したときに読み込む（ふだんの地図の読み込みには入らない）
// 始める・やめる・中心駅を変えるときは、変化前と変化後の位置を少しずつ混ぜて動かす（distortMap と同じ）
import type L from 'leaflet';
import { WarpBaseLayer, type WarpView } from './baseLayer';
import { decodeTable, makeWarp, nearestStation, placeMinutes, warpLatLng, type TimemapJson, type TimeTable, type Warp } from './warp';

/** アニメーションの長さ（ms） */
const DURATION = 900;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2); // 3 次のイーズインアウト

export class TimeMap implements WarpView {
  private warp: Warp;
  private layer: WarpBaseLayer;
  /** 変化前・変化後の歪め方（null は実際の地図） */
  private from: Warp | null = null;
  private to: Warp | null;
  private t0 = 0;
  private raf = 0;
  private timer = 0;
  /** 混ぜる割合（0＝変化前、1＝変化後。イーズ済み） */
  private a = 0; // 始めは実際の位置（begin で動かし始める）
  private onEnd: (() => void) | null = null;
  /** アニメーションの各フレームで呼ぶ（ピンを動かす）。最後のフレームの後は onChange */
  onFrame: () => void = () => {};

  private constructor(
    private tt: TimeTable,
    private map: L.Map,
    center: number,
    tile: { url: string; maxNativeZoom: number },
    private onChange: () => void,
  ) {
    this.warp = makeWarp(tt, center);
    this.to = this.warp;
    this.layer = new WarpBaseLayer(tt, this, tile.url, tile.maxNativeZoom, (i) => this.setCenter(i));
    this.layer.addTo(map);
    if (import.meta.env.DEV) (window as unknown as { __timemap?: TimeMap }).__timemap = this; // 開発中の確認用
  }

  /**
   * 表を読み込んで時間地図の層を載せる。中心駅は、前回の中心駅（名前）があればそれ、無ければ画面の中心にいちばん近い駅。
   * 層は始めは実際の位置で描き、画面の地図の画像が届くまで待ってから返す（その後 begin で動かし始める）。
   * 通常の地図の画像と同じ位置に描いてあるので、通常の地図を外しても継ぎ目は見えない
   */
  static async start(
    url: string,
    map: L.Map,
    tile: { url: string; maxNativeZoom: number },
    lastCenter: string | null,
    onChange: () => void,
    onFrame: () => void,
  ): Promise<TimeMap> {
    const res = await fetch(url);
    if (!res.ok) throw new Error('所要時間のデータを読み込めませんでした');
    const tt = decodeTable((await res.json()) as TimemapJson);
    const c = map.getCenter();
    const named = lastCenter ? tt.names.indexOf(lastCenter) : -1;
    const tm = new TimeMap(tt, map, named >= 0 ? named : nearestStation(tt, c.lat, c.lng), tile, onChange);
    tm.onFrame = onFrame;
    await tm.layer.whenReady();
    return tm;
  }

  /** 実際の地図から歪めた地図へ動かし始める */
  begin() {
    this.animate(null, this.warp);
  }

  // ---- WarpView（背景の層が使う） ----

  /** いま描く位置：変化前と変化後の位置を混ぜる */
  pos(lat: number, lon: number): [number, number] {
    const p1 = this.to ? warpLatLng(this.to, lat, lon) : ([lat, lon] as [number, number]);
    if (this.a >= 1) return p1;
    const p0 = this.from ? warpLatLng(this.from, lat, lon) : ([lat, lon] as [number, number]);
    return [p0[0] + (p1[0] - p0[0]) * this.a, p0[1] + (p1[1] - p0[1]) * this.a];
  }

  get main(): Warp {
    return this.to ?? this.from ?? this.warp;
  }

  get fade(): number {
    if (!this.from) return this.a; // 始めるとき
    if (!this.to) return 1 - this.a; // やめるとき
    return 1;
  }

  get animating(): boolean {
    return this.a < 1;
  }

  // ---- 操作 ----

  get centerName(): string {
    return this.tt.names[this.warp.center];
  }

  /** 中心駅を変える（地図の画面の中心も新しい中心駅へ動かす） */
  setCenter(i: number) {
    const next = makeWarp(this.tt, i);
    this.animate(this.to, next);
    this.warp = next;
    this.map.panTo([this.tt.lat[i], this.tt.lon[i]]);
    this.onChange();
  }

  /** 背景の地図の種類を変えたとき */
  setTile(url: string, maxNativeZoom: number) {
    this.layer.setTileUrl(url, maxNativeZoom);
  }

  /** 緯度経度を変化後の位置へ（どのピンを出すか選ぶのに使う） */
  place<T extends { lat: number; lon: number }>(x: T): T {
    if (!this.to) return x;
    const [lat, lon] = warpLatLng(this.to, x.lat, x.lon);
    return { ...x, lat, lon };
  }

  /** 中心駅から、ある場所まで電車＋徒歩の時間（分）と降りる駅の名前 */
  minutesTo(lat: number, lon: number): { min: number; via: string } | null {
    const r = placeMinutes(this.tt, this.warp.center, lat, lon);
    return r ? { min: Math.round(r.min), via: this.tt.names[r.via] } : null;
  }

  /** 実際の地図へ戻してから、時間地図の層を外す */
  stop(done: () => void) {
    this.animate(this.to, null, () => {
      this.layer.remove();
      done();
    });
    this.onChange();
  }

  /** from から to へ動かす（どちらも null なら実際の地図） */
  private animate(from: Warp | null, to: Warp | null, onEnd: (() => void) | null = null) {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.onEnd?.(); // 前のアニメーションの後始末（途中で次が来たとき）
    this.from = from;
    this.to = to;
    this.onEnd = onEnd;
    this.t0 = performance.now();
    this.a = 0;
    // 次のフレームを頼む。タブが裏にあって requestAnimationFrame が止まっているときはタイマーで進める
    // （進まないと、止まったときのピンの選び直しが起きないため）
    const next = () => {
      this.raf = requestAnimationFrame(step);
      clearTimeout(this.timer);
      this.timer = window.setTimeout(step, 100);
    };
    const step = () => {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.timer);
      const t = Math.min(1, (performance.now() - this.t0) / DURATION);
      this.a = t >= 1 ? 1 : ease(t);
      this.layer.drawNow();
      this.onFrame();
      if (t < 1) next();
      else {
        const end = this.onEnd;
        this.onEnd = null;
        this.from = null;
        if (end) end();
        else this.onChange(); // 止まったら、ピンを選び直す
      }
    };
    next();
  }
}
