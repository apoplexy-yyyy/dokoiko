// Leaflet 地図：場所（得点に応じた大きさ）・イベント・現在地・これまでに見た場所を表示し、地図の移動を通知する
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Bounds } from '../discover/pick';
import type { EventHit } from '../discover/events';
import type { Spot } from '../types';
import type { SavedSpot } from './history';
import { CAT, shortName } from './labels';
import { h } from './dom';
import { perf } from '../perf';
import { PinCanvas, type CanvasPin } from './pinCanvas';

/**
 * 見た目・描き方の切り替え（比較用）。URL の ?fx=3d,shadow で元の描き方に戻せる。
 * - 3d：Leaflet の既定（translate3d）でピンを置く。ピンごとに別の描画レイヤーになり、スマホでは描画が重い
 * - shadow：タッチ端末でもピンとラベルにぼかした影を付ける
 */
export const FX = new Set(
  typeof location === 'undefined' ? [] : (new URLSearchParams(location.search).get('fx') ?? '').split(',').filter(Boolean),
);

// ピンを 2D の translate で置く（Leaflet は translate3d を使うため、ピン100個が100枚の描画レイヤーになっていた）
if (!FX.has('3d')) {
  type PosMarker = { _icon?: HTMLElement; _shadow?: HTMLElement; _zIndex: number; options: L.MarkerOptions; _resetZIndex(): void };
  (L.Marker.prototype as unknown as { _setPos(this: PosMarker, pos: L.Point): void })._setPos = function (pos) {
    for (const el of [this._icon, this._shadow]) {
      if (!el) continue;
      (el as HTMLElement & { _leaflet_pos?: L.Point })._leaflet_pos = pos;
      el.style.transform = `translate(${pos.x}px,${pos.y}px)`;
    }
    this._zIndex = pos.y + (this.options.zIndexOffset ?? 0);
    this._resetZIndex();
  };
}

/** 隠しておくピンの上限（おすすめ・それ以外それぞれ） */
const MAX_PARKED = 120;

/** ピンと名前ラベルの間隔（px） */
const LABEL_GAP = 2;

/**
 * ピンの中身：アイコンと名前ラベル。
 * ラベルを Leaflet のツールチップ（別の要素）にすると、拡大・縮小の間ずっと1つずつ幅を測り直して重いので、
 * ピンの要素の中に入れてピンと一緒に動かす。ラベルを押してもピンを押したことになる
 */
function pinHtml(icon: HTMLElement, label: string, cls: string): HTMLElement {
  return h('div', { class: 'pin-in' }, icon, h('b', { class: `pin-label ${cls}`.trim() }, label));
}

/** 今の大きさ・濃さ・重なり順を覚えておくピン（変わったときだけ書き換える） */
type PinMarker = L.Marker & {
  pin: { px: number; op: string; z: number; pick: boolean; s: Spot; span?: HTMLElement | null; label?: HTMLElement | null };
};

/** 置くことにしたピン */
interface Placement {
  s: Spot;
  pick: boolean;
  px: number;
  op: string;
  z: number;
  key: string;
}

export interface RankedSpot {
  s: Spot;
  /** 重み（得点） */
  w: number;
  /** おすすめ（必ず表示し、目立たせる） */
  pick: boolean;
}

const GSI = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** 選べる地図の種類（背景） */
export const BASEMAPS: Record<string, { label: string; url: string; attribution: string; maxNativeZoom: number }> = {
  osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM, maxNativeZoom: 19 },
  photo: { label: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', attribution: GSI, maxNativeZoom: 18 },
};

