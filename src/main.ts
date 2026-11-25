import './styles.css';
import { DETAIL_ZOOM, loadBounds, loadEvents, loadHighlights, loadMeta, loadNews } from './data/loader';
import { eventsInView, WHEN_LABEL, whenDays, type EventHit, type When } from './discover/events';
import { distKm, rankInView, todaySeed, type AreaKeyword } from './discover/pick';
import type { EventItem, EventsData, Meta, NewsData, NewsItem, Spot } from './types';
import { renderCard } from './ui/card';
import { $, h, safeUrl } from './ui/dom';
import { history } from './ui/history';
import { CAT } from './ui/labels';
import { eventItem } from './ui/events';
import { DiscoverMap } from './ui/map';

/** 表示数の選択肢（候補の場所・イベントとも、この数だけ一覧と地図に出す） */
export const COUNTS = [3, 6, 10, 20];

const state = {
  meta: null as Meta | null,
  here: null as [number, number] | null, // 現在地（取得できたときだけ）
  rainy: false,
  count: COUNTS.includes(history.prefs.get<number>('count', 6)) ? history.prefs.get<number>('count', 6) : 6,
  when: history.prefs.get<When>('when', 'weekend'),
  eventsOpen: false,
  picks: [] as Spot[],
  skip: new Set<string>(), // 「ほかの場所」で外したもの
  seenAtLoad: history.ids('seen'), // 起動時点で見たことのある場所（表示中に順位が変わらないよう固定）
  seed: todaySeed(),
  req: 0,
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

/** 地図の表示範囲から候補を選び直して表示する */
async function refresh() {
  if (!state.meta) return;
  const req = ++state.req;
  const wide = map.zoom < DETAIL_ZOOM;
  const b = map.bounds();
  const spots = wide ? await loadHighlights() : await loadBounds(state.meta, b);
  const [news, events] = await Promise.all([loadNews(), loadEvents()]);
  if (req !== state.req) return; // 古い要求は捨てる

  const { picks, total, keywords } = rankInView(spots, b, {
    count: state.count,
    rainy: state.rainy,
    seen: state.seenAtLoad,
    skip: state.skip,
    seed: state.seed,
    terms: state.meta.terms,
  });
  state.picks = picks;
  render(picks, total, wide, news, keywords, events);
  for (const s of picks) history.add('seen', s);
  updateCounts();
}

/** 表示範囲のイベント欄 */
function renderEvents(box: HTMLElement, data: EventsData | null, b: ReturnType<DiscoverMap['bounds']>, wide: boolean) {
  const sec = h('section', { class: 'events', 'aria-label': 'イベント' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'イベントの日付' });
  for (const w of Object.keys(WHEN_LABEL) as When[]) {
    const btn = h('button', { type: 'button', 'aria-pressed': String(state.when === w) }, WHEN_LABEL[w]);
    btn.addEventListener('click', () => {
      state.when = w;
      state.eventsOpen = false;
      history.prefs.set('when', w);
      refresh();
    });
    seg.append(btn);
  }
  const all = data?.events ?? [];
  const hits = eventsInView(all, b, whenDays(state.when));
  sec.append(
    h('div', { class: 'events-head' }, h('h2', { class: 'results-title' }, `🗓️ ${wide ? '' : 'この範囲の'}${WHEN_LABEL[state.when]}のイベント`, hits.length ? h('span', { class: 'count' }, ` ${hits.length}件`) : null), seg),
  );
  // 地図に出すのは一覧に並べた分だけ（多すぎるとラベルで埋まる）
  const shown: EventHit[] = state.eventsOpen ? hits.slice(0, 60) : hits.slice(0, state.count);
  map.showEvents(shown.map((x) => x.ev), (id) => {
    document.querySelector(`.ev[data-ev="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  if (!hits.length) {
    const soon = state.when === 'soon' ? [] : eventsInView(all, b, whenDays('soon'));
    const p = h('p', { class: 'hint' }, all.length && !inAreaWithEvents(all, b) ? 'この範囲のイベント情報はまだありません（いまは川崎市・横浜市のみ）。' : `この範囲には${WHEN_LABEL[state.when]}のイベントがありません。`);
    if (soon.length) {
      const more = h('button', { type: 'button', class: 'link-btn' }, `2週間以内なら ${soon.length} 件 →`);
      more.addEventListener('click', () => {
        state.when = 'soon';
        history.prefs.set('when', 'soon');
        refresh();
      });
      p.append(' ', more);
    }
    sec.append(p);
    box.append(sec);
    return;
  }
  sec.append(
    h(
      'ul',
      { class: 'ev-list' },
      ...shown.map((x) => eventItem(x, (ev: EventItem) => map.highlightEvent(ev.id))),
    ),
  );
  if (hits.length > shown.length) {
    const more = h('button', { type: 'button', class: 'link-btn' }, `ほか ${hits.length - shown.length} 件を見る`);
    more.addEventListener('click', () => {
      state.eventsOpen = true;
      refresh();
    });
    sec.append(more);
  }
  box.append(sec);
}

/** 表示範囲に、イベント情報のある地域（過去・未来を問わず1件でも）が含まれるか */
function inAreaWithEvents(all: EventItem[], b: ReturnType<DiscoverMap['bounds']>) {
  return all.some((e) => e.lat >= b.south && e.lat <= b.north && e.lon >= b.west && e.lon <= b.east);
}

function render(picks: Spot[], total: number, wide: boolean, news: NewsData | null, keywords: AreaKeyword[], events: EventsData | null) {
  const box = $('#results');
  box.replaceChildren();
  renderEvents(box, events, map.bounds(), wide);
  map.showPicks(picks, (id) => {
    document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  if (!picks.length) {
    box.append(h('p', { class: 'empty' }, state.rainy ? 'この範囲には屋内の候補がありません。地図を広げてみてください。' : 'この範囲には候補がありません。地図を動かすか、縮小してみてください。'));
    return;
  }
  box.append(
    h(
      'h2',
      { class: 'results-title' },
      wide ? `📍 ${state.meta!.name}のおすすめから ${picks.length} か所` : `📍 この範囲の ${total.toLocaleString()} か所から ${picks.length} か所を発見`,
    ),
  );
  if (keywords.length)
    box.append(
      h(
        'div',
        { class: 'area-keywords' },
        h('span', { class: 'area-keywords-label' }, wide ? '県内の特徴' : 'この範囲の特徴'),
        ...keywords.map((k) => h('span', { class: 'kw' }, k.count > 1 ? `${k.label} ${k.count}` : k.label)),
      ),
    );
  if (wide) box.append(h('p', { class: 'hint' }, '地図を拡大すると、近所の知らなかった場所が出てきます。'));

  const ref = state.here ?? map.center;
  const grid = h('div', { class: 'cards' });
  picks.forEach((s, i) => {
    const card = renderCard(s, {
      index: i,
      isNew: !state.seenAtLoad.has(s.id),
      distKm: distKm(ref[0], ref[1], s.lat, s.lon),
      distFrom: state.here ? '現在地から ' : '地図の中心から ',
      tags: (s.t ?? []).map((i) => state.meta!.terms[i]).filter((t) => t && t.idf >= 1.5).map((t) => t.label),
      ...newsFor(s, news),
      events: (events?.events ?? []).filter((e) => e.spot === s.id),
      onReplace: () => {
        state.skip.add(s.id);
        refresh();
      },
      onFocus: () => map.highlight(s.id),
      onChange: updateCounts,
    });
    card.addEventListener('mouseenter', () => map.highlight(s.id));
    grid.append(card);
  });
  box.append(grid);
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
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
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
  const countSel = $<HTMLSelectElement>('#count');
  for (const n of COUNTS) countSel.append(h('option', { value: String(n) }, `${n}件`));
  countSel.value = String(state.count);
  countSel.addEventListener('change', () => {
    state.count = Number(countSel.value);
    state.eventsOpen = false;
    history.prefs.set('count', state.count);
    refresh();
  });
  $<HTMLInputElement>('#rainy').addEventListener('change', (e) => {
    state.rainy = (e.target as HTMLInputElement).checked;
    refresh();
  });
  setupLog();

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
