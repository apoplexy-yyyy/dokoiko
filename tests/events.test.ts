import { describe, expect, it } from 'vitest';
import { eventsInView, whenDays } from '../src/discover/events';
import { attachSpots, fromKawasaki, parseYkDates, venueName } from '../scripts/collect-events';
import type { EventItem, Spot } from '../src/types';

describe('whenDays', () => {
  it('平日なら次の土日、土曜なら土日、日曜なら当日', () => {
    expect(whenDays('weekend', new Date(2026, 10, 25))).toEqual(['2026-11-28', '2026-11-29']); // 水
    expect(whenDays('weekend', new Date(2026, 10, 28))).toEqual(['2026-11-28', '2026-11-29']); // 土
    expect(whenDays('weekend', new Date(2026, 10, 29))).toEqual(['2026-11-29']); // 日
    expect(whenDays('soon', new Date(2026, 10, 25))).toHaveLength(14);
  });
});

describe('eventsInView', () => {
  const ev = (id: string, dates: string[], lat = 35.5, approx = false): EventItem => ({ id, title: id, dates, lat, lon: 139.6, approx, city: 'x', url: 'https://example.com', src: 't' });
  const b = { south: 35.4, north: 35.6, west: 139.5, east: 139.7 };
  it('範囲と日付でしぼり、日付順・会場の分かるもの優先', () => {
    const hits = eventsInView([ev('a', ['2026-11-29']), ev('b', ['2026-11-28'], 35.5, true), ev('c', ['2026-11-28']), ev('d', ['2026-11-28'], 36)], b, ['2026-11-28', '2026-11-29']);
    expect(hits.map((h) => h.ev.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('収集', () => {
  it('横浜市の開催日表記を展開し、長期のものは除く', () => {
    expect(parseYkDates('2026/11/28')).toEqual(['2026-11-28']);
    expect(parseYkDates('2026/11/04,2026/12/02')).toEqual(['2026-11-04', '2026-12-02']);
    expect(parseYkDates('2026/11/28-2026/11/30')).toEqual(['2026-11-28', '2026-11-29', '2026-11-30']);
    expect(parseYkDates('2026/07/11-2026/12/25')).toEqual([]);
  });

  it('住所の後ろの施設名を取り出し、部屋名は除く', () => {
    expect(venueName('川崎市中原区小杉町3丁目600 コスギ 4階 川崎市総合自治会館')).toBe('川崎市総合自治会館');
    expect(venueName('川崎市宮前区宮前平2丁目20-4 宮前市民館')).toBe('宮前市民館');
    expect(venueName('川崎市幸区 第4会議室')).toBeUndefined();
  });

  const kw = (target: string, type1 = '学び・講座') => ({
    title: 'おはなし会', status: '公開中', type1, target, place: '中原区',
    date_list: [{ date: '2026-11-28', time_from: '10:00:00', time_to: '11:00:00', time_ext: '' }],
    event_location: [{ latitude: 35.57, longitude: 139.66, venue_address: '川崎市中原区 中原図書館', place: '中原区' }],
    place_adr: '', place_lat: null, place_lon: null, cost_ext: '', open_url: 'https://example.com/1', rel_list: [], upd_date: '',
  });
  it('川崎市：子供が対象のものだけ、全世代向けはジャンルで判断', () => {
    const e = fromKawasaki(kw('幼児,保護者'), '2026-11-25', '2026-12-31')!;
    expect(e.city).toBe('川崎市中原区');
    expect(e.time).toBe('10:00〜11:00');
    expect(e.venue).toBe('中原図書館');
    expect(fromKawasaki(kw('妊産婦,保護者'), '2026-11-25', '2026-12-31')).toBeNull();
    expect(fromKawasaki(kw('小学生,中学生,高校生,大学生,社会人,高齢者'), '2026-11-25', '2026-12-31')).toBeNull();
    expect(fromKawasaki(kw('指定なし', '遊び'), '2026-11-25', '2026-12-31')).not.toBeNull();
    expect(fromKawasaki(kw('幼児'), '2026-12-01', '2026-12-31')).toBeNull(); // 期間外
  });

  it('会場名に含まれる施設と結び付ける', () => {
    const spot = { id: 'n1', name: '中原図書館', lat: 35.5705, lon: 139.6605, city: '川崎市中原区' } as Spot;
    const other = { id: 'n2', name: '小杉公園', lat: 35.57, lon: 139.66, city: '川崎市中原区' } as Spot;
    const e = fromKawasaki(kw('幼児'), '2026-11-25', '2026-12-31')!;
    attachSpots([e], [other, spot]);
    expect(e.spot).toBe('n1');
  });
});