export class DiscoverMap {
  private map: L.Map;
  private hereLayer = L.layerGroup();
  private pickLayer = L.layerGroup();
  private foundLayer = L.layerGroup();
  private eventLayer = L.layerGroup();
  private eventMarkers = new Map<string, L.Marker>();
  private pickMarkers = new Map<string, L.Marker>();
  private otherLayer = L.layerGroup();
  private otherMarkers: L.Marker[] = [];
  /** 直近の showSpots で新しく作ったピンの数（計測用） */
  created = 0;
  /** 直近の showSpots の内訳（計測用。?perf のときだけ） */
  pinStats = '';
  /** 表示中の場所のピン（キー：ID・おすすめか）。次に表示するときに使い回す */
  private spotMarkers = new Map<string, L.Marker>();
  /** ピンを canvas に描くレイヤー（?fx=dom のときは使わず、HTML の部品で置く） */
  private pinCanvas?: PinCanvas;
  /** canvas に描くイベントのピン（showEvents で作り、showSpots でまとめて描く） */
  private canvasEvents: CanvasPin[] = [];
  /** 隠してある（次に使い回す）ピン */
  private parked = { pick: [] as PinMarker[], other: [] as PinMarker[] };
  /** 表示中のイベントのピン（キー：会場・イベント） */
  private eventPins = new Map<string, L.Marker>();
  private timer = 0;
  private baseLayer?: L.TileLayer;
  base = 'osm';

