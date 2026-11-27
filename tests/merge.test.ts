import { describe, expect, it } from 'vitest';
import { normName, parkKey, sameFacility, sameName } from '../scripts/lib/merge';
import { aggregate } from '../scripts/collect-gbif';
import { cityOfAddress, parseCsv } from '../scripts/collect-pref';
import { monthsText } from '../src/ui/card';

describe('名前の照合', () => {
  it('接頭辞・かっこ・空白をそろえて同じ施設とみなす', () => {
    expect(normName('横浜市立 金沢動物園≪公式≫')).toBe('金沢動物園');
    expect(sameName('よこはま動物園（ズーラシア）', 'よこはま動物園ズーラシア')).toBe(true);
    expect(sameName('横浜市立野毛山動物園', '野毛山動物園')).toBe(true);
    expect(sameName('大島こどもセンター', '城山こどもセンター')).toBe(false);
    expect(sameName('金沢図書館', '金沢動物園')).toBe(false);
  });
});

describe('GBIF の集計', () => {
  it('1km 升目ごとに生きものと月をまとめる', () => {
    const cells = aggregate([
      { ja: 'カブトムシ', key: 1, occ: { decimalLatitude: 35.4501, decimalLongitude: 139.4001, month: 7, license: 'CC0_1_0' } },
      { ja: 'カブトムシ', key: 1, occ: { decimalLatitude: 35.4502, decimalLongitude: 139.4002, month: 8 } },
      { ja: 'カワセミ', key: 2, occ: { decimalLatitude: 35.4503, decimalLongitude: 139.4003, month: 1 } },
      { ja: 'カワセミ', key: 2, occ: { decimalLatitude: 35.6, decimalLongitude: 139.6 } },
    ]);
    expect(cells).toHaveLength(2);
    const a = cells.find((c) => c.sp.length === 2)!;
    expect(a.sp[0]).toMatchObject({ ja: 'カブトムシ', n: 2, months: [7, 8] });
  });
  it('月の並びを短く書く', () => {
    expect(monthsText([6, 7, 8])).toBe('6〜8月');
    expect(monthsText([5, 9])).toBe('5・9月');
    expect(monthsText([1, 2, 7])).toBe('1・2・7月');
  });
});

describe('CSV', () => {
  it('引用符・カンマ・改行を含むセルを読む', () => {
    expect(parseCsv('﻿a,b\n"x,1","y""z"\r\n')).toEqual([['a', 'b'], ['x,1', 'y"z']]);
  });
});

describe('県の公園・おむつ替えの照合', () => {
  it('公園は一字違いの別の公園を同じとみなさない', () => {
    expect(parkKey('美しが丘第九公園')).not.toBe(parkKey('美しが丘第八公園'));
    expect(parkKey('県立 四季の森公園')).toBe(parkKey('四季の森公園'));
    expect(parkKey('はやま三ヵ岡山緑地')).toBe(parkKey('はやま三ヶ岡山緑地'));
  });
  it('所在地から区・市町村を取り出す', () => {
    expect(cityOfAddress('神奈川県横浜市泉区下飯田町5-5')).toBe('横浜市泉区');
    expect(cityOfAddress('神奈川県足柄上郡開成町吉田島1')).toBe('開成町');
    expect(cityOfAddress('神奈川県厚木市中町3-17-17')).toBe('厚木市');
  });
  it('おむつ替えの施設は名前がほぼ同じものだけ', () => {
    expect(sameFacility('よこはま動物園ズーラシア', '横浜市立よこはま動物園ズーラシア')).toBe(true);
    expect(sameFacility('はまぎん　こども宇宙科学館', 'はまぎんこども宇宙科学館')).toBe(true);
    expect(sameFacility('大口駅前薬局', '大口駅前公園')).toBe(false);
    expect(sameFacility('そごう横浜店', 'そごう美術館')).toBe(false);
  });
});
