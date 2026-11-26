// ピン・イベントのピン・名前ラベルを、1枚の canvas にまとめて描くレイヤー。
// ピンを1つずつ HTML の部品として置くと、スマホでは部品の作成・配置計算・描画に時間がかかるため。
// 地図を動かしている間は canvas ごと地図と一緒に動き、止まったら描き直す。拡大・縮小の間は canvas を拡大縮小する。
// 押したときは、いちばん上に描いたピン（またはラベル）を探して吹き出しを開く。
import L from 'leaflet';

export interface CanvasPin {
  lat: number;
  lon: number;
  /** ピンの半径（px） */
  r: number;
  /** 重なり順（大きいほど上） */
  z: number;
  /** 'spot'：場所 / 'event'：イベント */
  kind: 'spot' | 'event';
  color: string;
  icon: string;
  label: string;
  /** ラベルの種類：p＝おすすめ / o＝そのほか / e＝イベント */
  labelKind: 'p' | 'o' | 'e';
  pick: boolean;
  /** 濃さ 0〜1 */
  op: number;
  /** イベント：会場が分からない（区の中心）ときは点線 */
  dashed?: boolean;
  /** イベント：件数の表示 */
  badge?: string;
  /** 押したときの吹き出しの中身 */
  popup: () => HTMLElement;
  popupOptions: L.PopupOptions;
}

interface Placed {
  pin: CanvasPin;
  x: number;
  y: number;
  /** ラベルの位置（出さないときは undefined） */
  lb?: { l: number; t: number; w: number; h: number };
}

/** ピンとラベルの間隔（px） */
const GAP = 2;
/** ピンの絵を描く大きさの段階（半径）。その段階の中では縮めて使う */
const spriteR = (r: number) => (r <= 12 ? 12 : r <= 17 ? 17 : 24);
/** canvas を画面より広く取る幅（px） */
const PAD = 80;
const LABEL_MAX = 180;
/** 指で押すときのゆとり（px） */
const TOUCH = 4;

type Theme = { paper: string; ink: string; line: string; accent: string; accentInk: string; font: string };