  /** 地図の種類（背景）を切り替える */
  setBase(key: string) {
    const b = BASEMAPS[key] ?? BASEMAPS.osm;
    this.base = BASEMAPS[key] ? key : 'osm';
    this.baseLayer?.remove();
    // 場所のデータは OpenStreetMap 由来なので、背景を変えても OSM の出典は残す
    const attribution = b.attribution === OSM ? OSM : `${b.attribution}｜場所のデータ ${OSM}`;
    // keepBuffer：画面の外の地図画像も多めに残し、戻ったときに白い部分が出にくいようにする
    this.baseLayer = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.maxNativeZoom, attribution, keepBuffer: 4 }).addTo(this.map);
    this.baseLayer.bringToBack();
  }

  constructor(el: HTMLElement, center: [number, number], zoom: number, base: string, onMove: () => void) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 9 }).setView(center, zoom);
    this.setBase(base);
    this.foundLayer.addTo(this.map);
    this.otherLayer.addTo(this.map);
    this.eventLayer.addTo(this.map);
    this.hereLayer.addTo(this.map);
    this.pickLayer.addTo(this.map);
    if (!FX.has('dom')) this.pinCanvas = new PinCanvas().addTo(this.map);
    // 連続した移動はまとめて1回だけ通知
    // 吹き出しを開いている間（自動スクロールを含む）は選び直さず、閉じたときにまとめて選び直す
    let popupOpen = false;
    let pending = false;
    const notify = () => {
      if (popupOpen) {
        pending = true;
        return;
      }
      clearTimeout(this.timer);
      this.timer = window.setTimeout(onMove, 200);
    };
    this.map.on('moveend', notify);
    this.map.on('popupopen', (e) => {
      this.fitPopup(e.popup);
      popupOpen = true;
      el.parentElement?.classList.add('popup-open');
    });
    this.map.on('popupclose', () => {
      popupOpen = false;
      el.parentElement?.classList.remove('popup-open');
      if (pending) {
        pending = false;
        notify();
      }
    });
    // 読み込み時に地図の大きさが 0（非表示のタブなど）だと範囲が求まらないので、大きさが変わったら選び直す
    let size = `${el.clientWidth}x${el.clientHeight}`;
    new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now === size) return;
      size = now;
      this.map.invalidateSize();
      notify();
      this.declutterSoon();
    }).observe(el);
    // 拡大・縮小の間は影と名前ラベルを省いて描き直しを軽くする（スマホで重いため）。止まったら戻す
    this.map.on('zoomstart', () => el.classList.add('zooming'));
    this.map.on('zoomend', () => {
      el.classList.remove('zooming');
      this.declutterSoon();
    });
  }

  /**
   * 地図は動かさずに吹き出しを画面内に収める。
   * 上にはみ出すならピンの下側に出し、左右にはみ出すなら横にずらす。高すぎるときは中をスクロールさせる。
   */
  private fitPopup(p: L.Popup) {
    const el = p.getElement();
    if (!el) return;
    const content = el.querySelector<HTMLElement>('.leaflet-popup-content');
    const size = this.map.getSize();
    const M = 8; // 画面の端との余白
    el.classList.remove('below');
    p.options.offset = L.point(0, 7);
    if (content) {
      content.style.maxHeight = `${Math.max(160, size.y - 2 * M - 20)}px`;
      content.style.overflowY = 'auto';
    }
    p.update();
    const pt = this.map.latLngToContainerPoint(p.getLatLng()!);
    // 吹き出し本体（矢印を除く）を置きたい位置を、地図の座標で決める
    const wrap = el.querySelector<HTMLElement>('.leaflet-popup-content-wrapper') ?? el;
    const w = wrap.offsetWidth;
    let hb = wrap.offsetHeight;
    // 上下どちらにも入らず、横にも置けない（スマホなど）ときは、広い方に入るよう吹き出しを低くして中をスクロールさせる
    const spaceAbove = pt.y - 30 - M;
    const spaceBelow = size.y - M - (pt.y + 24);
    const sideFits = pt.x + 26 + w <= size.x - M || pt.x - 26 - w >= M;
    if (hb > spaceAbove && hb > spaceBelow && !sideFits && content && Math.max(spaceAbove, spaceBelow) >= 200) {
      const space = Math.max(spaceAbove, spaceBelow);
      content.style.maxHeight = `${content.offsetHeight - (hb - space)}px`;
      p.update();
      hb = wrap.offsetHeight;
    }
    const clampLeft = (left: number) => Math.min(Math.max(left, M), Math.max(M, size.x - M - w));
    let left: number;
    let top: number;
    if (pt.y - hb - 30 >= M) {
      // 上に入る（ふつう。矢印を残す）
      left = clampLeft(pt.x - w / 2);
      top = pt.y - hb - 30;
    } else {
      el.classList.add('below');
      if (pt.y + 24 + hb <= size.y - M) {
        // 下に入る
        left = clampLeft(pt.x - w / 2);
        top = pt.y + 24;
      } else {
        // 上下どちらにも入らない：ピンの横（右、入らなければ左）に、縦は画面内に収めて出す
        top = Math.min(Math.max(pt.y - hb / 2, M), Math.max(M, size.y - M - hb));
        const right = pt.x + 26;
        const leftSide = pt.x - 26 - w;
        left = right + w <= size.x - M ? right : leftSide >= M ? leftSide : M;
      }
    }
    // 実際の位置を測って、ずれた分だけ offset を直す（Leaflet の余白や矢印の高さを気にしなくて済む）
    const origin = this.map.getContainer().getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    const dx = left - (r.left - origin.left);
    const dy = top - (r.top - origin.top);
    p.options.offset = L.point(dx, 7 + dy);
    p.update();
  }

  private declutterFrame = 0;
  private declutterSoon() {
    // requestAnimationFrame は非表示のタブでは止まるので setTimeout を使う
    clearTimeout(this.declutterFrame);
    this.declutterFrame = window.setTimeout(() => this.declutter(), 30);
  }

  /**
   * 名前ラベルは、ほかのラベルやピンと重ならないものだけ表示する。
   * 候補（番号順）→ イベントの会場名 → そのほかの場所 の順に優先する。
   */
  private declutter() {
    const t0 = performance.now();
    this.declutterInner();
    perf.note("ラベル", performance.now() - t0);
  }

  private declutterInner() {
    const pad = 2;
    type Box = { l: number; t: number; r: number; b: number };
    const hit = (a: Box, b: Box) => a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;
    const markers = [...new Set([...this.pickMarkers.values(), ...this.eventMarkers.values(), ...this.otherMarkers])];
    const picks = new Set(this.pickMarkers.values());
    // ラベルの位置はブラウザに問い合わせず、ピンの座標とラベルの幅（文字から計算）で求める。
    // 問い合わせると、そのたびにページ全体の配置計算が走り、スマホでは数十ms かかるため
    const items = markers.map((m) => {
      const el = m.getElement()?.querySelector<HTMLElement>('.pin-label') ?? null;
      const c = this.map.latLngToContainerPoint(m.getLatLng());
      const r = (m as PinMarker).pin?.px ? (m as PinMarker).pin.px / 2 : 15;
      const icon: Box = { l: c.x - r, t: c.y - r, r: c.x + r, b: c.y + r };
      return { m, el, c, r, icon };
    });
    const placed: Box[] = [];
    const result: { el: HTMLElement; cls: '' | 'left' | 'hide' }[] = [];
    for (const it of items) {
      if (!it.el) continue;
      const size = this.labelSize(it.el);
      if (!size) continue;
      const [w, hgt] = size;
      // 候補のラベルは候補のピンだけを避ける（イベントのピンの上には重なってよい）
      const obstacles = picks.has(it.m) ? items.filter((x) => picks.has(x.m)) : items;
      const free = (b: Box) => !placed.some((p) => hit(b, p)) && !obstacles.some((x) => x.m !== it.m && hit(b, x.icon));
      const top = it.c.y - hgt / 2;
      const right: Box = { l: it.c.x + it.r + LABEL_GAP, t: top, r: it.c.x + it.r + LABEL_GAP + w, b: top + hgt };
      if (free(right)) {
        placed.push(right);
        result.push({ el: it.el, cls: '' });
        continue;
      }
      // 右がふさがっていたら、ピンの左側に出してみる
      const left: Box = { l: it.c.x - it.r - LABEL_GAP - w, t: top, r: it.c.x - it.r - LABEL_GAP, b: top + hgt };
      if (free(left)) {
        placed.push(left);
        result.push({ el: it.el, cls: 'left' });
      } else result.push({ el: it.el, cls: 'hide' });
    }
    // 変わったものだけ書き換える
    for (const { el, cls } of result) {
      const now = el.classList.contains('hide') ? 'hide' : el.classList.contains('left') ? 'left' : '';
      if (now === cls) continue;
      el.classList.remove('left', 'hide');
      if (cls) el.classList.add(cls);
    }
  }

  /** ラベルの種類ごとの文字の書式・余白・高さ（最初の1回だけブラウザに問い合わせる） */
  private labelFmt = new Map<string, { font: string; extra: number; height: number; max: number }>();
  /** ラベルの幅の計算結果（種類＋文字ごと） */
  private labelWidth = new Map<string, number>();
  private measureCtx?: CanvasRenderingContext2D | null;

  /** ラベルの幅と高さ。幅は文字から計算する（ブラウザの配置計算を起こさない） */
  private labelSize(el: HTMLElement): [number, number] | undefined {
    const kind = el.classList.contains('event-label') ? 'e' : el.classList.contains('other-label') ? 'o' : 'p';
    const text = el.textContent ?? '';
    this.measureCtx ??= document.createElement('canvas').getContext('2d');
    const ctx = this.measureCtx;
    if (!ctx) return undefined;
    let fmt = this.labelFmt.get(kind);
    if (!fmt) {
      // 種類ごとに1回だけ、実際のラベルを測って書式と余白を覚える
      const cs = getComputedStyle(el);
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.font = font;
      const tw = ctx.measureText(text).width;
      const w = el.offsetWidth;
      const max = parseFloat(cs.maxWidth) || 180;
      // 余白＋枠の幅（max-width は余白込み。長い名前で幅が上限に達していたら、余白は既定値にする）
      const extra = w < max - 1 ? Math.max(0, w - tw) : 14;
      fmt = { font, extra, height: el.offsetHeight, max };
      if (!fmt.height) return undefined; // まだ表示されていない
      this.labelFmt.set(kind, fmt);
    }
    const key = kind + text;
    let w = this.labelWidth.get(key);
    if (w === undefined) {
      ctx.font = fmt.font;
      w = Math.min(ctx.measureText(text).width + fmt.extra, fmt.max);
      this.labelWidth.set(key, w);
    }
    return [w, fmt.height];
  }

  get zoom() {
    return this.map.getZoom();
  }

  get center(): [number, number] {
    const c = this.map.getCenter();
    return [c.lat, c.lng];
  }

  /** 表示範囲（ピンが端で切れないよう少し内側） */
  bounds(): Bounds {
    const b = this.map.getBounds().pad(-0.04);
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  flyTo(lat: number, lon: number, zoom: number) {
    // 非表示のタブなどでアニメーションが止まった場合に備え、終わらなければ即座に移動する
    let arrived = false;
    this.map.once('moveend', () => (arrived = true));
    if (document.hidden) this.map.setView([lat, lon], zoom, { animate: false });
    else this.map.flyTo([lat, lon], zoom, { duration: 0.8 });
    setTimeout(() => {
      if (arrived) return;
      this.map.stop();
      this.map.setView([lat, lon], zoom, { animate: false });
    }, 1500);
  }

  setHere(lat: number, lon: number) {
    this.hereLayer.clearLayers();
    L.marker([lat, lon], {
      icon: L.divIcon({ className: 'here-pin', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
      keyboard: false,
    }).addTo(this.hereLayer);
  }

  /**
   * 場所のピン。得点が高いほど大きく濃く表示する。
   * 順位の高い順に置き、すでに置いたピンと重なるものは出さない（おすすめ＝pick は必ず出す）。
   * @returns 表示した数
   */
  showSpots(list: RankedSpot[], popup: (s: Spot) => HTMLElement): number {
    if (this.pinCanvas) return this.showSpotsCanvas(list, popup);
    // ピンは作り直さない：
    // ① 前と同じ場所のピンは、大きさ・濃さだけ直して使い回す
    // ② 画面から出ていくピンは、新しく入ってくる場所へ移して中身（アイコン・色・名前）を入れ替える
    // ③ 足りない分だけ新しく作り、余った分だけ外す
    // （ピンを作る・外すのはスマホで1個 0.6ms ほどかかり、地図を動かすたびに数十個あるため）
    const prev = this.spotMarkers as Map<string, PinMarker>;
    this.spotMarkers = new Map();
    this.created = 0;
    const T = { place: 0, reuse: 0, recycle: 0, create: 0, remove: 0 };
    const now = perf.on ? () => performance.now() : () => 0;
    let t = now();
    this.pickMarkers.clear();
    this.otherMarkers = [];
    const size = this.map.getSize();
    // すでに置いたピン。重なりの判定は、画面を升目に分けて近くの升目だけ調べる（全部と比べると数十〜数百倍の計算になる）
    const CELL = 48; // ピンの半径の和の最大（23+23）より大きく
    const grid = new Map<number, { x: number; y: number; r: number }[]>();
    const cellKey = (cx: number, cy: number) => cx * 4096 + cy;
    const put = (x: number, y: number, r: number) => {
      const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
      const a = grid.get(k);
      if (a) a.push({ x, y, r });
      else grid.set(k, [{ x, y, r }]);
    };
    const overlaps = (x: number, y: number, r: number) => {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let i = cx - 1; i <= cx + 1; i++)
        for (let j = cy - 1; j <= cy + 1; j++)
          for (const o of grid.get(cellKey(i, j)) ?? []) if (Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.9) return true;
      return false;
    };
    for (const m of this.eventMarkers.values()) {
      const p = this.map.latLngToContainerPoint(m.getLatLng());
      put(p.x, p.y, 15);
    }
    const wmax = Math.max(1e-9, ...list.map((x) => x.w));

    // 置く場所を決める（得点の高い順、ほかのピンと重ならないもの）
    const placed: Placement[] = [];
    for (const x of list.slice(0, 800)) {
      const { s } = x;
      const score = Math.sqrt(x.w / wmax); // 0〜1
      const px = 2 * Math.round((x.pick ? Math.max(40, 30 + 16 * score) : 20 + 18 * score) / 2);
      const r = px / 2;
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      if (!x.pick) {
        if (pt.x < r || pt.y < r || pt.x > size.x - r || pt.y > size.y - r) continue;
        if (overlaps(pt.x, pt.y, r)) continue;
      }
      put(pt.x, pt.y, r);
      placed.push({
        s,
        pick: x.pick,
        px,
        op: (0.7 + 0.3 * score).toFixed(2),
        z: Math.round(score * 1000) + (x.pick ? 2000 : 0),
        key: `${s.id}|${x.pick ? 1 : 0}`,
      });
    }
    T.place = now() - t;

    // ① 前と同じピン
    t = now();
    const fresh: Placement[] = [];
    for (const p of placed) {
      const m = prev.get(p.key);
      if (!m) {
        fresh.push(p);
        continue;
      }
      prev.delete(p.key);
      this.updatePin(m, p);
      this.keep(m, p);
    }
    T.reuse = now() - t;

    // ② 出ていくピンを入ってくる場所へ移す（おすすめかどうかが同じもの同士）
    t = now();
    // 前回隠しておいたピンも使う
    const spare = this.parked;
    for (const m of prev.values()) spare[m.pin.pick ? 'pick' : 'other'].push(m);
    const toCreate: Placement[] = [];
    for (const p of fresh) {
      const m = spare[p.pick ? 'pick' : 'other'].pop();
      if (!m) {
        toCreate.push(p);
        continue;
      }
      this.recyclePin(m, p);
      m.getElement()?.classList.remove('parked');
      this.keep(m, p);
    }
    T.recycle = now() - t;

    // ③ 足りない分を作る
    t = now();
    for (const p of toCreate) {
      const c = CAT[p.s.cat] ?? CAT.other;
      const r = p.px / 2;
      const m = L.marker([p.s.lat, p.s.lon], {
        icon: L.divIcon({
          className: `spot-pin${p.pick ? ' pick' : ''}`,
          html: pinHtml(h('span', { style: `--c:${c.color};--s:${p.px}px;opacity:${p.op}` }, c.icon), shortName(p.s.name), p.pick ? '' : 'other-label'),
          iconSize: [p.px, p.px],
          iconAnchor: [r, r],
        }),
        title: p.s.name,
        riseOnHover: true,
        zIndexOffset: p.z,
      }) as PinMarker;
      m.pin = { px: p.px, op: p.op, z: p.z, pick: p.pick, s: p.s };
      // 吹き出しの中身は開いたときに作る。移した後も今の場所を出すよう m.pin.s を見る
      m.bindPopup(() => popup(m.pin.s), { maxWidth: 340, minWidth: 260, autoPan: false, className: 'card-popup' });
      m.addTo(p.pick ? this.pickLayer : this.otherLayer);
      this.created++;
      this.keep(m, p);
    }
    T.create = now() - t;

    // 余った分は外さずに隠しておき、次に地図を動かしたときに使う（外すのもスマホで1個 0.3ms ほどかかるため）。
    // 多すぎる分だけ外す
    t = now();
    let parked = 0;
    for (const k of ['pick', 'other'] as const) {
      const list = spare[k];
      while (list.length > MAX_PARKED) list.pop()!.remove();
      for (const m of list) {
        const el = m.getElement();
        if (el && !el.classList.contains('parked')) {
          el.classList.add('parked');
          parked++;
        }
      }
    }
    const left = { length: parked };
    T.remove = now() - t;
    if (perf.on)
      this.pinStats = `配置 ${T.place.toFixed(1)}・使い回し ${T.reuse.toFixed(1)}・移す ${T.recycle.toFixed(1)}（${fresh.length - toCreate.length}）・新規 ${T.create.toFixed(1)}・隠す ${T.remove.toFixed(1)}（${left.length}）`;
    this.declutterSoon();
    return placed.length;
  }

  /** 表示中のピンとして登録する */
  private keep(m: PinMarker, p: Placement) {
    this.spotMarkers.set(p.key, m);
    if (p.pick) this.pickMarkers.set(p.s.id, m);
    else this.otherMarkers.push(m);
  }

  /** 大きさ・濃さ・重なり順を、変わったときだけ書き換える */
  private updatePin(m: PinMarker, p: Placement) {
    if (m.pin.z !== p.z) m.setZIndexOffset(p.z);
    const el = m.getElement();
    const span = (m.pin.span ??= el?.querySelector('span'));
    if (el && span && m.pin.px !== p.px) {
      el.style.width = el.style.height = `${p.px}px`;
      el.style.marginLeft = el.style.marginTop = `${-p.px / 2}px`;
      span.style.setProperty('--s', `${p.px}px`);
    }
    if (span && m.pin.op !== p.op) span.style.opacity = p.op;
    m.pin.px = p.px;
    m.pin.op = p.op;
    m.pin.z = p.z;
  }

  /** 出ていくピンを別の場所へ移し、中身を入れ替える */
  private recyclePin(m: PinMarker, p: Placement) {
    const el = m.getElement();
    const span = (m.pin.span ??= el?.querySelector('span'));
    const label = (m.pin.label ??= el?.querySelector<HTMLElement>('.pin-label'));
    const c = CAT[p.s.cat] ?? CAT.other;
    m.pin.s = p.s;
    m.setLatLng([p.s.lat, p.s.lon]);
    if (el) el.title = p.s.name;
    if (span) {
      span.style.setProperty('--c', c.color);
      if (span.textContent !== c.icon) span.textContent = c.icon;
    }
    if (label) label.textContent = shortName(p.s.name);
    this.updatePin(m, p);
  }

  /**
   * イベントのピン。会場の座標が分かるものは会場ごと、分からないもの（横浜市）は区の中心にまとめる。
   */
  showEvents(hits: EventHit[], popup: (hits: EventHit[]) => HTMLElement) {
    if (this.pinCanvas) return this.showEventsCanvas(hits, popup);
    // 前と同じ会場・同じ件数のピンは作り直さずに使い回す
    const prev = this.eventPins;
    this.eventPins = new Map();
    this.eventMarkers.clear();
    const groups = new Map<string, EventHit[]>();
    for (const x of hits) {
      const k = x.ev.approx ? `area:${x.ev.city}` : `${x.ev.lat.toFixed(4)},${x.ev.lon.toFixed(4)}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    for (const [k, list] of groups) {
      const ev = list[0].ev;
      const key = `${k}|${list.map((x) => x.ev.id).join(',')}`;
      const old = prev.get(key);
      if (old) {
        prev.delete(key);
        this.eventPins.set(key, old);
        for (const x of list) this.eventMarkers.set(x.ev.id, old);
        continue;
      }
      // 会場名（なければイベント名）を添える。長いものは短く
      const name = ev.approx ? `${ev.city.replace(/^横浜市/, '')}のイベント` : (ev.spotName ?? ev.venue ?? ev.title);
      const label = name.length > 14 ? name.slice(0, 14) + '…' : name;
      const m = L.marker([ev.lat, ev.lon], {
        icon: L.divIcon({
          className: `event-pin${ev.approx ? ' approx' : ''}`,
          html: pinHtml(h('span', {}, '🗓️', list.length > 1 && h('b', {}, String(list.length))), label, 'event-label'),
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        title: list.map((x) => x.ev.title).join(' / '),
        riseOnHover: true,
        zIndexOffset: 1500,
      });
      m.bindPopup(() => popup(list), { maxWidth: 360, minWidth: 260, autoPan: false, className: 'event-popup' });
      m.addTo(this.eventLayer);
      this.eventPins.set(key, m);
      for (const x of list) this.eventMarkers.set(x.ev.id, m);
    }
    for (const m of prev.values()) m.remove();
    this.declutterSoon();
  }

  /** canvas に描く：イベントのピン（描くのは showSpotsCanvas でまとめて） */
  private showEventsCanvas(hits: EventHit[], popup: (hits: EventHit[]) => HTMLElement) {
    const groups = new Map<string, EventHit[]>();
    for (const x of hits) {
      const k = x.ev.approx ? `area:${x.ev.city}` : `${x.ev.lat.toFixed(4)},${x.ev.lon.toFixed(4)}`;
      const a = groups.get(k);
      if (a) a.push(x);
      else groups.set(k, [x]);
    }
    this.canvasEvents = [...groups.values()].map((list) => {
      const ev = list[0].ev;
      const name = ev.approx ? `${ev.city.replace(/^横浜市/, '')}のイベント` : (ev.spotName ?? ev.venue ?? ev.title);
      return {
        lat: ev.lat,
        lon: ev.lon,
        r: 15,
        z: 1500,
        kind: 'event',
        color: '',
        icon: '🗓️',
        label: name.length > 14 ? name.slice(0, 14) + '…' : name,
        labelKind: 'e',
        pick: false,
        op: 1,
        dashed: ev.approx,
        badge: list.length > 1 ? String(list.length) : undefined,
        popup: () => popup(list),
        popupOptions: { maxWidth: 360, minWidth: 260, autoPan: false, className: 'event-popup' },
      } satisfies CanvasPin;
    });
  }

  /** canvas に描く：場所のピン（得点の高い順に、ほかのピンと重ならないものを置く） */
  private showSpotsCanvas(list: RankedSpot[], popup: (s: Spot) => HTMLElement): number {
    const t0 = perf.on ? performance.now() : 0;
    this.created = 0;
    const size = this.map.getSize();
    const CELL = 48;
    const grid = new Map<number, { x: number; y: number; r: number }[]>();
    const cellKey = (cx: number, cy: number) => cx * 4096 + cy;
    const put = (x: number, y: number, r: number) => {
      const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
      const a = grid.get(k);
      if (a) a.push({ x, y, r });
      else grid.set(k, [{ x, y, r }]);
    };
    const overlaps = (x: number, y: number, r: number) => {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let i = cx - 1; i <= cx + 1; i++)
        for (let j = cy - 1; j <= cy + 1; j++)
          for (const o of grid.get(cellKey(i, j)) ?? []) if (Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.9) return true;
      return false;
    };
    for (const e of this.canvasEvents) {
      const p = this.map.latLngToContainerPoint([e.lat, e.lon]);
      put(p.x, p.y, 15);
    }
    const wmax = Math.max(1e-9, ...list.map((x) => x.w));
    const pins: CanvasPin[] = [];
    for (const x of list.slice(0, 800)) {
      const { s } = x;
      const score = Math.sqrt(x.w / wmax);
      const px = 2 * Math.round((x.pick ? Math.max(40, 30 + 16 * score) : 20 + 18 * score) / 2);
      const r = px / 2;
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      if (!x.pick) {
        if (pt.x < r || pt.y < r || pt.x > size.x - r || pt.y > size.y - r) continue;
        if (overlaps(pt.x, pt.y, r)) continue;
      }
      put(pt.x, pt.y, r);
      const c = CAT[s.cat] ?? CAT.other;
      pins.push({
        lat: s.lat,
        lon: s.lon,
        r,
        z: Math.round(score * 1000) + (x.pick ? 2000 : 0),
        kind: 'spot',
        color: c.color,
        icon: c.icon,
        label: shortName(s.name),
        labelKind: x.pick ? 'p' : 'o',
        pick: x.pick,
        op: 0.7 + 0.3 * score,
        popup: () => popup(s),
        popupOptions: { maxWidth: 340, minWidth: 260, autoPan: false, className: 'card-popup' },
      });
    }
    const t1 = perf.on ? performance.now() : 0;
    this.pinCanvas!.setPins([...this.canvasEvents, ...pins]);
    if (perf.on) this.pinStats = `配置 ${(t1 - t0).toFixed(1)}・canvas に描く ${this.pinCanvas!.lastMs.toFixed(1)}
  canvas の内訳 ${this.pinCanvas!.breakdown}`;
    return pins.length;
  }

  showFound(list: SavedSpot[]) {
    this.foundLayer.clearLayers();
    for (const s of list) {
      L.circleMarker([s.lat, s.lon], {
        radius: 4,
        color: '#fff',
        weight: 1,
        fillColor: CAT[s.cat]?.color ?? '#8a7a5c',
        fillOpacity: 0.6,
        interactive: false,
      }).addTo(this.foundLayer);
    }
  }

  closePopup() {
    this.map.closePopup();
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
