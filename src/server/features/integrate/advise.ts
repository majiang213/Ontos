// 看过交集率之后的倾向 —— 硬证据进整合槽位，再给一句建议。
// 模型当顾问不当计算器：比率由 overlap 算好传入；本文件只做资格闸 + 把两个类的字段交给槽位。

import type { EngineEnv } from "../env";
import { getDraft } from "../ontology/current";
import { mustCls } from "../query/individual";
import { connectionsOf, hasSources, isCrossSource, sharedSourcesMsg } from "./eligibility";
import { EngineReject, MSG, toResult, type Result } from "../../errors";
import { VERDICT_LABELS, type PairAdvice } from "../../schema/verdict";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";

export interface OverlapEvidence {
  rate: number;
  count_a: number;
  count_b: number;
  count_hit: number;
}

/** 看过交集率之后，对这一对再给倾向。无源 / 同源 / 缺唯一键拒绝——和算交集率同一道闸。 */
export async function proposePair(
  env: EngineEnv,
  workspace: string = DEFAULT_WORKSPACE,
  class_a: string,
  class_b: string,
  overlap: OverlapEvidence
): Promise<Result<PairAdvice>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const a = mustCls(d, class_a);
    const b = mustCls(d, class_b);
    if (!hasSources(a.def) || !hasSources(b.def)) {
      throw new EngineReject(MSG.pairNoSources);
    }
    if (!isCrossSource(a.def, b.def)) {
      throw new EngineReject(sharedSourcesMsg(a.def, b.def));
    }
    if (!a.def.identity || !b.def.identity) {
      throw new EngineReject(MSG.pairNoIdentity);
    }
    const advice = await env.llm.proposePair({
      class_a: { name: a.name, sources: [...connectionsOf(a.def)].sort(), fields: Object.keys(a.def.properties) },
      class_b: { name: b.name, sources: [...connectionsOf(b.def)].sort(), fields: Object.keys(b.def.properties) },
      overlap,
    });
    return alignAdvice(advice, a.name, b.name);
  }, (v) => MSG.resultPairAdvice(VERDICT_LABELS[v.tendency]));
}

/** 槽位可能对调两端或写错类名：倾向留下，名字掰回请求里的这一对。 */
function alignAdvice(p: PairAdvice, a: string, b: string): PairAdvice {
  if (p.class_a === a && p.class_b === b) return p;
  return { ...p, class_a: a, class_b: b };
}
