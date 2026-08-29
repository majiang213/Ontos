// 看过交集率之后的倾向 —— 硬证据进整合槽位，再给一句建议。
// 模型当顾问不当计算器：比率由 overlap 算好传入；本文件只做资格闸 + 把两个类的字段交给槽位。

import type { EngineEnv } from "../env";
import { getDraft } from "../ontology/current";
import { mustCls } from "../query/individual";
import { hasSources, pairKey } from "./eligibility";
import { classShots, listCandidates } from "./candidates";
import { EngineReject, MSG, toResult, type Result } from "../../errors";
import { cleanAdvice, VERDICT_LABELS, type PairAdvice } from "../../schema/verdict";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";

export interface OverlapEvidence {
  rate: number;
  count_a: number;
  count_b: number;
  count_hit: number;
}

/** 看过交集率之后，对这一对再给倾向。无源 / 缺唯一键拒绝。同一库两张表也算。 */
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
    if (!a.def.identity || !b.def.identity) {
      throw new EngineReject(MSG.pairNoIdentity);
    }
    // 第一版建议（清单快照里的同一裁判）取来当锚：第二版维持它或由证据改口，不另起炉灶。
    // 清单拉不动不拦第二版——锚只是上下文，不是资格；清单外/已裁的对没有 base，实现按无锚处理。
    const list = await listCandidates(env, workspace);
    const key = pairKey(class_a, class_b);
    const base = list.code === 200 ? list.value.find((p) => pairKey(p.class_a, p.class_b) === key) : undefined;
    const shots = classShots(d); // 建议快照唯一构造处（与清单同源，含枚举值域）
    const shotOf = (name: string) => {
      const s = shots.find((x) => x.name === name);
      if (!s) throw new EngineReject(MSG.pairNoSources); // 两次读取之间类失源（并发编辑）：按业务拒绝收，不炸类型错误
      return s;
    };
    const advice = await env.llm.proposePair({
      class_a: shotOf(a.name),
      class_b: shotOf(b.name),
      overlap,
      ...(base ? { base: { tendency: base.tendency, reason: base.reason } } : {}),
    });
    return alignAdvice(advice, a.name, b.name);
  }, (v) => MSG.resultPairAdvice(VERDICT_LABELS[v.tendency]));
}

/** 调用口可能对调两端或写错类名、写 stage 空壳：倾向留下，名字掰回请求里的这一对，形状清一遍（cleanAdvice）。 */
function alignAdvice(p: PairAdvice, a: string, b: string): PairAdvice {
  const aligned = p.class_a === a && p.class_b === b ? p : { ...p, class_a: a, class_b: b };
  return cleanAdvice(aligned);
}
