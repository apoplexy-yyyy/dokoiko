import { describe, expect, it } from 'vitest';
import { isMatch, matchKey } from '../scripts/match-wikidata';
import { titleMatches } from '../scripts/enrich-commons-geo';
import { classify } from '../scripts/lib/score';

describe('Wikidata 照合', () => {
  it('表記ゆれをそろえる', () => {
    expect(matchKey('茅ヶ崎 里山公園（芹沢）')).toBe(matchKey('茅ケ崎里山公園'));
  });
  it('同名は1.5km以内、包含は300m以内で一致', () => {
    expect(isMatch('こども自然公園', 'こども自然公園', 1.2)).toBe(true);
    expect(isMatch('こども自然公園', 'こども自然公園', 2)).toBe(false);
    expect(isMatch('県立四季の森公園', '四季の森公園', 0.2)).toBe(true);
    expect(isMatch('県立四季の森公園', '四季の森公園', 0.5)).toBe(false);
    expect(isMatch('中央公園', '中央', 0.1)).toBe(false); // 短すぎる包含は不可
  });
});

describe('Commons 位置検索', () => {
  it('ファイル名にスポット名（または固有部分）を含む写真だけ採用', () => {
    expect(titleMatches('File:Shikinomori Park 01.jpg', '四季の森公園')).toBe(false);
    expect(titleMatches('File:四季の森公園の池.jpg', '四季の森公園')).toBe(true);
    expect(titleMatches('File:四季の森 2019.jpg', '四季の森公園')).toBe(true);
    expect(titleMatches('File:駅前の風景.jpg', '公園')).toBe(false);
  });
});

describe('名前条件つきカテゴリ', () => {
  it('児童館という名前の community_centre だけ拾う', () => {
    expect(classify({ amenity: 'community_centre', name: '〇〇児童館' })?.cat).toBe('play');
    expect(classify({ amenity: 'community_centre', name: '〇〇地区センター' })).toBeUndefined();
    expect(classify({ highway: 'rest_area', name: '道の駅 山北' })?.cat).toBe('farm');
  });
});
