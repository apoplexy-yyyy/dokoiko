// Leaflet 地図：表示範囲の候補（番号ピン）・現在地・これまでに見た場所を表示し、地図の移動を通知する
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Bounds } from '../discover/pick';
import type { EventItem, Spot } from '../types';
import type { SavedSpot } from './history';
import { CAT } from './labels';

export class DiscoverMap {
  private map: L.Map;
  private hereLayer = L.layerGroup();
  private pickLayer = L.layerGroup();
  private foundLayer = L.layerGroup();
  private eventLayer = L.layerGroup();
  private eventMarkers = new Map<string, L.Marker>();
  private pickMarkers = new Map<string, L.Marker>();
  private timer = 0;

  constructor(el: HTMLElement, center: [number, number], zoom: number, onMove: () => void) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 9 }).setView(center, zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.foundLayer.addTo(this.map);
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
    }).observe(el);
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
      m.on('click', () => onSelect(s.id));
      m.addTo(this.pickLayer);
      this.pickMarkers.set(s.id, m);
    });
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
      m.on('click', () => onSelect(evs[0].id));
      m.addTo(this.eventLayer);
      for (const e of evs) this.eventMarkers.set(e.id, m);
    }
  }

  highlightEvent(id: string) {
    const el = this.eventMarkers.get(id)?.getElement();
    if (!el) return;
    el.classList.remove('bounce');
    void el.offsetWidth;
    el.classList.add('bounce');
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
