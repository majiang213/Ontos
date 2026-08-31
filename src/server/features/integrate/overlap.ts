// 交集率 —— 候选对两端识别字段（归一化后）的集合重合度 = |∩| / max(|A|, |B|)。
// 编排（资格闸 + 取数）与算率（overlapRate）同住：一个问题一个文件。
// 只读采样，内存里算，集合算完即弃；落库的只有计数与比率（adj_overlap）。

import type { SourceDriver } from "../../infra/driver";
import { EngineReject, MSG, toResult, type Result } from "../../errors";
import { mustCls, keyColumn, sourcesOf, type Cls } from "../query/individual";
import { getDraft } from "../ontology/current";
import { hasSources } from "./eligibility";
import { columnValues, normalizeWith, pickRule } from "./normalize";
import type { EngineEnv } from "../env";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";
import type { MetaStore } from "../../meta/store";

/** 两端识别字段归一化后的集合重合度。无源 / 缺识别字段拒绝。同一库两张表也算。不收已定案闸——证据允许重算。 */
export async function computeOverlap(env: EngineEnv, workspace: string, class_a: string, class_b: string): Promise<Result<OverlapResult>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const a = mustCls(d, class_a);
    const b = mustCls(d, class_b);
    if (!hasSources(a.def) || !hasSources(b.def)) {
      throw new EngineReject(MSG.pairNoSources);
    }
    if (!a.def.identity || !b.def.identity) {
      throw new EngineReject(MSG.pairNoIdentity);
    }
    return overlapRate(await env.getRegistry(workspace), a, b, env.meta, workspace);
  }, (v) => MSG.resultOverlap(v.rate));
}

/** 识别列全量扫的行数上限：交集是内存集合运算，超大表先收窄再算。 */
const MAX_SCAN = 50_000;

export interface OverlapResult {
  class_a: string;
  class_b: string;
  norm_rule: string;
  count_a: number;
  count_b: number;
  count_hit: number;
  rate: number;
  fields: Record<string, string>; // 命中的字段：每边用的唯一键属性名（按类名索引）——留痕证据的「命中的字段」
}

/** 同一规则归一化后算交集。每源只读一次：前 20 条挑规则，全量进集合；值集合算完即弃。 */
export async function overlapRate(driver: SourceDriver, clsA: Cls, clsB: Cls, meta?: MetaStore, workspace = DEFAULT_WORKSPACE): Promise<OverlapResult> {
  const readRaw = async (cls: Cls): Promise<string[][]> => {
    const out: string[][] = [];
    for (const [, entry] of sourcesOf(cls)) {
      const col = keyColumn(cls, entry);
      const rows = await driver.select(entry.connection, entry.table, [col], [], MAX_SCAN + 1); // 多取一行探测超限
      if (rows.length > MAX_SCAN) throw new EngineReject(MSG.identityColumnTooBig(cls.name, MAX_SCAN));
      out.push(columnValues(rows, col)); // 空串不算标识，防幻影交集
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
    fields: {
      [clsA.name]: clsA.def.identity ?? "",
      [clsB.name]: clsB.def.identity ?? "",
    },
  };
  try {
    await meta?.recordOverlap(workspace, result); // 只落计数与比率；值集合随函数返回即弃
  } catch {
    // 留痕失败不挡返回——交集已经算出来了
  }
  return result;
}
