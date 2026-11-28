// 時間地図の背景：地図の画像（タイル）を歪めて描き、その上に路線・駅・時間の輪を描く Leaflet の層。
// distortMap の basemap.js を Leaflet 用に移したもの。
//   タイル 1 枚を MESH×MESH のマスの三角形に分け、頂点を歪めた位置へ貼る（中心駅からの方角はそのまま、距離だけ伸縮）。
// 地図を動かしている間は canvas ごと動き、止まったら描き直す。拡大・縮小の間は canvas ごと拡大縮小する
import L from 'leaflet';
import { NONE, ringKm, warpLatLng, type TimeTable, type Warp } from './warp';

const MESH = 8;
/** 1 回に描くタイル数の上限（スマホで重くなりすぎないように） */
const MAX_TILES = 160;
/** 画面より広く描く幅（px）。地図を少し動かしても端が白くならないように */
const PAD = 160;
/** 駅の範囲から外側に描く幅（km） */
const MARGIN_KM = 20;
/** 時間の輪（分） */
const RINGS = [15, 30, 45, 60, 90];
/** 駅を押したとみなす距離（px） */
const HIT = 12;

const tileLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const lngTile = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const latTile = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

type Pt = [number, number];

export class WarpBaseLayer extends L.Layer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tiles = new Map<string, { img: HTMLImageElement; ok: boolean }>();
  private nw = L.latLng(0, 0);
  private drawnZoom = 0;
  private frame = 0;
  /** 描いた駅の位置（押したときの判定用。canvas の座標） */
  private stationPts: { i: number; x: number; y: number }[] = [];
  private origin = L.point(0, 0);

  constructor(
    private tt: TimeTable,
    private warp: Warp,
    private tileUrl: string,
    private maxNativeZoom: number,
    private onStation: (i: number) => void,
  ) {
    super();
  }

  setWarp(w: Warp) {
    this.warp = w;
    this.redraw();
  }

  setTileUrl(url: string, maxNativeZoom: number) {
    if (url === this.tileUrl) return;
    this.tileUrl = url;
    this.maxNativeZoom = maxNativeZoom;
    this.tiles.clear();
    this.redraw();
  }

  onAdd(map: L.Map) {
    const pane = map.getPane('warpPane') ?? map.createPane('warpPane');
    pane.style.zIndex = '250'; // 通常の地図の画像（200）より上、ピン（610）より下
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'warp-canvas leaflet-zoom-animated', pane);
    this.ctx = this.canvas.getContext('2d')!;
    map.on('moveend viewreset resize', this.redraw, this);
    map.on('zoomanim', this.animateZoom, this);
    map.on('zoom', this.onZoomFrame, this);
    map.on('click', this.onClick, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map) {
    map.off('moveend viewreset resize', this.redraw, this);
    map.off('zoomanim', this.animateZoom, this);
    map.off('zoom', this.onZoomFrame, this);
    map.off('click', this.onClick, this);
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
    return this;
  }

  /** 拡大・縮小のアニメーション：canvas ごと地図の画像と同じように拡大縮小する */
  private animateZoom(e: L.ZoomAnimEvent) {
    const map = this._map as L.Map & { _latLngToNewLayerPoint(ll: L.LatLng, z: number, c: L.LatLng): L.Point };
    L.DomUtil.setTransform(this.canvas, map._latLngToNewLayerPoint(this.nw, e.zoom, e.center).subtract([PAD, PAD]), map.getZoomScale(e.zoom, this.drawnZoom));
  }

  /** 指 2 本での拡大・縮小の間 */
  private onZoomFrame() {
    const map = this._map;
    if (!map || (map as unknown as { _animatingZoom?: boolean })._animatingZoom) return;
    L.DomUtil.setTransform(this.canvas, map.latLngToLayerPoint(this.nw).subtract([PAD, PAD]), map.getZoomScale(map.getZoom(), this.drawnZoom));
  }

  redraw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.origin = map.containerPointToLayerPoint([0, 0]);
    this.nw = map.containerPointToLatLng([0, 0]);
    this.drawnZoom = map.getZoom();
    L.DomUtil.setTransform(this.canvas, this.origin.subtract([PAD, PAD]), 1);
    const cw = size.x + PAD * 2;
    const ch = size.y + PAD * 2;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${ch}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toPx = (lat: number, lon: number): Pt => {
      const [a, b] = warpLatLng(this.warp, lat, lon);
      const p = map.latLngToContainerPoint([a, b]);
      return [p.x + PAD, p.y + PAD];
    };
    this.drawTiles(toPx, cw, ch);
    this.drawOverlay(toPx);
  }

  /** 背景の地図の画像を歪めて貼る */
  private drawTiles(toPx: (lat: number, lon: number) => Pt, cw: number, ch: number) {
    const map = this._map;
    const w = this.warp;
    const tt = this.tt;
    // 代表的な伸縮率（駅の伸縮率の中央の値）。描くタイルの範囲とズームレベルの見当に使う
    const ss = w.pts.map((p) => p.s).sort((a, b) => a - b);
    const typical = ss.length ? ss[Math.floor(ss.length / 2)] : 1;
    // 画面に見えている範囲（歪めた地図）を、代表的な伸縮率で実際の緯度経度に戻し、余裕を持たせて広げる
    const view = [
      map.containerPointToLatLng([-PAD, -PAD]),
      map.containerPointToLatLng([cw - PAD, ch - PAD]),
    ];
    const toReal = (ll: L.LatLng) => [w.lat0 + (ll.lat - w.lat0) / typical, w.lon0 + (ll.lng - w.lon0) / typical];
    const [a, b] = view.map(toReal);
    let latMin = Math.min(a[0], b[0]);
    let latMax = Math.max(a[0], b[0]);
    let lonMin = Math.min(a[1], b[1]);
    let lonMax = Math.max(a[1], b[1]);
    const padLat = (latMax - latMin) * 0.5;
    const padLon = (lonMax - lonMin) * 0.5;
    let sMinLat = Infinity, sMaxLat = -Infinity, sMinLon = Infinity, sMaxLon = -Infinity;
    for (let i = 0; i < tt.n; i++) {
      sMinLat = Math.min(sMinLat, tt.lat[i]);
      sMaxLat = Math.max(sMaxLat, tt.lat[i]);
      sMinLon = Math.min(sMinLon, tt.lon[i]);
      sMaxLon = Math.max(sMaxLon, tt.lon[i]);
    }
    const mLat = MARGIN_KM / 110.57;
    const mLon = MARGIN_KM / (111.32 * Math.cos((w.lat0 * Math.PI) / 180));
    latMin = Math.max(latMin - padLat, sMinLat - mLat);
    latMax = Math.min(latMax + padLat, sMaxLat + mLat);
    lonMin = Math.max(lonMin - padLon, sMinLon - mLon);
    lonMax = Math.min(lonMax + padLon, sMaxLon + mLon);
    if (latMin >= latMax || lonMin >= lonMax) return;
    // 画面の 1 ピクセルがタイルの 1 ピクセル程度になるズームレベル。タイルが多すぎるときは粗くする
    let z = Math.max(5, Math.min(this.maxNativeZoom, Math.round(map.getZoom() + Math.log2(typical))));
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; ; z--) {
      x0 = Math.floor(lngTile(lonMin, z));
      x1 = Math.floor(lngTile(lonMax, z));
      y0 = Math.floor(latTile(latMax, z));
      y1 = Math.floor(latTile(latMin, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 900 || z <= 5) break;
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    let count = 0;
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        // まず四隅だけで、明らかに画面外のタイルを除く
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => toPx(tileLat(ty + j, z), tileLng(tx + i, z)));
        const cx0 = Math.min(...corners.map((p) => p[0]));
        const cx1 = Math.max(...corners.map((p) => p[0]));
        const cy0 = Math.min(...corners.map((p) => p[1]));
        const cy1 = Math.max(...corners.map((p) => p[1]));
        const px = (cx1 - cx0) * 0.5;
        const py = (cy1 - cy0) * 0.5;
        if (cx1 + px < 0 || cx0 - px > cw || cy1 + py < 0 || cy0 - py > ch) continue;
        const grid: Pt[][] = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j <= MESH; j++) {
          const row: Pt[] = [];
          const lat = tileLat(ty + j / MESH, z);
          for (let i = 0; i <= MESH; i++) {
            const p = toPx(lat, tileLng(tx + i / MESH, z));
            row.push(p);
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
          }
          grid.push(row);
        }
        if (maxX < 0 || minX > cw || maxY < 0 || minY > ch) continue;
        if (++count > MAX_TILES) return;
        const t = this.tile(z, tx, ty);
        if (!t.ok) continue;
        const step = 256 / MESH;
        for (let j = 0; j < MESH; j++)
          for (let i = 0; i < MESH; i++) {
            const s00: Pt = [i * step, j * step];
            const s10: Pt = [(i + 1) * step, j * step];
            const s01: Pt = [i * step, (j + 1) * step];
            const s11: Pt = [(i + 1) * step, (j + 1) * step];
            this.triangle(t.img, s00, s10, s11, grid[j][i], grid[j][i + 1], grid[j + 1][i + 1]);
            this.triangle(t.img, s00, s11, s01, grid[j][i], grid[j + 1][i + 1], grid[j + 1][i]);
          }
      }
    }
  }

  private tile(z: number, x: number, y: number) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      const img = new Image();
      const rec = { img, ok: false };
      img.onload = () => {
        rec.ok = true;
        this.redraw();
      };
      img.src = this.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      this.tiles.set(key, rec);
      t = rec;
      if (this.tiles.size > 1500) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return t;
  }

  /** 三角形 (s0,s1,s2)（タイル画像のピクセル）を (d0,d1,d2)（canvas）に貼る */
  private triangle(img: HTMLImageElement, s0: Pt, s1: Pt, s2: Pt, d0: Pt, d1: Pt, d2: Pt) {
    // 継ぎ目が見えないよう、三角形を重心から少し広げて切り抜く
    const gx = (d0[0] + d1[0] + d2[0]) / 3;
    const gy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p: Pt): Pt => {
      const dx = p[0] - gx;
      const dy = p[1] - gy;
      const len = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / len) * 0.8, p[1] + (dy / len) * 0.8];
    };
    const e0 = grow(d0);
    const e1 = grow(d1);
    const e2 = grow(d2);
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (!den) return;
    const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
    const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
    const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const e = d0[0] - a * s0[0] - c * s0[1];
    const f = d0[1] - b * s0[0] - d * s0[1];
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e0[0], e0[1]);
    ctx.lineTo(e1[0], e1[1]);
    ctx.lineTo(e2[0], e2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /** 時間の輪・路線・駅 */
  private drawOverlay(toPx: (lat: number, lon: number) => Pt) {
    const map = this._map;
    const ctx = this.ctx;
    const tt = this.tt;
    const w = this.warp;
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent').trim() || '#e8743b';
    const ink = cs.getPropertyValue('--ink').trim() || '#1f3a3d';
    const paper = cs.getPropertyValue('--paper').trim() || '#ffffff';
    // 時間の輪：歪めた地図では、中心からの距離が「所要時間 × k」なので円になる
    const c = toPx(w.lat0, w.lon0);
    const pxPerKm = (() => {
      const p = map.latLngToContainerPoint([w.lat0 + 1 / 110.57, w.lon0]);
      const q = map.latLngToContainerPoint([w.lat0, w.lon0]);
      return Math.hypot(p.x - q.x, p.y - q.y);
    })();
    ctx.save();
    ctx.font = `600 12px ${cs.getPropertyValue('font-family') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    for (const m of RINGS) {
      const r = ringKm(w, m) * pxPerKm;
      // 色の多い地図の上でも見えるよう、白い縁取りの上に太めの点線
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
      ctx.strokeStyle = paper;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = paper;
      ctx.strokeText(`${m}分`, c[0], c[1] - r - 4);
      ctx.fillStyle = accent;
      ctx.fillText(`${m}分`, c[0], c[1] - r - 4);
    }
    ctx.restore();
    // 路線
    const pts = Array.from({ length: tt.n }, (_, i) => toPx(tt.lat[i], tt.lon[i]));
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of tt.edges) {
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
    }
    ctx.stroke();
    ctx.restore();
    // 駅（行けない駅は描かない）。拡大しているときだけ駅名も
    this.stationPts = [];
    const showNames = map.getZoom() >= 12;
    ctx.save();
    ctx.font = `11px ${cs.getPropertyValue('font-family') || 'sans-serif'}`;
    for (let i = 0; i < tt.n; i++) {
      if (i !== w.center && tt.t[w.center * tt.n + i] === NONE) continue;
      const [x, y] = pts[i];
      if (x < -20 || y < -20 || x > this.canvas.width || y > this.canvas.height) continue;
      this.stationPts.push({ i, x, y });
      ctx.beginPath();
      ctx.arc(x, y, i === w.center ? 7 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === w.center ? accent : paper;
      ctx.fill();
      ctx.lineWidth = i === w.center ? 3 : 1.5;
      ctx.strokeStyle = i === w.center ? paper : ink;
      ctx.stroke();
      if (showNames || i === w.center) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = paper;
        const label = i === w.center ? `${tt.names[i]}（中心）` : tt.names[i];
        ctx.strokeText(label, x + 6, y - 6);
        ctx.fillStyle = ink;
        ctx.fillText(label, x + 6, y - 6);
      }
    }
    ctx.restore();
  }

  /** 駅を押したら、その駅を中心にする（ピンの吹き出しが開いたときは何もしない） */
  private onClick(e: L.LeafletMouseEvent) {
    const p = e.containerPoint;
    let best: { i: number; d: number } | undefined;
    for (const s of this.stationPts) {
      const d = Math.hypot(s.x - PAD - p.x, s.y - PAD - p.y);
      if (d <= HIT && (!best || d < best.d)) best = { i: s.i, d };
    }
    if (!best) return;
    const i = best.i;
    setTimeout(() => {
      const open = (this._map as unknown as { _popup?: L.Popup })._popup;
      if (open && this._map.hasLayer(open)) return;
      if (i !== this.warp.center) this.onStation(i);
    }, 0);
  }
}

