import { describe, expect, it } from 'vitest';
import { osmClosure, pageClosure, webClosure, wikidataClosure, pastClosure, wikipediaClosure } from '../scripts/lib/closed';

describe('閉館・閉業の判定', () => {
  it('公式サイトの閉館のお知らせを見つける', () => {
    expect(pageClosure('TRAIL PARK 海老名は、2026年4月19日をもちまして閉園いたしました。').st).toBe('notice');
    expect(pageClosure('知永古美術館は2025年3月一杯をもちまして一旦閉館').st).toBe('notice');
    expect(pageClosure('長らくのご愛顧ありがとうございました').st).toBe('notice');
    expect(pageClosure('お知らせ e-TRAIL PARK 海老名は、2026年4月19日をもちまして閉園いたしました').note).toMatch(/^e-TRAIL/);
    expect(pageClosure('<p>このドメインは販売中です</p>').st).toBe('parked');
  });
  it('季節の営業終了・本日の受付終了は閉業とみなさない', () => {
    expect(pageClosure('2026年ブルーベリー狩りは、閉園いたしました').st).toBe('ok');
    expect(pageClosure('また梅園もあいにく閉園いたしました').st).toBe('ok');
    expect(pageClosure('８月３１日をもちまして ２０２４年（令和６年）の 営業を終了').st).toBe('ok');
    expect(pageClosure('本日の営業は終了しました').st).toBe('ok');
    expect(pageClosure('今シーズンの営業を終了いたしました').st).toBe('ok');
  });
  it('ページが無いだけでは疑いにしない', () => {
    expect(webClosure({ checked: '2026-11-26', st: 'notfound' })).toBeUndefined();
    expect(webClosure({ checked: '2026-11-26', st: 'notice', note: '閉館しました' })?.level).toBe('suspect');
  });
  it('OSM のタグ', () => {
    expect(osmClosure({ name: 'A館', end_date: '2020-03-31' }, '2026-11-26')?.level).toBe('closed');
    expect(osmClosure({ name: 'A館', end_date: '2030' }, '2026-11-26')).toBeUndefined();
    expect(osmClosure({ name: '鎌倉大谷記念美術館(休館)' })?.level).toBe('suspect');
    expect(osmClosure({ name: '袖が浦プール', description: '2016年度から休止' })?.level).toBe('suspect');
    expect(osmClosure({ name: '箱根ドールハウス美術館', description: '閉鎖された箱根芦之湯フラワーセンターの建物を再利用' })).toBeUndefined();
    expect(osmClosure({ name: 'X', opening_hours: 'Mo-Su 09:00-17:00; We off' })).toBeUndefined();
  });
  it('Wikidata の閉館日', () => {
    expect(wikidataClosure('2021-09-30', '2026-11-26')?.level).toBe('closed');
    expect(wikidataClosure('1869-01-01', '2026-11-26')).toBeUndefined(); // 史跡（箱根関所）
    expect(wikidataClosure('2027-04-01', '2026-11-26')).toBeUndefined();
  });
  it('Wikipedia の説明文', () => {
    expect(wikipediaClosure('施設の老朽化や浄水場の再編に伴い2021年（令和3年）に全面閉館した。', 'museum')?.level).toBe('suspect');
    expect(wikipediaClosure('横浜中華街にあった水族館。2021年11月23日閉館。', 'zoo')?.level).toBe('suspect');
    expect(wikipediaClosure('2023年4月1日から2027年春頃までの予定で休館している。', 'museum')?.level).toBe('suspect');
    // 別の建物の閉館・改修後の再開・史跡は対象外
    expect(wikipediaClosure('2016年3月31日に鎌倉館は閉館。以後は葉山館', 'museum')).toBeUndefined();
    expect(wikipediaClosure('2021年2月より開館以来初の長期休館をしたのち、2024年3月15日に再開', 'museum')).toBeUndefined();
    expect(wikipediaClosure('かつて箱根にあった関所である。', 'history')).toBeUndefined();
    expect(wikipediaClosure('毎月第3月曜と年末年始は休園。入園無料。', 'park')).toBeUndefined();
  });
});

describe('説明文の過去形（〜にあった施設）', () => {
  it('自身の説明文なら閉館として消す', () => {
    expect(pastClosure(['神奈川県横浜市中区の山下埠頭にあった、機動戦士ガンダムを題材とした複合施設'], 'play', true)?.level).toBe('closed');
    expect(pastClosure([undefined, '横浜水道記念館は、横浜市保土ケ谷区にあった、水道をテーマにした博物館（水道記念館）である。'], 'museum', true)?.level).toBe('closed');
  });
  it('別の項目の説明文なら疑いにとどめる', () => {
    expect(pastClosure(['横浜市にあった海事博物館'], 'museum', false)?.level).toBe('suspect');
  });
  it('史跡や、別のものの話は除く', () => {
    expect(pastClosure(['神奈川県小田原市にあった城'], 'museum', true)).toBeUndefined();
    expect(pastClosure(['かつて箱根にあった関所である'], 'museum', true)).toBeUndefined();
    expect(pastClosure(['海軍工廠にあった建物を移築した記念館'], 'museum', true)).toBeUndefined();
    expect(pastClosure(['横浜市にあった競馬場の跡の公園'], 'park', true)).toBeUndefined();
    expect(pastClosure(['横浜市にある水族館'], 'water', true)).toBeUndefined();
  });
});
