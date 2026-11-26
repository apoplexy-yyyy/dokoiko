// 収集パイプライン一括実行：
// ① OSM → ②' Wikidata照合 → ② Wikidata → ③ Wikipedia → ④ Commons → ④' Commons位置検索 → ⑤ ニュース
// → ⑦ GBIF → ⑧ Overture → ⑨ 神奈川県オープンデータ → ⑩ Wikidata の県内施設 → 統合
// → ⑪ 公式サイトの確認（閉館のお知らせ・つながらないリンク）→ 統合し直し → ⑥ イベント
// OSM 取得に失敗した場合は前回の公開データを残して終了する（それ以外の失敗はスキップして続行）
import { collectOsm } from './collect-osm.ts';
import { matchWikidata } from './match-wikidata.ts';
import { enrichWikidata } from './enrich-wikidata.ts';
import { enrichWikipedia } from './enrich-wikipedia.ts';
import { enrichCommons } from './enrich-commons.ts';
import { enrichCommonsGeo } from './enrich-commons-geo.ts';
import { collectNews } from './collect-news.ts';
import { buildData } from './build-data.ts';
import { collectOverture } from './collect-overture.ts';
import { collectPref } from './collect-pref.ts';
import { collectGbif } from './collect-gbif.ts';
import { collectEvents } from './collect-events.ts';
import { collectFamous, collectWikidata } from './collect-wikidata.ts';
import { collectCoast, collectPlaces } from './collect-coast.ts';
import { checkWebsites } from './check-websites.ts';

async function step(name: string, fn: () => Promise<unknown>, required = false) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error(`✖ ${name}: ${(e as Error).message}`);
    if (required) throw e;
  }
}

const skipOsm = process.argv.includes('--skip-osm');

try {
  if (!skipOsm) await step('OpenStreetMap', collectOsm, true);
  await step('Wikidata 照合', matchWikidata);
  await step('Wikidata', enrichWikidata);
  await step('Wikipedia', enrichWikipedia);
  await step('Wikimedia Commons', enrichCommons);
  await step('Commons 位置検索', enrichCommonsGeo);
  await step('新着・イベント', collectNews);
  await step('Overture Maps', collectOverture);
  await step('神奈川県オープンデータ', collectPref);
  await step('生きもの観察（GBIF）', collectGbif);
  await step('Wikidata の県内施設', collectWikidata);
  await step('Wikidata の全国の有名な施設', collectFamous);
  await step('海岸線', collectCoast);
  await step('地名', collectPlaces);
  await step('統合・出力', buildData, true);
  await step('公式サイトの確認', checkWebsites);
  await step('統合・出力（公式サイトの確認を反映）', buildData, true);
  await step('子供向けイベント', () => collectEvents());
} catch {
  console.error('必須ステップが失敗したため、公開データは更新していません。');
  process.exit(1);
}
