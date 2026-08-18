// 交集率 —— 候选对两端识别字段（归一化后）的集合重合度 = |∩| / max(|A|, |B|)。
// 只读采样，内存里算，集合算完即弃；落库的只有计数与比率（adj_overlap）。

import type { SourceDriver } from "./driver";
import type { Cls } from "./individual";
import { keyColumn, sourcesOf } from "./individual";
import { pickRule, normalizeWith } from "./normalize";
import type { MetaStore } from "../meta/store";

export interface OverlapResult {
  class_a: string;
  class_b: string;
  norm_rule: string;
  count_a: number;
  count_b: number;
  count_hit: number;
  rate: number;
}

/** 同一规则归一化后算交集。每源只读一次：前 20 条挑规则，全量进集合；值集合算完即弃。 */
export async function computeOverlap(driver: SourceDriver, clsA: Cls, clsB: Cls, meta?: MetaStore): Promise<OverlapResult> {
  const readRaw = async (cls: Cls): Promise<string[][]> => {
    const out: string[][] = [];
    for (const [, entry] of sourcesOf(cls)) {
      const col = keyColumn(cls, entry);
      const rows = await driver.select(entry.connection, entry.table, [col], []);
      out.push(rows.map((r) => r[col]).filter((v) => v != null).map(String));
    }
    return out;
  };
  const rawA = await readRaw(clsA);
  const rawB = await readRaw(clsB);
  const rule = pickRule([...rawA.flat().slice(0, 20), ...rawB.flat().slice(0, 20)]);
  const toSet = (raw: string[][]) => new Set(raw.flat().map((v) => normalizeWith(rule, v)));
  const a = toSet(rawA);
  const b = toSet(rawB);
  let hit = 0;
  for (const v of a) if (b.has(v)) hit++;
  const result: OverlapResult = {
    class_a: clsA.name,
    class_b: clsB.name,
    norm_rule: rule.name,
    count_a: a.size,
    count_b: b.size,
    count_hit: hit,
    rate: Math.max(a.size, b.size) === 0 ? 0 : hit / Math.max(a.size, b.size),
  };
  meta?.recordOverlap(result); // 只落计数与比率；值集合随函数返回即弃
  return result;
}
