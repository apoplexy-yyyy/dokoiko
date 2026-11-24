import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// ビルド日時（日本時間）。更新されたかどうかを画面で確認できるようにする
const buildTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date());

// 相対パスにしておくと、GitHub Pages のリポジトリ名に依存せず動く
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
});
