// Leaflet 地図：場所（得点に応じた大きさ）・イベント・現在地・これまでに見た場所を表示し、地図の移動を通知する
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Bounds } from '../discover/pick';
import type { EventHit } from '../discover/events';
import type { Spot } from '../types';
import type { SavedSpot } from './history';
import { CAT, shortName } from './labels';

export interface RankedSpot {
  s: Spot;
  /** 重み（得点） */
  w: number;
  /** おすすめ（必ず表示し、目立たせる） */
  pick: boolean;
}

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
  private timer = 0;

  constructor(el: HTMLElement, center: [number, number], zoom: number, onMove: () => void) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 9 }).setView(center, zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.foundLayer.addTo(this.map);
    this.otherLayer.addTo(this.map);
    this.eventLayer.addTo(this.map);
    this.hereLayer.addTo(this.map);
    this.pickLayer.addTo(this.map);
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
    this.map.on('zoomend', () => this.declutterSoon());
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
    const pad = 2;
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
    const markers = [...new Set([...this.pickMarkers.values(), ...this.eventMarkers.values(), ...this.otherMarkers])];
    const icons = markers.map((m) => ({ m, r: m.getElement()?.querySelector('span')?.getBoundingClientRect() }));
    const picks = new Set(this.pickMarkers.values());
    const placed: DOMRect[] = [];
    for (const m of markers) {
      const el = m.getTooltip()?.getElement();
      if (!el) continue;
      el.style.visibility = '';
      el.style.marginLeft = '';
      // 候補のラベルは候補のピンだけを避ける（イベントのピンの上には重なってよい）
      const obstacles = picks.has(m) ? icons.filter((i) => picks.has(i.m)) : icons;
      const free = (r: DOMRect) =>
        !placed.some((p) => hit(r, p)) && !obstacles.some((i) => i.m !== m && i.r && i.r.width > 0 && hit(r, i.r));
      let r = el.getBoundingClientRect();
      if (!free(r)) {
        // 右がふさがっていたら、ピンの左側に出してみる
        const dx = (L.point(m.getTooltip()!.options.offset ?? [0, 0]).x || 0) * 2 + r.width + 10;
        el.style.marginLeft = `-${dx}px`;
        r = el.getBoundingClientRect();
      }
      if (free(r)) placed.push(r);
      else {
        el.style.marginLeft = '';
        el.style.visibility = 'hidden';
      }
    }
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
    this.pickLayer.clearLayers();
    this.otherLayer.clearLayers();
    this.pickMarkers.clear();
    this.otherMarkers = [];
    const size = this.map.getSize();
    const taken: { pt: L.Point; r: number }[] = [...this.eventMarkers.values()].map((m) => ({
      pt: this.map.latLngToContainerPoint(m.getLatLng()),
      r: 15,
    }));
    const wmax = Math.max(1e-9, ...list.map((x) => x.w));
    let shown = 0;
    for (const x of list.slice(0, 800)) {
      const { s } = x;
      const score = Math.sqrt(x.w / wmax); // 0〜1
      const px = Math.round(x.pick ? Math.max(40, 30 + 16 * score) : 20 + 18 * score);
      const r = px / 2;
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      if (!x.pick) {
        if (pt.x < r || pt.y < r || pt.x > size.x - r || pt.y > size.y - r) continue;
        if (taken.some((t) => t.pt.distanceTo(pt) < (t.r + r) * 0.9)) continue;
      }
      taken.push({ pt, r });
      const c = CAT[s.cat] ?? CAT.other;
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: `spot-pin${x.pick ? ' pick' : ''}`,
          html: `<span style="--c:${c.color};--s:${px}px;opacity:${(0.7 + 0.3 * score).toFixed(2)}">${c.icon}</span>`,
          iconSize: [px, px],
          iconAnchor: [r, r],
        }),
        title: s.name,
        riseOnHover: true,
        zIndexOffset: Math.round(score * 1000) + (x.pick ? 2000 : 0),
      });
      m.bindTooltip(shortName(s.name), {
        permanent: true,
        direction: 'right',
        offset: [r + 2, 0],
        className: `pin-label${x.pick ? '' : ' other-label'}`,
        interactive: true,
      });
      m.bindPopup(() => popup(s), { maxWidth: 340, minWidth: 260, autoPan: false, className: 'card-popup' });
      m.getTooltip()?.on('click', () => m.openPopup());
      m.addTo(x.pick ? this.pickLayer : this.otherLayer);
      if (x.pick) this.pickMarkers.set(s.id, m);
      else this.otherMarkers.push(m);
      shown++;
    }
    this.declutterSoon();
    return shown;
  }

  /**
   * イベントのピン。会場の座標が分かるものは会場ごと、分からないもの（横浜市）は区の中心にまとめる。
   */
  showEvents(hits: EventHit[], popup: (hits: EventHit[]) => HTMLElement) {
    this.eventLayer.clearLayers();
    this.eventMarkers.clear();
    const groups = new Map<string, EventHit[]>();
    for (const x of hits) {
      const k = x.ev.approx ? `area:${x.ev.city}` : `${x.ev.lat.toFixed(4)},${x.ev.lon.toFixed(4)}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    for (const list of groups.values()) {
      const ev = list[0].ev;
      const m = L.marker([ev.lat, ev.lon], {
        icon: L.divIcon({
          className: `event-pin${ev.approx ? ' approx' : ''}`,
          html: `<span>🗓️${list.length > 1 ? `<b>${list.length}</b>` : ''}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        title: list.map((x) => x.ev.title).join(' / '),
        riseOnHover: true,
        zIndexOffset: 1500,
      });
      // 会場名（なければイベント名）を添える。長いものは短く
      const label = ev.approx ? `${ev.city.replace(/^横浜市/, '')}のイベント` : (ev.spotName ?? ev.venue ?? ev.title);
      m.bindTooltip(label.length > 14 ? label.slice(0, 14) + '…' : label, {
        permanent: true,
        direction: 'right',
        offset: [15, 0],
        className: 'pin-label event-label',
        interactive: true,
      });
      m.bindPopup(() => popup(list), { maxWidth: 360, minWidth: 260, autoPan: false, className: 'event-popup' });
      m.getTooltip()?.on('click', () => m.openPopup());
      m.addTo(this.eventLayer);
      for (const x of list) this.eventMarkers.set(x.ev.id, m);
    }
    this.declutterSoon();
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
