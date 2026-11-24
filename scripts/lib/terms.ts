// スポットの特徴語（TF-IDF の「単語」）を作る
// - タグ由来：tourism=museum → 「ミュージアム」、natural=waterfall → 「滝」など
// - 名前由来：「〇〇梅林」→「梅」、「じゃぶじゃぶ池」→「水遊び」など
// 同じラベルは同じ語として扱う（滝のタグと名前の「滝」は同じ「滝」）
import terms from '../../config/terms.json' with { type: 'json' };

const tagLabels = Object.entries(terms.tagLabels as Record<string, string>).map(([kv, label]) => {
  const [k, v] = kv.split('=');
  return { k, v, label };
});
const keywords = terms.keywords.map((k) => ({ label: k.label, re: new RegExp(k.re) }));

export function extractTerms(tags: Record<string, string>, name: string, large = false): string[] {
  const out = new Set<string>();
  for (const t of tagLabels) if (tags[t.k] === t.v) out.add(t.label);
  const n = name.normalize('NFKC');
  for (const k of keywords) if (k.re.test(n)) out.add(k.label);
  if (large) out.add('広い公園');
  return [...out];
}

/** IDF = ln(N / df)。小数2桁に丸める */
export function computeIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return new Map([...df].map(([t, c]) => [t, Math.round(Math.log(n / c) * 100) / 100]));
}
