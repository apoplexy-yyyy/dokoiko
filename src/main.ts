import './styles.css';
import { DETAIL_ZOOM, loadBounds, loadEvents, loadHighlights, loadMeta, loadNews } from './data/loader';
import { eventsInView, WHEN_LABEL, whenDays, type EventHit, type When } from './discover/events';
import { distKm, rankInView, todaySeed } from './discover/pick';
import type { EventsData, Meta, NewsData, NewsItem, Spot } from './types';
import { renderCard } from './ui/card';
import { $, h, safeUrl } from './ui/dom';
import { eventItem } from './ui/events';
import { history } from './ui/history';
import { CAT } from './ui/labels';
import { DiscoverMap, type RankedSpot } from './ui/map';

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
  here: null as [number, number] | null, // 現在地（取得できたときだけ）
  rainy: false,
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

function locate() {
  if (!navigator.geolocation) return status('この端末では現在地を取得できません。');
  status('現在地を確認しています…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (!inRegion(lat, lon)) {
        status(`現在地が${state.meta!.name}の外のようです。いまは${state.meta!.name}のみ対応しています。`);
        return;
      }
      state.here = [lat, lon];
      map.setHere(lat, lon);
      map.flyTo(lat, lon, 14);
      status('');
    },
    () => status('現在地を取得できませんでした。地図を動かして探してください。'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

function newsFor(spot: Spot, news: NewsData | null): { spotNews: NewsItem[]; cityNews: NewsItem[] } {
  if (!news) return { spotNews: [], cityNews: [] };
  const cityKey = spot.city ? Object.keys(news.byCity).find((k) => spot.city!.startsWith(k)) : undefined;
  return { spotNews: news.bySpot[spot.id] ?? [], cityNews: cityKey ? news.byCity[cityKey] : [] };
}

/** 場所のピンを押したときの吹き出し（カード） */
function spotPopup(s: Spot): HTMLElement {
  const ref = state.here ?? map.center;
  return renderCard(s, {
    index: -1,
    isNew: !state.seenAtLoad.has(s.id),
    distKm: distKm(ref[0], ref[1], s.lat, s.lon),
    distFrom: state.here ? '現在地から ' : '地図の中心から ',
    tags: (s.t ?? []).map((i) => state.meta!.terms[i]).filter((t) => t && t.idf >= 1.5).map((t) => t.label),
    ...newsFor(s, state.news),
    events: (state.events?.events ?? []).filter((e) => e.spot === s.id),
    onReplace: () => {
      state.skip.add(s.id);
      map.closePopup();
      refresh();
    },
    onFocus: () => {},
    onChange: updateCounts,
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
  const wide = map.zoom < DETAIL_ZOOM;
  const b = map.bounds();
  const loaded = wide ? await loadHighlights() : await loadBounds(state.meta, b);
  const spots = loaded.filter((s) => !isHidden(s) && !state.off.has(s.cat));
  const [news, events] = await Promise.all([loadNews(), loadEvents()]);
  if (req !== state.req) return; // 古い要求は捨てる
  state.news = news;
  state.events = events;

  // イベント（先に置き、場所のピンはそれを避ける）
  const allEvents = events?.events ?? [];
  const hits = state.off.has('event') ? [] : eventsInView(allEvents, b, whenDays(state.when));
  map.showEvents(hits, eventPopup);

  const { picks, others, weights, total, keywords } = rankInView(spots, b, {
    count: COUNT,
    rainy: state.rainy,
    seen: state.seenAtLoad,
    skip: state.skip,
    seed: state.seed,
    terms: state.meta.terms,
  });
  const ranked: RankedSpot[] = [
    ...picks.map((s) => ({ s, w: weights.get(s.id) ?? 0, pick: true })),
    ...others.map((s) => ({ s, w: weights.get(s.id) ?? 0, pick: false })),
  ];
  const shown = map.showSpots(ranked, spotPopup);
  for (const s of picks) history.add('seen', s);
  updateCounts();

  // 地図の下の情報（件数・この範囲の特徴・イベントの有無）
  const info = $('#area-info');
  info.replaceChildren();
  if (!total) {
    if (KINDS.every((k) => state.off.has(k.key))) info.append(h('p', {}, 'すべての種類がオフになっています。右上の「表示する種類」でオンにしてください。'));
    else info.append(h('p', {}, state.rainy ? 'この範囲には屋内の場所がありません。地図を広げてみてください。' : 'この範囲には場所がありません。地図を動かすか、縮小してみてください。'));
  } else {
    info.append(
      h(
        'p',
        {},
        wide ? `${state.meta.name}のおすすめ ${total.toLocaleString()} か所から ${shown} か所を表示` : `この範囲の ${total.toLocaleString()} か所から ${shown} か所を表示`,
        hits.length ? `・${WHEN_LABEL[state.when]}のイベント ${hits.length} 件` : '',
      ),
    );
    if (keywords.length)
      info.append(
        h(
          'p',
          { class: 'area-keywords' },
          h('span', { class: 'area-keywords-label' }, wide ? '県内の特徴' : 'この範囲の特徴'),
          ...keywords.map((k) => h('span', { class: 'kw' }, k.count > 1 ? `${k.label} ${k.count}` : k.label)),
        ),
      );
  }
  if (!state.off.has('event') && !hits.length) {
    const inArea = allEvents.some((e) => e.lat >= b.south && e.lat <= b.north && e.lon >= b.west && e.lon <= b.east);
    const soon = state.when === 'soon' ? [] : eventsInView(allEvents, b, whenDays('soon'));
    const p = h('p', { class: 'hint' }, inArea || !allEvents.length ? `${WHEN_LABEL[state.when]}のイベントはこの範囲にありません。` : 'この範囲のイベント情報はまだありません（いまは川崎市・横浜市のみ）。');
    if (soon.length) {
      const more = h('button', { type: 'button', class: 'link-btn' }, `2週間以内なら ${soon.length} 件 →`);
      more.addEventListener('click', () => setWhen('soon'));
      p.append(' ', more);
    }
    info.append(p);
  }
}

function setWhen(w: When) {
  state.when = w;
  history.prefs.set('when', w);
  $('#when').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.when === w)));
  refresh();
}

