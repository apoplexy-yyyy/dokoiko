// 発見カード：行ってみたくなる情報（写真・特徴・説明・新着）とリンク
import type { EventItem, NewsItem, Spot } from '../types';
import { spotEvents } from './events';
import { h, safeUrl } from './dom';
import { CAT, FEAT, googleSearchUrl } from './labels';

export interface CardContext {
  /** 番号（0始まり）。負なら番号を出さない */
  index: number;
  /** このスポットの特徴語（珍しいものだけ） */
  tags: string[];
  spotNews: NewsItem[];
  cityNews: NewsItem[];
  /** この施設で開催予定のイベント */
  events: EventItem[];
  onFocus: () => void;
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
    ctx.index >= 0 ? h('span', { class: 'card-num' }, String(ctx.index + 1)) : null,
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
    : null; // 説明が無ければ何も出さない

  const card = h(
    'article',
    { class: 'card', 'data-id': s.id, style: `--c:${c.color}` },
    media,
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'card-kicker' }, h('span', { class: 'cat' }, `${c.icon} ${c.label}`)),
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
        safeUrl(s.web) ? h('a', { href: safeUrl(s.web), target: '_blank', rel: 'noopener' }, '🔗 公式サイト') : null,
      ),
    ),
  );
  media.addEventListener('click', ctx.onFocus);
  return card;
}
