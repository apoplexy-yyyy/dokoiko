import { describe, expect, it } from 'vitest';
import { fameKey, misplacedFamous, type Famous } from '../scripts/lib/fake';

const famous: Famous[] = [
  { q: 'Q1', name: '東京ディズニーランド', lat: 35.6328, lon: 139.8806, sitelinks: 40 },
  { q: 'Q2', name: '鴨川シーワールド', lat: 35.1161, lon: 140.1206, sitelinks: 7 },
  { q: 'Q3', name: '新江ノ島水族館', lat: 35.3097, lon: 139.4799, sitelinks: 3 },
  { q: 'Q4', name: '横浜アンパンマンこどもミュージアム', lat: 35.4631, lon: 139.6287, sitelinks: 4 },
  { q: 'Q5', name: '神戸アンパンマンこどもミュージアム&モール', lat: 34.6786, lon: 135.185, sitelinks: 4 },
  { q: 'Q6', name: '宇都宮こども動物園', lat: 36.6, lon: 139.9, sitelinks: 3 },
  { q: 'Q7', name: '横浜市立金沢動物園', lat: 35.3297, lon: 139.6181, sitelinks: 3 },
  { q: 'Q8', name: '河口湖', lat: 35.5167, lon: 138.75, sitelinks: 20 },
  { q: 'Q9', name: '夢の島熱帯植物館', lat: 35.6489, lon: 139.8236, sitelinks: 3 },
];
const KAWASAKI = [35.5287, 139.697] as const;

describe('有名な施設の名前を借りた場所', () => {
  it('表記ゆれをそろえる', () => {
    expect(fameKey('鴨川シーワルド')).toBe(fameKey('鴨川シーワールド'));
    expect(fameKey('新江之島水族館')).toBe(fameKey('新江ノ島水族館'));
  });

  it('本物が遠くにしか無ければ見つける', () => {
    expect(misplacedFamous('ディズニーランド', ...KAWASAKI, famous)?.q).toBe('Q1');
    expect(misplacedFamous('鴨川シーワルド', ...KAWASAKI, famous)?.q).toBe('Q2');
    expect(misplacedFamous('新江之島水族館', 35.4871, 139.6222, famous)?.q).toBe('Q3');
    expect(misplacedFamous('横浜市立 金沢動物園≪公式≫', 35.4431, 139.6445, famous)?.q).toBe('Q7');
    expect(misplacedFamous('河口湖', 35.5543, 139.6395, famous)?.q).toBe('Q8');
  });

  it('本物の近くや、近くに同じ名前の施設があるものは残す', () => {
    expect(misplacedFamous('新江ノ島水族館', 35.3096, 139.4799, famous)).toBeUndefined();
    expect(misplacedFamous('アンパンマンこどもミュージアム', 35.4635, 139.629, famous)).toBeUndefined();
  });

  it('一般的な短い名前では消さない', () => {
    expect(misplacedFamous('こども動物園', ...KAWASAKI, famous)).toBeUndefined();
    expect(misplacedFamous('水族館', ...KAWASAKI, famous)).toBeUndefined();
    expect(misplacedFamous('熱帯植物館', 35.2491, 139.0454, famous)).toBeUndefined(); // 強羅公園の温室
  });
});
