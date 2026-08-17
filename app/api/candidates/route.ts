// 候选对：GET /api/candidates
// 机器只在已上画布的对象之间找跨源候选对（《ontos-article.md》§3.2）：
// 两个类没有共同连接才算跨源的一对；字段重合度由槽位评估，建议只出倾向与依据，不定案。

import { NextResponse } from "next/server";
import { getDraft } from "@/lib/engine/configStore";
import { getSlot } from "@/lib/engine/llmSlot";

export async function GET() {
  const d = getDraft().draft;
  const classes = Object.entries(d.object_types)
    .filter(([, t]) => Object.keys(t.sources ?? {}).length > 0) // 无源对象不进裁决
    .map(([name, t]) => ({
      name,
      connections: new Set(Object.values(t.sources ?? {}).map((s) => s.connection)),
      fields: Object.keys(t.properties),
    }));

  const candidates = [];
  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) {
      const crossSource = ![...classes[i].connections].some((c) => classes[j].connections.has(c));
      if (!crossSource) continue; // 有共同连接 = 同一侧，不成对
      const advice = await getSlot().suggestPairs([
        { name: classes[i].name, source: [...classes[i].connections][0], fields: classes[i].fields },
        { name: classes[j].name, source: [...classes[j].connections][0], fields: classes[j].fields },
      ]);
      candidates.push(...advice);
    }
  }
  return NextResponse.json({ candidates });
}
