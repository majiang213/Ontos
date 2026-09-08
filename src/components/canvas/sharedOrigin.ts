// 画布上的判定留痕投影：现行 = 裁决工作记录（Agent 依证据落的判定，adj_decision 草稿行）；
// 历史 = 旧 class_conclusions 行（部分重叠曾立上位对象的由来虚线，兼容渲染）。不猜 shared_A_B。

import type { ClassConclusion } from "../../server/schema/config";
import { VERDICT_LABELS, Verdict } from "../../server/schema/verdict";
import type { CanvasLink } from "./layout";

export const SHARED_COLOR = "#9a94b8"; // = var(--shared)；SVG marker 不吃 CSS var

/** 判定键 → 展示文案：留痕卡与待定卡的行首标签共用（Tendency 是 Verdict 的子集，同一次查表）。 */
export const verdictLabel = (v: Verdict) => VERDICT_LABELS[v];

const SHARED_KIND = "shared" as const;

/** 判定留痕的统一行：两个类（排序后）+ 判定键；历史行带 shared（曾立上位对象，画由来虚线用）。 */
export interface DecisionRow {
  classes: [string, string];
  verdict: Verdict;
  shared?: string;
}

/** 留痕的统一行：现行 = adj_decision 行（verdict 由引擎按枚举写入，JSON 边界在 CanvasPage 收口为 Verdict）；
 *  历史 = 旧 class_conclusions 行（kind 映射为判定键，overlap 带 shared 供由来虚线与公共对象徽章）。 */
export function decisionRowsOf(
  legacy: ClassConclusion[] | undefined,
  adj: { class_a: string; class_b: string; verdict: Verdict }[] | undefined
): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const r of adj ?? []) rows.push({ classes: [r.class_a, r.class_b].sort() as [string, string], verdict: r.verdict });
  for (const r of legacy ?? []) {
    const verdict = r.kind === "homonym" ? Verdict.NameSimilar : r.kind === "overlap" ? Verdict.Overlap : undefined;
    if (verdict) rows.push({ classes: [...r.classes].sort() as [string, string], verdict, shared: r.shared });
  }
  return rows;
}

/** 历史行的由来虚线（部分重叠曾立上位对象）：只画带 shared 的历史行；新裁决（并入多源类）无边。 */
export function overlapEdgesOf(rows: DecisionRow[]): CanvasLink[] {
  return rows
    .filter((r) => r.verdict === Verdict.Overlap && r.shared)
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
  return l.kind === SHARED_KIND;
}

/** 同形异义：每个类 → 对方类名（一次判定一行，不合成一团）。 */
export function homonymPeerMap(rows: DecisionRow[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    if (r.verdict !== Verdict.NameSimilar) continue;
    for (const name of r.classes) {
      const others = r.classes.filter((c) => c !== name);
      m.set(name, [...new Set([...(m.get(name) ?? []), ...others])].sort());
    }
  }
  return m;
}

/** 节点底部的判定结论芯片（统一「结论 · 对方」格式）：谁、什么结论，一目了然。
 *  类等价合并后对方已并入本类（来源芯片即它），不打芯片；历史 shared_ 上位对象标「公共对象」（兼容渲染）。 */
export interface VerdictChip {
  text: string;
  dashed: boolean; // 虚线 = 两类都留下（同形异义）；实心 = 结构变了（并类 / 时期）
  peer: string | null; // 对方类名（画布上存在时可悬停高亮）
}

export function verdictChipsOf(rows: DecisionRow[], name: string): VerdictChip[] {
  const merged = new Map<string, VerdictChip>();
  for (const r of rows) {
    if (r.shared === name) {
      merged.set("公共对象", { text: "公共对象", dashed: false, peer: null }); // 历史 shared_ 上位对象（ADR 0013 前的旧结论，兼容渲染）
      continue;
    }
    if (!r.classes.includes(name) || r.verdict === Verdict.Same) continue; // 类等价：对方已并入本类，来源芯片即它
    const other = r.classes.find((c) => c !== name);
    if (!other) continue;
    const label =
      r.verdict === Verdict.Overlap
        ? `部分重叠 · ${other}`
        : r.verdict === Verdict.Stage
          ? `生命周期 · ${other}`
          : `同形异义 · ${other}`;
    merged.set(label, { text: label, dashed: r.verdict === Verdict.NameSimilar, peer: other });
  }
  return [...merged.values()];
}
