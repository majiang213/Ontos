// 画布上的类与类结论投影：只画配置 class_conclusions 里还活着的行。不猜 shared_A_B。

import type { ClassConclusion } from "../../server/schema/config";
import { VERDICT_LABELS, Verdict } from "../../server/schema/verdict";
import type { CanvasLink } from "./layout";

export const SHARED_COLOR = "#9a94b8"; // = var(--shared)；SVG marker 不吃 CSS var

const SHARED_KIND = "shared" as const;

/** 部分重叠：每个原类一条由来边，指向上位对象。 */
export function overlapLinksOf(rows: ClassConclusion[]): CanvasLink[] {
  return rows
    .filter((r) => r.kind === "overlap" && r.shared)
    .flatMap((r) =>
      r.classes.map((cls) => ({
        name: `shared:${r.shared}:${cls}`,
        from: cls,
        to: r.shared!,
        description: "公共部分",
        kind: SHARED_KIND,
      }))
    );
}

export function isSharedLink(l: CanvasLink): boolean {
  return l.kind === "shared";
}

/** 同形异义：每个类 → 对方类名（一次裁决一行，不合成一团）。 */
export function homonymPeerMap(rows: ClassConclusion[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "homonym") continue;
    for (const name of row.classes) {
      const others = row.classes.filter((c) => c !== name);
      m.set(name, [...new Set([...(m.get(name) ?? []), ...others])].sort());
    }
  }
  return m;
}

/** 节点头上的裁决结论徽章：这个对象被哪些结论点名——部分重叠的原类、公共对象（部分重叠立出的上位对象）、
 *  生命周期（带自环转化，调用方以 stage 告知）、同形异义。类等价合并后不留痕，不标。 */
export function verdictBadgesOf(rows: ClassConclusion[], name: string, opts?: { stage?: boolean }): string[] {
  const mine = rows.filter((r) => r.classes.includes(name) || r.shared === name);
  const badges: string[] = [];
  if (mine.some((r) => r.kind === "overlap" && r.classes.includes(name))) badges.push(VERDICT_LABELS[Verdict.Overlap]);
  if (mine.some((r) => r.kind === "overlap" && r.shared === name)) badges.push("公共对象");
  if (opts?.stage) badges.push(VERDICT_LABELS[Verdict.Stage]);
  if (mine.some((r) => r.kind === "homonym")) badges.push(VERDICT_LABELS[Verdict.NameSimilar]);
  return badges;
}
