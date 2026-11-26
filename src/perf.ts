// 処理時間の計測（URL に ?perf を付けたときだけ）。地図を動かしたときに、どの処理に何ミリ秒かかったかを画面の下に出す
const on = typeof location !== 'undefined' && /[?&]perf\b/.test(location.search);
let marks: [string, number][] = [];
let start = 0;

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
  /** 区切りごとの時間を表示する */
  end(extra = '') {
    if (!on) return;
    let prev = start;
    const parts = marks.map(([n, t]) => {
      const d = t - prev;
      prev = t;
      return `${n} ${d.toFixed(1)}`;
    });
    const total = (prev - start).toFixed(1);
    let el = document.getElementById('perf');
    if (!el) {
      el = document.createElement('div');
      el.id = 'perf';
      el.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:9999;background:rgba(0,0,0,.75);color:#fff;font:11px/1.4 monospace;padding:4px 6px;border-radius:6px;max-width:96vw;pointer-events:none;white-space:pre-wrap';
      document.body.append(el);
    }
    el.textContent = `計 ${total}ms｜${parts.join('｜')}${extra ? '\n' + extra : ''}`;
    console.log('[perf]', el.textContent);
  },
};
