// 候选对：GET /api/candidates
// 机器只在已上画布的对象之间找跨源候选对（《ontos-article.md》§3.2）。
// 有共同连接的不成对；已定案（含跳过）的不再出现；建议只出倾向与依据，不定案。

import { NextResponse } from "next/server";
import { getDraft } from "@/lib/engine/configStore";
import { getSlot, type PairAdvice } from "@/lib/engine/llmSlot";
import { metaStore } from "@/lib/meta/store";

export async function GET() {
  const d = getDraft().draft;
  const decided = new Set(metaStore().listDecisions().map((r) => [r.class_a, r.class_b].sort().join("|")));
  const classes = Object.entries(d.object_types)
    .filter(([, t]) => Object.keys(t.sources ?? {}).length > 0) // 无源对象不进裁决
    .map(([name, t]) => ({
      name,
      connections: new Set(Object.values(t.sources ?? {}).map((s) => s.connection)),
      fields: Object.keys(t.properties),
    }));
  const byName = new Map(classes.map((c) => [c.name, c]));

  // 整批交槽位评估（它自己两两比对）
  const advices: PairAdvice[] = await getSlot().suggestPairs(
    classes.map((c) => ({ name: c.name, source: [...c.connections].sort().join("+"), fields: c.fields }))
  );
  // 槽位只看单字符串源；跨源与已定案的复核在这里做
  const candidates = advices.filter((p) => {
    const a = byName.get(p.class_a);
    const b = byName.get(p.class_b);
    if (!a || !b) return false;
    if ([...a.connections].some((c) => b.connections.has(c))) return false;
    return !decided.has([p.class_a, p.class_b].sort().join("|"));
  });
  return NextResponse.json({ candidates });
}
