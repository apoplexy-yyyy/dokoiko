# どこいこ（神奈川県プロトタイプ）

「今日、子供とどこに行こう？」——行き先が決まっていない休日に、**近所にあるのに知らなかった場所**を偶然発見するための静的Webアプリです。
検索条件を入れて探すのではなく、地図を動かすと、表示している範囲から子供と行ける場所を6か所、重み付きランダムで提示します。

## しくみ

```
GitHub Actions（毎週土曜）
  ①  OpenStreetMap (Overpass) … 公園・遊び場・博物館・水辺・児童館・道の駅など＋遊具/トイレの位置・公園の広さ
  ②' Wikidata 照合            … wikidataタグのないスポットを、県内の項目と名前＋位置で結び付け
  ②  Wikidata                 … 説明文・画像・公式サイト・知名度(sitelink数)
  ③  Wikipedia(ja)            … 記事冒頭の要約
  ④  Wikimedia Commons        … 画像サムネイル・作者・ライセンス
  ④' Commons 位置検索         … 写真のない施設の近くで撮られ、ファイル名に施設名を含む写真
  ⑤  自治体RSS 等              … 新着・イベント情報（スポット名/市町村で照合）
        ↓ build-data（スコアリング・重複除去・0.05°タイル分割・広域用おすすめ抽出）
  public/data/kanagawa/{meta.json, news.json, highlights.json, tiles/*.json}
        ↓ vite build
GitHub Pages（広域表示は highlights.json、拡大時は表示範囲のタイルだけを読む）
```

### 発見ロジック（`src/discover/pick.ts`）

重み = 子供向け度 × 行く価値（公園は広さ）× 意外性（有名すぎない）× 情報の充実度 × 未発見ボーナス
- 地図の表示範囲が変わるたびに選び直す（ボタン操作なし）
- 乱数は「日付＋スポットID」から決まるので、同じ日に地図を少し動かしても候補は入れ替わらず、日が変わると顔ぶれが変わる
- ジャンルを4グループ（公園・遊び場／自然・水辺・眺め／学び／生きもの・あそび・直売）に分け、目安の割合で枠を配る
- 以前に表示した場所はブラウザに記録し、次に開いたときは出にくくする
- 「雨の日」は屋内施設だけから選ぶ

## 開発

```powershell
npm install
npm run dev          # http://localhost:5173
npm test             # 単体テスト
npm run build        # dist/ に出力
```

### データ収集

```powershell
npm run collect                  # すべて（OSMは数十分かかることがあります）
npm run collect -- --skip-osm    # OSM取得を省略して ②〜⑤＋統合だけ
npm run build:data               # .work/ の中間データから再出力だけ
```

- HTTP結果は `.cache/` にキャッシュされます（Overpass 20時間、Wikimedia 6日、Commons位置検索 13日、RSS 6時間）
- OSM取得に失敗した場合は公開データを更新しません。②〜⑤の失敗はスキップして続行します

### 設定

| ファイル | 内容 |
| --- | --- |
| `config/region.json` | 対象地域（ISO 3166-2コード、範囲、タイルサイズ） |
| `config/categories.json` | 収集するOSMタグとカテゴリ・子供向け基礎点・屋内フラグ |
| `config/feeds.json` | 新着情報のRSS/Atom、子供向けキーワード、Google News設定 |

## GitHub Pages で公開

1. GitHub にリポジトリを作成して push（`main` ブランチ）
2. Settings → Pages → Source を **GitHub Actions** に設定
3. Actions の「データ収集（週次）」を手動実行すると、データ更新後に自動でデプロイされます

## データの出典とライセンス

- 地図・施設データ：© OpenStreetMap contributors（ODbL）
- Wikidata（CC0）／Wikipedia（CC BY-SA 4.0、要約に記事リンクを併記）
- 画像：Wikimedia Commons（各ファイルの作者・ライセンスをカード上に表示）
- 新着情報：各自治体サイト（タイトル・日付・リンクのみ保存し、本文は転載しない）

> **Google News RSS について**：フィードの利用規約が「個人・非商用のフィードリーダー用途」に限定されているため、`config/feeds.json` で既定は無効（`googleNews.enabled: false`）にしています。公開サイトや事業化で使う場合は、利用条件を確認してください。

## 今後の拡張アイデア

- 対象地域の追加（`region.json` を複数化し、都道府県別に出力）
- 季節（花・紅葉・水遊び）や天気予報との連動
- 自治体オープンデータ（公園台帳・子育て施設一覧）の取り込み