function updateCounts() {
  const seen = history.list('seen');
  $('#found-count').textContent = String(seen.length);
  $('#log-count').textContent = String(history.list('want').length + history.list('went').length);
  map.showFound(seen);
}

function setupLog() {
  const dlg = $<HTMLDialogElement>('#log');
  let tab: 'want' | 'went' | 'seen' = 'want';
  const render = () => {
    dlg.querySelectorAll<HTMLButtonElement>('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const list = history.list(tab).slice().reverse();
    const ul = $('#log-list');
    ul.replaceChildren(
      ...(list.length
        ? list.map((s) => {
            const c = CAT[s.cat] ?? CAT.other;
            const li = h(
              'li',
              {},
              h('span', { class: 'log-icon', style: `--c:${c.color}` }, c.icon),
              h('span', { class: 'log-name' }, s.name),
              h('a', { href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`, target: '_blank', rel: 'noopener' }, '行き方'),
            );
            if (tab !== 'seen') {
              const rm = h('button', { type: 'button', class: 'ghost-btn', 'aria-label': `${s.name}を削除` }, '✕');
              rm.addEventListener('click', () => {
                history.remove(tab, s.id);
                render();
                updateCounts();
              });
              li.append(rm);
            }
            return li;
          })
        : [
            h(
              'li',
              { class: 'empty' },
              tab === 'want' ? '「⭐ 行ってみたい」を押した場所がここに並びます。' : tab === 'went' ? '行った場所を記録すると、ここに並びます。' : 'まだ見た場所はありません。',
            ),
          ]),
    );
  };
  $('#open-log').addEventListener('click', () => {
    render();
    dlg.showModal();
  });
  dlg.querySelector('.tabs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
    if (b) {
      tab = b.dataset.tab as typeof tab;
      render();
    }
  });
  const about = $<HTMLDialogElement>('#about');
  $('#open-about').addEventListener('click', () => about.showModal());
  for (const d of [dlg, about])
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
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
    const btn = h('button', { type: 'button', 'data-when': w, 'aria-pressed': String(state.when === w) }, `🗓️ ${WHEN_LABEL[w]}`);
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
  map = new DiscoverMap($('#map'), [start.lat, start.lon], start.z, () => {
    const [lat, lon] = map.center;
    history.prefs.set('view', { lat, lon, z: map.zoom });
    refresh();
  });

  const sel = $<HTMLSelectElement>('#city');
  for (const c of meta.cities) sel.append(h('option', { value: c.name }, c.name));
  sel.addEventListener('change', () => {
    const c = meta.cities.find((x) => x.name === sel.value);
    if (c) map.flyTo(c.lat, c.lon, 13);
  });

  $('#locate').addEventListener('click', locate);
  $<HTMLInputElement>('#rainy').addEventListener('change', (e) => {
    state.rainy = (e.target as HTMLInputElement).checked;
    refresh();
  });
  setupLog();
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

  updateCounts();
  window.addEventListener('resize', () => map.invalidate());
  // フォント読み込み等でレイアウトが変わった後にタイルを描き直す
  requestAnimationFrame(() => map.invalidate());
  document.fonts?.ready.then(() => map.invalidate());
  refresh();
}

init();
