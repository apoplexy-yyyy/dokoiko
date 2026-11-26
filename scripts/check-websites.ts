// ⑪ 公式サイトの確認：つながらない・ページが無い・閉館のお知らせがある・ドメインが売りに出ている、を調べる
// build-data が書き出した公式サイトの一覧（無ければ public/data）を対象に、6日以内に確認したものは飛ばす。結果は .work/web-check.json
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import region from '../config/region.json' with { type: 'json' };
import { isMain, readWork, writeWork } from './lib/work.ts';
import { pageClosure, type WebCheck } from './lib/closed.ts';
import type { Spot } from '../src/types.ts';

const UA = 'Mozilla/5.0 (compatible; dokoiko-collector/0.1; open data prototype)';
const RECHECK_DAYS = 6;
const CONCURRENCY = 8;

/** HTML を文字コードに合わせて読む（Shift_JIS・EUC-JP のサイトも多い） */
function decode(buf: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4000));
  const cs = (contentType?.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(/sjis|shift|ms932|windows-31j/.test(cs) ? 'shift_jis' : cs).decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

export async function checkOne(url: string): Promise<WebCheck> {
  const checked = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (res.status === 404 || res.status === 410) return { checked, st: 'notfound' };
    if (!res.ok) return { checked, st: 'error', note: `HTTP ${res.status}` };
    if (!/html|text/i.test(res.headers.get('content-type') ?? 'text/html')) return { checked, st: 'ok' };
    const buf = await res.arrayBuffer();
    return { checked, ...pageClosure(decode(buf.slice(0, 600_000), res.headers.get('content-type'))) };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? '';
    if (code === 'ENOTFOUND') return { checked, st: 'dns' };
    return { checked, st: 'error', note: code || (e as Error).name };
  }
}

async function publishedUrls(): Promise<string[]> {
  const listed = await readWork<string[]>('websites.json', []); // build-data が書き出した一覧
  if (listed.length) return listed;
  const dir = join('public', 'data', region.id, 'tiles');
  const urls = new Set<string>();
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const spots = JSON.parse(await readFile(join(dir, f), 'utf8')) as Spot[];
    for (const s of spots) if (s.web && /^https?:\/\//.test(s.web)) urls.add(s.web);
  }
  return [...urls];
}

export async function checkWebsites(): Promise<Record<string, WebCheck>> {
  const prev = await readWork<Record<string, WebCheck>>('web-check.json', {});
  const urls = await publishedUrls();
  const limit = Date.now() - RECHECK_DAYS * 86400_000;
  const todo = urls.filter((u) => !prev[u] || Date.parse(prev[u].checked) < limit);
  console.log(`[web] 公式サイト ${urls.length} 件のうち ${todo.length} 件を確認`);
  const out: Record<string, WebCheck> = Object.fromEntries(urls.filter((u) => prev[u]).map((u) => [u, prev[u]]));
  // 同じホストへは同時に1件ずつ
  const byHost = new Map<string, string[]>();
  for (const u of todo) {
    const h = new URL(u).host;
    byHost.set(h, [...(byHost.get(h) ?? []), u]);
  }
  const queues = [...byHost.values()];
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let q = queues.shift(); q; q = queues.shift())
        for (const u of q) {
          const r = await checkOne(u);
          // 一時的な失敗（タイムアウトなど）は前回の結果を残す
          out[u] = r.st === 'error' && prev[u] ? prev[u] : r;
          if (++done % 100 === 0) console.log(`[web] ${done}/${todo.length}`);
          await new Promise((res) => setTimeout(res, 500));
        }
    }),
  );
  await writeWork('web-check.json', out);
  const count: Record<string, number> = {};
  for (const c of Object.values(out)) count[c.st] = (count[c.st] ?? 0) + 1;
  console.log('[web] 結果', count);
  return out;
}

if (isMain(import.meta.url))
  checkWebsites().catch((e) => {
    console.error(e);
    process.exit(1);
  });
