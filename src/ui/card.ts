// 発見カード：行ってみたくなる情報（写真・特徴・説明・新着）と行動ボタン
import type { EventItem, NewsItem, Spot } from '../types';
import { spotEvents } from './events';
import { h, safeUrl } from './dom';
import { history } from './history';
import { CAT, FEAT, googleSearchUrl, travelText } from './labels';

export interface CardContext {
  index: number;
  distKm?: number;
  distFrom: string;
  /** このスポットの特徴語（珍しいものだけ） */
  tags: string[];
  isNew: boolean;
  spotNews: NewsItem[];
  cityNews: NewsItem[];
  /** この施設で開催予定のイベント */
  events: EventItem[];
  onReplace: () => void;
  onFocus: () => void;
  onChange: () => void;
}

const fmtDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function newsList(title: string, items: NewsItem[]) {
  if (!items.length) return null;
  return h(
    'div',
    { class: 'news' },
    h('p', { class: 'news-title' }, title),
    h(
      'ul',
      {},
      ...items.slice(0, 3).map((n) =>
        h(
          'li',
          {},
          h('a', { href: safeUrl(n.link), target: '_blank', rel: 'noopener' }, n.title),
          h('span', { class: 'news-meta' }, [fmtDate(n.date), n.source].filter(Boolean).join('・')),
        ),
      ),
    ),
  );
}

export function renderCard(s: Spot, ctx: CardContext): HTMLElement {
  const c = CAT[s.cat];
  const img = s.img && safeUrl(s.img.url);

  const media = h(
    'div',
    { class: 'card-media', style: `--c:${c.color}` },
    img
      ? h('img', { src: img, alt: s.name, loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('span', { class: 'card-emoji', 'aria-hidden': 'true' }, c.icon),
    h('span', { class: 'card-num' }, String(ctx.index + 1)),
    ctx.isNew ? h('span', { class: 'card-new' }, 'はじめて') : null,
  );
  if (img && s.img)
    media.append(
      h(
        'a',
        { class: 'credit', href: safeUrl(s.img.page), target: '_blank', rel: 'noopener' },
        ['📷', s.img.artist, s.img.license].filter(Boolean).join(' '),
      ),
    );

  const desc = s.wp?.extract ?? s.desc;
  const descEl = desc
    ? h(
        'p',
        { class: 'desc' },
        desc,
        s.wp
          ? h(
              'a',
              {
                class: 'src',
                href: `https://ja.wikipedia.org/wiki/${encodeURIComponent(s.wp.title)}`,
                target: '_blank',
                rel: 'noopener',
              },
              ' Wikipedia',
            )
          : null,
      )
    : h('p', { class: 'desc muted' }, `${c.label}。まだあまり知られていない場所かもしれません。行ってみて確かめよう！`);

  const wantBtn = h('button', { type: 'button', class: 'act', 'aria-pressed': String(history.has('want', s.id)) }, '⭐ 行ってみたい');
  const wentBtn = h('button', { type: 'button', class: 'act', 'aria-pressed': String(history.has('went', s.id)) }, '✅ 行った');
  wantBtn.addEventListener('click', () => {
    wantBtn.setAttribute('aria-pressed', String(history.toggle('want', s)));
    ctx.onChange();
  });
  wentBtn.addEventListener('click', () => {
    wentBtn.setAttribute('aria-pressed', String(history.toggle('went', s)));
    ctx.onChange();
  });
  const replaceBtn = h('button', { type: 'button', class: 'act subtle' }, '🔄 ほかの場所');
  replaceBtn.addEventListener('click', ctx.onReplace);

  const card = h(
    'article',
    { class: 'card', 'data-id': s.id, style: `--c:${c.color}` },
    media,
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'card-kicker' }, h('span', { class: 'cat' }, `${c.icon} ${c.label}`), ctx.distKm != null ? h('span', {}, `${ctx.distFrom}${travelText(ctx.distKm)}`) : null),
      h('h3', {}, s.name),
      ctx.tags.length ? h('p', { class: 'tags' }, ...ctx.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))) : null,
      s.city ? h('p', { class: 'city' }, s.city) : null,
      s.f.length ? h('ul', { class: 'feats' }, ...s.f.map((f) =>
              h('li', {}, `${FEAT[f].icon} ${FEAT[f].label}${f === 'large' && s.ha ? `（約${s.ha}ha）` : ''}`),
            )) : null,
      descEl,
      spotEvents(ctx.events),
      newsList('📰 この場所の新着', ctx.spotNews),
      newsList('🗓️ このまちの子供向け情報', ctx.cityNews),
      s.hours ? h('p', { class: 'meta' }, `🕘 ${s.hours}`) : null,
      h(
        'p',
        { class: 'links' },
        h('a', { href: googleSearchUrl(s.name, s.city), target: '_blank', rel: 'noopener' }, '🔍 Google'),
        h(
          'a',
          { href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`, target: '_blank', rel: 'noopener' },
          '🧭 行き方',
        ),
        h(
          'a',
          { href: `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[s.id[0]]}/${s.id.slice(1)}`, target: '_blank', rel: 'noopener' },
          '🗺️ OSM',
        ),
        safeUrl(s.web) ? h('a', { href: safeUrl(s.web), target: '_blank', rel: 'noopener' }, '🔗 公式サイト') : null,
      ),
      h('div', { class: 'actions' }, wantBtn, wentBtn, replaceBtn),
    ),
  );
  media.addEventListener('click', ctx.onFocus);
  return card;
}
