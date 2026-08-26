// 疑似重复的候选 —— 「哪些对等着人裁」：已上画布的跨源候选对，槽位给倾向，资格闸复核。
// 资格谓词在 eligibility.ts；路由只做解析与 JSON。

import type { EngineEnv } from "../env";
import { getDraft } from "../ontology/current";
import { connectionsOf, hasSources, pairEligible, pairKey } from "./eligibility";
import { type PairAdvice } from "../../schema/verdict";
import { MSG, toResult, type Result } from "../../errors";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";

/** 已上画布的跨源候选对：槽位给倾向，资格闸复核。已放弃的裁决（version=-1）不算定案。 */
export async function listCandidates(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<PairAdvice[]>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const decided = new Set(
      (await env.meta.listDecisions(workspace)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
    );
    const classes = Object.entries(d.object_types)
      .filter(([, t]) => hasSources(t))
      .map(([name, t]) => ({
        name,
        sources: [...connectionsOf(t)].sort(),
        fields: Object.keys(t.properties),
      }));
    const byName = new Map(Object.entries(d.object_types));
    const advices = await env.llm.proposePairs(classes);
    return advices.filter((p) => {
      const a = byName.get(p.class_a);
      const b = byName.get(p.class_b);
      return Boolean(a && b && pairEligible(a, b, decided, p.class_a, p.class_b));
    });
  }, (v) => MSG.resultCandidates(v.length));
}