export class PinCanvas extends L.Layer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private pins: CanvasPin[] = [];
  private placed: Placed[] = [];
  /** 描いたときの表示範囲（拡大・縮小のアニメーション用） */
  private drawnBounds?: L.LatLngBounds;
  /** ピンの絵（種類・大きさ・おすすめか）を覚えておく */
  private sprites = new Map<string, HTMLCanvasElement>();
  /** ラベルの文字（幅を超えるときは … で切ったもの）と幅 */
  private texts = new Map<string, { text: string; w: number }>();
  private theme?: Theme;
  /** 描いたときの画面左上の位置（地図の座標。地図を動かしても変わらない） */
  private origin = L.point(0, 0);
  /** 直近の描画にかかった時間（計測用） */
  lastMs = 0;
  /** 直近の描画の内訳（計測用） */
  breakdown = '';
  private newSprites = 0;

  onAdd(map: L.Map) {
    const pane = map.getPane('pinPane') ?? map.createPane('pinPane');
    pane.style.zIndex = '610';
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'pin-canvas leaflet-zoom-animated', pane);
    this.ctx = this.canvas.getContext('2d')!;
    // 地図を動かしている間・止めた後は canvas が地図と一緒に動くので描き直さない（新しいピンが来たら描く）。
    // 拡大・縮小の後と、大きさが変わったときだけ描き直す
    map.on('zoomend viewreset resize', this.redraw, this);
    map.on('zoomend', this.onZoomEnd, this);
    map.on('zoomanim', this.animateZoom, this);
    map.on('zoomstart', this.onZoomStart, this);
    map.on('click', this.onClick, this);
    map.on('mousemove', this.onHover, this);
    // 日本語の Web フォントは使う文字ごとに後から読み込まれ、幅が変わる。
    // 読み込み済みの文字のラベルだけ幅を覚え、残りは描くたびに測る（全部を毎回測るとスマホで数十 ms かかる）
    document.fonts?.ready.then(() => this.redraw());
    // ライト／ダークが切り替わったら色を読み直す
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      this.theme = undefined;
      this.sprites.clear();
      this.redraw();
    });
    this.redraw();
    return this;
  }

  onRemove(map: L.Map) {
    map.off('zoomend viewreset resize', this.redraw, this);
    map.off('zoomend', this.onZoomEnd, this);
    map.off('zoomanim', this.animateZoom, this);
    map.off('zoomstart', this.onZoomStart, this);
    map.off('click', this.onClick, this);
    map.off('mousemove', this.onHover, this);
    this.canvas.remove();
    return this;
  }

  /** 描くピンを差し替える */
  setPins(pins: CanvasPin[]) {
    this.pins = pins;
    this.hideLabels = false;
    clearTimeout(this.showLabelsTimer);
    this.redraw();
  }

  /**
   * 拡大・縮小の間は名前ラベルを出さない（canvas ごと拡大縮小するので、ラベルがピンからずれて見えるため）。
   * 新しいピンが来たら（setPins）出す。来ないとき（吹き出しを開いている間など）に備えて、少し後にも出す
   */
  private hideLabels = false;
  private showLabelsTimer = 0;
  private onZoomStart() {
    this.hideLabels = true;
    this.redraw();
  }

  /** 表示中のピンの位置（ほかのピンの配置で避けるため） */
  positions(): { x: number; y: number; r: number }[] {
    return this.pins.map((p) => {
      const c = this._map.latLngToContainerPoint([p.lat, p.lon]);
      return { x: c.x, y: c.y, r: p.r };
    });
  }

  redraw() {
    const map = this._map;
    if (!map) return;
    const t0 = performance.now();
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    // canvas を画面の左上に合わせる（そのときの位置を覚え、押した位置の換算に使う）
    // 画面より PAD だけ広く取り、地図を動かした直後に画面の端でラベルが切れないようにする
    this.origin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, this.origin.subtract([PAD, PAD]));
    const cw = size.x + PAD * 2;
    const chh = size.y + PAD * 2;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(chh * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(chh * dpr);
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${chh}px`;
    }
    this.drawnBounds = L.latLngBounds(map.containerPointToLatLng([-PAD, size.y + PAD]), map.containerPointToLatLng([size.x + PAD, -PAD]));
    // 色・フォントは覚えておく（毎回ページから読むと、スマホではスタイルの計算し直しが起きることがある）
    this.theme ??= readTheme();
    const tLayout = performance.now();
    this.layout(size);
    const tPins = performance.now();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x + PAD * 2, size.y + PAD * 2);
    ctx.translate(PAD, PAD);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 重なり順の低いものから描く（ピンとそのラベルは一緒に）
    let labelMs = 0;
    for (const p of [...this.placed].sort((a, b) => a.pin.z - b.pin.z)) {
      this.drawPin(p, dpr);
      if (p.lb && !this.hideLabels) {
        const t = performance.now();
        this.drawLabel(p);
        labelMs += performance.now() - t;
      }
    }
    const tEnd = performance.now();
    this.lastMs = tEnd - t0;
    this.breakdown = `準備 ${(tLayout - t0).toFixed(1)}・位置とラベルの幅 ${(tPins - tLayout).toFixed(1)}・ピン ${(tEnd - tPins - labelMs).toFixed(1)}・ラベル ${labelMs.toFixed(1)}（${this.placed.filter((p) => p.lb).length}）・新しい絵 ${this.newSprites}`;
    this.newSprites = 0;
  }

  /** 位置と、ラベルを右・左のどちらに出すか（どちらも重なるなら出さない）を決める */
  private layout(size: L.Point) {
    const map = this._map;
    const pad = 2;
    type Box = { l: number; t: number; r: number; b: number };
    const hit = (a: Box, b: Box) => a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;
    const items = this.pins
      .map((pin) => {
        const c = map.latLngToContainerPoint([pin.lat, pin.lon]);
        return { pin, x: c.x, y: c.y, icon: { l: c.x - pin.r, t: c.y - pin.r, r: c.x + pin.r, b: c.y + pin.r } };
      })
      .filter((it) => it.x > -60 && it.y > -60 && it.x < size.x + 60 && it.y < size.y + 60);
    // ラベルは おすすめ → イベント → そのほか の順に場所を取る
    const order = (k: CanvasPin['labelKind']) => (k === 'p' ? 0 : k === 'e' ? 1 : 2);
    const byPriority = [...items].sort((a, b) => order(a.pin.labelKind) - order(b.pin.labelKind));
    const placedBoxes: Box[] = [];
    this.placed = [];
    for (const it of byPriority) {
      const { text, w } = this.fitText(it.pin);
      void text;
      const h = labelHeight(it.pin.labelKind);
      // おすすめのラベルは、おすすめのピンだけを避ける（イベントのピンの上には重なってよい）
      const obstacles = it.pin.labelKind === 'p' ? items.filter((x) => x.pin.labelKind === 'p') : items;
      const free = (b: Box) => !placedBoxes.some((p) => hit(b, p)) && !obstacles.some((x) => x !== it && hit(b, x.icon));
      const top = it.y - h / 2;
      const right: Box = { l: it.x + it.pin.r + GAP, t: top, r: it.x + it.pin.r + GAP + w, b: top + h };
      const left: Box = { l: it.x - it.pin.r - GAP - w, t: top, r: it.x - it.pin.r - GAP, b: top + h };
      let lb: Placed['lb'];
      for (const b of [right, left])
        if (free(b)) {
          placedBoxes.push(b);
          lb = { l: b.l, t: b.t, w, h };
          break;
        }
      this.placed.push({ pin: it.pin, x: it.x, y: it.y, lb });
    }
  }

  private drawPin(p: Placed, dpr: number) {
    const ctx = this.ctx;
    const sprite = this.sprite(p.pin, dpr);
    // 絵は大きさの段階ごとに1枚なので、実際の大きさに縮めて貼る
    const s = (sprite.width / dpr) * (p.pin.r / spriteR(p.pin.r));
    ctx.globalAlpha = p.pin.op;
    ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    ctx.globalAlpha = 1;
    if (p.pin.badge) {
      // イベントの件数（右上の丸）
      const th = this.theme!;
      ctx.font = `700 11px ${th.font}`;
      const tw = ctx.measureText(p.pin.badge).width;
      const bw = Math.max(16, tw + 10);
      // ピンの右上（右に 8px、上に 6px はみ出す）
      const right = p.x + p.pin.r + 8;
      const top = p.y - p.pin.r - 6;
      roundRect(ctx, right - bw, top, bw, 16, 8);
      ctx.fillStyle = th.accent;
      ctx.fill();
      ctx.fillStyle = th.accentInk;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.pin.badge, right - bw / 2, top + 8.5);
      ctx.textAlign = 'left';
    }
  }

  /**
   * ピンの絵。種類ごと・大きさの段階（3段階）ごとに1回だけ、その段階の最大の大きさで描いて覚える。
   * 大きさを 1px 刻みで描き分けると絵の数が多くなり、絵文字を描くのがスマホでは1枚 数ms かかるため
   */
  private sprite(pin: CanvasPin, dpr: number): HTMLCanvasElement {
    const th = this.theme!;
    const R = spriteR(pin.r);
    const key = `${pin.kind}|${pin.icon}|${pin.color}|${R}|${pin.pick ? 1 : 0}|${pin.dashed ? 1 : 0}|${dpr}|${th.paper}|${th.accent}`;
    let c = this.sprites.get(key);
    if (c) return c;
    const ring = pin.pick ? 4 : 0;
    const s = R * 2 + ring * 2 + 2;
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(s * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const m = s / 2;
    if (ring) {
      // おすすめは外側に薄い輪
      g.beginPath();
      g.arc(m, m, R + ring, 0, Math.PI * 2);
      g.fillStyle = withAlpha(pin.color, 0.3);
      g.fill();
    }
    const bw = pin.kind === 'event' ? 2 : pin.pick ? 3 : 2;
    g.beginPath();
    g.arc(m, m, R - bw / 2, 0, Math.PI * 2);
    g.fillStyle = th.paper;
    g.fill();
    if (pin.pick) {
      g.fillStyle = withAlpha(pin.color, 0.18);
      g.fill();
    }
    g.lineWidth = bw;
    g.strokeStyle = pin.kind === 'event' ? th.accent : pin.color;
    if (pin.dashed) g.setLineDash([4, 3]);
    g.stroke();
    g.setLineDash([]);
    // 絵文字は塗りの透明度を受け継ぐので、不透明にしてから描く
    g.fillStyle = '#000';
    g.font = `${pin.kind === 'event' ? 15 : Math.round(R)}px ${th.font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(pin.icon, m, m + 1);
    this.sprites.set(key, c);
    this.newSprites++;
    return c;
  }

  /** ラベルを描く（新しいラベルが毎回あるので、絵にして覚えるより直接描く方が速い） */
  private drawLabel(p: Placed) {
    const ctx = this.ctx;
    const th = this.theme!;
    const lb = p.lb!;
    const { text } = this.fitText(p.pin);
    ctx.globalAlpha = p.pin.labelKind === 'o' ? 0.9 : 1;
    roundRect(ctx, lb.l + 0.5, lb.t + 0.5, lb.w - 1, lb.h - 1, 8);
    ctx.fillStyle = th.paper;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = p.pin.labelKind === 'e' ? th.accent : th.line;
    ctx.stroke();
    ctx.font = labelFont(p.pin.labelKind, th.font);
    ctx.fillStyle = th.ink;
    ctx.fillText(text, lb.l + 7, lb.t + lb.h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  /** ラベルの文字と幅。長いものは … で切る（結果は覚えておく） */
  private fitText(pin: CanvasPin): { text: string; w: number } {
    const font = labelFont(pin.labelKind, (this.theme ?? readTheme()).font);
    const key = font + '|' + pin.label;
    let v = this.texts.get(key);
    if (v) return v;
    const ctx = this.ctx;
    ctx.font = font;
    const padX = 14; // 左右の余白＋枠
    let text = pin.label;
    let w = ctx.measureText(text).width + padX;
    if (w > LABEL_MAX) {
      while (text.length > 1 && ctx.measureText(text + '…').width + padX > LABEL_MAX) text = text.slice(0, -1);
      text += '…';
      w = ctx.measureText(text).width + padX;
    }
    v = { text, w: Math.ceil(w) };
    // その文字の Web フォントが読み込み済みのときだけ覚える（読み込み前は代わりのフォントの幅なので、次に描くとき測り直す）
    if (!document.fonts || document.fonts.check(font, pin.label)) this.texts.set(key, v);
    return v;
  }

  private onZoomEnd() {
    clearTimeout(this.showLabelsTimer);
    this.showLabelsTimer = window.setTimeout(() => {
      if (!this.hideLabels) return;
      this.hideLabels = false;
      this.redraw();
    }, 800);
  }

  /** 拡大・縮小のアニメーション中は、描いた絵ごと拡大縮小する */
  private animateZoom(e: L.ZoomAnimEvent) {
    if (!this.drawnBounds) return;
    const map = this._map as L.Map & {
      _latLngBoundsToNewLayerBounds(b: L.LatLngBounds, z: number, c: L.LatLng): L.Bounds;
    };
    const scale = map.getZoomScale(e.zoom);
    const offset = map._latLngBoundsToNewLayerBounds(this.drawnBounds, e.zoom, e.center).min!;
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  /** 押した位置にあるピン（上に描いたものから探す） */
  private pick(pt: L.Point): Placed | undefined {
    const list = [...this.placed].sort((a, b) => b.pin.z - a.pin.z);
    for (const p of list) {
      if (Math.hypot(pt.x - p.x, pt.y - p.y) <= p.pin.r + TOUCH) return p;
      const lb = p.lb;
      if (lb && pt.x >= lb.l && pt.x <= lb.l + lb.w && pt.y >= lb.t - 2 && pt.y <= lb.t + lb.h + 2) return p;
    }
    return undefined;
  }

  /** 押した位置を、描いたときの画面の座標に直す（描いた後に地図を動かしていても合うように） */
  private toDrawn(e: L.LeafletMouseEvent): L.Point {
    return e.layerPoint.subtract(this.origin);
  }

  private onClick(e: L.LeafletMouseEvent) {
    const p = this.pick(this.toDrawn(e));
    if (!p) return;
    L.popup(p.pin.popupOptions).setLatLng([p.pin.lat, p.pin.lon]).setContent(p.pin.popup()).openOn(this._map);
  }

  private onHover(e: L.LeafletMouseEvent) {
    this._map.getContainer().style.cursor = this.pick(this.toDrawn(e)) ? 'pointer' : '';
  }
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    paper: v('--paper', '#ffffff'),
    ink: v('--ink', '#1f2a2b'),
    line: v('--line', '#d9e0dc'),
    accent: v('--accent', '#e8743b'),
    accentInk: v('--accent-ink', '#ffffff'),
    font: getComputedStyle(document.body).fontFamily || 'sans-serif',
  };
}

const labelFont = (k: CanvasPin['labelKind'], family: string) => (k === 'p' ? `700 13px ${family}` : `500 11px ${family}`);
/** ラベルの高さ（文字の高さ×1.4＋上下の余白と枠） */
const labelHeight = (k: CanvasPin['labelKind']) => (k === 'p' ? 22 : 20);

/** #rrggbb に透明度を付ける */
function withAlpha(hex: string, a: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
