// 裁决流水线 —— 疑似重复的三步（建议 → 交集率 → 定案）唯一入口。
// 资格谓词在 eligibility.ts；本模块编排定案集合、闸、槽位、留痕。路由只做解析与 JSON。

import type { ObjectType } from "../../schema/config";
import { metaStore } from "../../meta/store";
import { getDraft } from "../draft/current";
import { adjudicate, type Verdict } from "./adjudicate";
import { connectionsOf, hasSources, isCrossSource, pairEligible, pairKey, SAME_SOURCE_OK_VERDICTS } from "./eligibility";
import { EngineReject } from "../../errors";
import { mustCls } from "../query/individual";
import { getDriverRegistry } from "../infra/load";
import { getSlot } from "../llmSlot";
import { type PairAdvice } from "./verdict";
import { overlapRate, type OverlapResult } from "./overlap";
import { DEFAULT_WS } from "../infra/workspace";

export type { PairAdvice, OverlapResult };

function sharedSourcesMsg(a: ObjectType, b: ObjectType): string {
  const shared = [...connectionsOf(a)].filter((c) => connectionsOf(b).has(c));
  return `这两个对象有共同来源（${shared.join("、")}），不算疑似重复`;
}

/** 已上画布的跨源候选对：槽位给倾向，资格闸复核。已放弃的裁决（version=-1）不算定案。 */
export async function listCandidates(ws: string = DEFAULT_WS): Promise<PairAdvice[]> {
  const d = (await getDraft(ws)).draft;
  const decided = new Set(
    (await metaStore().listDecisions(ws)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
  );
  const classes = Object.entries(d.object_types)
    .filter(([, t]) => hasSources(t))
    .map(([name, t]) => ({
      name,
      sources: [...connectionsOf(t)].sort(),
      fields: Object.keys(t.properties),
    }));
  const byName = new Map(Object.entries(d.object_types));
  const advices = await getSlot().proposePairs(classes);
  return advices.filter((p) => {
    const a = byName.get(p.class_a);
    const b = byName.get(p.class_b);
    return Boolean(a && b && pairEligible(a, b, decided, p.class_a, p.class_b));
  });
}

/** 两端识别字段归一化后的集合重合度。无源 / 同源 / 缺识别字段拒绝。不收已定案闸——证据允许重算。 */
export async function computeOverlap(ws: string, class_a: string, class_b: string): Promise<OverlapResult> {
  const d = (await getDraft(ws)).draft;
  const a = mustCls(d, class_a);
  const b = mustCls(d, class_b);
  if (!hasSources(a.def) || !hasSources(b.def)) {
    throw new EngineReject("无源对象不算疑似重复（先给它挂来源）");
  }
  if (!isCrossSource(a.def, b.def)) {
    throw new EngineReject(sharedSourcesMsg(a.def, b.def));
  }
  if (!a.def.identity || !b.def.identity) {
    throw new EngineReject("两边对不上号：有类没设唯一键");
  }
  return overlapRate(await getDriverRegistry(ws), a, b, metaStore(), ws);
}

export interface DecideInput {
  class_a: string;
  class_b: string;
  verdict: Verdict;
  stage_names?: { from: string; to: string };
  llm_advice?: string;
  evidence?: {
    norm_rule?: string;
    count_a?: number;
    count_b?: number;
    count_hit?: number;
    rate?: number;
  };
  decided_by?: string;
}

/** 人定案：资格闸 → 写草稿 → 留痕。先裁决后留痕，校验回退不留幻影记录。 */
export async function decide(input: DecideInput, ws: string = DEFAULT_WS): Promise<{ ok: true; recorded: boolean }> {
  const d = (await getDraft(ws)).draft;
  const clsA = d.object_types[input.class_a];
  const clsB = d.object_types[input.class_b];
  if (!clsA || !clsB) throw new EngineReject("类不存在，先刷新画布");
  if (!hasSources(clsA) || !hasSources(clsB)) {
    throw new EngineReject("无源对象不进裁决（先给它挂来源）");
  }
  if (!isCrossSource(clsA, clsB) && !SAME_SOURCE_OK_VERDICTS.has(input.verdict)) {
    throw new EngineReject(sharedSourcesMsg(clsA, clsB));
  }
  const sourceOf = (name: string) => Object.keys(d.object_types[name]?.sources ?? {})[0] ?? "";
  const source_a = sourceOf(input.class_a);
  const source_b = sourceOf(input.class_b);
  await adjudicate({ class_a: input.class_a, class_b: input.class_b }, input.verdict, input.stage_names, ws);
  let recorded = true;
  try {
    await metaStore().recordDecision(ws, {
      class_a: input.class_a,
      class_b: input.class_b,
      source_a,
      source_b,
      llm_advice: input.llm_advice,
      rate: input.evidence?.rate,
      evidence: input.evidence,
      verdict: input.verdict,
      decided_by: input.decided_by ?? "画布操作者",
    });
  } catch {
    recorded = false;
  }
  return { ok: true, recorded };
}
