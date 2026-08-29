// 画布上的类与类结论投影：只画配置 class_conclusions 里还活着的行。不猜 shared_A_B。

import type { ClassConclusion } from "../../server/schema/config";
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
