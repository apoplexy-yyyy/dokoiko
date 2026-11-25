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

/** 記録された月の並びを「6〜8月」「5・9月」のように短く */
export function monthsText(m: number[]): string {
  if (!m.length) return '';
  const parts: string[] = [];
  let a = m[0];
  let b = m[0];
  for (const x of [...m.slice(1), NaN]) {
    if (x === b + 1) b = x;
    else {
      parts.push(a === b ? `${a}` : b === a + 1 ? `${a}・${b}` : `${a}〜${b}`);
      a = b = x;
    }
  }
  return parts.join('・') + '月';
}

/** 生きもの観察（GBIF）：見つかった生きものと時期 */
function obsList(s: Spot) {
  if (!s.obs?.length) return null;
  const d = 0.006;
  const poly = `POLYGON((${s.lon - d} ${s.lat - d},${s.lon + d} ${s.lat - d},${s.lon + d} ${s.lat + d},${s.lon - d} ${s.lat + d},${s.lon - d} ${s.lat - d}))`;
  const url = `https://www.gbif.org/occurrence/search?${s.obs.map((o) => `taxon_key=${o.key}`).join('&')}&geometry=${encodeURIComponent(poly)}`;
  return h(
    'div',
    { class: 'news' },
    h('p', { class: 'news-title' }, '🪲 この辺りで見つかった生きもの'),
    h('ul', {}, ...s.obs.slice(0, 6).map((o) => h('li', {}, `${o.ja}`, h('span', { class: 'news-meta' }, [`${o.n}件`, monthsText(o.m)].filter(Boolean).join('・'))))),
    h('p', { class: 'src-note' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, '観察記録：GBIF.org（CC0・CC BY）')),
  );
}

const SRC: Record<string, string> = {
  Overture: '施設情報：Overture Maps（CDLA Permissive 2.0 ほか）',
  神奈川県: '施設情報：神奈川県オープンデータ（CC BY 4.0）',
};

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
      s.ages?.length ? h('p', { class: 'meta' }, `👶 対象：${s.ages.join('・')}`) : null,
      descEl,
      obsList(s),
      spotEvents(ctx.events),
      newsList('📰 この場所の新着', ctx.spotNews),
      newsList('🗓️ このまちの子供向け情報', ctx.cityNews),
      s.hours ? h('p', { class: 'meta' }, `🕘 ${s.hours}`) : null,
      s.vis ? h('p', { class: 'meta' }, `👥 年間 約${s.vis >= 10 ? Math.round(s.vis / 10) : (s.vis / 10).toFixed(1)}万人が訪れる（神奈川県 入込観光客調査）`) : null,
      s.src && SRC[s.src] ? h('p', { class: 'src-note' }, SRC[s.src]) : null,
      h(
        'p',
        { class: 'links' },
        s.cat === 'creature' ? null : h('a', { href: googleSearchUrl(s.name, s.city), target: '_blank', rel: 'noopener' }, '🔍 Google'),
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
