// 候选对：GET /api/candidates
// 机器只在已上画布的对象之间找跨源候选对（《ontos-article.md》§3.2）。
// 有共同连接的不成对；已定案（含跳过）的不再出现；建议只出倾向与依据，不定案。

import { getDraft } from "@/server/engine/configStore";
import { pairEligible, pairKey } from "@/server/engine/eligibility";
import { getSlot, type PairAdvice } from "@/server/engine/llmSlot";
import { metaStore } from "@/server/meta/store";
import { respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    const d = (await getDraft(ws)).draft;
    // version=-1 是「已放弃」的裁决（草稿被丢弃）——不算定案，候选对可以再出现
    const decided = new Set((await metaStore().listDecisions(ws)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b)));
    const classes = Object.entries(d.object_types)
      .filter(([, t]) => Object.keys(t.sources ?? {}).length > 0) // 无源对象不进裁决
      .map(([name, t]) => ({
        name,
        connections: new Set(Object.values(t.sources ?? {}).map((s) => s.connection)),
        fields: Object.keys(t.properties),
      }));
    const byName = new Map(Object.entries(d.object_types).map(([name, t]) => [name, t] as const));

    // 整批交槽位评估（它自己两两比对）：连接集合直接给，不再 join 成串
    const advices: PairAdvice[] = await getSlot().suggestPairs(
      classes.map((c) => ({ name: c.name, sources: [...c.connections].sort(), fields: c.fields }))
    );
    // 跨源与已定案的复核走 engine 同一套谓词（eligibility.ts）
    const candidates = advices.filter((p) => {
      const a = byName.get(p.class_a);
      const b = byName.get(p.class_b);
      return a && b && pairEligible(a, b, decided, p.class_a, p.class_b);
    });
    return { candidates };
  });
}
