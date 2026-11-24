// 小さなDOMヘルパー。データ由来の文字列は必ず textContent で入れる（HTMLとして解釈しない）
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** http(s) のURLだけを許可 */
export const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);
