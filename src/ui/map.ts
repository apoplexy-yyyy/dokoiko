// Leaflet 地図：表示範囲の候補（番号ピン）・現在地・これまでに見た場所を表示し、地図の移動を通知する
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Bounds } from '../discover/pick';
import type { EventItem, Spot } from '../types';
import type { SavedSpot } from './history';
import { CAT, googleSearchUrl, shortName } from './labels';

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
    const notify = () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(onMove, 200);
    };
    this.map.on('moveend', notify);
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

  showPicks(picks: Spot[], onSelect: (id: string) => void) {
    this.pickLayer.clearLayers();
    this.pickMarkers.clear();
    picks.forEach((s, i) => {
      const c = CAT[s.cat];
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: 'pick-pin',
          html: `<span style="--c:${c.color}"><b>${i + 1}</b></span>`,
          iconSize: [36, 44],
          iconAnchor: [18, 42],
        }),
        title: s.name,
        riseOnHover: true,
      });
      // 「川崎市〇〇こども文化センター」などは市名を省いて短く
      m.bindTooltip(shortName(s.name), { permanent: true, direction: 'right', offset: [14, -24], className: 'pin-label', interactive: true });
      m.on('click', () => onSelect(s.id));
      m.getTooltip()?.on('click', () => onSelect(s.id));
      m.addTo(this.pickLayer);
      this.pickMarkers.set(s.id, m);
    });
    this.declutterSoon();
  }

  /** イベント会場（座標が分かるものだけ）。同じ会場は1つのピンにまとめる */
  showEvents(list: EventItem[], onSelect: (id: string) => void) {
    this.eventLayer.clearLayers();
    this.eventMarkers.clear();
    const byPlace = new Map<string, EventItem[]>();
    for (const ev of list) {
      if (ev.approx) continue;
      const k = `${ev.lat.toFixed(4)},${ev.lon.toFixed(4)}`;
      byPlace.set(k, [...(byPlace.get(k) ?? []), ev]);
    }
    for (const evs of byPlace.values()) {
      const m = L.marker([evs[0].lat, evs[0].lon], {
        icon: L.divIcon({
          className: 'event-pin',
          html: `<span>🗓️${evs.length > 1 ? `<b>${evs.length}</b>` : ''}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        title: evs.map((e) => e.title).join(' / '),
        riseOnHover: true,
      });
      // 会場名（なければイベント名）を添える。長いものは短く
      const label = evs[0].spotName ?? evs[0].venue ?? evs[0].title;
      m.bindTooltip(label.length > 14 ? label.slice(0, 14) + '…' : label, {
        permanent: true,
        direction: 'right',
        offset: [12, 0],
        className: 'pin-label event-label',
        interactive: true,
      });
      m.on('click', () => onSelect(evs[0].id));
      m.getTooltip()?.on('click', () => onSelect(evs[0].id));
      m.addTo(this.eventLayer);
      for (const e of evs) this.eventMarkers.set(e.id, m);
    }
    this.declutterSoon();
  }

  highlightEvent(id: string) {
    const el = this.eventMarkers.get(id)?.getElement();
    if (!el) return;
    el.classList.remove('bounce');
    void el.offsetWidth;
    el.classList.add('bounce');
  }

  /**
   * 候補以外の場所も、ほかのピンと重ならないものはすべて小さな丸で出す（順位の高い順に置いていく）
   * @returns 表示した数
   */
  showOthers(spots: Spot[]): number {
    this.otherLayer.clearLayers();
    this.otherMarkers = [];
    const size = this.map.getSize();
    const MIN = 26; // ピンどうしの最小間隔(px)
    const taken: L.Point[] = [];
    for (const m of [...this.pickMarkers.values(), ...this.eventMarkers.values()]) taken.push(this.map.latLngToContainerPoint(m.getLatLng()));
    for (const s of spots.slice(0, 600)) {
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      if (pt.x < 8 || pt.y < 8 || pt.x > size.x - 8 || pt.y > size.y - 8) continue;
      if (taken.some((t) => t.distanceTo(pt) < MIN)) continue;
      taken.push(pt);
      const c = CAT[s.cat] ?? CAT.other;
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: 'spot-dot', html: `<span style="--c:${c.color}">${c.icon}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        title: s.name,
      });
      m.bindTooltip(shortName(s.name), {
        permanent: true,
        direction: 'right',
        offset: [10, 0],
        className: 'pin-label other-label',
        interactive: true,
      });
      const pop = document.createElement('div');
      pop.className = 'spot-pop';
      const b = document.createElement('b');
      b.textContent = s.name;
      const meta = document.createElement('span');
      meta.textContent = [`${c.icon} ${c.label}`, s.city].filter(Boolean).join('・');
      const a = document.createElement('a');
      a.href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '🧭 行き方';
      const g = document.createElement('a');
      g.href = googleSearchUrl(s.name, s.city);
      g.target = '_blank';
      g.rel = 'noopener';
      g.textContent = '🔍 Google';
      const links = document.createElement('span');
      links.className = 'spot-pop-links';
      links.append(g, a);
      pop.append(b, meta, links);
      m.bindPopup(pop);
      m.getTooltip()?.on('click', () => m.openPopup());
      m.addTo(this.otherLayer);
      this.otherMarkers.push(m);
    }
    this.declutterSoon();
    return this.otherMarkers.length;
  }

  /** ピンを跳ねさせる（地図は動かさない＝候補が入れ替わらない） */
  highlight(id: string) {
    const el = this.pickMarkers.get(id)?.getElement();
    if (!el) return;
    el.classList.remove('bounce');
    void el.offsetWidth;
    el.classList.add('bounce');
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

  invalidate() {
    this.map.invalidateSize();
  }
}
