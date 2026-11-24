// パイプライン中間ファイル（.work/）の読み書き
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const WORK = '.work';

export async function readWork<T>(name: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(WORK, name), 'utf8')) as T;
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeJson(path: string, data: unknown, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, pretty ? 2 : 0));
}

export const writeWork = (name: string, data: unknown) => writeJson(join(WORK, name), data, true);

export function argLimit(): number | undefined {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
}

import { pathToFileURL } from 'node:url';

/** スクリプトが直接実行されたかどうか */
export const isMain = (metaUrl: string) => !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
