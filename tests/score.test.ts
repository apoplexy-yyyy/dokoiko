import { describe, expect, it } from 'vitest';
import { PointIndex, appeal, classify, dedupe, matchNews, toSpot } from '../scripts/lib/score';
import { parseFeed } from '../scripts/collect-news';
import type { Spot } from '../src/types';

const near = { playgrounds: new PointIndex([[35.45, 139.4001]]), toilets: new PointIndex([]) };

describe('classify / toSpot', () => {
  it('より子供向けのカテゴリを優先する', () => {
    expect(classify({ leisure: 'park', tourism: 'zoo' })?.cat).toBe('zoo');
    expect(classify({ shop: 'bakery' })).toBeUndefined();
  });

  it('近くの遊具・無料・屋内を判定する', () => {
    const s = toSpot({ id: 'w1', lat: 35.45, lon: 139.4, tags: { leisure: 'park', name: 'みどり公園' } }, {}, near)!;
    expect(s.cat).toBe('park');
    expect(s.f).toContain('playground');
    expect(s.f).toContain('free');
    expect(s.kid).toBeGreaterThan(0.6);
    const m = toSpot({ id: 'n2', lat: 35.0, lon: 139.0, tags: { tourism: 'museum', name: '郷土資料館', fee: 'yes' } }, {}, near)!;
    expect(m.indoor).toBe(true);
    expect(m.f).not.toContain('free');
  });

  it('名前なし・私有地は除外する', () => {
    expect(toSpot({ id: 'n3', lat: 35, lon: 139, tags: { leisure: 'park' } }, {}, near)).toBeNull();
    expect(toSpot({ id: 'n4', lat: 35, lon: 139, tags: { leisure: 'park', name: '社宅公園', access: 'private' } }, {}, near)).toBeNull();
  });

  it('有名な場所ほど意外性(nov)が低い', () => {
    const tags = { tourism: 'zoo', name: '動物園' };
    const unknown = toSpot({ id: 'n5', lat: 35, lon: 139, tags }, {}, near)!;
    const famous = toSpot({ id: 'n6', lat: 35, lon: 139, tags }, { sitelinks: 40 }, near)!;
    expect(famous.nov).toBeLessThan(unknown.nov);
  });
});

describe('dedupe', () => {
  it('同名で近いものはまとめ、離れていれば残す', () => {
    const mk = (id: string, lat: number): Spot => ({
      id, name: '中央公園', lat, lon: 139.4, cat: 'park', indoor: false, f: [], kid: 0.6, nov: 1, rich: 0.4, apl: 1,
    });
    expect(dedupe([mk('n1', 35.45), mk('w1', 35.4501), mk('w2', 35.5)])).toHaveLength(2);
  });
});

describe('matchNews', () => {
  const spots: Spot[] = [
    { id: 'n1', name: 'こども自然公園', lat: 0, lon: 0, cat: 'park', indoor: false, f: [], kid: 1, nov: 1, rich: 1, apl: 1, city: '横浜市旭区' },
    { id: 'n2', name: '中央公園', lat: 0, lon: 0, cat: 'park', indoor: false, f: [], kid: 1, nov: 1, rich: 1, apl: 1 },
    { id: 'n3', name: '中央公園', lat: 1, lon: 1, cat: 'park', indoor: false, f: [], kid: 1, nov: 1, rich: 1, apl: 1 },
  ];
  it('固有のスポット名と市町村で照合する', () => {
    const r = matchNews(
      spots,
      [
        { title: 'こども自然公園で親子観察会', link: 'a', source: 'x' },
        { title: '中央公園で清掃', link: 'b', source: 'x' },
        { title: '親子で工作体験', link: 'c', source: '平塚市', city: '平塚市' },
        { title: '税の申告について', link: 'd', source: '平塚市', city: '平塚市' },
      ],
      ['横浜市', '平塚市'],
      ['親子', '体験'],
    );
    expect(r.bySpot.n1?.map((n) => n.link)).toEqual(['a']);
    expect(r.bySpot.n2).toBeUndefined(); // 同名が複数あるので照合しない
    expect(r.byCity['平塚市']?.map((n) => n.link)).toEqual(['c']);
  });
});

describe('parseFeed', () => {
  it('RSS 2.0 と Atom を読める', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>A</title><link>https://a</link><pubDate>Tue, 24 Nov 2026 00:05:37 +0900</pubDate></item></channel></rss>`;
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>B</title><link href="https://b"/><updated>2026-11-20T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(rss, 's')[0]).toMatchObject({ title: 'A', link: 'https://a', date: '2026-11-23T15:05:37.000Z' });
    expect(parseFeed(atom, 's')[0]).toMatchObject({ title: 'B', link: 'https://b' });
  });
});

describe('除外ルール', () => {
  it('大学図書館・霊園は除外する', () => {
    expect(toSpot({ id: 'n7', lat: 35, lon: 139, tags: { amenity: 'library', name: '附属図書館' } }, {}, near)).toBeNull();
    expect(toSpot({ id: 'n8', lat: 35, lon: 139, tags: { leisure: 'park', name: '市営霊園' } }, {}, near)).toBeNull();
    expect(toSpot({ id: 'n9', lat: 35, lon: 139, tags: { amenity: 'library', name: '市立中央図書館' } }, {}, near)).not.toBeNull();
  });
});

describe('appeal', () => {
  it('小さな番号付き公園は低く、広い公園や施設は高い', () => {
    expect(appeal('park', '若葉台第三公園', 0.08, {})).toBeLessThan(0.1);
    expect(appeal('park', '県立大池公園', 30, {})).toBe(1);
    expect(appeal('museum', '郷土資料館', undefined, {})).toBe(1);
    const big = toSpot({ id: 'w10', lat: 35, lon: 139, ha: 12.3, tags: { leisure: 'park', name: '大池公園' } }, {}, near)!;
    expect(big.f[0]).toBe('large');
    expect(big.ha).toBe(12.3);
  });
});
