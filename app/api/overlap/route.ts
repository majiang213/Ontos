// 交集率：POST /api/overlap { class_a, class_b }
// 归一化后算两端识别字段的集合重合度；只读采样，内存算，只落计数。

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDraft } from "@/lib/engine/configStore";
import { getDriverRegistry } from "@/lib/engine/load";
import { EngineReject, mustCls } from "@/lib/engine/individual";
import { computeOverlap } from "@/lib/engine/overlap";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

const bodySchema = z
  .object({ class_a: z.string(), class_b: z.string() })
  .refine((b) => b.class_a !== b.class_b, { message: "自己和自己不算疑似重复" });

export async function POST(req: Request) {
  const denied = requireWriteAuth(req); // 触发两列全量扫 + 写计数，口径与写端点对齐
  if (denied) return denied;
  try {
    const ws = wsOf(req);
    const { class_a, class_b } = bodySchema.parse(await bodyJson(req));
    const d = getDraft(ws).draft;
    const a = mustCls(d, class_a);
    const b = mustCls(d, class_b);
    if (!a.def.identity || !b.def.identity) {
      return NextResponse.json({ error: "两边对不上号：有类没设识别字段" }, { status: 422 });
    }
    const result = await computeOverlap(getDriverRegistry(ws), a, b, metaStore(ws));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
