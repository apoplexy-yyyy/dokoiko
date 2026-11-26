// 処理時間の計測（URL に ?perf を付けたときだけ）。地図を動かしたときに、どの処理に何ミリ秒かかったかを画面の下に出す。
// 「コピー」ボタンで、直近の記録と端末の情報をまとめてコピーできる（不具合の報告用）
const on = typeof location !== 'undefined' && /[?&]perf\b/.test(location.search);
let marks: [string, number][] = [];
let start = 0;
/** 直近の記録（新しいものが後ろ） */
const log: string[] = [];
const MAX_LOG = 20;

let box: HTMLElement | undefined;
let text: HTMLElement | undefined;

function ui() {
  if (box) return;
  box = document.createElement('div');
  box.id = 'perf';
  box.style.cssText =
    'position:fixed;left:4px;bottom:4px;z-index:9999;display:flex;gap:6px;align-items:flex-start;background:rgba(0,0,0,.75);color:#fff;font:11px/1.4 monospace;padding:4px 6px;border-radius:6px;max-width:calc(100vw - 8px)';
  text = document.createElement('div');
  text.style.cssText = 'white-space:pre-wrap;pointer-events:none;flex:1;min-width:0';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'コピー';
  btn.style.cssText = 'flex:none;font:inherit;font-weight:700;padding:4px 8px;border:0;border-radius:4px;background:#fff;color:#000;cursor:pointer';
  btn.addEventListener('click', async () => {
    const ok = await copy(report());
    btn.textContent = ok ? 'コピーしました' : 'コピーできません';
    setTimeout(() => (btn.textContent = 'コピー'), 1500);
  });
  box.append(text, btn);
  document.body.append(box);
}

/** 直近の記録＋端末の情報 */
function report(): string {
  return [
    `どこいこ v${__APP_VERSION__} 処理時間（ms）`,
    `端末: ${navigator.userAgent}`,
    `画面: ${innerWidth}x${innerHeight} @${+devicePixelRatio.toFixed(2)}x`,
    ...log,
  ].join('\n');
}

async function copy(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    // 古いブラウザ向け
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function push(line: string) {
  log.push(line);
  if (log.length > MAX_LOG) log.shift();
  ui();
  // 画面には直近3件だけ
  text!.textContent = log.slice(-3).join('\n');
  console.log('[perf]', line);
}

export const perf = {
  on,
  begin() {
    if (!on) return;
    marks = [];
    start = performance.now();
  },
  mark(name: string) {
    if (on) marks.push([name, performance.now()]);
  },
  /** 区切りごとの時間を記録する */
  end(extra = '') {
    if (!on) return;
    let prev = start;
    const parts = marks.map(([n, t]) => {
      const d = t - prev;
      prev = t;
      return `${n} ${d.toFixed(1)}`;
    });
    push(`計 ${(prev - start).toFixed(1)}｜${parts.join('｜')}${extra ? `｜${extra}` : ''}`);
    // 処理のあと、ブラウザが画面を描き終えるまで（配置の計算・描画）。次の次のフレームまでの時間で測る
    const t0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => push(`描画 ${(performance.now() - t0).toFixed(1)}`)));
  },
  /** 単独の処理時間を記録する */
  note(name: string, ms: number) {
    if (on) push(`${name} ${ms.toFixed(1)}`);
  },
};
