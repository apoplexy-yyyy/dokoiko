import './styles.css';
import { DETAIL_ZOOM, loadAllTiles, loadBounds, loadEvents, loadHighlights, loadMeta, loadNews, prefetchAround } from './data/loader';
import type { TimeMap } from './timemap';
import { eventsInView, WHEN_LABEL, whenDays, type EventHit, type When } from './discover/events';
import { rankInView, todaySeed } from './discover/pick';
import type { EventsData, Meta, NewsData, NewsItem, Spot } from './types';
import { renderCard } from './ui/card';
import { $, h, safeUrl } from './ui/dom';
import { eventItem } from './ui/events';
import { history } from './ui/history';
import { CAT, googleSearchUrl } from './ui/labels';
import { BASEMAPS, DiscoverMap, FX, type RankedSpot } from './ui/map';
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
  /** 時間地図（ボタンを押している間だけ） */
  tm: null as TimeMap | null,
  /** 時間地図の間：歪めた位置に置き換える前のスポット（カードには元の位置のものを渡す） */
  orig: new Map<string, Spot>(),
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
function spotPopup(shown: Spot): HTMLElement {
  const s = state.tm ? (state.orig.get(shown.id) ?? shown) : shown;
  history.add('viewed', s); // 閲覧履歴（吹き出しを開いた場所）
  const card = renderCard(s, {
    index: -1,
    tags: (s.t ?? []).map((i) => state.meta!.terms[i]).filter((t) => t && t.idf >= 1.5).map((t) => t.label),
    ...newsFor(s, state.news),
    events: (state.events?.events ?? []).filter((e) => e.spot === s.id),
    onFocus: () => {},
  });
  // 時間地図の間は、中心駅からの時間を先頭に出す
  const tm = state.tm;
  if (tm) {
    const r = tm.minutesTo(s.lat, s.lon);
    card.prepend(
      h(
        'p',
        { class: 'tm-time' },
        r
          ? `🚃 ${tm.centerName}駅から電車で約${r.min}分（${r.via}駅から歩いて。休日の日中の平均・推定）`
          : `🚃 ${tm.centerName}駅から電車で行ける駅が近くにありません`,
      ),
    );
  }
  return card;
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
  const tm = state.tm;
  // 時間地図の間は、全部のスポットを歪めた位置に置き換え、画面の範囲（歪めた地図）で選ぶ
  const loaded = wide ? await loadHighlights() : tm ? await loadAllTiles(state.meta) : await loadBounds(state.meta, b);
  let spots = loaded.filter((s) => !isHidden(s) && !state.off.has(s.cat));
  if (tm) {
    state.orig = new Map(spots.map((s) => [s.id, s]));
    spots = spots.map((s) => tm.place(s));
  }
  const [news, events] = await Promise.all([loadNews(), loadEvents()]);
  if (req !== state.req) return; // 古い要求は捨てる
  perf.mark('読込');
  state.news = news;
  state.events = events;

  // イベント（先に置き、場所のピンはそれを避ける）
  const allEvents = (events?.events ?? []).map((e) => (tm ? tm.place(e) : e));
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
  perf.end(`${FX.size ? `fx=${[...FX].join(',')}｜` : ''}候補 ${spots.length}・ピン ${shown}（新規 ${map.created}）
  ピンの内訳 ${map.pinStats}`);
  if (tm) return; // 時間地図では全部読み込んでいる
  if (!wide) prefetchAround(state.meta, b);
  // 詳しい表示の一歩手前では、拡大したときに出る範囲（画面の中心まわり）を先に読んでおく
  else if (map.zoom >= DETAIL_ZOOM - 1) {
    const cy = (b.south + b.north) / 2;
    const cx = (b.west + b.east) / 2;
    const hy = (b.north - b.south) / 4;
    const hx = (b.east - b.west) / 4;
    prefetchAround(state.meta, { south: cy - hy, north: cy + hy, west: cx - hx, east: cx + hx }, 0);
  }

}

function setWhen(w: When) {
  state.when = w;
  history.prefs.set('when', w);
  $('#when').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.when === w)));
  refresh();
}

// ---------------- 時間地図 ----------------

/** 時間地図を始める・やめる（初めて使うときに src/timemap を読み込む） */
async function setTimeMap(on: boolean) {
  const btn = $('#tm-toggle');
  if (on && !state.tm) {
    btn.setAttribute('aria-busy', 'true');
    try {
      const { TimeMap } = await import('./timemap');
      state.tm = await TimeMap.start(
        `${import.meta.env.BASE_URL}data/kanagawa/timemap.json`,
        map.leaflet,
        map.baseTile,
        history.prefs.get<string | null>('tmCenter', null),
        onTimeMapChange,
      );
      map.setBaseVisible(false);
    } catch (e) {
      console.error(e);
      status('時間地図のデータを読み込めませんでした。時間をおいてもう一度お試しください。');
    } finally {
      btn.removeAttribute('aria-busy');
    }
  } else if (!on && state.tm) {
    state.tm.stop();
    state.tm = null;
    state.orig.clear();
    map.setBaseVisible(true);
  }
  btn.setAttribute('aria-pressed', String(!!state.tm));
  history.prefs.set('tm', !!state.tm);
  if (state.tm) history.prefs.set('tmCenter', state.tm.centerName);
  showTimeMapInfo();
  map.closePopup();
  refresh();
}

/** 中心駅が変わったとき */
function onTimeMapChange() {
  if (!state.tm) return;
  history.prefs.set('tmCenter', state.tm.centerName);
  showTimeMapInfo();
  map.closePopup();
  refresh();
}

function showTimeMapInfo() {
  const el = $('#tm-info');
  el.toggleAttribute('hidden', !state.tm);
  if (state.tm)
    el.replaceChildren(
      `🚃 ${state.tm.centerName}駅から電車で（休日の日中の平均・推定）`,
      h('span', { class: 'tm-hint' }, '。駅を押すと中心が変わります'),
    );
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
  // すべてオフのときは、地図が空になった理由が分かるよう地図の中央にお知らせを出す
  const notice = $('#all-off-notice');
  const showNotice = () => notice.toggleAttribute('hidden', !KINDS.every((k) => state.off.has(k.key)));
  const sync = () => {
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(!state.off.has(k)));
    history.prefs.set('off', [...state.off]);
    state.skip.clear();
    showNotice();
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
  $('#all-off-restore').addEventListener('click', () => {
    state.off.clear();
    sync();
  });
  showNotice(); // 前回すべてオフのまま閉じた場合も出す
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
  // タッチ端末では、描画の重いぼかした影を省く（?fx=shadow で付ける）
  if (matchMedia('(pointer: coarse)').matches && !FX.has('shadow')) document.documentElement.classList.add('lite');
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
    const t = map.baseTile;
    state.tm?.setTile(t.url, t.maxNativeZoom);
  });
  $('#tm-toggle').addEventListener('click', () => setTimeMap(!state.tm));
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
  // 前回、時間地図のまま閉じたときは時間地図で始める
  if (history.prefs.get<boolean>('tm', false)) setTimeMap(true);
  else refresh();
}

init();
