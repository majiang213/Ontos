// ============================================================
// 交集验证 —— 真实实现（文档第 2 节，三层证据链第 2 层）
// 在内存中完成；只返回比率/规则/统计摘要，标识集合不落地。
// ============================================================

import { getTable } from "./sources";
import { pickRule, normalizeWith } from "./normalize";

export interface OverlapEvidence {
  pair: string; // "recruiting.candidate ↔ hr.employee"
  identityField: { a: string; b: string } | null; // 可比对标识列
  rule: string | null; // 命中的归一化规则
  countA: number;
  countB: number;
  intersection: number;
  rate: number | null; // |∩| / min(|A|,|B|)；无可比对标识时为 null
  suggestion: "①" | "②" | "③" | "⑤";
  reason: string;
}

// 候选对两端的标识列猜测：两边各自找"像标识"的列，且规则一致才可比
function guessIdentityColumns(
  aCols: string[],
  aSamples: Record<string, unknown>[],
  bCols: string[],
  bSamples: Record<string, unknown>[],
): { a: string; b: string; rule: string } | null {
  for (const ca of aCols) {
    const ra = pickRule(ca, aSamples.map((r) => r[ca]).slice(0, 20));
    if (!ra) continue;
    for (const cb of bCols) {
      const rb = pickRule(cb, bSamples.map((r) => r[cb]).slice(0, 20));
      if (rb && rb.name === ra.name) return { a: ca, b: cb, rule: ra.name };
    }
  }
  return null;
}

export function analyzePair(
  aConn: string,
  aTable: string,
  bConn: string,
  bTable: string,
  semanticHint: string, // 模拟 LLM 的 schema 语义建议（软证据，先入快照）
): OverlapEvidence {
  const ta = getTable(aConn, aTable);
  const tb = getTable(bConn, bTable);
  const pair = `${aConn}.${aTable} ↔ ${bConn}.${bTable}`;
  const base = { pair, countA: ta.rows.length, countB: tb.rows.length, intersection: 0 };

  // 部门对：标识就是名称列本身，无需归一化规则
  const nameCols = (t: typeof ta) => t.columns.find((c) => /name/i.test(c.name))?.name;
  if (aTable === "department" && bTable === "department") {
    const ca = nameCols(ta)!;
    const cb = nameCols(tb)!;
    const sa = new Set(ta.rows.map((r) => String(r[ca])));
    const inter = tb.rows.filter((r) => sa.has(String(r[cb]))).length;
    const rate = inter / Math.min(ta.rows.length, tb.rows.length);
    return {
      ...base,
      identityField: { a: ca, b: cb },
      rule: "名称精确匹配",
      intersection: inter,
      rate,
      suggestion: rate >= 0.95 ? "①" : "②",
      reason: `交集率 ${(rate * 100).toFixed(0)}%，名称完全一致 → 建议①完全等价`,
    };
  }

  const guess = guessIdentityColumns(
    ta.columns.map((c) => c.name),
    ta.rows,
    tb.columns.map((c) => c.name),
    tb.rows,
  );
  if (!guess) {
    return {
      ...base,
      identityField: null,
      rule: null,
      rate: null,
      suggestion: "⑤",
      reason: `无可比对标识字段；schema 语义（${semanticHint}）仅名字像 → 建议⑤不合并`,
    };
  }

  const ruleA = pickRule(guess.a, ta.rows.map((r) => r[guess.a]))!;
  const setA = new Set(ta.rows.map((r) => normalizeWith(ruleA, r[guess.a])).filter(Boolean));
  const ruleB = pickRule(guess.b, tb.rows.map((r) => r[guess.b]))!;
  const inter = tb.rows.filter((r) => {
    const v = normalizeWith(ruleB, r[guess.b]);
    return v && setA.has(v);
  }).length;
  // 交集率 = |∩| / 较大集合（34% 的 demo 口径）；|∩|/较小集合用于识别④包含关系，V2 再细分
  const rate = inter / Math.max(ta.rows.length, tb.rows.length);

  // 判定：≈0%→⑤；≈100%→①/②；中间值→②/③（demo 数据量小，直接用阈值演示）
  let suggestion: OverlapEvidence["suggestion"];
  let reason: string;
  if (rate <= 0.05) {
    suggestion = "⑤";
    reason = `交集率 ${(rate * 100).toFixed(0)}% ≈ 0 → 建议⑤各自独立`;
  } else if (rate >= 0.95) {
    suggestion = "①";
    reason = `交集率 ${(rate * 100).toFixed(0)}% ≈ 100% → 建议①完全等价（或②，按属性重合度细分）`;
  } else {
    suggestion = "③";
    reason = `交集率 ${(rate * 100).toFixed(0)}% 居中，且 hr.employee 有 status 状态字段 → 建议③生命周期（候选人→员工）`;
  }
  return {
    ...base,
    identityField: { a: guess.a, b: guess.b },
    rule: `${ruleA.label}归一化（去区号/分隔符）`,
    intersection: inter,
    rate,
    suggestion,
    reason,
  };
}
