import './styles.css';
import { DETAIL_ZOOM, loadBounds, loadEvents, loadHighlights, loadMeta, loadNews, prefetchAround } from './data/loader';
import { eventsInView, WHEN_LABEL, whenDays, type EventHit, type When } from './discover/events';
import { rankInView, todaySeed } from './discover/pick';
import type { EventsData, Meta, NewsData, NewsItem, Spot } from './types';
import { renderCard } from './ui/card';
import { $, h, safeUrl } from './ui/dom';
import { eventItem } from './ui/events';
import { history } from './ui/history';
import { CAT, googleSearchUrl } from './ui/labels';
import { BASEMAPS, DiscoverMap, type RankedSpot } from './ui/map';
import { perf } from './perf';

/** おすすめ（大きく、必ず表示する）の数 */
const COUNT = 6;
/**
 * 表示しない場所：公園と、遊び場のうち実質は街区公園のもの（「〇〇公園」「児童遊園」など）、遊具単体・園庭など。
 * 公園はデータの7割を占めて候補が埋まるため。データには残し、イベント会場との照合には使う。
 */
const PARKLIKE = /公園|緑地|遊園|広場|ひろば|プレイロット|こうえん|^(鉄棒|ブランコ|迷路|グラウンド)$|ベンチ|バランス|幼稚園|保育|園庭|テニス|囲碁|サイクル/;
export const isHidden = (s: Spot) => s.cat === 'park' || (s.cat === 'playground' && PARKLIKE.test(s.name));

/** 凡例に並べる種類（イベント＋公園以外のカテゴリ） */
const KINDS: { key: string; icon: string; label: string; color: string }[] = [
  { key: 'event', icon: '🗓️', label: 'イベント', color: '#e8743b' },
  ...Object.entries(CAT)
    .filter(([k]) => k !== 'park')
    .map(([key, c]) => ({ key, icon: c.icon, label: c.label, color: c.color })),
];

const state = {
  meta: null as Meta | null,
  /** 表示をオフにした種類（カテゴリ名、またはイベントは 'event'） */
  off: new Set(history.prefs.get<string[]>('off', [])),
  when: history.prefs.get<When>('when', 'weekend'),
  skip: new Set<string>(), // 「ほかの場所」で外したもの
  seenAtLoad: history.ids('seen'), // 起動時点で見たことのある場所（表示中に順位が変わらないよう固定）
  seed: todaySeed(),
  req: 0,
  news: null as NewsData | null,
  events: null as EventsData | null,
};

let map: DiscoverMap;

const status = (msg: string) => ($('#status').textContent = msg);

function inRegion(lat: number, lon: number) {
  const b = state.meta!.bbox;
  return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
}

function newsFor(spot: Spot, news: NewsData | null): { spotNews: NewsItem[]; cityNews: NewsItem[] } {
  if (!news) return { spotNews: [], cityNews: [] };
  const cityKey = spot.city ? Object.keys(news.byCity).find((k) => spot.city!.startsWith(k)) : undefined;
  return { spotNews: news.bySpot[spot.id] ?? [], cityNews: cityKey ? news.byCity[cityKey] : [] };
}

/** 場所のピンを押したときの吹き出し（カード） */
function spotPopup(s: Spot): HTMLElement {
  history.add('viewed', s); // 閲覧履歴（吹き出しを開いた場所）
  return renderCard(s, {
    index: -1,
    tags: (s.t ?? []).map((i) => state.meta!.terms[i]).filter((t) => t && t.idf >= 1.5).map((t) => t.label),
    ...newsFor(s, state.news),
    events: (state.events?.events ?? []).filter((e) => e.spot === s.id),
    onFocus: () => {},
  });
}

/** イベントのピンを押したときの吹き出し */
function eventPopup(hits: EventHit[]): HTMLElement {
  const ev = hits[0].ev;
  return h(
    'div',
    { class: 'ev-pop' },
    h('p', { class: 'ev-pop-title' }, ev.approx ? `🗓️ ${ev.city}の${WHEN_LABEL[state.when]}のイベント` : `🗓️ ${ev.spotName ?? ev.venue ?? ev.city}`),
    h('ul', { class: 'ev-list' }, ...hits.slice(0, 30).map((x) => eventItem(x))),
  );
}

