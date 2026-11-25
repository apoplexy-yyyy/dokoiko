// イベント一覧の表示
import { dayLabel, type EventHit } from '../discover/events';
import type { EventItem } from '../types';
import { h, safeUrl } from './dom';

export function eventItem(hit: EventHit, onFocus?: (ev: EventItem) => void): HTMLElement {
  const { ev, day, times } = hit;
  const { md, dow } = dayLabel(day);
  const where = [ev.venue, ev.approx ? `${ev.city}（会場は詳細ページへ）` : ev.city].filter(Boolean).join('・');
  const who = ev.target ? `👶 ${ev.target.replace(/,/g, '・')}` : '';
  const li = h(
    'li',
    { class: 'ev', 'data-ev': ev.id },
    h('div', { class: `ev-date${dow === '土' ? ' sat' : dow === '日' ? ' sun' : ''}` }, h('b', {}, md), h('span', {}, dow)),
    h(
      'div',
      { class: 'ev-body' },
      h('a', { class: 'ev-title', href: safeUrl(ev.url), target: '_blank', rel: 'noopener' }, ev.title),
      h('p', { class: 'ev-meta' }, [ev.time ? `🕘 ${ev.time}` : '', times > 1 ? `ほか${times - 1}日` : '', where].filter(Boolean).join('　')),
      who || ev.cost ? h('p', { class: 'ev-meta' }, [who, ev.cost ? `💴 ${ev.cost}` : ''].filter(Boolean).join('　')) : null,
      h('p', { class: 'ev-src' }, `出典：${ev.src}`),
    ),
  );
  if (onFocus && !ev.approx) {
    const btn = h('button', { type: 'button', class: 'ghost-btn ev-pin', 'aria-label': `${ev.title}の場所を地図で見る` }, '📍');
    btn.addEventListener('click', () => onFocus(ev));
    li.append(btn);
  }
  return li;
}

/** 施設カードに載せる「ここで開催予定」 */
export function spotEvents(list: EventItem[]): HTMLElement | null {
  if (!list.length) return null;
  return h(
    'div',
    { class: 'news' },
    h('p', { class: 'news-title' }, '🗓️ ここで開催予定'),
    h(
      'ul',
      {},
      ...list.slice(0, 3).map((ev) => {
        const { md, dow } = dayLabel(ev.dates[0]);
        return h(
          'li',
          {},
          h('a', { href: safeUrl(ev.url), target: '_blank', rel: 'noopener' }, ev.title),
          h('span', { class: 'news-meta' }, `${md}(${dow})${ev.dates.length > 1 ? ` ほか${ev.dates.length - 1}日` : ''}`),
        );
      }),
    ),
  );
}
