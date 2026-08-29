// 疑似重复串 —— 「裁完这一对之后，还该拿谁来比」（《ontos-article.md》§3.2、ADR 0005）。
// 清单上的对是牵线。类等价/生命周期把被并掉的类改写成留下的类；部分重叠不新增与公共对象的对；
// 同形异义/跳过不改清单（定案过滤在读时套）。上一对的结论不写进下一对。

import { Verdict, type PairAdvice } from "../../schema/verdict";
import { pairKey } from "./eligibility";

/** 按刚裁的这一对改写还没问完的对。proposals 是裁之前快照里的清单（含刚裁的这一对）。
 *  decided 用 pairKey：已定案的牵线不改写成新对（跳过仍留在快照里，放弃裁决能回来；并入时不把已拿掉的线改名再问）。 */
export function rewriteAfterVerdict(
  proposals: PairAdvice[],
  class_a: string,
  class_b: string,
  verdict: Verdict,
  decided: Set<string>
): PairAdvice[] {
  if (verdict === Verdict.NameSimilar || verdict === Verdict.Skip) {
    return proposals; // 牵线还在快照里，读时过滤；放弃未发布裁决后还能回来
  }
  if (verdict === Verdict.Overlap) {
    return proposals; // 两类都还在；公共对象不跟每个类成对。刚裁的那一对读时过滤
  }
  // 类等价 / 生命周期：class_b 并进 class_a。已定案的牵线不改名（跳过的 B–C 不变成 A–C）
  const seen = new Set<string>();
  const out: PairAdvice[] = [];
  for (const p of proposals) {
    const orig = pairKey(p.class_a, p.class_b);
    if (decided.has(orig)) continue;
    const a = p.class_a === class_b ? class_a : p.class_a;
    const b = p.class_b === class_b ? class_a : p.class_b;
    if (a === b) continue;
    const k = pairKey(a, b);
    if (seen.has(k) || decided.has(k)) continue;
    seen.add(k);
    if (a === p.class_a && b === p.class_b) {
      out.push(p);
      continue;
    }
    out.push({ class_a: a, class_b: b, tendency: p.tendency, reason: "并完之后还该问这一对，按三问定案", pending: true });
  }
  return out;
}
