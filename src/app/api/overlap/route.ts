// 交集率：POST /api/overlap { class_a, class_b }
// 归一化后算两端识别字段的集合重合度；只读采样，内存算，只落计数。

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDraft } from "@/server/engine/configStore";
import { connectionsOf, hasSources, isCrossSource } from "@/server/engine/eligibility";
import { getDriverRegistry } from "@/server/engine/load";
import { mustCls } from "@/server/engine/individual";
import { computeOverlap } from "@/server/engine/overlap";
import { metaStore } from "@/server/meta/store";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

const bodySchema = z
  .object({ class_a: z.string(), class_b: z.string() })
  .refine((b) => b.class_a !== b.class_b, { message: "自己和自己不算疑似重复" });

export async function POST(req: Request) {
  const denied = requireWriteAuth(req); // 触发两列全量扫 + 写计数，口径与写端点对齐
  if (denied) return denied;
  return respond(async () => {
    const ws = wsOf(req);
    const { class_a, class_b } = bodySchema.parse(await bodyJson(req));
    const d = (await getDraft(ws)).draft;
    const a = mustCls(d, class_a);
    const b = mustCls(d, class_b);
    // 资格闸走 eligibility 同一套谓词（不收 decided 闸——证据允许重算）：
    // 无源类算出的是幻影 rate 0（空集当零交集），同源对的白扫两列全量
    if (!hasSources(a.def) || !hasSources(b.def)) {
      return NextResponse.json({ error: "无源对象不算疑似重复（先给它挂来源）" }, { status: 422 });
    }
    if (!isCrossSource(a.def, b.def)) {
      const shared = [...connectionsOf(a.def)].filter((c) => connectionsOf(b.def).has(c));
      return NextResponse.json({ error: `这两个对象有共同来源（${shared.join("、")}），不算疑似重复` }, { status: 422 });
    }
    if (!a.def.identity || !b.def.identity) {
      return NextResponse.json({ error: "两边对不上号：有类没设识别字段" }, { status: 422 });
    }
    return computeOverlap(await getDriverRegistry(ws), a, b, metaStore(), ws);
  });
}
