import './styles.css';
import { DETAIL_ZOOM, loadBounds, loadHighlights, loadMeta, loadNews } from './data/loader';
import { distKm, rankInView, todaySeed, type AreaKeyword } from './discover/pick';
import type { Meta, NewsData, NewsItem, Spot } from './types';
import { renderCard } from './ui/card';
import { $, h, safeUrl } from './ui/dom';
import { history } from './ui/history';
import { CAT } from './ui/labels';
import { DiscoverMap } from './ui/map';

const COUNT = 6;

const state = {
  meta: null as Meta | null,
  here: null as [number, number] | null, // 現在地（取得できたときだけ）
  rainy: false,
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
  const news = await loadNews();
  if (req !== state.req) return; // 古い要求は捨てる

  const { picks, total, keywords } = rankInView(spots, b, {
    count: COUNT,
    rainy: state.rainy,
    seen: state.seenAtLoad,
    skip: state.skip,
    seed: state.seed,
    terms: state.meta.terms,
  });
  state.picks = picks;
  render(picks, total, wide, news, keywords);
  for (const s of picks) history.add('seen', s);
  updateCounts();
}

function render(picks: Spot[], total: number, wide: boolean, news: NewsData | null, keywords: AreaKeyword[]) {
  const box = $('#results');
  box.replaceChildren();
  map.showPicks(picks, (id) => {
    document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  if (!picks.length) {
    box.append(h('p', { class: 'empty' }, state.rainy ? 'この範囲には屋内の候補がありません。地図を広げてみてください。' : 'この範囲には候補がありません。地図を動かすか、縮小してみてください。'));
    return;
  }
  box.append(
    h(
      'p',
      { class: 'results-title' },
      wide ? `${state.meta!.name}のおすすめから ${picks.length} か所` : `この範囲の ${total.toLocaleString()} か所から ${picks.length} か所を発見`,
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
  $<HTMLInputElement>('#rainy').addEventListener('change', (e) => {
    state.rainy = (e.target as HTMLInputElement).checked;
    refresh();
  });
  setupLog();

  const d = new Date(meta.updatedAt);
  $('#updated').textContent = `${meta.name}の ${meta.count.toLocaleString()} か所を収録・データ更新 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  $('#sources').replaceChildren(
    '出典：',
    ...meta.sources.flatMap((s, i) => [i ? '、' : '', h('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener' }, s.name), `（${s.license}）`]),
  );

  updateCounts();
  window.addEventListener('resize', () => map.invalidate());
  // フォント読み込み等でレイアウトが変わった後にタイルを描き直す
  requestAnimationFrame(() => map.invalidate());
  document.fonts?.ready.then(() => map.invalidate());
  refresh();
}

init();