/** 地図の表示範囲から選び直して表示する */
async function refresh() {
  if (!state.meta) return;
  const req = ++state.req;
  perf.begin();
  const wide = map.zoom < DETAIL_ZOOM;
  const b = map.bounds();
  const loaded = wide ? await loadHighlights() : await loadBounds(state.meta, b);
  const spots = loaded.filter((s) => !isHidden(s) && !state.off.has(s.cat));
  const [news, events] = await Promise.all([loadNews(), loadEvents()]);
  if (req !== state.req) return; // 古い要求は捨てる
  perf.mark('読込');
  state.news = news;
  state.events = events;

  // イベント（先に置き、場所のピンはそれを避ける）
  const allEvents = events?.events ?? [];
  const hits = state.off.has('event') ? [] : eventsInView(allEvents, b, whenDays(state.when));
  map.showEvents(hits, eventPopup);
  perf.mark('イベント');

  const { picks, others, weights } = rankInView(spots, b, {
    count: COUNT,
    rainy: false,
    seen: state.seenAtLoad,
    skip: state.skip,
    seed: state.seed,
    terms: state.meta.terms,
  });
  const ranked: RankedSpot[] = [
    ...picks.map((s) => ({ s, w: weights.get(s.id) ?? 0, pick: true })),
    // おすすめ以外は得点の高い順に置く（近くに複数あるときは得点の高いものが残る）
    ...others.map((s) => ({ s, w: weights.get(s.id) ?? 0, pick: false })).sort((a, b) => b.w - a.w),
  ];
  perf.mark('選ぶ');
  const shown = map.showSpots(ranked, spotPopup);
  perf.mark('ピン');
  history.addMany('seen', picks);
  perf.mark('履歴');
  perf.end(`候補 ${spots.length}・ピン ${shown}（新規 ${map.created}）`);
  if (!wide) prefetchAround(state.meta, b);

}

function setWhen(w: When) {
  state.when = w;
  history.prefs.set('when', w);
  $('#when').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.when === w)));
  refresh();
}

