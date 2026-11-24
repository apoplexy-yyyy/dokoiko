// 収集パイプライン一括実行：
// ① OSM → ②' Wikidata照合 → ② Wikidata → ③ Wikipedia → ④ Commons → ④' Commons位置検索 → ⑤ ニュース → 統合
// OSM 取得に失敗した場合は前回の公開データを残して終了する（それ以外の失敗はスキップして続行）
import { collectOsm } from './collect-osm.ts';
import { matchWikidata } from './match-wikidata.ts';
import { enrichWikidata } from './enrich-wikidata.ts';
import { enrichWikipedia } from './enrich-wikipedia.ts';
import { enrichCommons } from './enrich-commons.ts';
import { enrichCommonsGeo } from './enrich-commons-geo.ts';
import { collectNews } from './collect-news.ts';
import { buildData } from './build-data.ts';

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
  await step('統合・出力', buildData, true);
} catch {
  console.error('必須ステップが失敗したため、公開データは更新していません。');
  process.exit(1);
}
