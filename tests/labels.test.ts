import { describe, expect, it } from 'vitest';
import { googleSearchUrl, shortName } from '../src/ui/labels';

describe('shortName', () => {
  it('頭の市名を省くが、名前の一部なら残す', () => {
    expect(shortName('川崎市大戸こども文化センター')).toBe('大戸こども文化センター');
    expect(shortName('相模原市立麻溝こどもセンター')).toBe('麻溝こどもセンター');
    expect(shortName('横浜市電保存館')).toBe('横浜市電保存館');
    expect(shortName('川崎市民プール')).toBe('川崎市民プール');
    expect(shortName('等々力緑地')).toBe('等々力緑地');
  });
  it('Google検索URL', () => {
    expect(googleSearchUrl('市民プール', '平塚市')).toBe('https://www.google.com/search?q=%E5%B8%82%E6%B0%91%E3%83%97%E3%83%BC%E3%83%AB%20%E5%B9%B3%E5%A1%9A%E5%B8%82');
  });
});
