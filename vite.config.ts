import { defineConfig } from 'vite';

// 相対パスにしておくと、GitHub Pages のリポジトリ名に依存せず動く
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
