// 公共对象的由来：部分重叠立出的 shared_A_B 怎样在画布上认出两个原类、画成虚线。
// 只读投影：applyVerdict 用同名规则起名（shared_${a}_${b}），这里按名字拆回去。不进配置、不落库。

import type { CanvasLink } from "./layout";

export interface OriginTriple {
  shared: string; // 公共对象（shared_ 前缀）
  a: string;
  b: string;
}

/** 从对象名推导公共对象由来：shared_A_B 且 A、B 都存在即成立。返回按公共对象名排序。 */
export function originTriples(objectNames: string[]): OriginTriple[] {
  const names = new Set(objectNames);
  const out: OriginTriple[] = [];
  for (const n of names) {
    if (!n.startsWith("shared_")) continue;
    const rest = n.slice("shared_".length);
    let best: OriginTriple | null = null;
    for (const a of names) {
      if (a === n || a.startsWith("shared_")) continue;
      if (!rest.startsWith(`${a}_`)) continue;
      const b = rest.slice(a.length + 1);
      if (!b || !names.has(b) || b.startsWith("shared_")) continue;
      if (!best || a.length > best.a.length) best = { shared: n, a, b };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => (x.shared < y.shared ? -1 : x.shared > y.shared ? 1 : 0));
}

const ORIGIN_KIND = "origin" as const;
export const ORIGIN_COLOR = "#9a94b8"; // 淡紫：SVG marker 不吃 CSS var，与描边同值
export const isOriginEdge = (id: string) => id.startsWith("origin:");

/** 一组三元组 → 两条由来边（原类 → 公共对象；反向进 dagre 后公共对象排在上层）。 */
export function originLinksOf(triples: OriginTriple[]): CanvasLink[] {
  return triples.flatMap((t) =>
    [t.a, t.b].map((cls) => ({
      name: `origin:${t.shared}:${cls}`,
      from: cls,
      to: t.shared,
      description: "公共部分",
      kind: ORIGIN_KIND,
    }))
  );
}
