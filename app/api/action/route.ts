// M8 动作执行器：POST /api/action
// 薄适配：解析并校验写入请求 → 引擎按已发布动作执行 → 每条投影的成败。
// 跨库部分失败不回滚；补偿是重发同一动作（幂等）或人工修库。

import { NextResponse } from "next/server";
import { actionRequestSchema } from "@/lib/schema/request";
import { runAction } from "@/lib/engine/action";
import { demoDriver, loadConfig } from "@/lib/engine/load";
import { ZodError } from "zod";

export async function POST(req: Request) {
  try {
    const action = actionRequestSchema.parse(await req.json());
    const result = runAction(loadConfig(), demoDriver(), action);
    // 前置不满足、公理拦截：不动任何源，422
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