/** 閲覧履歴：吹き出しを開いた場所（新しい順） */
function setupViewed() {
  const dlg = $<HTMLDialogElement>('#viewed');
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const render = () => {
    const list = history.list('viewed').slice().reverse();
    $('#viewed-clear').toggleAttribute('hidden', !list.length);
    $('#viewed-list').replaceChildren(
      ...(list.length
        ? list.map((v) => {
            const c = CAT[v.cat] ?? CAT.other;
            const go = h('button', { type: 'button', class: 'log-name link-like', title: '地図で見る' }, v.name);
            go.addEventListener('click', () => {
              dlg.close();
              map.flyTo(v.lat, v.lon, Math.max(map.zoom, 15));
            });
            const rm = h('button', { type: 'button', class: 'ghost-btn', 'aria-label': `${v.name}を履歴から消す` }, '✕');
            rm.addEventListener('click', () => {
              history.remove('viewed', v.id);
              render();
            });
            return h(
              'li',
              {},
              h('span', { class: 'log-icon', style: `--c:${c.color}` }, c.icon),
              h('div', { class: 'log-main' }, go, h('span', { class: 'log-meta' }, [v.city, fmt(v.at)].filter(Boolean).join('・'))),
              h('a', { href: googleSearchUrl(v.name, v.city), target: '_blank', rel: 'noopener' }, 'Google'),
              h('a', { href: `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}`, target: '_blank', rel: 'noopener' }, '行き方'),
              rm,
            );
          })
        : [h('li', { class: 'empty' }, 'アイコンを押して詳しい情報を見た場所が、ここに新しい順で並びます。')]),
    );
  };
  $('#open-viewed').addEventListener('click', () => {
    render();
    dlg.showModal();
  });
  $('#viewed-clear').addEventListener('click', () => {
    history.clear('viewed');
    render();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

function setupAbout() {
  const about = $<HTMLDialogElement>('#about');
  $('#open-about').addEventListener('click', () => about.showModal());
  about.addEventListener('click', (e) => {
    if (e.target === about) about.close();
  });
}

/** 地図上の凡例：種類ごとの表示 on/off */
function setupLegend() {
  const box = $('#kinds');
  const buttons = new Map<string, HTMLButtonElement>();
  const sync = () => {
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(!state.off.has(k)));
    history.prefs.set('off', [...state.off]);
    state.skip.clear();
    refresh();
  };
  for (const k of KINDS) {
    const btn = h(
      'button',
      { type: 'button', class: 'kind', 'aria-pressed': String(!state.off.has(k.key)) },
      h('span', { class: 'kind-icon', style: `--c:${k.color}` }, k.icon),
      k.label,
    );
    btn.addEventListener('click', () => {
      if (state.off.has(k.key)) state.off.delete(k.key);
      else state.off.add(k.key);
      sync();
    });
    buttons.set(k.key, btn);
    box.append(btn);
  }
  $('#all-on').addEventListener('click', () => {
    state.off.clear();
    sync();
  });
  $('#all-off').addEventListener('click', () => {
    for (const k of KINDS) state.off.add(k.key);
    sync();
  });
  // スマホでは地図を広く使えるよう、凡例は閉じておく
  if (window.matchMedia('(max-width: 700px)').matches) $<HTMLDetailsElement>('#legend').open = false;
}

function setupWhen() {
  const seg = $('#when');
  for (const w of Object.keys(WHEN_LABEL) as When[]) {
    const btn = h('button', { type: 'button', 'data-when': w, 'aria-pressed': String(state.when === w) }, WHEN_LABEL[w]);
    btn.addEventListener('click', () => setWhen(w));
    seg.append(btn);
  }
}

async function init() {
  try {
    state.meta = await loadMeta();
  } catch (e) {
    status('データの読み込みに失敗しました。時間をおいて再読み込みしてください。');
    throw e;
  }
  const meta = state.meta;
  const view = history.prefs.get<{ lat: number; lon: number; z: number } | null>('view', null);
  const start = view && inRegion(view.lat, view.lon) ? view : { lat: meta.center[0], lon: meta.center[1], z: 10 };
  map = new DiscoverMap($('#map'), [start.lat, start.lon], start.z, history.prefs.get<string>('base', 'osm'), () => {
    const [lat, lon] = map.center;
    history.prefs.set('view', { lat, lon, z: map.zoom });
    refresh();
  });

  setupAbout();
  setupViewed();
  const baseSel = $<HTMLSelectElement>('#base');
  for (const [k, b] of Object.entries(BASEMAPS)) baseSel.append(h('option', { value: k }, b.label));
  baseSel.value = map.base;
  baseSel.addEventListener('change', () => {
    map.setBase(baseSel.value);
    history.prefs.set('base', baseSel.value);
  });
  setupLegend();
  setupWhen();

  const ver = $('#ver');
  ver.textContent = `v${__APP_VERSION__}`;
  ver.title = `ビルド ${__BUILD_TIME__}`;

  const d = new Date(meta.updatedAt);
  $('#updated').textContent = `${meta.name}の ${meta.count.toLocaleString()} か所を収録・データ更新 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  $('#sources').replaceChildren(
    '出典：',
    ...meta.sources.flatMap((s, i) => [i ? '、' : '', h('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener' }, s.name), `（${s.license}）`]),
  );
  loadEvents().then((ev) => {
    if (!ev) return;
    $('#sources').append(
      '、イベント：',
      ...ev.sources.flatMap((s, i) => [i ? '、' : '', h('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener' }, s.name), `（${s.license}）`]),
    );
  });

  window.addEventListener('resize', () => map.invalidate());
  // フォント読み込み等でレイアウトが変わった後にタイルを描き直す
  requestAnimationFrame(() => map.invalidate());
  document.fonts?.ready.then(() => map.invalidate());
  refresh();
}

init();
