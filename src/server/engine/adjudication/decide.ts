// 定案 —— 「人裁一对会怎样」：资格闸 → 写草稿（applyVerdict 经 mutateDraft 通道）→ 留痕。
// 先裁决后留痕，校验回退不留幻影记录。路由只做解析与 JSON。

import { metaStore } from "../../meta/store";
import { getDraft } from "../draft/current";
import { adjudicate, type Verdict } from "./applyVerdict";
import { hasSources, isCrossSource, SAME_SOURCE_OK_VERDICTS, sharedSourcesMsg } from "./eligibility";
import { EngineReject } from "../../errors";
import { DEFAULT_WS } from "../infra/workspace";

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

/** 人定案：资格闸 → 写草稿 → 留痕。 */
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
