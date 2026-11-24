// 収集用のHTTPユーティリティ：汎用User-Agent・ホスト単位のレート制限・リトライ・ディスクキャッシュ
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const UA = 'dokoiko-collector/0.1 (open data prototype; https://github.com/)';
const CACHE_DIR = '.cache/http';
const lastHit = new Map<string, number>();

export interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** キャッシュ有効時間（時間）。0でキャッシュしない */
  ttlHours?: number;
  /** 同一ホストへの最小間隔(ms) */
  intervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  /** 本文の検証。例外を投げるとキャッシュせずリトライ扱いにする */
  validate?: (text: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(host: string, intervalMs: number) {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + intervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const { method = 'GET', body, headers = {}, ttlHours = 24, intervalMs = 1000, retries = 3, timeoutMs = 120_000 } = opts;
  const key = createHash('sha1').update(`${method} ${url} ${body ?? ''}`).digest('hex');
  const file = join(CACHE_DIR, key);

  if (ttlHours > 0) {
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < ttlHours * 3600_000) return await readFile(file, 'utf8');
    } catch {
      /* キャッシュなし */
    }
  }

  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, intervalMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { retryAfter });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      const text = await res.text();
      opts.validate?.(text);
      if (ttlHours > 0) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, text);
      }
      return text;
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      const ra = (e as { retryAfter?: number }).retryAfter ?? 0;
      const backoff = Math.max(ra * 1000, 3000 * 2 ** attempt);
      if (attempt < retries) {
        console.warn(`  retry ${attempt + 1}/${retries} in ${backoff}ms: ${(e as Error).message}`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
