// 施設名の照合用の正規化（merge.ts・fake.ts から使う）
/** 名前の比較用：全角半角・空白・かっこ・「市立」などの接頭辞をそろえる */
export function normName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[≪《].*?[≫》]|公式/g, '')
    .replace(/[\s・･「」『』()（）［］[\]【】〈〉<>"'’`~〜-]/g, '')
    .replace(/^(神奈川県立|県立|横浜市立|川崎市立|相模原市立|[^\s]{1,4}[市町村]立|(横浜|川崎|相模原|横須賀|藤沢|平塚|小田原|茅ヶ崎|鎌倉)市)/, '')
    .toLowerCase();
}
