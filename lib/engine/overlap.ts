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

/** 同一规则归一化后算交集。 */
export async function computeOverlap(driver: SourceDriver, clsA: Cls, clsB: Cls, meta?: MetaStore): Promise<OverlapResult> {
  const samples: string[] = [];
  for (const cls of [clsA, clsB]) {
    for (const [, entry] of sourcesOf(cls)) {
      const col = keyColumn(cls, entry);
      const rows = await driver.select(entry.connection, entry.table, [col], []);
      for (const r of rows.slice(0, 20)) {
        const v = r[col];
        if (v != null) samples.push(String(v));
      }
    }
  }
  const rule = pickRule(samples);
  const readSet = async (cls: Cls) => {
    const values = new Set<string>();
    for (const [, entry] of sourcesOf(cls)) {
      const col = keyColumn(cls, entry);
      const rows = await driver.select(entry.connection, entry.table, [col], []);
      for (const r of rows) {
        const v = r[col];
        if (v != null) values.add(normalizeWith(rule, v));
      }
    }
    return values;
  };
  const a = await readSet(clsA);
  const b = await readSet(clsB);
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
